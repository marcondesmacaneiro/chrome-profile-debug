#!/usr/bin/env node
// MCP server for chrome-profile-debug.
//
//   MCP client <--stdio, MCP--> this file <--NDJSON, Unix socket--> host/host.js
//
// One host process connects per Chrome profile and identifies itself with a
// `hello`. Tool calls name a profile; this file routes them to that profile's
// connection and correlates the reply by request id.
//
// stdout belongs to the MCP transport. Every diagnostic goes to stderr — a
// stray byte on stdout corrupts the session.

import { createServer, connect } from 'node:net';
import { chmodSync, existsSync, mkdirSync, statSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const SERVER_NAME = 'chrome-profile-debug';
const SERVER_VERSION = '0.1.0';
const PROTOCOL_VERSION = 1;
const DEFAULT_REQUEST_TIMEOUT_MS = readPositiveInt(process.env.CPD_REQUEST_TIMEOUT_MS) ?? 30_000;

// A host that never sends a newline must not be able to exhaust memory. One
// chunk is 512 KB of payload before base64, so this leaves ample headroom.
const MAX_LINE_LENGTH = 32 * 1024 * 1024;

const SOCKET_MODE = 0o600;
const STATE_DIR_MODE = 0o700;

const NOT_CONNECTED_CHECKLIST = [
  'Check, in this order:',
  '  1. the extension is loaded in that Chrome profile (chrome://extensions, Developer mode, Load unpacked);',
  '  2. the profile has a name set in the extension popup — an unnamed profile never connects, by design;',
  '  3. the native messaging host manifest lists that profile\'s extension ID (npm run install-host -- --extension-id <ID>);',
  '  4. Chrome is running.',
].join('\n');

function log(message) {
  process.stderr.write(`[${new Date().toISOString()}] ${SERVER_NAME}: ${message}\n`);
}

// Raised when the bridge itself fails (timeout, dropped host, bad framing).
// These messages are already specific, so callTool passes them through with
// their code rather than wrapping them in the generic TOOL_FAILED text.
class BridgeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'BridgeError';
    this.code = code;
  }
}

function readPositiveInt(raw) {
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

// --- Socket path and permissions -------------------------------------------

function resolveSocketPath() {
  if (process.env.CPD_SOCKET) return process.env.CPD_SOCKET;
  const stateHome = process.env.XDG_STATE_HOME;
  const base = stateHome && isAbsolute(stateHome) ? stateHome : join(homedir(), '.local', 'state');
  return join(base, 'chrome-profile-debug', 'bridge.sock');
}

// Connect to decide whether an existing socket file is live or a crash leftover.
// ECONNREFUSED means nothing is listening, so the file is safe to remove.
function probeExistingSocket(socketPath) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (verdict) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      probe.destroy();
      resolve(verdict);
    };
    const probe = connect(socketPath);
    const timer = setTimeout(() => finish('live'), 1000);
    timer.unref();
    probe.on('connect', () => finish('live'));
    probe.on('error', (err) => finish(err.code === 'ECONNREFUSED' || err.code === 'ENOENT' ? 'stale' : 'unknown'));
  });
}

async function prepareSocketPath(socketPath) {
  const dir = dirname(socketPath);
  mkdirSync(dir, { recursive: true, mode: STATE_DIR_MODE });
  // mkdir's mode is masked by umask, and the directory may predate us with
  // looser bits. 0700 on the directory is half of what keeps other users out.
  chmodSync(dir, STATE_DIR_MODE);
  assertMode(dir, STATE_DIR_MODE, 'state directory');

  if (!existsSync(socketPath)) return;

  if (!statSync(socketPath).isSocket()) {
    throw new Error(`${socketPath} exists and is not a socket. Remove it, or point $CPD_SOCKET somewhere else.`);
  }

  const verdict = await probeExistingSocket(socketPath);
  if (verdict === 'live') {
    throw new Error(
      `Another ${SERVER_NAME} server is already listening on ${socketPath}. ` +
        'Stop that one, or set $CPD_SOCKET to a different path for this instance.',
    );
  }
  if (verdict === 'unknown') {
    throw new Error(
      `${socketPath} exists but could not be probed, so it is not safe to remove automatically. ` +
        'Delete it by hand if no server is running.',
    );
  }
  unlinkSync(socketPath);
  log(`removed a stale socket left at ${socketPath}`);
}

