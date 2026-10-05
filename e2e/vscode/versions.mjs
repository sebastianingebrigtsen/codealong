// VS Code versions the extension is tested against. Single source of truth for CI and docs.
//
// MINIMUM must match `engines.vscode` in packages/vscode/package.json (checked by
// test/repository.test.ts). LATEST_TESTED is a pinned recent stable release, bumped by hand when
// the weekly "VS Code compatibility" workflow (which tests the moving `stable`) is green, so a new
// VS Code release can never break CI for pull requests on its own.
export const MINIMUM = '1.95.3';
export const LATEST_TESTED = '1.140.0';

/** Resolves a CLI/env value: "minimum", "latest-tested", "stable", "insiders" or an x.y.z version. */
export function resolveVersion(value) {
  if (!value || value === 'latest-tested') return LATEST_TESTED;
  if (value === 'minimum') return MINIMUM;
  return value;
}
