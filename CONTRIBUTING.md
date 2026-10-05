# Contributing to CodeAlong

Thanks for your interest! Bug reports, ideas and pull requests are all welcome. For anything larger
than a small fix, please open an issue first so we can agree on the approach.

## Setup

Prerequisites: **Node.js 22+**, **Chrome** and **VS Code**.

```bash
git clone https://github.com/sebastianingebrigtsen/codealong.git
cd codealong
npm install
npm run dev
```

`npm run dev` builds both extensions and rebuilds on every change.

- **Chrome extension:** `chrome://extensions` → enable _Developer mode_ → _Load unpacked_ →
  select `packages/chrome/dist`. After a rebuild, click the reload icon on the extension card. The
  manifest contains a public development key, so the extension always gets the ID
  `golihbblpnhanlhgnnngcfhmolomajoo`, which the VS Code side accepts.
- **VS Code extension:** open the repository in VS Code and press **F5** (_Run CodeAlong_). Set
  `"codealong.debugLogging": true` in the new window to see events in the _CodeAlong_ output channel.

## Project layout

```
packages/protocol   message types and validation shared by both extensions
packages/vscode     VS Code extension (state machine, local server, editor activity)
packages/chrome     Chrome extension (service worker, content script, popup, welcome page)
test/               integration tests across both sides (real WebSockets, fake video)
e2e/                Chrome extension in real Chromium; VS Code extension in real VS Code
scripts/            build, packaging, versioning, asset rendering
docs/               architecture, privacy, releasing, store listing
```

Start with [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). It explains the design and the guarantees
every change must keep.

## Checks

| Command                             | What it does                                                                                                                                                                                                                         |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `npm run check`                     | Formatting check, lint, typecheck, unit + integration tests, build                                                                                                                                                                   |
| `npm test`                          | Unit and integration tests (Vitest, a few seconds)                                                                                                                                                                                   |
| `npm run format`                    | Format everything with Prettier                                                                                                                                                                                                      |
| `npm run test:e2e`                  | Chrome extension in real Chromium. First run: `npx playwright install chromium`                                                                                                                                                      |
| `npm run test:vscode`               | VS Code extension in real VS Code (pinned "latest tested" version, downloaded once). `CODEALONG_VSCODE_VERSION=minimum` tests the oldest supported version, `stable` the newest; `CODEALONG_VSCODE=<path>` uses an installed VS Code |
| `npm run package -- --allow-dev-id` | Builds `dist/codealong-chrome-<v>.zip` and `dist/codealong-vscode-<v>.vsix`                                                                                                                                                          |
| `npm run assets`                    | Re-renders icons and store images from `assets/icon.svg` (needs Playwright's Chromium)                                                                                                                                               |

The e2e tests use their own ports (`48390`+), so they don't interfere with a CodeAlong you use day
to day.

CI runs `check` and packaging on Linux, Windows and macOS, the Chromium e2e suite, and the VS Code
e2e suite against two pinned VS Code versions (see `e2e/vscode/versions.mjs`). A weekly workflow
tests the newest VS Code on all three systems without blocking pull requests.

The VS Code e2e suite must never depend on machine speed: use long idle delays where no automatic
resume may happen, and assert lower bounds rather than tight timings.

## Guidelines

- Keep it small and focused. CodeAlong does one thing.
- Behaviour changes need tests. The state machine (`HubCore`) and the video controller are pure
  and easy to test; prefer adding cases there.
- Never weaken the invariants: **a video the user paused is never resumed automatically**, and
  **code never leaves the editor** (nor is it logged).
- User-facing text is plain English and avoids jargon such as "WebSocket" or "hub".
- Add a line under _Unreleased_ in [CHANGELOG.md](CHANGELOG.md) for user-visible changes.

## Labels

`bug`, `enhancement`, `documentation`, `good first issue` and `help wanted` (GitHub's defaults) are
used; there's no other process.

## Releases

Maintainers follow [docs/RELEASING.md](docs/RELEASING.md).

By contributing you agree that your contributions are licensed under the [MIT License](LICENSE)
and that you follow the [Code of Conduct](CODE_OF_CONDUCT.md).