function assertMode(path, expected, label) {
  const actual = statSync(path).mode & 0o777;
  if (actual !== expected) {
    throw new Error(
      `Refusing to run: the ${label} ${path} is mode 0${actual.toString(8)}, expected 0${expected.toString(8)}. ` +
        'The bridge must not be reachable by other local users.',
    );
  }
}

function listenOnSocket(socketPath) {
  return new Promise((resolve, reject) => {
    const socketServer = createServer((socket) => registerConnection(socket));
    let umaskRestored = false;
    // Create the socket already at 0600: chmod after listen() would leave a
    // window in which any local user could connect.
    const previousUmask = process.umask(0o177);
    const restoreUmask = () => {
      if (umaskRestored) return;
      umaskRestored = true;
      process.umask(previousUmask);
    };

    socketServer.on('error', (err) => {
      restoreUmask();
      reject(
        err.code === 'EADDRINUSE'
          ? new Error(`${socketPath} is already in use. Another server took it between the probe and the bind.`)
          : err,
      );
    });

    socketServer.listen(socketPath, () => {
      restoreUmask();
      try {
        chmodSync(socketPath, SOCKET_MODE);
        assertMode(socketPath, SOCKET_MODE, 'bridge socket');
      } catch (err) {
        socketServer.close();
        reject(err);
        return;
      }
      resolve(socketServer);
    });
  });
}

// --- Profile registry and connections --------------------------------------

const profiles = new Map(); // profile name -> connection
const connections = new Set();

function registerConnection(socket) {
  const connection = {
    socket,
    buffer: '',
    profile: null,
    pending: new Map(),
    closed: false,
    label: 'an unnamed connection',
  };
  connections.add(connection);

  // setEncoding decodes with a StringDecoder, so multi-byte characters are
  // never split across chunk boundaries.
  socket.setEncoding('utf8');
  socket.on('data', (chunk) => onData(connection, chunk));
  socket.on('error', (err) => log(`socket error on ${connection.label}: ${err.message}`));
  socket.on('close', () => closeConnection(connection, 'the host disconnected'));
}

function onData(connection, chunk) {
  connection.buffer += chunk;
  if (connection.buffer.length > MAX_LINE_LENGTH) {
    rejectConnection(connection, 'LINE_TOO_LONG', `A single NDJSON line exceeded ${MAX_LINE_LENGTH} bytes.`);
    connection.buffer = '';
    return;
  }

  let newline = connection.buffer.indexOf('\n');
  while (newline !== -1) {
    const line = connection.buffer.slice(0, newline);
    connection.buffer = connection.buffer.slice(newline + 1);
    if (line.trim() !== '') {
      try {
        handleLine(connection, line);
      } catch (err) {
        // One bad line must never take the server down.
        log(`error while handling a line from ${connection.label}: ${err.stack || err.message}`);
      }
    }
    newline = connection.buffer.indexOf('\n');
  }
}

function handleLine(connection, line) {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    message = undefined;
  }

  if (message === undefined || message === null || typeof message !== 'object' || Array.isArray(message)) {
    if (connection.profile) {
      log(`ignoring a malformed line from ${connection.label}`);
    } else {
      rejectConnection(connection, 'BAD_HELLO', 'The first message must be a JSON object of type "hello".');
    }
    return;
  }

  if (!connection.profile) {
    if (message.type !== 'hello') {
      rejectConnection(
        connection,
        'BAD_HELLO',
        `Expected "hello" as the first message, received "${message.type}".`,
      );
      return;
    }
    handleHello(connection, message);
    return;
  }

  switch (message.type) {
    case 'response':
      handleResponse(connection, message);
      break;
    case 'ping':
      writeMessage(connection, { type: 'pong', ts: typeof message.ts === 'number' ? message.ts : Date.now() });
      break;
    case 'pong':
      break;
    case 'hello':
      log(`ignoring a second hello from ${connection.label}`);
      break;
    case 'error':
      log(`${connection.label} reported an error: ${message.code || 'no code'} ${message.message || ''}`);
      break;
    default:
      log(`ignoring an unknown message type "${message.type}" from ${connection.label}`);
  }
}

