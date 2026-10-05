// Runs the VS Code extension inside a real VS Code instance (isolated profile) and drives it
// with a simulated Chrome extension over the real local WebSocket.
//   node e2e/vscode/run.mjs                      downloads a VS Code build to .vscode-test/
//   CODEALONG_VSCODE=/path/to/Electron node ...  uses an installed VS Code instead
import { runTests } from '@vscode/test-electron';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// When launched from inside VS Code (integrated terminal, extensions), this variable would make
// the VS Code binary behave like plain Node.
delete process.env.ELECTRON_RUN_AS_NODE;

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const profile = mkdtempSync(join(tmpdir(), 'codealong-vscode-'));
try {
  await runTests({
    vscodeExecutablePath: process.env.CODEALONG_VSCODE || undefined,
    extensionDevelopmentPath: join(root, 'packages/vscode'),
    extensionTestsPath: join(here, 'suite.cjs'),
    launchArgs: ['--disable-extensions', '--user-data-dir', join(profile, 'data'), '--disable-workspace-trust', profile],
    extensionTestsEnv: { CODEALONG_ROOT: root, CODEALONG_TMP: profile },
  });
  console.log('VS Code extension e2e: passed');
} catch (err) {
  console.error('VS Code extension e2e: FAILED', err);
  process.exitCode = 1;
} finally {
  rmSync(profile, { recursive: true, force: true });
}
