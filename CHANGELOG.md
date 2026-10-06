# Changelog

All notable changes to CodeAlong are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and CodeAlong uses
[semantic versioning](https://semver.org/). The Chrome and VS Code extensions share one version
number and are released together.

## [Unreleased]

## [0.2.0] - 2026-10-06

### Added

- **Settings in the Chrome popup.** A compact Settings section with: continue after I stop typing
  (and how long to wait, 1–30 s), continue when I save, rewind before continuing (and how far,
  1–15 s), continue when I return to the tab, and show status on the video. Includes a one-line
  summary and "Reset to defaults". Changes apply in VS Code instantly.
- **Status on the video.** A small label on the paused video says why it is paused, how it will
  continue and counts down before it does ("Continuing in 2…", then "Rewound 2 s"). Can be turned off.
- Popup: on/off label, "Report a problem" link, version number, and "Copy diagnostics" (no page
  titles or URLs) under Troubleshooting.
- VS Code: "Timing and Settings" command, settings summary in the status bar tooltip.

### Changed

- **Settings are now owned by the Chrome extension** and stored locally in Chrome. VS Code applies
  whatever Chrome sends, on every (re)connect. The VS Code timing settings from 0.1.0
  (`codealong.idleDelaySeconds`, `codealong.rewindSeconds` and others) are no longer used; VS Code
  shows them as moved and tells you once if you had changed them.
- The on/off switch is shared: turning CodeAlong off in Chrome or in VS Code stops automatic
  pausing in both. Chrome now stays connected while it is off, so the shortcuts and status keep
  working.
- Turning CodeAlong off while it has the video paused hands that pause to you, so turning it back on
  never starts the video by surprise.
- A changed idle delay also applies to a countdown that is already running.
- Privacy policy moved to https://sebastianingebrigtsen.github.io/codealong/PRIVACY.html.

### Compatibility

- The extensions still speak protocol version 1, extended with optional messages. A 0.2.0 Chrome
  extension works with a 0.1.0 VS Code extension (which keeps using its own settings, and the popup
  says so), and the other way round, until both have updated.

## [0.1.0] - 2026-10-05

First public release.

### Added

- Chrome extension: follow a tutorial tab and let CodeAlong pause and play its video. Works with
  standard HTML5 video, including videos in iframes and in open shadow DOM (YouTube, Laracasts, Vimeo
  embeds and similar sites).
- VS Code extension: pauses the tutorial when you start typing and continues after a configurable
  idle delay, on save, on the done shortcut or (optionally) when you switch back to the tutorial.
- Rewind before an automatic resume (2 seconds by default).
- Guarantee: a video paused by the user is never started automatically.
- Keyboard shortcuts in VS Code (`Ctrl+Alt+P`, `Ctrl+Alt+D`) and Chrome (`Alt+Shift+P`, `Alt+Shift+D`).
- Status bar, welcome walkthrough in VS Code and a welcome page in Chrome.
- Local, authenticated connection between the two extensions that picks a free port by itself
  and supports several VS Code windows.

[Unreleased]: https://github.com/sebastianingebrigtsen/codealong/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/sebastianingebrigtsen/codealong/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/sebastianingebrigtsen/codealong/releases/tag/v0.1.0