function handleHello(connection, message) {
  if (message.protocolVersion !== PROTOCOL_VERSION) {
    rejectConnection(
      connection,
      'PROTOCOL_VERSION_MISMATCH',
      `This server speaks protocol version ${PROTOCOL_VERSION}, the host announced ${message.protocolVersion}. Update both sides from the same checkout.`,
    );
    return;
  }

  const profile = message.profile;
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) {
    rejectConnection(connection, 'BAD_HELLO', 'hello.profile must be an object.');
    return;
  }

  const name = typeof profile.name === 'string' ? profile.name.trim() : '';
  if (name === '') {
    rejectConnection(
      connection,
      'BAD_HELLO',
      'hello.profile.name is required. A profile with no name must not connect — naming it is what makes it opt-in.',
    );
    return;
  }

  const incumbent = profiles.get(name);
  if (incumbent && !incumbent.closed) {
    // A matching profile.id means this is that same profile reconnecting, not a
    // second profile claiming the name. profile.id is a stable per-install UUID.
    //
    // This matters because a host killed abruptly (kill -9, a crash) leaves its
    // socket half-open: the incumbent still looks alive here for as long as the
    // OS takes to deliver the close. Refusing the newcomer in that window would
    // send it back through reconnect backoff, hit the same stale incumbent, and
    // loop — taking the profile off the air permanently.
    const sameProfile =
      typeof profile.id === 'string' &&
      incumbent.profile != null &&
      incumbent.profile.id === profile.id;

    if (sameProfile) {
      log(`replacing a stale connection for profile "${name}" (same profile id)`);
      closeConnection(incumbent, 'replaced by a reconnect from the same profile');
    } else {
      writeMessage(connection, {
        type: 'error',
        code: 'DUPLICATE_NAME',
        message: `Another connected profile is already named "${name}". Rename this one in the extension popup.`,
      });
      log(`refused a duplicate registration for profile "${name}"`);
      connection.socket.end();
      return;
    }
  }

  connection.profile = {
    id: typeof profile.id === 'string' ? profile.id : null,
    name,
    chromeVersion: typeof profile.chromeVersion === 'string' ? profile.chromeVersion : null,
    extensionVersion: typeof profile.extensionVersion === 'string' ? profile.extensionVersion : null,
  };
  connection.label = `profile "${name}"`;
  profiles.set(name, connection);
  log(`registered ${connection.label} (Chrome ${connection.profile.chromeVersion || 'unknown'})`);
}

function rejectConnection(connection, code, message) {
  log(`rejecting ${connection.label}: ${code} — ${message}`);
  writeMessage(connection, { type: 'error', code, message });
  connection.socket.end();
}

function writeMessage(connection, message) {
  if (connection.closed || connection.socket.destroyed || connection.socket.writableEnded) return false;
  connection.socket.write(`${JSON.stringify(message)}\n`);
  return true;
}

function closeConnection(connection, reason) {
  if (connection.closed) return;
  connection.closed = true;
  connections.delete(connection);

  // Only deregister if this connection is the one holding the name: a rejected
  // duplicate must not evict the incumbent when it closes.
  if (connection.profile && profiles.get(connection.profile.name) === connection) {
    profiles.delete(connection.profile.name);
    log(`deregistered ${connection.label}: ${reason}`);
  }

  for (const pending of connection.pending.values()) {
    clearTimeout(pending.timer);
    pending.reject(
      new BridgeError(
        'PROFILE_DISCONNECTED',
        `The connection to ${connection.label} closed before "${pending.method}" answered (${reason}). ` +
          'Call list_profiles to see which profiles are connected now.',
      ),
    );
  }
  connection.pending.clear();
}

// --- Request routing --------------------------------------------------------

