// Produces the release artifacts in dist/:
//   codealong-chrome-<version>.zip   upload to the Chrome Web Store
//   codealong-vscode-<version>.vsix  upload to the VS Code Marketplace (or `vsce publish --packagePath`)
//   SHA256SUMS.txt
//
//   npm run package                 release packaging (requires the Web Store extension ID)
//   npm run package -- --allow-dev-id   packaging check without the store ID (CI, local testing)
//
// Nothing is published. See docs/RELEASING.md.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkVersions } from './versions.mjs';
import { zipDirectory } from './zip.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const allowDevId = process.argv.includes('--allow-dev-id');
const fail = (msg) => {
  console.error(`\n✖ ${msg}\n`);
  process.exit(1);
};

const version = checkVersions();
if (version === null) fail('Package versions differ. Run `npm run version:set -- <x.y.z>` to align them.');

const protocolSrc = readFileSync(join(root, 'packages/protocol/src/index.ts'), 'utf8');
const storeId = /STORE_CHROME_EXTENSION_ID: string \| null = (null|'([a-p]{32})')/.exec(protocolSrc);
if (!storeId) fail('Could not find STORE_CHROME_EXTENSION_ID in packages/protocol/src/index.ts.');
if (storeId[1] === 'null' && !allowDevId) {
  fail(
    'STORE_CHROME_EXTENSION_ID is not set, so the VS Code extension would reject the Web Store build of the\n' +
      '  Chrome extension. Set it first (docs/RELEASING.md), or pass --allow-dev-id for a test package.',
  );
}

const run = (cmd, args, cwd = root) => {
  const r = spawnSync(cmd, args, { cwd, stdio: 'inherit' });
  if (r.status !== 0) fail(`${[cmd, ...args].join(' ')} failed`);
};

const dist = join(root, 'dist');
rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

// The Chrome release build goes to dist/chrome so packages/chrome/dist stays a development build.
run(process.execPath, [join(root, 'scripts/build.mjs'), '--release', '--chrome-out=dist/chrome']);

// Chrome Web Store zip (deterministic).
const chromeZip = `codealong-chrome-${version}.zip`;
writeFileSync(join(dist, chromeZip), zipDirectory(join(dist, 'chrome')));
console.log(`Wrote dist/${chromeZip}`);

// VS Code VSIX. The Marketplace page shows the extension folder's README, CHANGELOG and LICENSE;
// the latter two are copied in from the repository root for packaging only.
const vscodeDir = join(root, 'packages/vscode');
const staged = ['LICENSE', 'CHANGELOG.md'];
for (const f of staged) copyFileSync(join(root, f), join(vscodeDir, f));
try {
  const vsce = join(dirname(createRequire(import.meta.url).resolve('@vscode/vsce/package.json')), 'vsce');
  const vsix = `codealong-vscode-${version}.vsix`;
  run(process.execPath, [vsce, 'package', '--no-dependencies', '--out', join(dist, vsix)], vscodeDir);
} finally {
  for (const f of staged) rmSync(join(vscodeDir, f), { force: true });
}

const sums = [chromeZip, `codealong-vscode-${version}.vsix`]
  .map(
    (f) =>
      `${createHash('sha256')
        .update(readFileSync(join(dist, f)))
        .digest('hex')}  ${f}`,
  )
  .join('\n');
writeFileSync(join(dist, 'SHA256SUMS.txt'), `${sums}\n`);
console.log(
  `\n✔ CodeAlong ${version} packaged in dist/${storeId[1] === 'null' ? ' (dev extension ID only – not for release)' : ''}`,
);
