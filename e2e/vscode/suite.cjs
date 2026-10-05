/* Runs inside the VS Code extension host. Plain CommonJS on purpose (no build step).
 *
 * Design rule: no assertion may depend on how fast this machine is. Every edit goes through the
 * VS Code renderer, which can stall for seconds on a small headless CI machine. So:
 *  - checks that must not see an automatic resume use a long idle delay (LONG_IDLE_S);
 *  - the idle-resume check uses a short delay and asserts a lower bound (never early) as well as
 *    eventually resuming;
 *  - waits are generous (waiting longer never makes a check weaker).
 */
const vscode = require('vscode');
const fs = require('node:fs');
const path = require('node:path');
const WsClient = require(path.join(process.env.CODEALONG_ROOT, 'node_modules/ws')).WebSocket;

const PORT = 48395; // matches CODEALONG_HUB_PORTS in run.mjs
const ORIGIN = 'chrome-extension://golihbblpnhanlhgnnngcfhmolomajoo';
const WAIT_MS = 30_000;
const LONG_IDLE_S = 60;
const SHORT_IDLE_S = 2;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(cond, what, ms = WAIT_MS) {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error(`timed out after ${ms} ms waiting for: ${what}`);
    await sleep(25);
  }
  return Date.now() - start;
}

/** A fake Chrome extension: reports a video and obeys commands like the real VideoController. */
function fakeBrowser() {
  const commands = [];
  const video = { status: 'playing', owner: null, pauseId: null, currentTime: 30, duration: 600 };
  const ws = new WsClient(`ws://127.0.0.1:${PORT}`, { headers: { Origin: ORIGIN } });
  const report = (cause) => ws.send(JSON.stringify({ type: 'video', video, cause }));
  ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', protocol: 1, role: 'browser', client: 'e2e' })));
  ws.on('message', (data) => {
    const msg = JSON.parse(String(data));
    if (msg.type === 'welcome') {
      ws.send(JSON.stringify({ type: 'tutorial', tutorial: { tabId: 1, title: 'E2E', host: 'youtube.com' } }));
      report('play');
    } else if (msg.type === 'ping') {
      ws.send('{"type":"pong"}');
    } else if (msg.type === 'command') {
      commands.push({ ...msg, at: Date.now() });
      if (msg.command === 'pause' && video.status === 'playing') {
        Object.assign(video, { status: 'paused', owner: 'codealong', pauseId: msg.pauseId });
        report('codealong-pause');
      } else if (msg.command === 'resume' && video.owner === 'codealong' && video.pauseId === msg.pauseId) {
        Object.assign(video, {
          status: 'playing',
          owner: null,
          pauseId: null,
          currentTime: Math.max(0, video.currentTime - msg.rewindSeconds),
        });
        report('codealong-resume');
      } else if (msg.command === 'userToggle') {
        if (video.status === 'playing') Object.assign(video, { status: 'paused', owner: 'user' });
        else Object.assign(video, { status: 'playing', owner: null, pauseId: null });
        report(video.status === 'playing' ? 'manual-play' : 'manual-pause');
      }
    }
  });
  return {
    ws,
    commands,
    video,
    count: (command) => commands.filter((c) => c.command === command).length,
    last: (command) => commands.filter((c) => c.command === command).at(-1),
    opened: new Promise((r, j) => {
      ws.on('open', r);
      ws.on('error', j);
    }),
  };
}