function sendRequest(connection, method, params, timeoutMs) {
  return new Promise((resolve, reject) => {
    const id = randomUUID();

    const timer = setTimeout(() => {
      connection.pending.delete(id);
      reject(
        new BridgeError(
          'TIMEOUT',
          `Timed out after ${timeoutMs} ms waiting for "${method}" on ${connection.label}. ` +
            'The profile is still connected but did not answer. The tab may be busy, or DevTools may be attached to it ' +
            '(see DEBUGGER_BUSY). Retry, or call list_tabs to check that the profile responds.',
        ),
      );
    }, timeoutMs);
    timer.unref();

    connection.pending.set(id, { method, resolve, reject, timer, chunks: null, chunkTotal: 0 });

    if (!writeMessage(connection, { id, type: 'request', method, params })) {
      clearTimeout(timer);
      connection.pending.delete(id);
      reject(
        new BridgeError(
          'PROFILE_DISCONNECTED',
          `${connection.label} disconnected before "${method}" could be sent. Call list_profiles to see what is connected.`,
        ),
      );
    }
  });
}

function handleResponse(connection, message) {
  const pending = connection.pending.get(message.id);
  if (!pending) {
    log(`ignoring a response for an unknown request id "${message.id}" from ${connection.label}`);
    return;
  }

  const settle = (settler, value) => {
    clearTimeout(pending.timer);
    connection.pending.delete(message.id);
    settler(value);
  };

  if (message.ok === false) {
    settle(pending.resolve, {
      ok: false,
      error: message.error || { code: 'INTERNAL', message: 'The extension reported a failure with no detail.' },
    });
    return;
  }

  if (message.ok !== true) {
    settle(
      pending.reject,
      new BridgeError(
        'BAD_RESPONSE',
        `${connection.label} sent a response for "${pending.method}" with no "ok" field. Retry the call.`,
      ),
    );
    return;
  }

  if (!message.chunk) {
    settle(pending.resolve, { ok: true, result: message.result });
    return;
  }

  const { index, total } = message.chunk;
  if (
    !Number.isInteger(index) ||
    !Number.isInteger(total) ||
    total < 1 ||
    index < 0 ||
    index >= total ||
    typeof message.resultChunk !== 'string'
  ) {
    settle(
      pending.reject,
      new BridgeError(
        'BAD_RESPONSE',
        `${connection.label} sent a malformed chunk for "${pending.method}" (index=${index}, total=${total}). ` +
          'The response was dropped; retry the call.',
      ),
    );
    return;
  }

  if (pending.chunks === null) {
    pending.chunks = [];
    pending.chunkTotal = total;
  }

  if (pending.chunkTotal !== total) {
    settle(
      pending.reject,
      new BridgeError(
        'BAD_RESPONSE',
        `${connection.label} changed the chunk count mid-response for "${pending.method}" ` +
          `(${pending.chunkTotal} then ${total}). The response was dropped; retry the call.`,
      ),
    );
    return;
  }

  if (index !== pending.chunks.length) {
    settle(
      pending.reject,
      new BridgeError(
        'BAD_RESPONSE',
        `${connection.label} sent an out-of-order chunk for "${pending.method}": expected index ` +
          `${pending.chunks.length}, received ${index}. The response was dropped; retry the call.`,
      ),
    );
    return;
  }

  pending.chunks.push(message.resultChunk);
  if (pending.chunks.length < total) return;

  let result;
  try {
    result = JSON.parse(Buffer.from(pending.chunks.join(''), 'base64').toString('utf8'));
  } catch (err) {
    settle(
      pending.reject,
      new BridgeError(
        'BAD_RESPONSE',
        `The ${total} chunks of "${pending.method}" from ${connection.label} did not reassemble into valid JSON ` +
          `(${err.message}). Retry the call.`,
      ),
    );
    return;
  }
  settle(pending.resolve, { ok: true, result });
}

// --- MCP tool surface -------------------------------------------------------

const TAB_ID = { type: 'integer', description: 'Tab id from list_tabs.' };

