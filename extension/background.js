/**
 * Chrome Profile Debug - MV3 service worker.
 *
 * Bridges this Chrome profile to a local MCP server through Chrome native
 * messaging. The wire contract lives in docs/PROTOCOL.md; every envelope built
 * or parsed here must match that document exactly.
 *
 * Two rules shape the whole file:
 *   1. A profile with no name never calls connectNative. Participation is opt-in.
 *   2. Page access goes through chrome.debugger only. The manifest declares no
 *      host permissions and there is no content script.
 */

const PROTOCOL_VERSION = 1;
const HOST_NAME = 'io.github.marcondesmacaneiro.chrome_profile_debug';
const DEBUGGER_VERSION = '1.3';

const KEEPALIVE_ALARM = 'cpd-keepalive';
// Chrome clamps alarm periods to 30 s for packed extensions; asking for 20 s
// gives us the tightest revival interval the browser is willing to grant.
const KEEPALIVE_PERIOD_MINUTES = 20 / 60;

const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 30000;

const MAX_RESULT_BYTES = 512 * 1024;
const CHUNK_CHARS = 512 * 1024;

const CDP_TIMEOUT_MS = 30000;
const SLOW_CDP_TIMEOUT_MS = 60000;
const BOX_TIMEOUT_MS = 5000;
const NAVIGATE_TIMEOUT_MS = 30000;

const CONSOLE_BUFFER_LIMIT = 500;
const NETWORK_BUFFER_LIMIT = 500;
const DOCUMENT_STATUS_LIMIT = 32;

const DEFAULT_MAX_NODES = 2000;
const DEFAULT_MAX_CHARS = 100000;
const DEFAULT_LOG_LIMIT = 100;
const BOX_CONCURRENCY = 16;
const MAX_SCREENSHOT_EDGE = 16384;

/** Roles page.readTree keeps when interactiveOnly is set. */
const INTERACTIVE_ROLES = new Set([
  'button',
  'link',
  'textbox',
  'checkbox',
  'radio',
  'combobox',
  'menuitem',
  'tab',
  'switch',
  'slider',
  'searchbox'
]);

const RESTRICTED_SCHEMES = ['chrome://', 'chrome-extension://', 'devtools://'];
const RESTRICTED_HOSTS = new Set(['chromewebstore.google.com']);

/* ------------------------------------------------------------------ errors */

/** An error carrying one of the protocol's documented error codes. */
class ProtocolError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ProtocolError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new ProtocolError(code, message);
}

function errorCodeOf(error) {
  return error instanceof ProtocolError ? error.code : 'INTERNAL';
}

function messageOf(error) {
  if (!error) return 'Unknown error';
  return error.message ?? String(error);
}

/* ---------------------------------------------------------------- identity */

/**
 * Reads the profile identity, generating the stable id on first run.
 * The id is created once and never changed for the life of the install.
 */
async function readIdentity() {
  const stored = await chrome.storage.local.get(['profileName', 'profileId']);
  let profileId = stored.profileId;
  if (typeof profileId !== 'string' || profileId === '') {
    profileId = crypto.randomUUID();
    await chrome.storage.local.set({ profileId });
  }
  const rawName = stored.profileName;
  const profileName = typeof rawName === 'string' ? rawName.trim() : '';
  return { profileId, profileName };
}

function chromeVersion() {
  const match = /Chrome\/([\d.]+)/.exec(navigator.userAgent);
  return match ? match[1] : 'unknown';
}

function extensionVersion() {
  return chrome.runtime.getManifest().version;
}

function describeProfile(identity) {
  return {
    id: identity.profileId,
    name: identity.profileName,
    chromeVersion: chromeVersion(),
    extensionVersion: extensionVersion()
  };
}

async function profileInfo() {
  return describeProfile(await readIdentity());
}

/* -------------------------------------------------------------- connection */

let port = null;
let connectingPromise = null;
let reconnectTimer = null;
let reconnectDelayMs = RECONNECT_MIN_MS;

/** Opens the native port unless the profile is unnamed or already connected. */
async function ensureConnected() {
  if (port) return;
  if (connectingPromise) return connectingPromise;
  connectingPromise = openPort().finally(() => {
    connectingPromise = null;
  });
  return connectingPromise;
}

async function openPort() {
  const identity = await readIdentity();
  // An unnamed profile is never exposed, so it never opens the port.
  if (!identity.profileName) return;
  if (port) return;

  let opened;
  try {
    opened = chrome.runtime.connectNative(HOST_NAME);
  } catch (error) {
    // The host manifest may not be installed yet; keep trying in the background.
    console.debug('[cpd] connectNative failed:', messageOf(error));
    scheduleReconnect();
    return;
  }

  port = opened;
  opened.onMessage.addListener(onHostMessage);
  opened.onDisconnect.addListener(() => onPortDisconnected(opened));

  // hello is always the first message on a connection.
  sendToHost({
    type: 'hello',
    protocolVersion: PROTOCOL_VERSION,
    profile: describeProfile(identity)
  });
}

