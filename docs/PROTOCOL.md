# Wire protocol (v1)

This document is the contract between the three components. Any change here is a
breaking change and must bump `PROTOCOL_VERSION`.

```
  MCP client (Claude Code, Codex, ...)
        │  stdio, MCP
        ▼
  server/index.js ───────── listens on a Unix domain socket (mode 0600)
        ▲
        │  NDJSON over Unix socket        ← Layer 2
        │
  host/host.js  (one process per Chrome profile; Chrome spawns it)
        ▲
        │  Chrome native messaging        ← Layer 1
        │
  extension/  (one instance per Chrome profile)
        │  chrome.debugger / chrome.tabs
        ▼
      web page
```

No component ever opens a TCP port.

## Layer 1 — extension <-> native host

Standard Chrome native messaging: each message is a 4-byte unsigned integer
length prefix in **native byte order** (little-endian on all supported
platforms), followed by that many bytes of UTF-8 JSON. Chrome implements its
side; the host must implement framing on stdin/stdout.

Chrome's per-message limit is 1 MB from the host to the extension. Responses
that can exceed it (screenshots, accessibility trees) MUST be chunked — see
[Chunking](#chunking).

## Layer 2 — native host <-> MCP server

Unix domain socket. Path resolution order:

1. `$CPD_SOCKET`
2. `$XDG_STATE_HOME/chrome-profile-debug/bridge.sock`
3. `~/.local/state/chrome-profile-debug/bridge.sock`

The server creates the parent directory with mode `0700` and the socket with
mode `0600`. The host connects as a client and retries with exponential backoff
(500 ms, doubling, capped at 30 s) forever — the server is frequently not
running.

Framing is **NDJSON**: one JSON value per line, `\n`-terminated. `JSON.stringify`
never emits a raw newline, so no escaping is needed.

## Envelope

Every message is a JSON object with a `type` field.

### `hello` — host to server, first message on every connection

```json
{
  "type": "hello",
  "protocolVersion": 1,
  "profile": {
    "id": "8f14e45f-ceea-467a-9a3c-9c0b6ef7c0de",
    "name": "olcen",
    "chromeVersion": "141.0.7390.55",
    "extensionVersion": "0.1.0"
  }
}
```

`profile.id` is a UUID generated once by the extension and kept in
`chrome.storage.local`; it is stable for the life of that profile's install.
`profile.name` is set by the user in the extension popup.

**A profile with no name never connects.** The extension must not call
`connectNative` until a name exists. This makes every profile opt-in.

If two connected profiles report the same `name`, the server keeps the first and
replies with `{"type":"error","code":"DUPLICATE_NAME"}`, then closes.

### `request` — server to host to extension

```json
{ "id": "01J8...", "type": "request", "method": "tabs.list", "params": {} }
```

`id` is a ULID or UUID chosen by the server and echoed back unchanged.

### `response` — extension to host to server

```json
{ "id": "01J8...", "type": "response", "ok": true, "result": { } }
```

```json
{ "id": "01J8...", "type": "response", "ok": false,
  "error": { "code": "TAB_NOT_FOUND", "message": "No tab with id 42" } }
```

Error codes: `BAD_PARAMS`, `TAB_NOT_FOUND`, `DEBUGGER_ATTACH_FAILED`,
`DEBUGGER_BUSY`, `RESTRICTED_URL`, `TIMEOUT`, `INTERNAL`.

`RESTRICTED_URL` is returned for `chrome://`, `chrome-extension://`,
`devtools://` and the Chrome Web Store, which extensions may not touch.

### `ping` / `pong` — either direction

```json
{ "type": "ping", "ts": 1756400000000 }
```

The host pings the server every 20 s. A peer that misses two consecutive pongs
closes and reconnects.

### Chunking

When a `result` would exceed 512 KB serialized, the responder splits it:

```json
{ "id": "01J8...", "type": "response", "ok": true,
  "chunk": { "index": 0, "total": 3 }, "resultChunk": "<base64 slice>" }
```

Chunks arrive in order. The receiver concatenates `resultChunk` values, base64-
decodes, and parses the result as JSON. Absence of `chunk` means a whole result.

## Methods (v1)

Every method runs against the profile the connection belongs to; the profile is
never a parameter at this layer.

| Method | Params | Result |
|---|---|---|
| `profile.info` | — | `{ id, name, chromeVersion, extensionVersion }` |
| `tabs.list` | — | `[{ tabId, windowId, title, url, active }]` |
| `tabs.create` | `{ url? }` | `{ tabId }` |
| `tabs.close` | `{ tabId }` | `{ closed: true }` |
| `tabs.activate` | `{ tabId }` | `{ ok: true }` |
| `page.navigate` | `{ tabId, url, timeoutMs? }` | `{ url, status }` |
| `page.readTree` | `{ tabId, interactiveOnly?, maxNodes? }` | `[{ ref, role, name, value, backendDOMNodeId, box }]` |
| `page.screenshot` | `{ tabId, format?, quality?, fullPage? }` | `{ dataBase64, width, height }` |
| `page.evaluate` | `{ tabId, expression, awaitPromise? }` | `{ value }` |
| `page.text` | `{ tabId, maxChars? }` | `{ text, truncated }` |
| `input.click` | `{ tabId, x, y, button?, clickCount? }` | `{ ok: true }` |
| `input.type` | `{ tabId, text }` | `{ ok: true }` |
| `input.key` | `{ tabId, key, modifiers? }` | `{ ok: true }` |
| `input.scroll` | `{ tabId, x, y, deltaX?, deltaY? }` | `{ ok: true }` |
| `console.read` | `{ tabId, pattern?, limit?, onlyErrors? }` | `[{ level, text, ts, url, line }]` |
| `network.read` | `{ tabId, urlPattern?, limit? }` | `[{ method, url, status, ts, type }]` |

`box` in `page.readTree` is `{ x, y, width, height }` in **viewport CSS pixels**,
with `x`/`y` at the centre of the element, ready to pass to `input.click`. Nodes
that are off-screen or have no box report `box: null`.

`ref` is a short opaque string (`ref_1`, `ref_2`, ...) stable within one
`page.readTree` call, so callers can refer to a node without coordinates.

## MCP tool surface

The server exposes one tool per method above, prefixed and flattened, plus:

| Tool | Params | Notes |
|---|---|---|
| `list_profiles` | — | Connected, named profiles. Always call this first. |

Every other tool takes a required `profile` string naming the target. The server
resolves it to a connection; an unknown name fails with `PROFILE_NOT_CONNECTED`
and the error message lists the names that *are* connected.
