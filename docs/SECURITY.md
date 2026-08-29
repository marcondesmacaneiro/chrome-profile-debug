# Security model

This tool hands an LLM the ability to drive Chrome profiles that hold your real
logged-in sessions. That is the point of it, and it is also the whole risk. The
design below exists to keep that reach deliberate rather than accidental.

## What it does not do

**No listening TCP port.** The extension talks to a local process through Chrome
native messaging (stdin/stdout of a child process) and that process reaches the
MCP server over a Unix domain socket with mode `0600`. Nothing binds a port.

This is the main difference from the common `--remote-debugging-port` approach,
which opens an unauthenticated endpoint on `127.0.0.1`. Any local process can
speak to such a port and read cookies for every session in that browser. A Unix
socket at `0600` is reachable only by your user, and native messaging is not
reachable over the network at all.

**No `host_permissions`.** `chrome.debugger` does not require them, so the
manifest declares none. The extension cannot read page content through content
scripts; every page interaction goes through the debugger, which Chrome
announces with a visible banner.

**The debugging banner is never suppressed.** If a tab is being driven, you can
see it.

**No telemetry.** No analytics endpoint, no crash reporter, no usage ping. The
only network traffic is whatever page you ask it to open.

## Opt-in per profile

A profile participates only after two deliberate acts:

1. You load the unpacked extension in that specific profile.
2. You give the profile a name in the extension popup.

Until a name exists the extension does not call `connectNative`, so an installed
but unnamed profile never appears to any MCP client. Removing the name
disconnects it.

Naming is not cosmetic. Without it, an agent asked to work in "the work profile"
has no way to tell which browser it actually reached, and can act on the wrong
session while both sides believe otherwise.

## What is not protected

- **Anything the profile is logged into is reachable** once that profile is
  named and connected. Do not name a profile that holds production admin
  sessions unless that is precisely what you want to automate.
- **The MCP client sees page content.** Whatever is read — page text, the
  accessibility tree, console output — becomes context for the model, and
  travels wherever that client sends its context.
- **`page.evaluate` runs arbitrary JavaScript** in the page's origin. It is as
  powerful as the DevTools console.
- **Credentials typed through `input.type` are plain strings.** They pass through
  the host and the server in memory. Neither logs message bodies, but prefer
  logging in by hand.

## Files kept out of git

`native-host-manifest.json` is generated at install time and holds an absolute
path and your local extension ID. It is written outside the repository, into
Chrome's `NativeMessagingHosts` directory, and is listed in `.gitignore`.

Profile names live in `chrome.storage.local`, inside your Chrome profile. They
are never written to the repository.

## Reporting

Open an issue. Do not include profile names, extension IDs, or session data.
