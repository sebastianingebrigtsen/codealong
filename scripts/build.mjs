// Builds both extensions with esbuild.
//   node scripts/build.mjs          one-off build
//   node scripts/build.mjs --watch  rebuild on change
import * as esbuild from 'esbuild';
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeIcon } from './icons.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const watch = process.argv.includes('--watch');
const chromeDir = join(root, 'packages/chrome');
const chromeDist = join(chromeDir, 'dist');
const vscodeDir = join(root, 'packages/vscode');

rmSync(chromeDist, { recursive: true, force: true });
rmSync(join(vscodeDir, 'dist'), { recursive: true, force: true });
mkdirSync(join(chromeDist, 'icons'), { recursive: true });

function copyChromeStatic() {
  cpSync(join(chromeDir, 'static'), chromeDist, { recursive: true });
  for (const size of [16, 32, 48, 128]) writeFileSync(join(chromeDist, 'icons', `${size}.png`), makeIcon(size));
}

const common = { bundle: true, sourcemap: 'linked', logLevel: 'info', legalComments: 'none' };

const builds = [
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
    },
    outdir: chromeDist,
    platform: 'browser',
    format: 'iife',
    target: 'chrome116',
    plugins: [
      {
        name: 'copy-static',
        setup(build) {
          build.onEnd(() => copyChromeStatic());
        },
      },
    ],
  },
];

if (watch) {
  const contexts = await Promise.all(builds.map((b) => esbuild.context(b)));
  await Promise.all(contexts.map((c) => c.watch()));
  console.log('Watching for changes…');
} else {
  await Promise.all(builds.map((b) => esbuild.build(b)));
}