function onPortDisconnected(disconnected) {
  const lastError = chrome.runtime.lastError;
  if (lastError) {
    console.debug('[cpd] native port closed:', lastError.message);
  }
  // Ignore stale ports we already replaced or closed on purpose.
  if (port !== disconnected) return;
  port = null;
  scheduleReconnect();
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  const delay = reconnectDelayMs;
  reconnectDelayMs = Math.min(reconnectDelayMs * 2, RECONNECT_MAX_MS);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    ensureConnected().catch((error) => console.debug('[cpd] reconnect failed:', messageOf(error)));
  }, delay);
}

function disconnect() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  const open = port;
  port = null;
  if (!open) return;
  try {
    open.disconnect();
  } catch (error) {
    console.debug('[cpd] disconnect failed:', messageOf(error));
  }
}

function sendToHost(message) {
  if (!port) {
    console.debug('[cpd] dropped message, no native port:', message.type);
    return;
  }
  try {
    port.postMessage(message);
  } catch (error) {
    console.warn('[cpd] postMessage failed:', messageOf(error));
  }
}

function onHostMessage(message) {
  // Any traffic proves the pipe works, so the backoff starts over.
  reconnectDelayMs = RECONNECT_MIN_MS;
  if (!message || typeof message !== 'object') return;

  switch (message.type) {
    case 'ping':
      sendToHost({ type: 'pong', ts: Date.now() });
      return;
    case 'pong':
      return;
    case 'error':
      console.warn('[cpd] server rejected this profile:', message.code ?? 'unknown');
      return;
    case 'request':
      handleRequest(message);
      return;
    default:
      console.debug('[cpd] ignoring message of type', message.type);
  }
}

/* ------------------------------------------------------------ response I/O */

function sendResult(id, result) {
  const value = result === undefined ? null : result;
  const json = JSON.stringify(value);
  const bytes = new TextEncoder().encode(json);

  if (bytes.length <= MAX_RESULT_BYTES) {
    sendToHost({ id, type: 'response', ok: true, result: value });
    return;
  }

  const encoded = bytesToBase64(bytes);
  const total = Math.ceil(encoded.length / CHUNK_CHARS);
  for (let index = 0; index < total; index += 1) {
    sendToHost({
      id,
      type: 'response',
      ok: true,
      chunk: { index, total },
      resultChunk: encoded.slice(index * CHUNK_CHARS, (index + 1) * CHUNK_CHARS)
    });
  }
}

function sendError(id, code, message) {
  sendToHost({ id, type: 'response', ok: false, error: { code, message } });
}

function bytesToBase64(bytes) {
  const STEP = 0x8000;
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += STEP) {
    binary += String.fromCharCode.apply(null, bytes.subarray(offset, offset + STEP));
  }
  return btoa(binary);
}

async function handleRequest(message) {
  const { id, method, params } = message;
  if (typeof id !== 'string' && typeof id !== 'number') {
    console.warn('[cpd] request without an id, dropped');
    return;
  }

  const handler = METHODS[method];
  if (!handler) {
    sendError(id, 'BAD_PARAMS', `Unknown method: ${method}`);
    return;
  }

  try {
    const result = await handler(params && typeof params === 'object' ? params : {});
    sendResult(id, result);
  } catch (error) {
    sendError(id, errorCodeOf(error), messageOf(error));
  }
}

/* ------------------------------------------------------ parameter checking */

function requireTabId(params) {
  const tabId = params.tabId;
  if (!Number.isInteger(tabId)) fail('BAD_PARAMS', 'tabId must be an integer');
  return tabId;
}

function requireString(params, key, allowEmpty = false) {
  const value = params[key];
  if (typeof value !== 'string' || (!allowEmpty && value === '')) {
    fail('BAD_PARAMS', `${key} must be a${allowEmpty ? '' : ' non-empty'} string`);
  }
  return value;
}

function requireNumber(params, key) {
  const value = params[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    fail('BAD_PARAMS', `${key} must be a finite number`);
  }
  return value;
}

function optionalNumber(params, key, fallback) {
  const value = params[key];
  if (value == null) return fallback;
  return requireNumber(params, key);
}

function positiveInt(params, key, fallback) {
  const value = params[key];
  if (value == null) return fallback;
  if (!Number.isInteger(value) || value <= 0) {
    fail('BAD_PARAMS', `${key} must be a positive integer`);
  }
  return value;
}

function compilePattern(pattern, key) {
  if (pattern == null) return null;
  if (typeof pattern !== 'string') fail('BAD_PARAMS', `${key} must be a string`);
  try {
    return new RegExp(pattern);
  } catch (error) {
    fail('BAD_PARAMS', `${key} is not a valid regular expression: ${messageOf(error)}`);
  }
}

/** True for pages Chrome forbids extensions from driving. */
function isRestrictedUrl(url) {
  if (typeof url !== 'string' || url === '') return false;
  const lower = url.toLowerCase();
  if (RESTRICTED_SCHEMES.some((scheme) => lower.startsWith(scheme))) return true;

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const host = parsed.hostname.toLowerCase();
  const isLegacyStore = host === 'chrome.google.com' && parsed.pathname.startsWith('/webstore');
  return RESTRICTED_HOSTS.has(host) || isLegacyStore;
}

