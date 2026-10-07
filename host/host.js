#!/usr/bin/env node
// Native messaging host for chrome-profile-debug. See docs/PROTOCOL.md.
//
// This process is a pipe with two ends:
//
//   Chrome extension  <-- stdin/stdout, native messaging framing -->  host.js
//   host.js           <-- NDJSON over Unix domain sockets          -->  MCP servers
//
// There is one MCP server per MCP client session, each on its own socket in the
// state directory, and this host connects to all of them. A `hello` goes to every
// server; a request is remembered by id so its response goes back only to the
// server that asked. Messages otherwise cross verbatim. The only messages this
// process originates are its keepalive pings, the pongs answering a peer's ping,
// and the replay of the last `hello` on a new socket connection.
//
// Two rules constrain everything below:
//   1. Nothing but framed native messages is ever written to stdout. A stray
//      line there desynchronises the stream and Chrome kills the host.
//   2. Message bodies are never logged. Page text, credentials typed through
//      input.type and console output all flow through this process; stderr gets
//      connection lifecycle events and error classes only.

import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const BACKOFF_MIN_MS = 500;
const BACKOFF_MAX_MS = 30_000;
const PING_INTERVAL_MS = 20_000;
const MISSED_PONGS_BEFORE_RESET = 2;
// How often the state directory is rescanned for servers that started later.
const RESCAN_INTERVAL_MS = 2_000;
// A request whose response never comes must not pin its routing entry forever.
const ROUTE_TTL_MS = 10 * 60_000;

// A length prefix larger than this means the stdin stream is corrupt, not that a
// huge message is arriving; refusing to allocate for it is cheaper than dying.
const MAX_MESSAGE_BYTES = 64 * 1024 * 1024;

// Chrome's limit for a single message from the host to the extension. Exceeding
// it is the responder's bug (results that big must be chunked), but logging it
// here turns an otherwise silent port teardown into a diagnosable event.
const CHROME_MESSAGE_LIMIT_BYTES = 1024 * 1024;

const NATIVE_LITTLE_ENDIAN = os.endianness() === 'LE';

let stdinBuffer = Buffer.alloc(0); // stdin bytes not yet forming a whole message
let lastHello = null;
let shuttingDown = false;
let rescanTimer = null;

// socket path -> { path, socket, ready, buffer, backoffMs, reconnectTimer, pingTimer, unansweredPings }
const links = new Map();
// request id -> { link, at }: where the response to that request must go
const routes = new Map();

// Callers must pass event names and error classes only, never message content.
function log(event, detail) {
  process.stderr.write(detail ? `[cpd-host] ${event}: ${detail}\n` : `[cpd-host] ${event}\n`);
}

// $CPD_SOCKET pins a single server; otherwise every *.sock in the state
// directory is a server to connect to.
const explicitSocket = process.env.CPD_SOCKET || null;

function stateDir() {
  const stateHome = process.env.XDG_STATE_HOME;
  const base = stateHome && path.isAbsolute(stateHome) ? stateHome : path.join(os.homedir(), '.local', 'state');
  return path.join(base, 'chrome-profile-debug');
}

function linkName(link) {
  return path.basename(link.path);
}

function readLength(buffer, offset) {
  return NATIVE_LITTLE_ENDIAN ? buffer.readUInt32LE(offset) : buffer.readUInt32BE(offset);
}

function frame(json) {
  const body = Buffer.from(json, 'utf8');
  const header = Buffer.allocUnsafe(4);
  if (NATIVE_LITTLE_ENDIAN) header.writeUInt32LE(body.length, 0);
  else header.writeUInt32BE(body.length, 0);
  return Buffer.concat([header, body]);
}

function sendToExtension(json) {
  const packet = frame(json);
  if (packet.length - 4 > CHROME_MESSAGE_LIMIT_BYTES) {
    log('oversized message to extension', `${packet.length - 4} bytes`);
  }
  process.stdout.write(packet);
}

function writeToLink(link, line) {
  if (link.ready) link.socket.write(line + '\n');
}

function broadcast(line) {
  for (const link of links.values()) writeToLink(link, line);
}

