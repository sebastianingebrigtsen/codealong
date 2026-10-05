// One version for the whole project: the root package.json. The workspace packages carry the
// same number (the VS Code Marketplace reads packages/vscode/package.json directly); the Chrome
// manifest gets it at build time.
//
//   npm run version:set -- 0.2.0   set the version everywhere
//   npm run version:set            print the version and check that all packages agree
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const FILES = [
  'package.json',
  'packages/protocol/package.json',
  'packages/chrome/package.json',
  'packages/vscode/package.json',
];

const read = (f) => JSON.parse(readFileSync(join(root, f), 'utf8'));

/** Returns the shared version, or null if the packages disagree. */
export function checkVersions() {
  const versions = FILES.map((f) => read(f).version);
  return versions.every((v) => v === versions[0]) ? versions[0] : null;
}

function setVersion(version) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`"${version}" is not a plain x.y.z version`);
  for (const f of FILES) {
    const pkg = read(f);
    pkg.version = version;
    for (const deps of [pkg.dependencies, pkg.devDependencies]) {
      if (deps?.['@codealong/protocol']) deps['@codealong/protocol'] = version;
    }
    writeFileSync(join(root, f), `${JSON.stringify(pkg, null, 2)}\n`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const next = process.argv[2];
  if (next) {
    setVersion(next);
    console.log(`Version set to ${next}. Run \`npm install\` to update package-lock.json, then add a CHANGELOG entry.`);
  } else {
    const v = checkVersions();
    if (!v) {
      console.error('Versions differ:', FILES.map((f) => `${f}=${read(f).version}`).join(', '));
      process.exit(1);
    }
    console.log(v);
  }
}
