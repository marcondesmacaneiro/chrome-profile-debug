# Chrome Web Store submission

Publishing is optional. `Load unpacked` works permanently for personal use and
is what the README documents. The store only matters for distributing to other
people — and it solves less of that problem than it appears to, because the
store cannot install the native messaging host. Anyone installing from the store
still needs Node, this repository, and `npm run install-host`.

## The dashboard cannot be automated by this extension

Worth knowing before you try: Chrome blocks extensions from the Web Store
domain, and that block covers `chrome.google.com/webstore/*` as well as
`chromewebstore.google.com`. This extension refuses those URLs with
`RESTRICTED_URL`, as it must. Submission is a manual, human step, and no
amount of tooling changes that.

## Known review risk

`page.evaluate` executes arbitrary JavaScript supplied by whatever MCP client is
connected. Chrome Web Store policy prohibits executing remotely-hosted code, and
a reviewer may reasonably read this as exactly that, even though the "remote"
end is a process on the user's own machine.

Three ways to handle it, in the order we would try them:

1. Submit as-is and answer the reviewer's question directly: the code comes from
   a local process the user installed themselves over native messaging, never
   from a network endpoint. The extension makes no network requests of its own:
   its host permission only lets it run a script in a tab a command names.
2. Gate `page.evaluate` behind a checkbox in the popup, off by default, so the
   published default build has no arbitrary-execution path.
3. Drop `page.evaluate` from the published build and keep it in the unpacked
   development build.

Do not discover this at submission time. Decide before paying the fee.

## Before submitting

- [ ] Developer account registered (one-time US$5 fee)
- [ ] `docs/PRIVACY.md` reachable at a public URL, and that URL entered in the
      listing. A raw GitHub URL is accepted.
- [ ] Icons declared in `extension/manifest.json` at 16, 32, 48 and 128 px
- [ ] A production zip containing **only** `extension/` — never the repository
      root, which carries `node_modules/` and the server
- [ ] Version bumped in `extension/manifest.json`

## Required assets

| Asset | Spec |
|---|---|
| Store icon | 128 x 128 PNG |
| Screenshots | 1280 x 800 or 640 x 400, at least one, at most five |
| Small promo tile | 440 x 280 PNG, optional but improves placement |

A good screenshot set: the popup with a profile named and connected; a terminal
showing `list_profiles` returning several names; a page being driven with
Chrome's debugging banner visible. Showing the banner is honest and pre-empts
the obvious reviewer question.

## Single purpose statement

> Expose one Chrome profile to a local automation host, under a name the user
> chooses, so that developer tooling on the same machine can drive that profile.

## Permission justifications

Copy these into the listing. Each must say why the permission is *necessary*,
not merely useful.

**`debugger`** — The primary mechanism by which the extension reads page
structure, captures screenshots, dispatches input, and observes console and
network events. Chrome displays a persistent banner on any tab under debugger
control, which the extension does not suppress. Chrome surfaces `debugger` to
the user as "Read and change all your data on all websites" on its own.

**`scripting`** and **host permission `<all_urls>`** — Chrome refuses
`chrome.debugger` on any tab that contains a frame belonging to another
extension, which password managers inject into most login and form pages.
Without a fallback those pages cannot be driven at all. On such a tab, and only
when a command from the user's local tooling names it, the extension runs a
script there with `chrome.scripting.executeScript` to read the page or dispatch
the input the command asked for, and `chrome.tabs.captureVisibleTab` for
screenshots. There is no content script and nothing is injected into pages the
user merely browses. The host permission must be `<all_urls>` because the user
decides which site to automate; no fixed list could cover it.

**`tabs`** — Needed to enumerate, create, activate and close tabs within the
profile, and to read their title and URL so the operator can identify a target.

**`nativeMessaging`** — The extension's only communication channel. It connects
to a companion process the user installs from source on the same machine. The
extension has no network capability of its own.

**`storage`** — Persists two values: the profile name the user types in the
popup, and a locally generated UUID that distinguishes this profile from others.
Nothing else is stored.

**`alarms`** — Manifest V3 suspends the service worker aggressively. A periodic
alarm re-establishes the native messaging connection after suspension; without
it the extension silently stops responding.

## Packaging

The store rejects a manifest carrying `key`, which the repository keeps so the
unpacked build gets the published ID. Pack a copy without it:

```bash
v=$(node -p "require('./extension/manifest.json').version") && tmp=$(mktemp -d) \
  && cp -R extension/ "$tmp/" \
  && node -e "const f=process.argv[1],m=JSON.parse(require('fs').readFileSync(f));delete m.key;require('fs').writeFileSync(f,JSON.stringify(m,null,2)+'\n')" "$tmp/manifest.json" \
  && (cd "$tmp" && zip -r - . -x '.*') > "chrome-profile-debug-$v.zip" && rm -rf "$tmp"
```

Verify the zip has `manifest.json` at its root, with no `key`, and that it
contains no `node_modules`, no `.git`, and nothing from `host/` or `server/`.

## After publishing

The store assigns its own extension ID, different from the unpacked one. Users
must register the native host with that published ID:

```bash
npm run install-host -- --extension-id <PUBLISHED_ID>
```

`install-host.js` accepts the flag repeatedly, so a developer can register the
unpacked and published IDs side by side.
