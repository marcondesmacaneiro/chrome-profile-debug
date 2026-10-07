// Several MCP sessions at once: every server on its own socket, every host on
// all of them. Run with `npm test`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const hello = { type: 'hello', protocolVersion: 1, profile: { id: 'p-1', name: 'teste' } };

// /tmp, not os.tmpdir(): a Unix socket path must fit in 104 bytes on macOS.
function makeStateHome() {
  const state = mkdtempSync('/tmp/cpd-');
  const dir = path.join(state, 'chrome-profile-debug');
  mkdirSync(dir, { mode: 0o700 });
  return { state, dir };
}

function within(promise, ms = 5_000) {
  return Promise.race([
    promise,
    delay(ms).then(() => {
      throw new Error(`timed out after ${ms} ms`);
    }),
  ]);
}

async function waitFor(condition, ms = 5_000) {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await delay(50);
  }
}

function frame(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  return Buffer.concat([header, body]);
}

// Reads native-messaging frames the host writes for the extension.
function frameReader(stream) {
  let buffer = Buffer.alloc(0);
  const ready = [];
  const waiting = [];
  stream.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4) {
      const length = buffer.readUInt32LE(0);
      if (buffer.length < 4 + length) break;
      const message = JSON.parse(buffer.subarray(4, 4 + length).toString('utf8'));
      buffer = buffer.subarray(4 + length);
      const waiter = waiting.shift();
      if (waiter) waiter(message);
      else ready.push(message);
    }
  });
  return () => (ready.length ? Promise.resolve(ready.shift()) : new Promise((resolve) => waiting.push(resolve)));
}

// Stands in for server/index.js on the socket side; keepalive pings are ignored.
function fakeServer(socketPath) {
  const ready = [];
  const waiting = [];
  let peer = null;
  const server = net.createServer((socket) => {
    peer = socket;
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      buffer += chunk;
      for (let newline = buffer.indexOf('\n'); newline !== -1; newline = buffer.indexOf('\n')) {
        const message = JSON.parse(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        if (message.type === 'ping' || message.type === 'pong') continue;
        const waiter = waiting.shift();
        if (waiter) waiter(message);
        else ready.push(message);
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(socketPath, () =>
      resolve({
        next: () => (ready.length ? Promise.resolve(ready.shift()) : new Promise((r) => waiting.push(r))),
        unread: () => ready.length,
        send: (message) => peer.write(JSON.stringify(message) + '\n'),
        close: () =>
          new Promise((r) => {
            peer?.destroy();
            server.close(() => r());
          }),
      }),
    );
  });
}

function startHost(state) {
  return spawn(process.execPath, [path.join(root, 'host', 'host.js')], {
    env: { ...process.env, XDG_STATE_HOME: state, CPD_SOCKET: '' },
    stdio: ['pipe', 'pipe', 'ignore'],
  });
}

test('the host greets every server and returns each response only to the server that asked', async (t) => {
  const { state, dir } = makeStateHome();
  const a = await fakeServer(path.join(dir, 'bridge-1.sock'));
  const b = await fakeServer(path.join(dir, 'bridge-2.sock'));
  const host = startHost(state);
  t.after(async () => {
    host.kill();
    await a.close();
    await b.close();
    rmSync(state, { recursive: true, force: true });
  });
  const fromHost = frameReader(host.stdout);

  host.stdin.write(frame(hello));
  assert.equal((await within(a.next())).type, 'hello');
  assert.equal((await within(b.next())).type, 'hello');

  a.send({ id: 'a-1', type: 'request', method: 'tabs.list', params: {} });
  assert.equal((await within(fromHost())).id, 'a-1');
  host.stdin.write(frame({ id: 'a-1', type: 'response', ok: true, result: [] }));
  assert.equal((await within(a.next())).id, 'a-1');

  b.send({ id: 'b-1', type: 'request', method: 'page.screenshot', params: {} });
  assert.equal((await within(fromHost())).id, 'b-1');
  host.stdin.write(frame({ id: 'b-1', type: 'response', ok: true, chunk: { index: 0, total: 2 }, resultChunk: 'AA' }));
  host.stdin.write(frame({ id: 'b-1', type: 'response', ok: true, chunk: { index: 1, total: 2 }, resultChunk: 'BB' }));
  assert.equal((await within(b.next())).chunk.index, 0);
  assert.equal((await within(b.next())).chunk.index, 1);

  await delay(300);
  assert.equal(a.unread(), 0, "a response to b's request leaked to a");
});

test('the host picks up a server that starts after it', async (t) => {
  const { state, dir } = makeStateHome();
  const host = startHost(state);
  let late = null;
  t.after(async () => {
    host.kill();
    await late?.close();
    rmSync(state, { recursive: true, force: true });
  });

  host.stdin.write(frame(hello));
  await delay(500);
  late = await fakeServer(path.join(dir, 'bridge-3.sock'));
  assert.equal((await within(late.next(), 8_000)).type, 'hello');
});

test('two servers run side by side and sweep the socket of a dead one', async (t) => {
  const { state, dir } = makeStateHome();
  const servers = [];
  t.after(() => {
    for (const server of servers) server.kill();
    rmSync(state, { recursive: true, force: true });
  });

  // A listener killed with SIGKILL never removes its socket file.
  const stalePath = path.join(dir, 'bridge-99999.sock');
  const orphan = spawn(process.execPath, ['-e', `require('net').createServer().listen(${JSON.stringify(stalePath)})`]);
  await waitFor(() => existsSync(stalePath));
  orphan.kill('SIGKILL');
  await once(orphan, 'exit');
  assert.ok(existsSync(stalePath));

  const startServer = () => {
    const child = spawn(process.execPath, [path.join(root, 'server', 'index.js')], {
      env: { ...process.env, XDG_STATE_HOME: state, CPD_SOCKET: '' },
      stdio: ['pipe', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.ready = () => waitFor(() => stderr.includes('ready'), 8_000);
    servers.push(child);
    return child;
  };
  const first = startServer();
  const second = startServer();
  await first.ready();
  await second.ready();

  const sockets = readdirSync(dir).filter((name) => name.endsWith('.sock')).sort();
  assert.deepEqual(sockets, [`bridge-${first.pid}.sock`, `bridge-${second.pid}.sock`].sort());
});
