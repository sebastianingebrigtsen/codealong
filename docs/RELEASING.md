# Releasing CodeAlong

CodeAlong uses [semantic versioning](https://semver.org/) with **one version for both extensions**.
They're released together because they share a protocol. While in `0.x`, minor versions may
contain breaking changes.

Nothing is published automatically. Pushing a `v*` tag only builds the artifacts and creates a
**draft** GitHub release for you to review.

## One-time setup

1. **Chrome Web Store**
   1. Register as a Chrome Web Store developer (one-time fee) at https://chrome.google.com/webstore/devconsole.
   2. Create a new item by uploading any build (`npm run package -- --allow-dev-id`, then
      `dist/codealong-chrome-<version>.zip`). Don't submit it yet; this only reserves the item and its ID.
   3. Copy the item ID (32 letters a–p) into `STORE_CHROME_EXTENSION_ID` in
      `packages/protocol/src/index.ts`. The VS Code extension only accepts connections from known
      extension IDs, so this must be in place before any VS Code release.
   4. Optional: in the dashboard's _Package_ tab, copy the public key and replace `key` in
      `packages/chrome/manifest.json` so local development builds get the store ID as well. Then
      update `DEV_CHROME_EXTENSION_ID` accordingly.
   5. Fill in the listing and privacy tab from [store/chrome-web-store.md](store/chrome-web-store.md).
2. **VS Code Marketplace**
   1. Create a publisher at https://marketplace.visualstudio.com/manage (sign in with a Microsoft
      account). Use the ID `sebastianingebrigtsen`, or change `publisher` in
      `packages/vscode/package.json` to the one you create.
   2. To publish from the command line, create an Azure DevOps personal access token with the
      _Marketplace → Manage_ scope ([guide](https://code.visualstudio.com/api/working-with-extensions/publishing-extension#get-a-personal-access-token)).
      Uploading the `.vsix` in the web UI works too.
3. After both listings exist, replace the `TODO(release)` placeholders in `README.md` and set
   `VSCODE_EXTENSION_URL` in `packages/chrome/src/shared/links.ts` to the Marketplace URL.

## Every release

1. Make sure `main` is green in CI, and run the _VS Code compatibility_ workflow (Actions → Run
   workflow) against `stable`. If it passes on a newer VS Code than `LATEST_TESTED` in
   `e2e/vscode/versions.mjs`, bump `LATEST_TESTED`. Raising the minimum VS Code version means changing
   `MINIMUM`, `engines.vscode` and `@types/vscode` together (a test enforces this).
2. Set the version and update the changelog:
   ```bash
   npm run version:set -- 0.2.0
   npm install            # refreshes package-lock.json
   ```
   Move the `Unreleased` notes in `CHANGELOG.md` under the new version with today's date.
3. Run everything locally:
   ```bash
   npm run check
   npm run test:e2e
   npm run test:vscode
   npm run package        # fails if STORE_CHROME_EXTENSION_ID is not set
   ```
4. Do the [manual smoke test](#manual-smoke-test) with the packaged artifacts.
5. Commit (`Release 0.2.0`), tag and push:
   ```bash
   git tag v0.2.0
   git push origin main v0.2.0
   ```
   The _Release_ workflow builds the artifacts and creates a draft GitHub release with
   `codealong-chrome-<version>.zip`, `codealong-vscode-<version>.vsix` and `SHA256SUMS.txt`.
6. Upload the zip to the Chrome Web Store (_Package → Upload new package_) and submit for review.
7. Publish the VSIX: upload it at https://marketplace.visualstudio.com/manage, or
   `npx vsce publish --packagePath dist/codealong-vscode-<version>.vsix`.
8. Publish the draft GitHub release once both stores have accepted the update.

If the protocol changes incompatibly, bump `PROTOCOL_VERSION`. Users who updated only one side
then get a clear "update both extensions" error instead of odd behaviour. Chrome and VS Code
update extensions independently, so allow for a mismatched pair for a few days.

## Manual smoke test

On at least one OS (ideally macOS and Windows), with the **packaged** artifacts:

1. Install the VSIX (_Extensions → … → Install from VSIX_). Run `npm run build` and load
   `packages/chrome/dist` with _Load unpacked_. It's the same code as the store zip, but it keeps
   the development key so its ID is accepted. (An unpacked copy of the store zip gets a random
   ID, which VS Code correctly rejects.)
2. The VS Code welcome notification appears once; the walkthrough opens.
3. The Chrome welcome page opens and shows "VS Code is running with CodeAlong".
4. On YouTube and on Laracasts: Follow this tab → type → video pauses → stop typing → resumes about
   2 s earlier.
5. Pause the video yourself → type → stop → it stays paused.
6. `Ctrl+Alt+P` / `Ctrl+Alt+D` work from VS Code; the status bar and toolbar badge update.
7. Close and reopen VS Code while following: Chrome reconnects on its own.