/** Throws RESTRICTED_URL for pages extensions are not allowed to drive. */
function assertAllowedUrl(url) {
  if (isRestrictedUrl(url)) {
    fail('RESTRICTED_URL', `Extensions may not touch ${url}`);
  }
}

async function getTab(tabId) {
  try {
    return await chrome.tabs.get(tabId);
  } catch {
    return fail('TAB_NOT_FOUND', `No tab with id ${tabId}`);
  }
}

/* ------------------------------------------------------- debugger sessions */

/** tabId -> session state. Rebuilt lazily after the worker is killed. */
const sessions = new Map();

function sessionFor(tabId) {
  let state = sessions.get(tabId);
  if (!state) {
    state = {
      tabId,
      attached: false,
      accessibilityEnabled: false,
      mainFrameId: null,
      consoleEntries: [],
      networkEntries: [],
      networkByRequestId: new Map(),
      documentStatus: new Map(),
      eventWaiters: new Set()
    };
    sessions.set(tabId, state);
  }
  return state;
}

/**
 * Attaches the debugger to a tab on first use and keeps it attached.
 * The session survives until the tab closes or another client takes over.
 */
async function ensureAttached(tabId) {
  const tab = await getTab(tabId);
  assertAllowedUrl(tab.url);

  const state = sessionFor(tabId);
  if (state.attached) return state;

  await attachDebugger(tabId);
  state.attached = true;
  await enableDomains(tabId);
  return state;
}

async function attachDebugger(tabId) {
  try {
    await chrome.debugger.attach({ tabId }, DEBUGGER_VERSION);
    return;
  } catch (error) {
    const message = messageOf(error);
    if (!/already attached/i.test(message)) {
      fail('DEBUGGER_ATTACH_FAILED', message);
    }
    // Something holds the tab. If it is our own session from a previous worker
    // lifetime a plain command still works; if it is DevTools, it does not.
    try {
      await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', { expression: '1' });
    } catch {
      fail('DEBUGGER_BUSY', `Another debugger client is attached to tab ${tabId}`);
    }
  }
}

async function enableDomains(tabId) {
  try {
    await chrome.debugger.sendCommand({ tabId }, 'Page.enable', {});
    await chrome.debugger.sendCommand({ tabId }, 'Runtime.enable', {});
    await chrome.debugger.sendCommand({ tabId }, 'Log.enable', {});
    await chrome.debugger.sendCommand({ tabId }, 'DOM.enable', {});
    // We never read response bodies, so keep Chrome's buffers small.
    await chrome.debugger.sendCommand({ tabId }, 'Network.enable', {
      maxTotalBufferSize: 1000000,
      maxResourceBufferSize: 500000
    });
  } catch (error) {
    sessions.delete(tabId);
    fail('DEBUGGER_ATTACH_FAILED', `Could not enable debugger domains: ${messageOf(error)}`);
  }
}

async function releaseTab(tabId) {
  const state = sessions.get(tabId);
  sessions.delete(tabId);
  if (!state || !state.attached) return;
  try {
    await chrome.debugger.detach({ tabId });
  } catch (error) {
    console.debug('[cpd] detach failed:', messageOf(error));
  }
}

/** Sends one CDP command, mapping failures onto protocol error codes. */
async function cdp(tabId, method, params = {}, timeoutMs = CDP_TIMEOUT_MS) {
  let timer = null;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new ProtocolError('TIMEOUT', `${method} timed out after ${timeoutMs} ms`)),
      timeoutMs
    );
  });

  try {
    return await Promise.race([chrome.debugger.sendCommand({ tabId }, method, params), timeout]);
  } catch (error) {
    if (error instanceof ProtocolError) throw error;
    const message = messageOf(error);
    if (/not attached/i.test(message)) {
      const state = sessions.get(tabId);
      if (state) state.attached = false;
      fail('DEBUGGER_ATTACH_FAILED', `Debugger detached from tab ${tabId}`);
    }
    return fail('INTERNAL', `${method} failed: ${message}`);
  } finally {
    clearTimeout(timer);
  }
}

/** Resolves when a debugger event matching the predicate arrives. */
function waitForDebuggerEvent(state, predicate, timeoutMs) {
  return new Promise((resolve, reject) => {
    let timer = null;
    const waiter = (method, params) => {
      if (!predicate(method, params)) return;
      clearTimeout(timer);
      state.eventWaiters.delete(waiter);
      resolve({ method, params });
    };
    timer = setTimeout(() => {
      state.eventWaiters.delete(waiter);
      reject(new ProtocolError('TIMEOUT', 'Timed out waiting for the page to load'));
    }, timeoutMs);
    state.eventWaiters.add(waiter);
  });
}

/* ---------------------------------------------------------- event capture */

chrome.debugger.onEvent.addListener((source, method, params) => {
  const tabId = source.tabId;
  if (tabId == null) return;
  const state = sessions.get(tabId);
  if (!state) return;

  captureEvent(state, method, params ?? {});
  for (const waiter of [...state.eventWaiters]) {
    waiter(method, params ?? {});
  }
});

chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId == null) return;
  sessions.delete(source.tabId);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  releaseTab(tabId).catch(() => {});
});