const TOOLS = [
  {
    name: 'list_tabs',
    method: 'tabs.list',
    description: 'List the open tabs of one profile; every other page tool needs a tabId from here.',
    annotations: { readOnlyHint: true },
    properties: {},
    required: [],
  },
  {
    name: 'new_tab',
    method: 'tabs.create',
    description: 'Open a new tab in the profile, optionally at a URL, and return its tabId.',
    annotations: { openWorldHint: true },
    properties: {
      url: { type: 'string', description: 'URL to open. Defaults to the new tab page when omitted.' },
    },
    required: [],
  },
  {
    name: 'close_tab',
    method: 'tabs.close',
    description: 'Close one tab in the profile.',
    annotations: { destructiveHint: true },
    properties: { tabId: TAB_ID },
    required: ['tabId'],
  },
  {
    name: 'activate_tab',
    method: 'tabs.activate',
    description: 'Bring one tab to the foreground of its window.',
    properties: { tabId: TAB_ID },
    required: ['tabId'],
  },
  {
    name: 'navigate',
    method: 'page.navigate',
    description: 'Navigate an existing tab to a URL and wait for the load to settle.',
    annotations: { openWorldHint: true },
    properties: {
      tabId: TAB_ID,
      url: { type: 'string', description: 'Absolute URL to load. chrome:// and devtools:// are rejected by the browser.' },
      timeoutMs: {
        type: 'integer',
        minimum: 1,
        description: 'How long the page may take to load, in milliseconds.',
      },
    },
    required: ['tabId', 'url'],
  },
  {
    name: 'read_page',
    method: 'page.readTree',
    description: 'Read the accessibility tree of a tab: role, name and click-ready centre coordinates per element.',
    annotations: { readOnlyHint: true },
    properties: {
      tabId: TAB_ID,
      interactiveOnly: {
        type: 'boolean',
        description: 'Keep only elements a user can act on (links, buttons, fields). Much smaller output.',
      },
      maxNodes: { type: 'integer', minimum: 1, description: 'Cap on the number of nodes returned.' },
    },
    required: ['tabId'],
  },
  {
    name: 'page_text',
    method: 'page.text',
    description: 'Read the visible text of a tab as plain text.',
    annotations: { readOnlyHint: true },
    properties: {
      tabId: TAB_ID,
      maxChars: { type: 'integer', minimum: 1, description: 'Truncate the text at this many characters.' },
    },
    required: ['tabId'],
  },
  {
    name: 'screenshot',
    method: 'page.screenshot',
    description: 'Capture a screenshot of a tab and return it as an image.',
    annotations: { readOnlyHint: true },
    properties: {
      tabId: TAB_ID,
      format: { type: 'string', enum: ['png', 'jpeg'], description: 'Image format. Defaults to png.' },
      quality: { type: 'integer', minimum: 1, maximum: 100, description: 'JPEG quality, 1-100. Ignored for png.' },
      fullPage: { type: 'boolean', description: 'Capture the whole scrollable page instead of the viewport.' },
    },
    required: ['tabId'],
    formatResult: formatScreenshot,
  },
  {
    name: 'evaluate',
    method: 'page.evaluate',
    description: 'Run a JavaScript expression in the page and return its value.',
    properties: {
      tabId: TAB_ID,
      expression: { type: 'string', description: 'JavaScript expression evaluated in the page context.' },
      awaitPromise: { type: 'boolean', description: 'Await the result when the expression returns a promise.' },
    },
    required: ['tabId', 'expression'],
  },
  {
    name: 'click',
    method: 'input.click',
    description: 'Click at viewport coordinates in a tab; use the box centre reported by read_page.',
    properties: {
      tabId: TAB_ID,
      x: { type: 'number', description: 'Viewport x in CSS pixels.' },
      y: { type: 'number', description: 'Viewport y in CSS pixels.' },
      button: { type: 'string', enum: ['left', 'middle', 'right'], description: 'Mouse button. Defaults to left.' },
      clickCount: { type: 'integer', minimum: 1, description: 'Use 2 for a double click.' },
    },
    required: ['tabId', 'x', 'y'],
  },
  {
    name: 'type_text',
    method: 'input.type',
    description: 'Type text into the focused element of a tab; click the field first.',
    properties: {
      tabId: TAB_ID,
      text: { type: 'string', description: 'Text to type, character by character.' },
    },
    required: ['tabId', 'text'],
  },
  {
    name: 'press_key',
    method: 'input.key',
    description: 'Press a single key in a tab, optionally with modifiers.',
    properties: {
      tabId: TAB_ID,
      key: { type: 'string', description: 'Key name, e.g. "Enter", "Tab", "Escape", "ArrowDown", "a".' },
      modifiers: {
        type: 'array',
        items: { type: 'string', enum: ['Alt', 'Control', 'Meta', 'Shift'] },
        description: 'Modifiers held while the key is pressed.',
      },
    },
    required: ['tabId', 'key'],
  },
  {
    name: 'scroll',
    method: 'input.scroll',
    description: 'Scroll a tab by a wheel delta at the given viewport coordinates.',
    properties: {
      tabId: TAB_ID,
      x: { type: 'number', description: 'Viewport x in CSS pixels where the wheel event lands.' },
      y: { type: 'number', description: 'Viewport y in CSS pixels where the wheel event lands.' },
      deltaX: { type: 'number', description: 'Horizontal scroll amount in CSS pixels.' },
      deltaY: { type: 'number', description: 'Vertical scroll amount in CSS pixels; positive scrolls down.' },
    },
    required: ['tabId', 'x', 'y'],
  },
  {
    name: 'read_console',
    method: 'console.read',
    description: 'Read recent console messages from a tab, optionally filtered by regex or errors only.',
    annotations: { readOnlyHint: true },
    properties: {
      tabId: TAB_ID,
      pattern: { type: 'string', description: 'Regular expression the message text must match.' },
      limit: { type: 'integer', minimum: 1, description: 'Maximum number of messages to return.' },
      onlyErrors: { type: 'boolean', description: 'Keep only errors and warnings.' },
    },
    required: ['tabId'],
  },
  {
    name: 'read_network',
    method: 'network.read',
    description: 'Read recent network requests from a tab, optionally filtered by URL pattern.',
    annotations: { readOnlyHint: true },
    properties: {
      tabId: TAB_ID,
      urlPattern: { type: 'string', description: 'Regular expression the request URL must match.' },
      limit: { type: 'integer', minimum: 1, description: 'Maximum number of requests to return.' },
    },
    required: ['tabId'],
  },
];