// --- extension -> server -----------------------------------------------------

function handleFromExtension(raw) {
  let message;
  try {
    message = JSON.parse(raw);
  } catch (err) {
    log('dropped unparsable message from extension', err.name);
    return;
  }

  const type = message !== null && typeof message === 'object' ? message.type : null;

  if (type === 'ping') {
    sendToExtension(JSON.stringify({ type: 'pong', ts: Date.now() }));
    return;
  }
  if (type === 'pong') return; // this host never pings the extension

  // Forwarded byte for byte, unless a raw newline would break NDJSON framing.
  const line = raw.includes('\n') || raw.includes('\r') ? JSON.stringify(message) : raw;

  if (type === 'hello') {
    // Remembered so the profile can be registered with servers that connect
    // later; the replay on connect covers every socket that is down now.
    lastHello = line;
    broadcast(line);
    return;
  }

  if (type === 'response' && typeof message.id === 'string') {
    const route = routes.get(message.id);
    if (!route) {
      log('dropped response to an unknown request');
      return;
    }
    // A chunked response keeps its route until the last chunk has gone out.
    const chunk = message.chunk;
    if (!chunk || chunk.index >= chunk.total - 1) routes.delete(message.id);
    writeToLink(route.link, line);
    return;
  }

  broadcast(line);
}

function onStdinData(chunk) {
  stdinBuffer = stdinBuffer.length ? Buffer.concat([stdinBuffer, chunk]) : chunk;

  for (;;) {
    if (stdinBuffer.length < 4) return;
    const length = readLength(stdinBuffer, 0);
    if (length > MAX_MESSAGE_BYTES) {
      log('fatal', `length prefix out of range (${length})`);
      shutdown(1);
      return;
    }
    if (stdinBuffer.length < 4 + length) return;
    const raw = stdinBuffer.subarray(4, 4 + length).toString('utf8');
    stdinBuffer = stdinBuffer.subarray(4 + length);
    handleFromExtension(raw);
  }
}

// --- server -> extension -----------------------------------------------------

function handleFromServer(link, line) {
  let message;
  try {
    message = JSON.parse(line);
  } catch (err) {
    log('dropped unparsable line from server', err.name);
    return;
  }

  const type = message !== null && typeof message === 'object' ? message.type : null;

  if (type === 'ping') {
    writeToLink(link, JSON.stringify({ type: 'pong', ts: Date.now() }));
    return;
  }
  if (type === 'pong') {
    link.unansweredPings = 0;
    return;
  }
  if (type === 'request' && typeof message.id === 'string') {
    routes.set(message.id, { link, at: Date.now() });
  }

  sendToExtension(line);
}

function onSocketData(link, chunk) {
  // Split on bytes, not on a decoded string: a multi-byte character straddling
  // two chunks would be mangled by decoding each chunk on its own.
  link.buffer = link.buffer.length ? Buffer.concat([link.buffer, chunk]) : chunk;

  for (;;) {
    const newline = link.buffer.indexOf(0x0a);
    if (newline === -1) return;
    const line = link.buffer.subarray(0, newline).toString('utf8').replace(/\r$/, '');
    link.buffer = link.buffer.subarray(newline + 1);
    if (line.trim().length > 0) handleFromServer(link, line);
  }
}

// --- socket lifecycle --------------------------------------------------------

function discover() {
  if (shuttingDown) return;
  let paths;
  if (explicitSocket) {
    paths = [explicitSocket];
  } else {
    try {
      paths = fs
        .readdirSync(stateDir())
        .filter((name) => name.endsWith('.sock'))
        .map((name) => path.join(stateDir(), name));
    } catch (err) {
      // No server has ever run on this machine yet; the next scan retries.
      if (err.code !== 'ENOENT') log('cannot read the state directory', err.code || err.name);
      paths = [];
    }
  }
  for (const socketPath of paths) {
    if (links.has(socketPath)) continue;
    const link = {
      path: socketPath,
      socket: null,
      ready: false,
      buffer: Buffer.alloc(0),
      backoffMs: BACKOFF_MIN_MS,
      reconnectTimer: null,
      pingTimer: null,
      unansweredPings: 0,
    };
    links.set(socketPath, link);
    connect(link);
  }
  const expired = Date.now() - ROUTE_TTL_MS;
  for (const [id, route] of routes) if (route.at < expired) routes.delete(id);
}