function captureEvent(state, method, params) {
  switch (method) {
    case 'Runtime.consoleAPICalled':
      pushConsole(state, consoleEntryFromApiCall(params));
      return;
    case 'Runtime.exceptionThrown':
      pushConsole(state, consoleEntryFromException(params));
      return;
    case 'Log.entryAdded':
      pushConsole(state, consoleEntryFromLog(params.entry ?? {}));
      return;
    case 'Network.requestWillBeSent':
      pushNetwork(state, params);
      return;
    case 'Network.responseReceived':
      updateNetwork(state, params);
      return;
    case 'Network.loadingFailed':
      markNetworkFailed(state, params);
      return;
    default:
  }
}

const CONSOLE_LEVELS = {
  error: 'error',
  assert: 'error',
  warning: 'warning',
  warn: 'warning',
  info: 'info',
  verbose: 'debug',
  debug: 'debug',
  trace: 'debug'
};

function normalizeLevel(type) {
  return CONSOLE_LEVELS[type] ?? 'log';
}

function pushConsole(state, entry) {
  state.consoleEntries.push(entry);
  if (state.consoleEntries.length > CONSOLE_BUFFER_LIMIT) {
    state.consoleEntries.splice(0, state.consoleEntries.length - CONSOLE_BUFFER_LIMIT);
  }
}

function consoleEntryFromApiCall(params) {
  const frame = params.stackTrace?.callFrames?.[0];
  return {
    level: normalizeLevel(params.type),
    text: (params.args ?? []).map(describeRemoteObject).join(' '),
    ts: Math.round(params.timestamp ?? Date.now()),
    url: frame?.url ?? null,
    // CDP line numbers are 0-based; report the 1-based line a human would read.
    line: frame ? frame.lineNumber + 1 : null
  };
}

function consoleEntryFromException(params) {
  const details = params.exceptionDetails ?? {};
  return {
    level: 'error',
    text: describeException(details),
    ts: Math.round(params.timestamp ?? Date.now()),
    url: details.url ?? details.stackTrace?.callFrames?.[0]?.url ?? null,
    line: typeof details.lineNumber === 'number' ? details.lineNumber + 1 : null
  };
}

function consoleEntryFromLog(entry) {
  return {
    level: normalizeLevel(entry.level),
    text: entry.text ?? '',
    ts: Math.round(entry.timestamp ?? Date.now()),
    url: entry.url ?? null,
    line: typeof entry.lineNumber === 'number' ? entry.lineNumber + 1 : null
  };
}

function describeRemoteObject(arg) {
  if (arg == null || typeof arg !== 'object') return String(arg);
  if (arg.type === 'string') return arg.value ?? '';
  if (arg.unserializableValue) return arg.unserializableValue;
  if ('value' in arg) {
    try {
      return typeof arg.value === 'object' ? JSON.stringify(arg.value) : String(arg.value);
    } catch {
      return String(arg.value);
    }
  }
  if (arg.preview) return describePreview(arg.preview);
  return arg.description ?? arg.type ?? '';
}

function describePreview(preview) {
  const properties = (preview.properties ?? [])
    .map((property) => `${property.name}: ${property.value}`)
    .join(', ');
  const label = preview.description ?? '';
  return properties ? `${label} {${properties}}`.trim() : label;
}

function describeException(details) {
  return (
    details.exception?.description ??
    details.exception?.value ??
    details.text ??
    'Uncaught exception'
  );
}

function pushNetwork(state, params) {
  const wallTime = typeof params.wallTime === 'number' ? params.wallTime * 1000 : Date.now();
  const entry = {
    requestId: params.requestId,
    method: params.request?.method ?? '',
    url: params.request?.url ?? '',
    status: null,
    ts: Math.round(wallTime),
    type: params.type ?? null
  };

  state.networkEntries.push(entry);
  if (params.requestId) state.networkByRequestId.set(params.requestId, entry);
  while (state.networkEntries.length > NETWORK_BUFFER_LIMIT) {
    const evicted = state.networkEntries.shift();
    if (evicted.requestId) state.networkByRequestId.delete(evicted.requestId);
  }
}

function updateNetwork(state, params) {
  const entry = state.networkByRequestId.get(params.requestId);
  if (entry) {
    entry.status = params.response?.status ?? null;
    if (params.type) entry.type = params.type;
  }
  if (params.type === 'Document' && params.loaderId) {
    rememberDocumentStatus(state, params.loaderId, params.response?.status ?? null);
  }
}

function markNetworkFailed(state, params) {
  const entry = state.networkByRequestId.get(params.requestId);
  if (entry) entry.status = null;
}

function rememberDocumentStatus(state, loaderId, status) {
  state.documentStatus.set(loaderId, status);
  while (state.documentStatus.size > DOCUMENT_STATUS_LIMIT) {
    const oldest = state.documentStatus.keys().next().value;
    state.documentStatus.delete(oldest);
  }
}

/* ------------------------------------------------------------ tab methods */

async function tabsList() {
  const found = await chrome.tabs.query({});
  return found.map((tab) => ({
    tabId: tab.id,
    windowId: tab.windowId,
    title: tab.title ?? '',
    url: tab.url ?? '',
    active: Boolean(tab.active)
  }));
}

