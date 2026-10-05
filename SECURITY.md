# Security

## Reporting a vulnerability

Please **don't open a public issue** for security problems. Report them privately through
[GitHub's private vulnerability reporting](https://github.com/sebastianingebrigtsen/codealong/security/advisories/new).
You should get a first response within a week. Fixes are released as soon as possible and credited
unless you prefer otherwise.

Only the latest release is supported with security fixes.

## What CodeAlong can access

| Part              | Access                                                                                                                                                                                   |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| VS Code extension | Receives editor events (a document changed, a document was saved). It only looks at the document's URI scheme and whether it's the active, focused editor. It never reads document text. |
| Chrome extension  | On YouTube, Vimeo and Laracasts, and on sites you explicitly grant: finds the `<video>` element and reads the page title. Controls only the tab you follow.                              |
| Local connection  | `127.0.0.1` only. Carries "edit"/"save" signals, video state (playing/paused, time) and the tutorial's page title and host name.                                                         |

There is no backend, telemetry, analytics or remote code.

## Threat model (for maintainers)

**In scope**

- _A website tries to talk to the local hub_, for example by opening `ws://127.0.0.1:47390` from
  page JavaScript. The hub rejects every request whose `Origin` header isn't an allow-listed
  CodeAlong extension ID (`ALLOWED_CHROME_EXTENSION_IDS`), before the WebSocket handshake.
  Browsers always send `Origin` on WebSocket requests, and pages can't forge it. This is tested
  in real Chromium.
- _DNS rebinding:_ requests whose `Host` isn't `127.0.0.1`/`localhost` are rejected.
- _Malformed or hostile messages:_ every message is validated against the protocol; unknown
  fields and types are dropped; messages are limited to 16 KB; clients that don't say hello within
  3 s are closed.
- _Other browser extensions:_ they have their own origins and are rejected by the allow-list. The
  service worker accepts popup commands only from its own extension pages.
- _Other VS Code windows_ authenticate with a random 256-bit token in `~/.codealong/editor-token`.
  The file is created with owner-only permissions on macOS/Linux; on Windows it relies on the
  user profile's ACL.

**Out of scope**

- _Malware running as the same OS user._ It can read the token file, set any `Origin` header and
  connect to the hub, but it gains only the ability to pause or play a video and to learn when you
  type. Such malware can already do far more.
- _A sideloaded extension that reuses the public development key._ The dev ID
  (`DEV_CHROME_EXTENSION_ID`) comes from a public key in this repository, so a developer-mode
  extension could claim it. Installing it requires the user to enable developer mode and load it
  by hand; the impact is the same as above.

**Data minimisation:** logs (VS Code output channel, popup event log) contain event names and host
names only, never code, file names or keystrokes, and debug logging is off by default.

**Browser change to watch:** Chrome's Local Network Access restrictions apply to websites
connecting to localhost. They don't currently block the extension's service worker. The real-Chromium
e2e test will catch it if that changes.
