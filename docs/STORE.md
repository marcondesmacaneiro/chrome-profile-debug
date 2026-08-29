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
   from a network endpoint. The extension has no `host_permissions` and cannot
   fetch anything.
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

**`debugger`** — The sole mechanism by which the extension reads page structure,
captures screenshots, dispatches input, and observes console and network events.
The extension declares no `host_permissions` and injects no content scripts, so
there is no lighter-weight alternative available to it. Chrome displays a
persistent banner on any tab under debugger control, which the extension does
not suppress. Note that Chrome surfaces `debugger` to the user as "Read and
change all your data on all websites" even with no host permissions declared;
expect a reviewer to ask about that string, and answer that it comes from
`debugger` itself, not from any declared host access.

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

```bash
cd extension && zip -r ../chrome-profile-debug-$(node -p "require('./manifest.json').version").zip . -x '.*'
```

Verify the zip has `manifest.json` at its root, and that it contains no
`node_modules`, no `.git`, and nothing from `host/` or `server/`.

## After publishing

The store assigns its own extension ID, different from the unpacked one. Users
must register the native host with that published ID:

```bash
npm run install-host -- --extension-id <PUBLISHED_ID>
```

`install-host.js` accepts the flag repeatedly, so a developer can register the
unpacked and published IDs side by side.