async function tabsCreate(params) {
  const url = params.url == null ? null : requireString(params, 'url');
  if (url) assertAllowedUrl(url);

  const created = await chrome.tabs.create({});
  if (!url) return { tabId: created.id };

  // Create blank, then navigate. chrome.tabs.create resolves as soon as the tab
  // object exists, long before its document does: returning here would make the
  // very next page.text or page.readTree describe an empty page and report it as
  // success. An empty result is worse than an error, because the caller believes
  // it. pageNavigate waits for the load to settle and already handles a new tab
  // starting on a restricted URL, so delegate rather than duplicate that.
  const navigateParams = { tabId: created.id, url };
  if (params.timeoutMs != null) navigateParams.timeoutMs = params.timeoutMs;
  await pageNavigate(navigateParams);

  return { tabId: created.id };
}

async function tabsClose(params) {
  const tabId = requireTabId(params);
  await getTab(tabId);
  await releaseTab(tabId);
  await chrome.tabs.remove(tabId);
  return { closed: true };
}

async function tabsActivate(params) {
  const tabId = requireTabId(params);
  const tab = await getTab(tabId);
  await chrome.tabs.update(tabId, { active: true });
  try {
    await chrome.windows.update(tab.windowId, { focused: true });
  } catch (error) {
    console.debug('[cpd] could not focus window:', messageOf(error));
  }
  return { ok: true };
}

/* ----------------------------------------------------------- page methods */

async function pageNavigate(params) {
  const tabId = requireTabId(params);
  const url = requireString(params, 'url');
  assertAllowedUrl(url);
  const timeoutMs = positiveInt(params, 'timeoutMs', NAVIGATE_TIMEOUT_MS);

  const current = await getTab(tabId);
  if (isRestrictedUrl(current.url)) {
    // The debugger cannot attach to a restricted page - a new tab sits on one -
    // so the first hop off it goes through the tabs API instead. No debugger
    // session means no document response, hence no status on that hop.
    await navigateWithTabsApi(tabId, url, timeoutMs);
    const moved = await getTab(tabId);
    return { url: moved.url ?? url, status: null };
  }

  const state = await ensureAttached(tabId);
  const settled = waitForDebuggerEvent(state, isNavigationSettled(state), timeoutMs);
  // Mark the promise handled so a timeout raised before we await it stays quiet.
  settled.catch(() => {});

  const navigation = await cdp(tabId, 'Page.navigate', { url }, timeoutMs);
  if (navigation.errorText) {
    fail('INTERNAL', `Navigation failed: ${navigation.errorText}`);
  }
  if (navigation.frameId) state.mainFrameId = navigation.frameId;

  await settled;

  const tab = await getTab(tabId);
  const status = navigation.loaderId ? state.documentStatus.get(navigation.loaderId) ?? null : null;
  return { url: tab.url ?? url, status };
}

/** Navigates with chrome.tabs and resolves when the tab finishes loading. */
function navigateWithTabsApi(tabId, url, timeoutMs) {
  return new Promise((resolve, reject) => {
    let timer = null;
    const onUpdated = (updatedTabId, changeInfo) => {
      if (updatedTabId !== tabId || changeInfo.status !== 'complete') return;
      cleanup();
      resolve();
    };
    const cleanup = () => {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
    };

    timer = setTimeout(() => {
      cleanup();
      reject(new ProtocolError('TIMEOUT', `Navigation did not finish in ${timeoutMs} ms`));
    }, timeoutMs);
    chrome.tabs.onUpdated.addListener(onUpdated);

    chrome.tabs.update(tabId, { url }).catch((error) => {
      cleanup();
      reject(new ProtocolError('INTERNAL', `Navigation failed: ${messageOf(error)}`));
    });
  });
}

function isNavigationSettled(state) {
  return (method, params) => {
    if (method === 'Page.loadEventFired') return true;
    if (method === 'Page.navigatedWithinDocument') return true;
    return method === 'Page.frameStoppedLoading' && params.frameId === state.mainFrameId;
  };
}

async function pageReadTree(params) {
  const tabId = requireTabId(params);
  const maxNodes = positiveInt(params, 'maxNodes', DEFAULT_MAX_NODES);
  const interactiveOnly = Boolean(params.interactiveOnly);

  const state = await ensureAttached(tabId);
  if (!state.accessibilityEnabled) {
    await cdp(tabId, 'Accessibility.enable', {});
    state.accessibilityEnabled = true;
  }

  const tree = await cdp(tabId, 'Accessibility.getFullAXTree', {}, SLOW_CDP_TIMEOUT_MS);
  const nodes = selectAccessibilityNodes(tree.nodes ?? [], interactiveOnly, maxNodes);
  const viewport = await readViewport(tabId);
  await resolveBoxes(tabId, nodes, viewport);
  return nodes;
}

