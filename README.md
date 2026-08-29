# chrome-profile-debug

Drive **any of your named Chrome profiles** from an MCP client — Claude Code,
Codex, or anything else that speaks MCP over stdio.

Chrome keeps every profile in one browser process. Tools that attach over
`--remote-debugging-port` therefore see *all* of your open profiles at once and
cannot tell them apart, while extension-based tools usually bind to whichever
single profile happens to be paired. Neither lets you say "work in the profile I
call `staging`".

This does. You name each profile once, and every tool call takes that name.

```
list_profiles()            → ["personal", "staging", "prod-readonly"]
navigate(profile: "staging", url: "https://app.example.com")
read_page(profile: "staging")
```

No listening TCP port. No telemetry. No Chrome Web Store account required.

## How it works

```
  MCP client
      │ stdio
      ▼
  server/index.js ──── Unix domain socket (0600)
      ▲
      │ NDJSON
  host/host.js ─────── one process per profile, spawned by Chrome
      ▲
      │ Chrome native messaging
  extension/ ───────── one instance per profile
      │ chrome.debugger
      ▼
    web page
```

The wire format is specified in [docs/PROTOCOL.md](docs/PROTOCOL.md). The threat
model and its limits are in [docs/SECURITY.md](docs/SECURITY.md).

## Install

Requires Node.js 20+ and a Chromium-family browser.

### 1. Get the code

```bash
git clone https://github.com/marcondesmacaneiro/chrome-profile-debug.git
cd chrome-profile-debug
npm install
```

Keep the directory where it is. An unpacked extension's ID is derived from its
absolute path, and the native messaging manifest pins that ID — moving the
folder breaks the link until you re-run the installer.

### 2. Load the extension into each profile you want to drive

In **each** Chrome profile, separately:

1. Open `chrome://extensions`
2. Turn on **Developer mode**
3. Click **Load unpacked** and select the `extension/` directory
4. Copy the extension ID that appears

You do **not** need to publish to the Chrome Web Store. Loading unpacked is
permanent for personal use; the store only matters for distributing to other
people.

### 3. Register the native messaging host

Once per machine, using the ID from the previous step:

```bash
npm run install-host -- --extension-id <ID>
```

This writes a manifest into Chrome's `NativeMessagingHosts` directory. It
contains an absolute path and your extension ID, so it is generated locally and
never committed.

If you loaded the extension into several profiles, pass every ID:

```bash
npm run install-host -- --extension-id <ID1> --extension-id <ID2>
```

### 4. Name each profile

Click the extension icon in a profile and give it a name — `staging`,
`personal`, whatever you will type in your prompts. **A profile with no name
never connects**, which is what makes participation opt-in.

### 5. Point your MCP client at the server

Claude Code:

```bash
claude mcp add chrome-profile-debug -- node /absolute/path/to/chrome-profile-debug/server/index.js
```

Any other client: run `server/index.js` over stdio.

## Tools

`list_profiles` first — everything else takes a `profile` name.

| Tool | Purpose |
|---|---|
| `list_profiles` | Connected, named profiles |
| `list_tabs` | Tabs in that profile |
| `new_tab`, `close_tab`, `activate_tab` | Tab lifecycle |
| `navigate` | Open a URL |
| `read_page` | Accessibility tree with click-ready coordinates |
| `page_text` | Plain text of the page |
| `screenshot` | PNG or JPEG of the viewport |
| `evaluate` | Run JavaScript in the page |
| `click`, `type_text`, `press_key`, `scroll` | Input |
| `read_console` | Console messages, optionally filtered by regex |
| `read_network` | Network requests |

## Troubleshooting

**A profile does not appear in `list_profiles`.** Check, in order: the extension
is loaded in that profile; it has a name in the popup; the native host manifest
lists that profile's extension ID; the MCP server is running.

**`DEBUGGER_BUSY`.** Chrome allows one debugger client per tab. Close DevTools
on that tab.

**`RESTRICTED_URL`.** Extensions cannot touch `chrome://`, `devtools://`, or the
Chrome Web Store. This is a browser restriction with no workaround.

## License

MIT
