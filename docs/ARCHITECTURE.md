# Architecture

CodeAlong is two extensions and a local connection between them.

```
┌──────────────── Chrome ────────────────┐            ┌────────────── VS Code (each window) ──────────────┐
│ content script (every frame of the      │            │ extension.ts   editor events → "edit" / "save"    │
│   followed tab)                         │            │ activity.ts    what counts as the user coding     │
│   FrameAgent       finds the video      │            │                                                    │
│   VideoController  pause/play/rewind,   │            │ HubNode        leader election between windows     │
│                    knows who paused     │            │   leader:   HubServer (WebSocket, 127.0.0.1)       │
│        ▲ chrome.runtime messages        │            │             CoreRunner → HubCore (state machine)   │
│        ▼                                │  WebSocket │   follower: forwards edit/save/shortcuts to leader │
│ service worker                          │◄──────────►│                                                    │
│   Active Tutorial, HubConnection,       │ 127.0.0.1  │ statusBar.ts, walkthrough                          │
│   FrameTracker, focus, shortcuts, badge │            └────────────────────────────────────────────────────┘
│ popup / welcome page                    │
└─────────────────────────────────────────┘
```

| Concern                                       | Lives in                                                                      |
| --------------------------------------------- | ----------------------------------------------------------------------------- |
| Finding the video (incl. iframes, shadow DOM) | `packages/chrome/src/content/agent.ts`, `discovery.ts`, `shared/selection.ts` |
| Controlling the video, knowing who paused it  | `packages/chrome/src/content/videoController.ts`                              |
| Which tab is followed, routing, reconnect     | `packages/chrome/src/background/`                                             |
| Deciding when to pause and resume (state)     | `packages/vscode/src/core/hubCore.ts`                                         |
| Detecting editor activity                     | `packages/vscode/src/activity.ts`, `extension.ts`                             |
| Settings: storage, popup UI, sync to VS Code  | `packages/chrome/src/shared/settings.ts`, `background/index.ts`, `popup/`     |
| Status label on the video                     | `packages/chrome/src/content/overlay.ts`                                      |
| Local server, authentication                  | `packages/vscode/src/hub/server.ts`                                           |
| Several VS Code windows                       | `packages/vscode/src/hub/hubNode.ts`                                          |
| Wire protocol and validation                  | `packages/protocol/src/index.ts`                                              |

## Invariants

These are product guarantees. Changes that weaken them need a very good reason and tests.

1. **CodeAlong never automatically resumes a video the user paused.** The browser is the source of
   truth for _who_ paused. Every pause/play/seek CodeAlong performs is registered as "expected"
   before calling the media API, and the resulting DOM event is recognised. Any other event is the
   user's (or the site's own player), and clears CodeAlong's ownership. A resume command carries
   the `pauseId` of the CodeAlong pause and is ignored unless the video is still paused by
   CodeAlong with exactly that id. User intent wins any race. Turning CodeAlong off while it has the
   video paused sends `release`, which hands that pause to the user, so turning it back on later
   can't start the video either.
2. **Source code never leaves VS Code.** Only the facts "edit happened" and "file saved" are
   sent. Document contents, file names and keystrokes are never read for this purpose, sent, or
   logged.
3. **Only the followed tab is controlled.** Content scripts stay dormant until the service worker
   confirms their tab is the Active Tutorial.
4. **Websites cannot use the local connection.** See [SECURITY.md](../SECURITY.md).

## State machine (`HubCore`)

`HubCore` is pure and synchronous: `dispatch(event, now) → effects`. Events are things like
`edit`, `save`, `video` (a report from the browser), `tutorialFocus`, `control` and `tick`.
Effects are commands to the browser and log entries.

Time is modelled as deadlines stored in the state (`idleDeadline`, `saveResumeAt`, the pending
command's timeout). `CoreRunner` keeps one timer armed for the earliest deadline and dispatches
`tick`. A late or stale timer therefore finds nothing to do: idle events cannot fire "after the fact".
At most one pause or resume command is in flight; a command without an acknowledgement is given up
after 3 seconds.

Status phases shown to users: `disabled`, `waitingForBrowser`, `noTutorial`, `noVideo`, `playing`,
`coding`, `codingWhilePlaying`, `waitingToResume`, `pausedByUser`, `ended`.

## Settings

The Chrome extension **owns** the settings that shape behaviour (on/off, idle delay, resume on
save, rewind, resume on tab focus) and stores them in `chrome.storage.local`, which persists across
browser restarts and extension updates and is never synced to a cloud.

- On every (re)connect, and whenever the user changes something in the popup, Chrome sends a
  `settings` message. The hub applies it immediately (including to an idle countdown that is
  already running) and never persists it.
- VS Code can ask for a change with `updateSettings` (the status bar's on/off). Chrome stores it and
  sends the new settings back, so there is a single source of truth and no merge logic.
- Values are validated on both sides with `sanitizeSettings` (unknown keys dropped, numbers clamped
  and rounded, wrong types replaced by defaults). The 0.1.0 storage format is migrated on start.
- Why Chrome: settings only matter while Chrome is connected, Chrome is always the side that
  (re)connects, its popup is where users look for them, and multiple VS Code windows (leader
  changes) need no coordination because the browser simply re-sends them to whichever window is
  the hub.
- Compatibility: hubs advertise `features: ["settings"]` in their welcome. Chrome only sends
  settings to hubs that support them; a hub that hasn't received any uses defaults. Older and
  newer extensions therefore keep working together while the stores roll out an update.

Editor-only preferences (`codealong.debugLogging`) stay in VS Code; Chrome-only ones (the status
label on the video, the event log) stay in Chrome.

## Connection

- **Transport:** WebSocket on `127.0.0.1`, JSON messages, protocol version handshake
  (`hello` → `welcome`), heartbeat every 20 s, 16 KB message limit.
- **Ports:** the hub uses the first free port of `HUB_PORTS` (47390–47392). The browser tries the
  same list. Ports occupied by other programs are skipped on both sides, so nobody configures a port.
- **Several VS Code windows:** on start, a window first looks for an existing CodeAlong hub on the
  candidate ports and joins it as a _follower_. Otherwise it binds the first free port and becomes
  the _leader_. If two windows race, the loser gets `EADDRINUSE`, waits a moment and joins the
  winner. When the leader window closes, followers run the election again.
- **Chrome side:** the service worker connects only while a tutorial is followed. It reconnects
  with backoff (1 → 10 s), is woken by the content scripts' heartbeat and by a 30 s alarm if Chrome
  stopped it, and re-injects content scripts after an extension update. The hub adopts a CodeAlong
  pause it did not create (for example after VS Code restarted), so such a pause is still resumed.
- **Probes:** the popup and welcome page check whether VS Code is reachable with a `probe` hello,
  which the hub answers and closes without touching the active connection.

## Building and testing

See [CONTRIBUTING.md](../CONTRIBUTING.md). The tests mirror the layers: `HubCore` unit tests, the
`VideoController` against a fake media element, the server against real WebSocket clients, a
full loop in Node (`test/fullLoop.test.ts`), the Chrome extension in real Chromium (`e2e/`) and
the VS Code extension in real VS Code (`e2e/vscode/`).