function connect(link) {
  link.reconnectTimer = null;
  link.buffer = Buffer.alloc(0);

  const candidate = net.createConnection({ path: link.path });
  link.socket = candidate;

  candidate.on('connect', () => {
    link.ready = true;
    link.backoffMs = BACKOFF_MIN_MS;
    link.unansweredPings = 0;
    log('socket connected', linkName(link));
    if (lastHello) candidate.write(lastHello + '\n');
    startPing(link);
  });

  candidate.on('data', (chunk) => onSocketData(link, chunk));
  // A socket left behind by a crashed server refuses connections until the next
  // server start sweeps it; that is expected, not an incident.
  candidate.on('error', (err) => log('socket error', `${linkName(link)} ${err.code || err.name}`));
  candidate.on('close', () => {
    if (candidate === link.socket) dropLink(link, 'closed');
  });
}

function dropLink(link, reason) {
  stopPing(link);
  if (link.socket) {
    link.socket.removeAllListeners();
    link.socket.destroy();
    link.socket = null;
  }
  link.ready = false;
  link.buffer = Buffer.alloc(0);
  // The server that asked is gone, so are the answers it was waiting for.
  for (const [id, route] of routes) if (route.link === link) routes.delete(id);
  if (shuttingDown) return;
  if (!explicitSocket && !fs.existsSync(link.path)) {
    links.delete(link.path);
    log('server gone', linkName(link));
    return;
  }
  log('socket down', `${linkName(link)} ${reason}`);
  scheduleReconnect(link);
}

function scheduleReconnect(link) {
  if (link.reconnectTimer || shuttingDown) return;
  const delay = link.backoffMs;
  link.backoffMs = Math.min(link.backoffMs * 2, BACKOFF_MAX_MS);
  link.reconnectTimer = setTimeout(() => {
    // A file swept while we waited means that server is not coming back.
    if (!explicitSocket && !fs.existsSync(link.path)) {
      links.delete(link.path);
      log('server gone', linkName(link));
      return;
    }
    connect(link);
  }, delay);
}

function startPing(link) {
  stopPing(link);
  link.pingTimer = setInterval(() => {
    if (!link.ready) return;
    if (link.unansweredPings >= MISSED_PONGS_BEFORE_RESET) {
      dropLink(link, 'missed pongs');
      return;
    }
    link.unansweredPings++;
    link.socket.write(JSON.stringify({ type: 'ping', ts: Date.now() }) + '\n');
  }, PING_INTERVAL_MS);
}

function stopPing(link) {
  if (link.pingTimer) {
    clearInterval(link.pingTimer);
    link.pingTimer = null;
  }
}

// --- shutdown ----------------------------------------------------------------

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (rescanTimer) clearInterval(rescanTimer);
  for (const link of links.values()) {
    stopPing(link);
    if (link.reconnectTimer) clearTimeout(link.reconnectTimer);
    if (link.socket) {
      link.socket.removeAllListeners();
      link.socket.destroy();
    }
  }
  links.clear();
  log('exiting', `code ${code}`);
  process.exit(code);
}

process.stdin.on('data', onStdinData);
// stdin closing means Chrome has gone away: there is nothing left to relay.
process.stdin.on('end', () => shutdown(0));
process.stdin.on('error', (err) => {
  log('stdin error', err.code || err.name);
  shutdown(0);
});
process.stdout.on('error', (err) => {
  log('stdout error', err.code || err.name);
  shutdown(0);
});
process.on('SIGTERM', () => shutdown(0));
process.on('SIGINT', () => shutdown(0));

log('starting', explicitSocket ? `socket ${explicitSocket}` : `servers in ${stateDir()}`);
discover();
rescanTimer = setInterval(discover, RESCAN_INTERVAL_MS);