const LIST_PROFILES_TOOL = {
  name: 'list_profiles',
  description:
    'List the connected, named Chrome profiles. Call this first: every other tool needs one of these names.',
  annotations: { readOnlyHint: true },
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
};

for (const tool of TOOLS) {
  tool.inputSchema = {
    type: 'object',
    properties: {
      profile: {
        type: 'string',
        description: 'Name of the target Chrome profile, exactly as returned by list_profiles.',
      },
      ...tool.properties,
    },
    required: ['profile', ...tool.required],
    additionalProperties: false,
  };
}

const TOOLS_BY_NAME = new Map(TOOLS.map((tool) => [tool.name, tool]));

const ERROR_HINTS = {
  BAD_PARAMS: 'Check the parameter names and types against this tool\'s schema.',
  TAB_NOT_FOUND: 'Call list_tabs for the current tab ids; the tab may have been closed.',
  DEBUGGER_ATTACH_FAILED: 'Chrome refused the debugger attach. Make sure the tab is a normal web page.',
  DEBUGGER_BUSY: 'Chrome allows one debugger client per tab. Close DevTools on that tab and retry.',
  RESTRICTED_URL:
    'Extensions cannot touch chrome://, chrome-extension://, devtools:// or the Chrome Web Store. This is a browser restriction with no workaround; use a normal web page.',
  TIMEOUT: 'The page did not finish in time. Retry, or call navigate with a larger timeoutMs.',
  INTERNAL:
    'The extension hit an unexpected error. Open chrome://extensions in that profile and check the service worker console.',
  PROFILE_DISCONNECTED: 'Call list_profiles to see which profiles are connected now, then retry.',
  BAD_RESPONSE: 'The bridge dropped a malformed reply. Retry; if it persists, check the native host and extension versions.',
};

// --- Tool execution ---------------------------------------------------------

function textResult(value) {
  return { content: [{ type: 'text', text: JSON.stringify(value === undefined ? null : value, null, 2) }] };
}

function errorResult(text) {
  return { content: [{ type: 'text', text }], isError: true };
}

