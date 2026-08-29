# Chrome Web Store listing copy

Paste-ready. Nothing here is filled in for you by the packaging step.

## Name (max 75)

```
Chrome Profile Debug
```

## Short description (max 132)

```
Drive a named Chrome profile from a local MCP client. No open port, no telemetry, and no access until you name the profile.
```

## Detailed description

```
Chrome Profile Debug exposes one Chrome profile to a local automation host,
under a name you choose, so developer tooling on the same machine can drive
that profile.

Chrome keeps every profile in a single browser process. Tools that attach over
--remote-debugging-port therefore see all of your open profiles at once and
cannot tell them apart, and they do it through an unauthenticated port on
localhost that any local process can reach. Extension-based tools usually bind
to whichever single profile happens to be paired, leaving you unsure which one
an automation actually touched.

This extension takes a different approach. You name each profile once. Every
command from your tooling names the profile it is for, so there is never any
doubt about which browser session was driven.

HOW IT WORKS

The extension talks to a companion program on your own computer through
Chrome's native messaging API. That program is open source and you install it
yourself. No TCP port is opened. The extension has no network capability of its
own and no host permissions, so it never injects a content script into any page
and has no passive presence on the sites you browse.

Page interaction goes exclusively through the Chrome DevTools Protocol, which
means Chrome displays its debugging banner on any tab being driven. The
extension never suppresses that banner.

OPT-IN, PER PROFILE

A profile with no name never connects. Installing the extension in a profile
does nothing on its own; you have to open the popup and name it. Clearing the
name disconnects it again.

WHAT YOU NEED

The companion host requires Node.js 20 or later and a one-time setup step. The
Chrome Web Store cannot install it for you. Source, installation instructions
and the full security model:

https://github.com/marcondesmacaneiro/chrome-profile-debug

PRIVACY

No analytics. No crash reporting. No usage telemetry. No server operated by the
author. Page content read on your instruction is relayed only to the local
program you connected.
```

## Category

`Developer Tools`

## Privacy policy URL

```
https://github.com/marcondesmacaneiro/chrome-profile-debug/blob/main/docs/PRIVACY.md
```

## Single purpose

```
Expose one Chrome profile to a local automation host, under a name the user
chooses, so that developer tooling on the same machine can drive that profile.
```

## Data usage disclosures

Answer the data collection form as follows. All of these are verifiable in the
source, so answer them exactly.

| Question | Answer |
|---|---|
| Collects personally identifiable information | No |
| Collects health information | No |
| Collects financial and payment information | No |
| Collects authentication information | No |
| Collects personal communications | No |
| Collects location | No |
| Collects web history | No |
| Collects user activity | No |
| Collects website content | No |
| Sells data to third parties | No |
| Uses data for purposes unrelated to the single purpose | No |
| Uses data to determine creditworthiness or for lending | No |

The extension transmits nothing to the author or to any third party. Page
content crosses the native messaging boundary to a program on the user's own
machine, at the user's instruction, and never leaves it by any path this
extension controls.

## Permission justifications

See `docs/STORE.md`. Expect the reviewer to ask about "Read and change all your
data on all websites"; that string comes from the `debugger` permission alone,
not from any declared host permission, and the details page confirms the
extension has no additional site access.

## Screenshots still needed

1280x800 or 640x400, at least one. Suggested set:

1. The popup with a profile named and the status reading `Connected as ...`.
2. A terminal where `list_profiles` returns several named profiles.
3. A page being driven, with Chrome's debugging banner visible. Include this
   one deliberately: it pre-empts the obvious reviewer question and is honest
   about what the extension does.
