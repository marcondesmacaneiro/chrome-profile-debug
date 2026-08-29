#!/usr/bin/env node
// Native messaging host for chrome-profile-debug. See docs/PROTOCOL.md.
//
// This process is a pipe with two ends:
//
//   Chrome extension  <-- stdin/stdout, native messaging framing -->  host.js
//   host.js           <-- NDJSON over a Unix domain socket        -->  MCP server
//
// Messages cross verbatim in both directions. The only messages this process
// originates are its own keepalive ping, the pong answering a peer's ping, and
// the replay of the last `hello` on a new socket connection.
//
// Two rules constrain everything below:
//   1. Nothing but framed native messages is ever written to stdout. A stray
//      line there desynchronises the stream and Chrome kills the host.
//   2. Message bodies are never logged. Page text, credentials typed through
//      input.type and console output all flow through this process; stderr gets
//      connection lifecycle events and error classes only.

import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const BACKOFF_MIN_MS = 500;
const BACKOFF_MAX_MS = 30_000;
const PING_INTERVAL_MS = 20_000;
const MISSED_PONGS_BEFORE_RESET = 2;
const QUEUE_LIMIT = 100;

// A length prefix larger than this means the stdin stream is corrupt, not that a
// huge message is arriving; refusing to allocate for it is cheaper than dying.
const MAX_MESSAGE_BYTES = 64 * 1024 * 1024;

// Chrome's limit for a single message from the host to the extension. Exceeding
// it is the responder's bug (results that big must be chunked), but logging it
// here turns an otherwise silent port teardown into a diagnosable event.
const CHROME_MESSAGE_LIMIT_BYTES = 1024 * 1024;

const NATIVE_LITTLE_ENDIAN = os.endianness() === 'LE';

let stdinBuffer = Buffer.alloc(0); // stdin bytes not yet forming a whole message
let socketBuffer = Buffer.alloc(0); // socket bytes not yet forming a whole line
let socket = null;
let socketReady = false;
let queue = [];
let lastHello = null;
let backoffMs = BACKOFF_MIN_MS;
let reconnectTimer = null;
let pingTimer = null;
let unansweredPings = 0;
let shuttingDown = false;

// Callers must pass event names and error classes only, never message content.
function log(event, detail) {
  process.stderr.write(detail ? `[cpd-host] ${event}: ${detail}\n` : `[cpd-host] ${event}\n`);
}

function socketPath() {
  if (process.env.CPD_SOCKET) return process.env.CPD_SOCKET;
  const base = process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state');
  return path.join(base, 'chrome-profile-debug', 'bridge.sock');
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

function sendToServer(line) {
  if (socketReady) {
    socket.write(line + '\n');
    return;
  }
  queue.push(line);
  if (queue.length > QUEUE_LIMIT) {
    queue.shift();
    log('queue full, dropped oldest message', `limit ${QUEUE_LIMIT}`);
  }
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
    // Remembered so the profile can be re-registered after a reconnect. Never
    // queued: the replay on connect already covers the socket-down case.
    lastHello = line;
    if (socketReady) socket.write(line + '\n');
    return;
  }

  sendToServer(line);
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

function handleFromServer(line) {
  let message;
  try {
    message = JSON.parse(line);
  } catch (err) {
    log('dropped unparsable line from server', err.name);
    return;
  }

  const type = message !== null && typeof message === 'object' ? message.type : null;

  if (type === 'ping') {
    if (socketReady) socket.write(JSON.stringify({ type: 'pong', ts: Date.now() }) + '\n');
    return;
  }
  if (type === 'pong') {
    unansweredPings = 0;
    return;
  }

  sendToExtension(line);
}

function onSocketData(chunk) {
  // Split on bytes, not on a decoded string: a multi-byte character straddling
  // two chunks would be mangled by decoding each chunk on its own.
  socketBuffer = socketBuffer.length ? Buffer.concat([socketBuffer, chunk]) : chunk;

  for (;;) {
    const newline = socketBuffer.indexOf(0x0a);
    if (newline === -1) return;
    const line = socketBuffer.subarray(0, newline).toString('utf8').replace(/\r$/, '');
    socketBuffer = socketBuffer.subarray(newline + 1);
    if (line.trim().length > 0) handleFromServer(line);
  }
}

// --- socket lifecycle --------------------------------------------------------

function connect() {
  reconnectTimer = null;
  socketBuffer = Buffer.alloc(0);

  const candidate = net.createConnection({ path: socketPath() });
  socket = candidate;

  candidate.on('connect', () => {
    socketReady = true;
    backoffMs = BACKOFF_MIN_MS;
    unansweredPings = 0;
    log('socket connected');

    if (lastHello) candidate.write(lastHello + '\n');

    const pendingLines = queue;
    queue = [];
    for (const line of pendingLines) candidate.write(line + '\n');
    if (pendingLines.length > 0) log('flushed queued messages', `${pendingLines.length}`);

    startPing();
  });

  candidate.on('data', onSocketData);
  // The server is frequently not running; that is expected, not an incident.
  candidate.on('error', (err) => log('socket error', err.code || err.name));
  candidate.on('close', () => {
    if (candidate === socket) dropSocket('closed');
  });
}

function dropSocket(reason) {
  stopPing();
  if (socket) {
    socket.removeAllListeners();
    socket.destroy();
    socket = null;
  }
  socketReady = false;
  socketBuffer = Buffer.alloc(0);
  if (shuttingDown) return;
  log('socket down', reason);
  scheduleReconnect();
}

function scheduleReconnect() {
  if (reconnectTimer || shuttingDown) return;
  const delay = backoffMs;
  backoffMs = Math.min(backoffMs * 2, BACKOFF_MAX_MS);
  log('reconnecting', `in ${delay} ms`);
  reconnectTimer = setTimeout(connect, delay);
}

function startPing() {
  stopPing();
  pingTimer = setInterval(() => {
    if (!socketReady) return;
    if (unansweredPings >= MISSED_PONGS_BEFORE_RESET) {
      dropSocket('missed pongs');
      return;
    }
    unansweredPings++;
    socket.write(JSON.stringify({ type: 'ping', ts: Date.now() }) + '\n');
  }, PING_INTERVAL_MS);
}

function stopPing() {
  if (pingTimer) {
    clearInterval(pingTimer);
    pingTimer = null;
  }
}

// --- shutdown ----------------------------------------------------------------

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  stopPing();
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (socket) {
    socket.removeAllListeners();
    socket.destroy();
    socket = null;
  }
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

log('starting', `socket ${socketPath()}`);
connect();