exports.run = async function run() {
  const results = [];
  const save = () => fs.writeFileSync(process.env.CODEALONG_E2E_RESULTS, results.join('\n'));
  const check = (name, ok, extra = '') => {
    results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ` (${extra})` : ''}`);
    save();
    if (!ok) throw new Error(`${name} ${extra}`);
  };
  const step = async (name, fn) => {
    try {
      const extra = await fn();
      check(name, true, extra ?? '');
    } catch (err) {
      if (!results.at(-1)?.startsWith(`FAIL ${name}`)) check(name, false, err.message);
      throw err;
    }
  };

  results.push(`INFO VS Code ${vscode.version}, ${process.platform}`);
  save();

  const cfg = vscode.workspace.getConfiguration('codealong');
  const G = vscode.ConfigurationTarget.Global;
  const setIdle = async (seconds) => {
    await cfg.update('idleDelaySeconds', seconds, G);
    await sleep(300); // let the extension's configuration listener apply it
  };
  await setIdle(LONG_IDLE_S);
  await cfg.update('debugLogging', true, G);

  const manifest = JSON.parse(
    fs.readFileSync(path.join(process.env.CODEALONG_ROOT, 'packages/vscode/package.json'), 'utf8'),
  );
  const ext = vscode.extensions.getExtension(`${manifest.publisher}.${manifest.name}`);
  check('extension found', !!ext);
  await step('extension activates', () => ext.activate());

  await step('commands registered', async () => {
    const ids = await vscode.commands.getCommands(true);
    const missing = manifest.contributes.commands.map((c) => c.command).filter((c) => !ids.includes(c));
    if (missing.length) throw new Error(`missing: ${missing.join(', ')}`);
  });

  await step('walkthrough opens', () => vscode.commands.executeCommand('codealong.openWalkthrough'));

  let browser;
  await step('hub accepts the Chrome extension', async () => {
    const start = Date.now();
    while (!browser && Date.now() - start < WAIT_MS) {
      const b = fakeBrowser();
      try {
        await b.opened;
        browser = b;
      } catch {
        await sleep(250);
      }
    }
    if (!browser) throw new Error('no connection');
    await waitFor(() => browser.commands.length === 0 && browser.ws.readyState === 1, 'connection ready');
  });

  const file = path.join(process.env.CODEALONG_TMP, 'app.js');
  fs.writeFileSync(file, '// tutorial code\n');
  const doc = await vscode.workspace.openTextDocument(file);
  let editor = await vscode.window.showTextDocument(doc);
  const type = async (text) => {
    editor = await vscode.window.showTextDocument(doc);
    await editor.edit((b) => b.insert(new vscode.Position(0, 0), text));
  };

  // CodeAlong deliberately ignores edits in a window without OS focus. Give the window manager a
  // moment, then either run the typing checks or (locally only) report why they could not run.
  await waitFor(() => vscode.window.state.focused, 'window focus', 5_000).catch(() => undefined);
  const focused = vscode.window.state.focused;
  results.push(`INFO window focused: ${focused}`);
  if (!focused && process.env.CODEALONG_E2E_REQUIRE_FOCUS) {
    check('window has OS focus (required in CI)', false);
  }

  if (focused) {
    // Long idle delay: whatever the machine's speed, nothing may resume during these checks.
    await step('typing pauses the tutorial', async () => {
      await type('const answer = 42;\n');
      return `${await waitFor(() => browser.count('pause') === 1, 'pause after typing')} ms`;
    });
    await step('more typing does not pause again', async () => {
      for (const line of ['let a = 1;\n', 'let b = 2;\n', 'let c = 3;\n']) await type(line);
      await sleep(500);
      if (browser.count('pause') !== 1 || browser.count('resume') !== 0) {
        throw new Error(`pauses=${browser.count('pause')} resumes=${browser.count('resume')}`);
      }
    });
    await step('"I\'m done" resumes with rewind', async () => {
      await vscode.commands.executeCommand('codealong.done');
      await waitFor(() => browser.count('resume') === 1, 'resume after done');
      const r = browser.last('resume');
      if (r.rewindSeconds !== 2) throw new Error(`rewind=${r.rewindSeconds}`);
    });

    // Short idle delay: resumes on its own, but never before the delay has passed.
    await step('idle resumes, not before the idle delay', async () => {
      await setIdle(SHORT_IDLE_S);
      await type('// idle test\n'); // a single edit: it both pauses and starts the idle timer
      await waitFor(() => browser.count('pause') === 2, 'pause before idle');
      await waitFor(() => browser.count('resume') === 2, 'resume after idle');
      const r = browser.last('resume');
      // The pause command is sent in the same instant the idle timer starts, so measuring from
      // its arrival is independent of how slow the editor was. 100 ms slack for timer granularity.
      const waited = r.at - browser.last('pause').at;
      if (waited < SHORT_IDLE_S * 1000 - 100) throw new Error(`resumed after only ${waited} ms`);
      if (r.rewindSeconds !== 2) throw new Error(`rewind=${r.rewindSeconds}`);
      return `${waited} ms after the pause`;
    });

    // Long idle again: a save is the only thing that can resume within the wait below.
    await step('manual save resumes', async () => {
      await setIdle(LONG_IDLE_S);
      await type('// save test\n');
      await waitFor(() => browser.count('pause') === 3, 'pause before save');
      const savedAt = Date.now();
      await vscode.commands.executeCommand('workbench.action.files.save');
      await waitFor(() => browser.count('resume') === 3, 'resume after save', (LONG_IDLE_S / 2) * 1000);
      return `${Date.now() - savedAt} ms`;
    });
  } else {
    results.push(
      'SKIP typing checks: the test window has no OS focus (edits in unfocused windows are ignored by design)',
    );
    save();
  }

  await step('edits outside the active editor are ignored', async () => {
    const before = browser.commands.length;
    const other = await vscode.workspace.openTextDocument({ content: 'x', language: 'plaintext' });
    const wsEdit = new vscode.WorkspaceEdit();
    wsEdit.insert(other.uri, new vscode.Position(0, 0), 'background change ');
    await vscode.workspace.applyEdit(wsEdit);
    await sleep(500);
    if (browser.commands.length !== before) throw new Error('a background edit sent a command');
  });

  await step('toggle shortcut pauses as a user action', async () => {
    await vscode.commands.executeCommand('codealong.togglePlayback');
    await waitFor(() => browser.video.owner === 'user', 'user pause recorded');
  });

  await step('a user pause is never resumed', async () => {
    await setIdle(SHORT_IDLE_S);
    const resumes = browser.count('resume');
    if (focused) await type('// typing while paused by the user\n');
    await vscode.commands.executeCommand('workbench.action.files.save');
    await sleep(SHORT_IDLE_S * 1000 * 3);
    if (browser.count('resume') !== resumes || browser.video.status !== 'paused') {
      throw new Error('CodeAlong resumed a video the user paused');
    }
  });

  await step('turning CodeAlong off applies immediately', async () => {
    await cfg.update('enabled', false, G);
    await sleep(300);
    await vscode.commands.executeCommand('codealong.togglePlayback'); // user plays
    await waitFor(() => browser.video.status === 'playing', 'playing');
    const pauses = browser.count('pause');
    if (focused) await type('// typing while disabled\n');
    await sleep(500);
    if (browser.count('pause') !== pauses) throw new Error('paused while disabled');
  });

  browser.ws.close();
  save();
};
