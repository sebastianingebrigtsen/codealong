// Builds both extensions with esbuild.
//
//   node scripts/build.mjs             development build (sourcemaps, pinned dev extension ID)
//   node scripts/build.mjs --watch     development build, rebuild on change
//   node scripts/build.mjs --release   store build (no sourcemaps, no manifest "key")
//
// --chrome-out=<dir> writes the Chrome build elsewhere (packaging and tests use this so the
// unpacked development build in packages/chrome/dist is never replaced). --chrome-only skips the
// VS Code build. For automated tests only, the env var CODEALONG_HUB_PORTS (development builds
// only) makes the Chrome extension use other ports.
//
// Output: packages/chrome/dist (load this folder unpacked) and packages/vscode/dist.
import * as esbuild from 'esbuild';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const watch = process.argv.includes('--watch');
const release = process.argv.includes('--release');
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const chromeDir = join(root, 'packages/chrome');
const chromeOutArg = process.argv.find((a) => a.startsWith('--chrome-out='));
const chromeDist = chromeOutArg ? join(root, chromeOutArg.slice('--chrome-out='.length)) : join(chromeDir, 'dist');
const testPorts = release ? '' : (process.env.CODEALONG_HUB_PORTS ?? '');
const vscodeDir = join(root, 'packages/vscode');

rmSync(chromeDist, { recursive: true, force: true });
const chromeOnly = process.argv.includes('--chrome-only');
if (!chromeOnly) rmSync(join(vscodeDir, 'dist'), { recursive: true, force: true });
mkdirSync(chromeDist, { recursive: true });

function writeChromeStatic() {
  cpSync(join(chromeDir, 'static'), chromeDist, { recursive: true });
  const manifest = JSON.parse(readFileSync(join(chromeDir, 'manifest.json'), 'utf8'));
  manifest.version = version;
  // The Chrome Web Store rejects manifests containing "key" and assigns its own extension ID.
  if (release) delete manifest.key;
  writeFileSync(join(chromeDist, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
}

const common = {
  bundle: true,
  sourcemap: release ? false : 'linked',
  logLevel: 'info',
  legalComments: release ? 'eof' : 'none',
  // Readable output: easier store review, and nothing to hide.
  minify: false,
  define: { __CODEALONG_TEST_PORTS__: JSON.stringify(testPorts) },
};

const allBuilds = [
  {
    ...common,
    entryPoints: { extension: join(vscodeDir, 'src/extension.ts') },
    outdir: join(vscodeDir, 'dist'),
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    // `ws` optionally uses these native addons and works without them.
    external: ['vscode', 'bufferutil', 'utf-8-validate'],
  },
  {
    ...common,
    entryPoints: {
      background: join(chromeDir, 'src/background/index.ts'),
      content: join(chromeDir, 'src/content/index.ts'),
      popup: join(chromeDir, 'src/popup/index.ts'),
      welcome: join(chromeDir, 'src/welcome/index.ts'),
    },
    outdir: chromeDist,
    platform: 'browser',
    format: 'iife',
    target: 'chrome116',
    plugins: [{ name: 'chrome-static', setup: (build) => build.onEnd(writeChromeStatic) }],
  },
];

const builds = chromeOnly ? allBuilds.filter((b) => b.platform === 'browser') : allBuilds;

if (watch) {
  const contexts = await Promise.all(builds.map((b) => esbuild.context(b)));
  await Promise.all(contexts.map((c) => c.watch()));
  console.log('Watching for changes… Reload the extension in chrome://extensions after edits.');
} else {
  await Promise.all(builds.map((b) => esbuild.build(b)));
  console.log(`Built CodeAlong ${version}${release ? ' (release)' : ''}.`);
}
