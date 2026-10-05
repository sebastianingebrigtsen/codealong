// Runs the VS Code extension inside a real VS Code instance (isolated profile) and drives it
// with a simulated Chrome extension over the real local WebSocket.
//
//   node e2e/vscode/run.mjs                        pinned "latest tested" VS Code (downloaded)
//   CODEALONG_VSCODE_VERSION=minimum node ...      oldest supported VS Code (engines.vscode)
//   CODEALONG_VSCODE_VERSION=stable node ...       whatever is newest today
//   CODEALONG_VSCODE=/path/to/Code node ...        an installed VS Code executable instead
//
// Downloads are cached in .vscode-test/. Results go to e2e/.artifacts/vscode-<version>/.
import { downloadAndUnzipVSCode, runTests } from '@vscode/test-electron';
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveVersion } from './versions.mjs';

// When launched from inside VS Code (integrated terminal, extensions), this variable would make
// the VS Code binary behave like plain Node.
delete process.env.ELECTRON_RUN_AS_NODE;

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const installed = process.env.CODEALONG_VSCODE;
const version = installed ? 'installed' : resolveVersion(process.env.CODEALONG_VSCODE_VERSION);
const artifacts = join(root, 'e2e/.artifacts', `vscode-${version}`);
rmSync(artifacts, { recursive: true, force: true });
mkdirSync(artifacts, { recursive: true });
const resultsFile = join(artifacts, 'results.txt');
const inCi = !!process.env.CI;
// Short path on purpose: VS Code creates IPC sockets in the user data dir, and Unix socket paths
// are limited to ~104 characters (macOS).
const profile = mkdtempSync(join(tmpdir(), 'cavsc-'));
mkdirSync(join(profile, 'workspace'));

let passed = false;
try {
  const vscodeExecutablePath =
    installed || (await downloadAndUnzipVSCode({ version, cachePath: join(root, '.vscode-test') }));
  await runTests({
    vscodeExecutablePath,
    extensionDevelopmentPath: join(root, 'packages/vscode'),
    extensionTestsPath: join(here, 'suite.cjs'),
    launchArgs: [
      '--disable-extensions',
      '--disable-workspace-trust',
      // Keep first-run UI (welcome page, release notes webview) and GPU work off the renderer:
      // on a small headless CI machine they can stall it for seconds.
      '--skip-welcome',
      '--skip-release-notes',
      '--disable-updates',
      '--disable-telemetry',
      '--disable-gpu',
      '--user-data-dir',
      join(profile, 'data'),
      join(profile, 'workspace'),
    ],
    extensionTestsEnv: {
      CODEALONG_ROOT: root,
      CODEALONG_TMP: join(profile, 'workspace'),
      CODEALONG_E2E_RESULTS: resultsFile,
      // Test-only port, so a real CodeAlong running on this machine is never touched.
      CODEALONG_HUB_PORTS: '48395',
      // In CI every check must run: a window without OS focus is a failure, not a skip.
      // CODEALONG_E2E_REQUIRE_FOCUS=0 opts out (used only by the non-blocking compatibility job).
      CODEALONG_E2E_REQUIRE_FOCUS: (process.env.CODEALONG_E2E_REQUIRE_FOCUS ?? (inCi ? '1' : '')) === '1' ? '1' : '',
    },
  });
  passed = true;
} catch (err) {
  console.error(`VS Code ${version} extension e2e: FAILED`, err);
  process.exitCode = 1;
} finally {
  const results = existsSync(resultsFile) ? readFileSync(resultsFile, 'utf8').trim() : '(the suite did not start)';
  console.log(`\nVS Code ${version} – results:\n${results}\n`);
  if (process.env.GITHUB_ACTIONS) {
    // Annotations are visible on the run page without downloading logs.
    const lines = results.split('\n');
    const failed = lines.filter((l) => l.startsWith('FAIL'));
    for (const l of failed) console.log(`::error title=VS Code ${version} e2e::${l}`);
    if (!passed && failed.length === 0) console.log(`::error title=VS Code ${version} e2e::${lines.at(-1)}`);
    if (process.env.GITHUB_STEP_SUMMARY) {
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### VS Code ${version}\n\n\`\`\`\n${results}\n\`\`\`\n`);
    }
  }
  console.log(`VS Code ${version} extension e2e: ${passed ? 'passed' : 'FAILED'}`);
  // Keep VS Code's own logs for the CI artifact on failure.
  if (!passed && existsSync(join(profile, 'data/logs')))
    cpSync(join(profile, 'data/logs'), join(artifacts, 'logs'), { recursive: true });
  rmSync(profile, { recursive: true, force: true });
}
