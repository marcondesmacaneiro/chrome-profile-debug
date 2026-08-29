# Privacy policy

*Last updated: 29 August 2026*

**Chrome Profile Debug does not collect, transmit, or sell any personal data.**

The extension has no server. It contains no analytics, no crash reporting, and
no usage telemetry. It makes no network requests of its own — it has no
`host_permissions` and cannot reach any website on its own initiative.

## What the extension stores

Two values, in `chrome.storage.local`, on your device only:

| Value | Purpose |
|---|---|
| Profile name | The name you type in the popup, used to identify this profile |
| Profile ID | A random UUID generated on first run, so the companion process can tell profiles apart |

Neither is transmitted anywhere except to the local companion process described
below. Clearing the name stops the extension from connecting at all.

## What the extension can access, and where it goes

When you name a profile, the extension connects — over Chrome's native
messaging API, to a process running on your own computer — to a companion
program you installed yourself from source. There is no other channel.

On instruction from that local program, the extension can read page content,
take screenshots, and dispatch clicks and keystrokes in tabs of that profile,
using the Chrome DevTools Protocol. Chrome displays a visible banner on any tab
while this is happening.

**That page content is relayed to whatever software you connected.** In the
intended use, that is an AI coding assistant on your machine, which will send it
to its own model provider under that provider's terms. The extension has no
knowledge of, and no control over, what happens after the data leaves the local
companion process. Choose what you connect, and which profiles you name,
accordingly.

## What the extension never does

- It never connects to a network service operated by the author.
- It never runs in a profile you have not explicitly named.
- It never enumerates or touches your other Chrome profiles. Each profile runs
  its own isolated instance.
- It never suppresses Chrome's debugging banner.

## Data retention

None. The extension keeps no history of pages visited, content read, or actions
taken. Console and network buffers are held in memory while a tab is attached
and are discarded when the tab closes or the browser restarts.

## Contact

Open an issue at https://github.com/marcondesmacaneiro/chrome-profile-debug