function selectAccessibilityNodes(rawNodes, interactiveOnly, maxNodes) {
  const selected = [];
  for (const node of rawNodes) {
    if (selected.length >= maxNodes) break;
    if (node.ignored) continue;

    const role = node.role?.value ?? '';
    if (interactiveOnly && !INTERACTIVE_ROLES.has(String(role).toLowerCase())) continue;

    const name = node.name?.value ?? '';
    if (!interactiveOnly && role === '' && name === '') continue;

    selected.push({
      ref: `ref_${selected.length + 1}`,
      role,
      name,
      value: node.value?.value ?? null,
      backendDOMNodeId: node.backendDOMNodeId ?? null,
      box: null
    });
  }
  return selected;
}

async function readViewport(tabId) {
  const metrics = await cdp(tabId, 'Page.getLayoutMetrics', {});
  const layout = metrics.cssLayoutViewport ?? metrics.layoutViewport ?? {};
  return {
    width: layout.clientWidth ?? 0,
    height: layout.clientHeight ?? 0
  };
}

async function resolveBoxes(tabId, nodes, viewport) {
  const targets = nodes.filter((node) => node.backendDOMNodeId != null);
  for (let offset = 0; offset < targets.length; offset += BOX_CONCURRENCY) {
    const batch = targets.slice(offset, offset + BOX_CONCURRENCY);
    await Promise.all(
      batch.map(async (node) => {
        node.box = await boxForNode(tabId, node.backendDOMNodeId, viewport);
      })
    );
  }
}

/**
 * Returns the element box in viewport CSS pixels with x/y at the centre of the
 * part that is actually on screen, so the point can be clicked as-is.
 * Off-screen elements report null, as the protocol requires.
 */
async function boxForNode(tabId, backendNodeId, viewport) {
  let model;
  try {
    const response = await cdp(tabId, 'DOM.getBoxModel', { backendNodeId }, BOX_TIMEOUT_MS);
    model = response?.model;
  } catch {
    return null;
  }

  const quad = model?.border ?? model?.content;
  if (!Array.isArray(quad) || quad.length < 8) return null;

  const xs = [quad[0], quad[2], quad[4], quad[6]];
  const ys = [quad[1], quad[3], quad[5], quad[7]];
  const left = Math.min(...xs);
  const right = Math.max(...xs);
  const top = Math.min(...ys);
  const bottom = Math.max(...ys);
  if (right <= left || bottom <= top) return null;

  const visibleLeft = Math.max(left, 0);
  const visibleRight = Math.min(right, viewport.width || right);
  const visibleTop = Math.max(top, 0);
  const visibleBottom = Math.min(bottom, viewport.height || bottom);
  if (visibleRight <= visibleLeft || visibleBottom <= visibleTop) return null;

  return {
    x: Math.round((visibleLeft + visibleRight) / 2),
    y: Math.round((visibleTop + visibleBottom) / 2),
    width: Math.round(right - left),
    height: Math.round(bottom - top)
  };
}

async function pageScreenshot(params) {
  const tabId = requireTabId(params);
  const format = params.format == null ? 'png' : requireString(params, 'format');
  if (!['png', 'jpeg', 'webp'].includes(format)) {
    fail('BAD_PARAMS', 'format must be png, jpeg or webp');
  }
  const quality = params.quality == null ? null : positiveInt(params, 'quality', 100);
  if (quality != null && quality > 100) fail('BAD_PARAMS', 'quality must be between 1 and 100');
  const fullPage = Boolean(params.fullPage);

  await ensureAttached(tabId);
  const metrics = await cdp(tabId, 'Page.getLayoutMetrics', {});
  const request = { format, captureBeyondViewport: fullPage };
  if (format !== 'png' && quality != null) request.quality = quality;

  let width;
  let height;
  if (fullPage) {
    const content = metrics.cssContentSize ?? metrics.contentSize ?? {};
    width = Math.min(Math.ceil(content.width ?? 0), MAX_SCREENSHOT_EDGE);
    height = Math.min(Math.ceil(content.height ?? 0), MAX_SCREENSHOT_EDGE);
    if (width > 0 && height > 0) {
      request.clip = { x: 0, y: 0, width, height, scale: 1 };
    }
  } else {
    const layout = metrics.cssLayoutViewport ?? metrics.layoutViewport ?? {};
    width = Math.ceil(layout.clientWidth ?? 0);
    height = Math.ceil(layout.clientHeight ?? 0);
  }

  const shot = await cdp(tabId, 'Page.captureScreenshot', request, SLOW_CDP_TIMEOUT_MS);
  return { dataBase64: shot.data ?? '', width, height };
}

async function pageEvaluate(params) {
  const tabId = requireTabId(params);
  const expression = requireString(params, 'expression');
  const awaitPromise = Boolean(params.awaitPromise);

  await ensureAttached(tabId);
  return { value: await evaluate(tabId, expression, awaitPromise) };
}

async function evaluate(tabId, expression, awaitPromise = false) {
  const request = { expression, awaitPromise, userGesture: true, returnByValue: true };
  let response;
  try {
    response = await cdp(tabId, 'Runtime.evaluate', request);
  } catch (error) {
    if (error instanceof ProtocolError && error.code !== 'INTERNAL') throw error;
    // Values that cannot be serialised come back as a description instead.
    response = await cdp(tabId, 'Runtime.evaluate', { ...request, returnByValue: false });
  }

  if (response.exceptionDetails) {
    fail('INTERNAL', describeException(response.exceptionDetails));
  }
  const result = response.result ?? {};
  if ('value' in result) return result.value;
  return result.description ?? null;
}