function formatScreenshot(result, params) {
  if (!result || typeof result.dataBase64 !== 'string') {
    return errorResult(
      `screenshot returned no image data for tab ${params.tabId}. Retry, or check the extension service worker console.`,
    );
  }
  const mimeType = params.format === 'jpeg' ? 'image/jpeg' : 'image/png';
  const size = result.width && result.height ? `${result.width}x${result.height} CSS px` : 'unknown size';
  return {
    content: [
      {
        type: 'text',
        text: `Screenshot of tab ${params.tabId} (${size}). Coordinates read off this image can be passed to click.`,
      },
      { type: 'image', data: result.dataBase64, mimeType },
    ],
  };
}

function profileNotConnectedMessage(requested) {
  const names = connectedProfiles().map((profile) => `"${profile.name}"`);
  if (names.length === 0) {
    return (
      `PROFILE_NOT_CONNECTED: no Chrome profile named ${JSON.stringify(requested)} is connected, ` +
      `and in fact no profiles are connected at all.\n${NOT_CONNECTED_CHECKLIST}`
    );
  }
  return (
    `PROFILE_NOT_CONNECTED: no Chrome profile named ${JSON.stringify(requested)} is connected. ` +
    `Connected profiles: ${names.join(', ')}. Retry with one of those names, or call list_profiles for the current list.`
  );
}

function formatMethodError(tool, profileName, error) {
  const code = typeof error.code === 'string' ? error.code : 'INTERNAL';
  const message = typeof error.message === 'string' ? error.message : 'no detail supplied';
  const hint = ERROR_HINTS[code];
  return `${code}: ${tool.name} failed on profile "${profileName}" (${tool.method}): ${message}${hint ? `\n${hint}` : ''}`;
}

function checkValue(key, value, spec) {
  switch (spec.type) {
    case 'integer':
      if (!Number.isInteger(value)) return `"${key}" must be an integer`;
      break;
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) return `"${key}" must be a number`;
      break;
    case 'string':
      if (typeof value !== 'string') return `"${key}" must be a string`;
      break;
    case 'boolean':
      if (typeof value !== 'boolean') return `"${key}" must be true or false`;
      break;
    case 'array':
      if (!Array.isArray(value)) return `"${key}" must be an array`;
      for (const item of value) {
        const itemProblem = checkValue(`${key}[]`, item, spec.items || {});
        if (itemProblem) return itemProblem;
      }
      break;
    default:
      break;
  }
  if (spec.enum && !spec.enum.includes(value)) {
    return `"${key}" must be one of: ${spec.enum.join(', ')}`;
  }
  if (typeof value === 'number') {
    if (spec.minimum !== undefined && value < spec.minimum) return `"${key}" must be >= ${spec.minimum}`;
    if (spec.maximum !== undefined && value > spec.maximum) return `"${key}" must be <= ${spec.maximum}`;
  }
  return null;
}

function validateArguments(tool, args) {
  const schema = tool.inputSchema;
  for (const key of schema.required || []) {
    if (args[key] === undefined || args[key] === null) return `"${key}" is required`;
  }
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined) continue;
    const spec = schema.properties[key];
    if (!spec) {
      const known = Object.keys(schema.properties).join(', ');
      return `"${key}" is not a parameter of ${tool.name} (accepted: ${known})`;
    }
    const problem = checkValue(key, value, spec);
    if (problem) return problem;
  }
  return null;
}

function buildParams(tool, args) {
  const params = {};
  for (const key of Object.keys(tool.properties)) {
    if (args[key] !== undefined) params[key] = args[key];
  }
  return params;
}

function connectedProfiles() {
  return [...profiles.values()]
    .filter((connection) => !connection.closed)
    .map((connection) => connection.profile)
    .sort((a, b) => a.name.localeCompare(b.name));
}

function listProfilesResult() {
  const list = connectedProfiles();
  if (list.length === 0) {
    return {
      content: [
        {
          type: 'text',
          text: `No Chrome profiles are connected, so no other tool can run yet.\n${NOT_CONNECTED_CHECKLIST}`,
        },
      ],
    };
  }
  return textResult(list);
}

// navigate carries its own page-load budget; the socket must outlive it or the
// transport timeout would fire before the browser gives up.
function requestTimeoutFor(params) {
  const requested = readPositiveInt(params.timeoutMs);
  return requested ? Math.max(DEFAULT_REQUEST_TIMEOUT_MS, requested + 5_000) : DEFAULT_REQUEST_TIMEOUT_MS;
}

