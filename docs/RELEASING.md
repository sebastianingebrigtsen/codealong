# Releasing CodeAlong

CodeAlong uses [semantic versioning](https://semver.org/) with **one version for both extensions**.
They're released together because they share a protocol. While in `0.x`, minor versions add
features and may change behaviour; patch versions only fix bugs.

| Where               | Listing                                                                             | Published by                    |
| ------------------- | ----------------------------------------------------------------------------------- | ------------------------------- |
| Chrome Web Store    | https://chromewebstore.google.com/detail/codealong/jhfmljdjpeaclncddhhifegcknjgfjij | manual upload (dashboard)       |
| VS Code Marketplace | https://marketplace.visualstudio.com/items?itemName=SebastianIngebrigtsen.codealong | manual upload or `vsce publish` |
| GitHub Releases     | https://github.com/sebastianingebrigtsen/codealong/releases                         | tag → draft release (CI)        |

Nothing is published to the stores automatically. Pushing a `v*` tag builds the artifacts and
creates a **draft** GitHub release for you to review.

## Every release

1. **Compatibility check.** Run the _VS Code compatibility_ workflow (Actions → Run workflow) against
   `stable`. If it passes on a newer VS Code than `LATEST_TESTED` in `e2e/vscode/versions.mjs`, bump
   `LATEST_TESTED`. Raising the minimum VS Code version means changing `MINIMUM`, `engines.vscode`
   and `@types/vscode` together (a test enforces this).
2. **Version and changelog** on a branch (`main` is protected and only changes through pull requests):
   ```bash
   git switch -c release/0.3.0
   npm run version:set -- 0.3.0
   npm install            # refreshes package-lock.json
   ```
   Move the `Unreleased` notes in `CHANGELOG.md` under the new version with today's date and add
   the compare link at the bottom.
3. **Screenshots**, if the popup or the welcome page changed: `npm run build && npm run assets`.
4. **Run everything locally:**
   ```bash
   npm run check
   npm run test:e2e
   npm run test:vscode
   npm run package        # dist/codealong-chrome-<v>.zip, dist/codealong-vscode-<v>.vsix
   ```
5. Do the [manual smoke test](#manual-smoke-test).
6. **Pull request** (`Release 0.3.0`), wait for CI, merge.
7. **Tag the merge commit** and push the tag:
   ```bash
   git switch main && git pull
   git tag -a v0.3.0 -m "CodeAlong 0.3.0"
   git push origin v0.3.0
   ```
   The _Release_ workflow checks that the tag matches the version, runs all checks, and creates a
   draft GitHub release with the zip, the VSIX and `SHA256SUMS.txt`.
8. **Chrome Web Store:** [Developer Dashboard](https://chrome.google.com/webstore/devconsole) →
   CodeAlong → _Package_ → _Upload new package_ → `codealong-chrome-<v>.zip` (from the draft
   release or `dist/`). Update the store listing and screenshots from
   [store/chrome-web-store.md](store/chrome-web-store.md) if they changed, then _Submit for review_.
9. **VS Code Marketplace:** https://marketplace.visualstudio.com/manage/publishers/SebastianIngebrigtsen
   → CodeAlong → _…_ → _Update_ → upload `codealong-vscode-<v>.vsix`. Or, with a personal access
   token: `npx vsce publish --packagePath dist/codealong-vscode-<v>.vsix`.
10. **Publish the draft GitHub release** once both stores show the new version.

Chrome and VS Code update extensions independently, so a user may run mismatched versions for a
day or two. Keep protocol changes additive where possible (new optional messages and fields,
advertised through `features` in the welcome message). Bump `PROTOCOL_VERSION` only for a truly
incompatible change; users then see a clear "update both extensions" message.

## Manual smoke test

On at least one OS (ideally macOS and Windows):

1. Install the VSIX (_Extensions → … → Install from VSIX_). Run `npm run build` and load
   `packages/chrome/dist` with _Load unpacked_. It's the same code as the store zip, but it keeps
   the development key so its ID is accepted. (An unpacked copy of the store zip gets a random
   ID, which VS Code correctly rejects.) Remove the store version of the Chrome extension first.
2. On YouTube and on Laracasts: Follow this tab → type → video pauses and the label on the video
   says "Paused while you code" → stop typing → countdown → resumes about 2 s earlier.
3. Pause the video yourself → type → stop → it stays paused.
4. Popup → Settings: change the wait and the rewind; the next pause uses them. Close and reopen
   Chrome: the settings are still there. Reset to defaults works.
5. Turn CodeAlong off in VS Code (status bar) → the popup switch shows Off; typing doesn't pause.
6. `Ctrl+Alt+P` / `Ctrl+Alt+D` work from VS Code; the status bar and toolbar badge update.
7. Close and reopen VS Code while following: Chrome reconnects on its own.

## One-time setup (done)

For reference, in case the project moves to new accounts:

- **Chrome Web Store:** the item ID is set in `STORE_CHROME_EXTENSION_ID`
  (`packages/protocol/src/index.ts`). The VS Code extension only accepts connections from known
  extension IDs, so a new store item needs a matching VS Code release first. `npm run package`
  refuses to package without the ID.
- **VS Code Marketplace:** publisher `SebastianIngebrigtsen` (`packages/vscode/package.json`).
- **Privacy policy:** served by GitHub Pages from `docs/` on `main`:
  https://sebastianingebrigtsen.github.io/codealong/PRIVACY.html