async function pageText(params) {
  const tabId = requireTabId(params);
  const maxChars = positiveInt(params, 'maxChars', DEFAULT_MAX_CHARS);

  await ensureAttached(tabId);
  // Truncating inside the page avoids moving megabytes we would throw away.
  const expression = `(() => {
    const text = document.body ? document.body.innerText : '';
    return { text: text.slice(0, ${maxChars}), truncated: text.length > ${maxChars} };
  })()`;
  const value = await evaluate(tabId, expression);
  return {
    text: value?.text ?? '',
    truncated: Boolean(value?.truncated)
  };
}

/* ---------------------------------------------------------- input methods */

const BUTTON_MASKS = { left: 1, right: 2, middle: 4 };

const MODIFIER_BITS = {
  alt: 1,
  ctrl: 2,
  control: 2,
  meta: 4,
  command: 4,
  cmd: 4,
  shift: 8
};

const KEY_DEFINITIONS = {
  Enter: { code: 'Enter', keyCode: 13, text: '\r' },
  Tab: { code: 'Tab', keyCode: 9, text: '\t' },
  Escape: { code: 'Escape', keyCode: 27 },
  Backspace: { code: 'Backspace', keyCode: 8 },
  Delete: { code: 'Delete', keyCode: 46 },
  ArrowUp: { code: 'ArrowUp', keyCode: 38 },
  ArrowDown: { code: 'ArrowDown', keyCode: 40 },
  ArrowLeft: { code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { code: 'ArrowRight', keyCode: 39 },
  Home: { code: 'Home', keyCode: 36 },
  End: { code: 'End', keyCode: 35 },
  PageUp: { code: 'PageUp', keyCode: 33 },
  PageDown: { code: 'PageDown', keyCode: 34 },
  Space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
  ' ': { code: 'Space', keyCode: 32, text: ' ' }
};

function normalizeModifiers(value) {
  if (value == null) return 0;
  if (Number.isInteger(value) && value >= 0) return value;
  if (!Array.isArray(value)) {
    return fail('BAD_PARAMS', 'modifiers must be an array of names or a bitmask integer');
  }
  return value.reduce((mask, name) => {
    const bit = MODIFIER_BITS[String(name).toLowerCase()];
    if (!bit) fail('BAD_PARAMS', `Unknown modifier: ${name}`);
    return mask | bit;
  }, 0);
}

function keyDefinition(key) {
  const known = KEY_DEFINITIONS[key];
  if (known) {
    return { key: known.key ?? key, code: known.code, keyCode: known.keyCode, text: known.text };
  }
  if ([...key].length === 1) {
    const upper = key.toUpperCase();
    let code = '';
    if (/[a-z]/i.test(key)) code = `Key${upper}`;
    else if (/[0-9]/.test(key)) code = `Digit${key}`;
    return { key, code, keyCode: upper.charCodeAt(0), text: key };
  }
  return fail('BAD_PARAMS', `Unsupported key: ${key}`);
}

async function dispatchKey(tabId, key, modifiers) {
  const definition = keyDefinition(key);
  const common = {
    key: definition.key,
    code: definition.code,
    windowsVirtualKeyCode: definition.keyCode,
    nativeVirtualKeyCode: definition.keyCode,
    modifiers
  };
  // Only a bare key (or Shift plus key) produces text; Ctrl+A must not type "a".
  const producesText = Boolean(definition.text) && (modifiers & ~MODIFIER_BITS.shift) === 0;
  const down = producesText
    ? { ...common, type: 'keyDown', text: definition.text }
    : { ...common, type: 'rawKeyDown' };

  await cdp(tabId, 'Input.dispatchKeyEvent', down);
  await cdp(tabId, 'Input.dispatchKeyEvent', { ...common, type: 'keyUp' });
}

async function inputClick(params) {
  const tabId = requireTabId(params);
  const x = requireNumber(params, 'x');
  const y = requireNumber(params, 'y');
  const button = params.button == null ? 'left' : requireString(params, 'button');
  if (!(button in BUTTON_MASKS)) fail('BAD_PARAMS', 'button must be left, right or middle');
  const clickCount = positiveInt(params, 'clickCount', 1);

  await ensureAttached(tabId);
  const base = { x, y, button, modifiers: 0, pointerType: 'mouse' };
  await cdp(tabId, 'Input.dispatchMouseEvent', {
    ...base,
    type: 'mouseMoved',
    button: 'none',
    buttons: 0,
    clickCount: 0
  });
  await cdp(tabId, 'Input.dispatchMouseEvent', {
    ...base,
    type: 'mousePressed',
    buttons: BUTTON_MASKS[button],
    clickCount
  });
  await cdp(tabId, 'Input.dispatchMouseEvent', {
    ...base,
    type: 'mouseReleased',
    buttons: 0,
    clickCount
  });
  return { ok: true };
}

async function inputType(params) {
  const tabId = requireTabId(params);
  const text = requireString(params, 'text', true);

  await ensureAttached(tabId);
  // Bulk text goes in with insertText; newline and tab need real key events so
  // that forms submit and focus moves the way a user would expect.
  for (const segment of text.split(/(\n|\t)/)) {
    if (segment === '') continue;
    if (segment === '\n') await dispatchKey(tabId, 'Enter', 0);
    else if (segment === '\t') await dispatchKey(tabId, 'Tab', 0);
    else await cdp(tabId, 'Input.insertText', { text: segment });
  }
  return { ok: true };
}

async function inputKey(params) {
  const tabId = requireTabId(params);
  const key = requireString(params, 'key');
  const modifiers = normalizeModifiers(params.modifiers);

  await ensureAttached(tabId);
  await dispatchKey(tabId, key, modifiers);
  return { ok: true };
}

async function inputScroll(params) {
  const tabId = requireTabId(params);
  const x = requireNumber(params, 'x');
  const y = requireNumber(params, 'y');
  const deltaX = optionalNumber(params, 'deltaX', 0);
  const deltaY = optionalNumber(params, 'deltaY', 0);

  await ensureAttached(tabId);
  await cdp(tabId, 'Input.dispatchMouseEvent', {
    type: 'mouseWheel',
    x,
    y,
    deltaX,
    deltaY,
    modifiers: 0,
    pointerType: 'mouse'
  });
  return { ok: true };
}

/* -------------------------------------------------------- buffer readers */

async function consoleRead(params) {
  const tabId = requireTabId(params);
  const limit = positiveInt(params, 'limit', DEFAULT_LOG_LIMIT);
  const pattern = compilePattern(params.pattern, 'pattern');
  const onlyErrors = Boolean(params.onlyErrors);

  const state = await ensureAttached(tabId);
  let entries = state.consoleEntries;
  if (onlyErrors) entries = entries.filter((entry) => entry.level === 'error');
  if (pattern) entries = entries.filter((entry) => pattern.test(entry.text));

  return entries.slice(-limit).map((entry) => ({
    level: entry.level,
    text: entry.text,
    ts: entry.ts,
    url: entry.url,
    line: entry.line
  }));
}

async function networkRead(params) {
  const tabId = requireTabId(params);
  const limit = positiveInt(params, 'limit', DEFAULT_LOG_LIMIT);
  const pattern = compilePattern(params.urlPattern, 'urlPattern');

  const state = await ensureAttached(tabId);
  let entries = state.networkEntries;
  if (pattern) entries = entries.filter((entry) => pattern.test(entry.url));

  return entries.slice(-limit).map((entry) => ({
    method: entry.method,
    url: entry.url,
    status: entry.status,
    ts: entry.ts,
    type: entry.type
  }));
}

/* ------------------------------------------------------------- dispatch */

const METHODS = {
  'profile.info': () => profileInfo(),
  'tabs.list': () => tabsList(),
  'tabs.create': tabsCreate,
  'tabs.close': tabsClose,
  'tabs.activate': tabsActivate,
  'page.navigate': pageNavigate,
  'page.readTree': pageReadTree,
  'page.screenshot': pageScreenshot,
  'page.evaluate': pageEvaluate,
  'page.text': pageText,
  'input.click': inputClick,
  'input.type': inputType,
  'input.key': inputKey,
  'input.scroll': inputScroll,
  'console.read': consoleRead,
  'network.read': networkRead
};

/* ------------------------------------------------------------ popup API */

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'cpd.getStatus') {
    connectionStatus().then(sendResponse);
    return true;
  }
  if (message?.type === 'cpd.setName') {
    setProfileName(message.name).then(sendResponse);
    return true;
  }
  return false;
});