async function callTool(name, args) {
  if (name === LIST_PROFILES_TOOL.name) return listProfilesResult();

  const tool = TOOLS_BY_NAME.get(name);
  if (!tool) {
    const known = [LIST_PROFILES_TOOL.name, ...TOOLS_BY_NAME.keys()].join(', ');
    return errorResult(`UNKNOWN_TOOL: this server has no tool named "${name}". Available tools: ${known}.`);
  }

  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    return errorResult(`BAD_PARAMS: ${tool.name} expects a JSON object of arguments.`);
  }

  const problem = validateArguments(tool, args);
  if (problem) return errorResult(`BAD_PARAMS: ${problem}.`);

  const connection = profiles.get(args.profile);
  if (!connection || connection.closed) return errorResult(profileNotConnectedMessage(args.profile));

  const params = buildParams(tool, args);
  const outcome = await sendRequest(connection, tool.method, params, requestTimeoutFor(params));
  if (!outcome.ok) return errorResult(formatMethodError(tool, args.profile, outcome.error));
  return tool.formatResult ? tool.formatResult(outcome.result, params) : textResult(outcome.result);
}

// --- Wiring -----------------------------------------------------------------

const mcp = new Server(
  { name: SERVER_NAME, version: SERVER_VERSION },
  {
    capabilities: { tools: {} },
    instructions:
      'Drives named Chrome profiles through a local extension. Call list_profiles first to learn which profile ' +
      'names exist, then pass one of them as the "profile" argument of every other tool. Tab-scoped tools need a ' +
      'tabId from list_tabs. read_page gives click-ready coordinates for click.',
  },
);

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: LIST_PROFILES_TOOL.name,
      description: LIST_PROFILES_TOOL.description,
      inputSchema: LIST_PROFILES_TOOL.inputSchema,
      annotations: LIST_PROFILES_TOOL.annotations,
    },
    ...TOOLS.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      ...(tool.annotations ? { annotations: tool.annotations } : {}),
    })),
  ],
}));

mcp.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  try {
    return await callTool(name, args ?? {});
  } catch (err) {
    // A failing tool call must never take the server down.
    if (err instanceof BridgeError) {
      log(`tool "${name}" failed: ${err.code} — ${err.message}`);
      const hint = ERROR_HINTS[err.code];
      return errorResult(`${err.code}: ${err.message}${hint ? `\n${hint}` : ''}`);
    }
    log(`tool "${name}" failed: ${err.stack || err.message}`);
    return errorResult(
      `TOOL_FAILED: ${name} could not complete: ${err.message}\n` +
        'The server is still running. Call list_profiles to check the bridge, then retry.',
    );
  }
});

function installCleanup(socketPath, socketServer) {
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    try {
      socketServer.close();
    } catch {
      // Already closing; nothing to do.
    }
    try {
      if (existsSync(socketPath)) unlinkSync(socketPath);
    } catch (err) {
      log(`could not remove ${socketPath}: ${err.message}`);
    }
  };

  process.on('exit', cleanup);
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      log(`received ${signal}, shutting down`);
      cleanup();
      process.exit(0);
    });
  }
}

async function main() {
  const socketPath = resolveSocketPath();
  await prepareSocketPath(socketPath);
  const socketServer = await listenOnSocket(socketPath);
  installCleanup(socketPath, socketServer);

  socketServer.on('error', (err) => log(`bridge socket error: ${err.message}`));

  // The bridge is worthless without the client; leave when it detaches.
  mcp.onclose = () => {
    log('the MCP client disconnected, exiting');
    process.exit(0);
  };

  await mcp.connect(new StdioServerTransport());
  log(`ready — MCP on stdio, bridge listening on ${socketPath} (mode 0600)`);

  // The bridge outlives individual failures on purpose: a broken host or a
  // crashing tool call must not end the MCP session.
  process.on('uncaughtException', (err) => log(`uncaught exception, staying up: ${err.stack || err.message}`));
  process.on('unhandledRejection', (reason) => log(`unhandled rejection, staying up: ${reason?.stack || reason}`));
}

main().catch((err) => {
  log(`failed to start: ${err.message}`);
  process.exit(1);
});
