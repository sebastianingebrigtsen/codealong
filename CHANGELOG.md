# Changelog

All notable changes to CodeAlong are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and CodeAlong uses
[semantic versioning](https://semver.org/). The Chrome and VS Code extensions share one version
number and are released together.

## [Unreleased]

## [0.1.0] - Unreleased

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

[Unreleased]: https://github.com/sebastianingebrigtsen/codealong/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/sebastianingebrigtsen/codealong/releases/tag/v0.1.0