async function connectionStatus() {
  const { profileName } = await readIdentity();
  if (!profileName) return { state: 'unnamed', name: '' };
  return { state: port ? 'connected' : 'connecting', name: profileName };
}

async function setProfileName(rawName) {
  const name = typeof rawName === 'string' ? rawName.trim() : '';
  await chrome.storage.local.set({ profileName: name });

  // Renaming has to re-handshake, and clearing the name has to cut the link.
  disconnect();
  reconnectDelayMs = RECONNECT_MIN_MS;
  if (name) await ensureConnected();
  return connectionStatus();
}

/* ------------------------------------------------------------ lifecycle */

chrome.runtime.onInstalled.addListener(() => {
  start().catch((error) => console.debug('[cpd] install start failed:', messageOf(error)));
});

chrome.runtime.onStartup.addListener(() => {
  start().catch((error) => console.debug('[cpd] startup failed:', messageOf(error)));
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== KEEPALIVE_ALARM) return;
  // This is what revives the worker after Chrome kills it.
  start().catch((error) => console.debug('[cpd] keepalive failed:', messageOf(error)));
});

async function start() {
  const existing = await chrome.alarms.get(KEEPALIVE_ALARM);
  if (!existing) {
    await chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: KEEPALIVE_PERIOD_MINUTES });
  }
  await ensureConnected();
}

start().catch((error) => console.debug('[cpd] start failed:', messageOf(error)));
