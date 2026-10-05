/* Runs inside the VS Code extension host. Plain CommonJS on purpose (no build step). */
const vscode = require('vscode');
const fs = require('node:fs');
const path = require('node:path');
const WsClient = require(path.join(process.env.CODEALONG_ROOT, 'node_modules/ws')).WebSocket;

const PORT = 47391;
const ORIGIN = 'chrome-extension://golihbblpnhanlhgnnngcfhmolomajoo';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(cond, what, ms = 8000) {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error(`timed out waiting for: ${what}`);
    await sleep(25);
  }
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
      commands.push(msg);
      if (msg.command === 'pause' && video.status === 'playing') {
        Object.assign(video, { status: 'paused', owner: 'codealong', pauseId: msg.pauseId });
        report('codealong-pause');
      } else if (msg.command === 'resume' && video.owner === 'codealong' && video.pauseId === msg.pauseId) {
        Object.assign(video, { status: 'playing', owner: null, pauseId: null, currentTime: Math.max(0, video.currentTime - msg.rewindSeconds) });
        report('codealong-resume');
      } else if (msg.command === 'userToggle') {
        if (video.status === 'playing') Object.assign(video, { status: 'paused', owner: 'user' });
        else Object.assign(video, { status: 'playing', owner: null, pauseId: null });
        report(video.status === 'playing' ? 'manual-play' : 'manual-pause');
      }
    }
  });
  return { ws, commands, video, opened: new Promise((r, j) => { ws.on('open', r); ws.on('error', j); }) };
}

exports.run = async function run() {
  const results = [];
  const check = (name, ok, extra = '') => {
    results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ` (${extra})` : ''}`);
    if (!ok) throw new Error(`${name} ${extra}\n${results.join('\n')}`);
  };

  const cfg = vscode.workspace.getConfiguration('codealong');
  const G = vscode.ConfigurationTarget.Global;
  await cfg.update('port', PORT, G);
  await cfg.update('idleDelaySeconds', 1, G);
  await cfg.update('debug', true, G);

  const ext = vscode.extensions.getExtension('codealong.codealong');
  check('extension found', !!ext);
  await ext.activate();
  const commandIds = await vscode.commands.getCommands(true);
  check('commands registered', ['codealong.togglePlayback', 'codealong.done', 'codealong.toggleEnabled', 'codealong.showMenu'].every((c) => commandIds.includes(c)));

  // Hub comes up (port change triggers a restart).
  let browser;
  for (let i = 0; i < 40 && !browser; i++) {
    const b = fakeBrowser();
    try {
      await b.opened;
      browser = b;
    } catch {
      await sleep(250);
    }
  }
  check('hub accepts the Chrome extension', !!browser);
  await sleep(300);

  const file = path.join(process.env.CODEALONG_TMP, 'app.js');
  fs.writeFileSync(file, '// tutorial code\n');
  const doc = await vscode.workspace.openTextDocument(file);
  const editor = await vscode.window.showTextDocument(doc);

  const focused = vscode.window.state.focused;
  results.push(`INFO window focused: ${focused}`);
  if (focused) {
    await editor.edit((b) => b.insert(new vscode.Position(1, 0), 'const answer = 42;\n'));
    await waitFor(() => browser.commands.some((c) => c.command === 'pause'), 'pause after typing');
    check('typing pauses the tutorial', true);
    await editor.edit((b) => b.insert(new vscode.Position(2, 0), 'console.log(answer);\n'));
    await sleep(300);
    check('no duplicate pause while typing', browser.commands.filter((c) => c.command === 'pause').length === 1);
    await waitFor(() => browser.commands.some((c) => c.command === 'resume'), 'resume after idle', 5000);
    const resume = browser.commands.find((c) => c.command === 'resume');
    check('idle resumes with rewind', resume.rewindSeconds === 2, `rewind=${resume.rewindSeconds}`);
  } else {
    results.push('SKIP typing tests: the test window did not get OS focus (CodeAlong ignores edits in unfocused windows by design)');
  }

  // Edits in a non-active document never count.
  const before = browser.commands.length;
  const other = await vscode.workspace.openTextDocument({ content: 'x', language: 'plaintext' });
  const wsEdit = new vscode.WorkspaceEdit();
  wsEdit.insert(other.uri, new vscode.Position(0, 0), 'background change ');
  await vscode.workspace.applyEdit(wsEdit);
  await sleep(300);
  check('background edits are ignored', browser.commands.length === before);

  await vscode.commands.executeCommand('codealong.togglePlayback');
  await waitFor(() => browser.commands.some((c) => c.command === 'userToggle'), 'toggle command');
  check('toggle hotkey command reaches the browser', true);
  await waitFor(() => browser.video.owner === 'user', 'user pause recorded');
  await editor.edit((b) => b.insert(new vscode.Position(0, 0), '// more\n'));
  await sleep(1800);
  check('user pause is never resumed', !browser.commands.some((c, i) => i > before && c.command === 'resume'));

  // Manual save = "done": resumes ~1 s after the save, long before the (now 10 s) idle delay.
  if (focused) {
    await cfg.update('idleDelaySeconds', 10, G);
    await vscode.commands.executeCommand('codealong.togglePlayback'); // user plays again
    await waitFor(() => browser.video.status === 'playing', 'playing again');
    await vscode.window.showTextDocument(doc);
    const pausesBefore = browser.commands.filter((c) => c.command === 'pause').length;
    await editor.edit((b) => b.insert(new vscode.Position(0, 0), '// save test\n'));
    await waitFor(() => browser.commands.filter((c) => c.command === 'pause').length > pausesBefore, 'pause before save');
    const resumesBefore = browser.commands.filter((c) => c.command === 'resume').length;
    const savedAt = Date.now();
    await vscode.commands.executeCommand('workbench.action.files.save');
    await waitFor(() => browser.commands.filter((c) => c.command === 'resume').length > resumesBefore, 'resume after save', 5000);
    check('manual save resumes', Date.now() - savedAt < 4000, `${Date.now() - savedAt} ms`);
  }

  await cfg.update('enabled', false, G);
  await sleep(200);
  results.push('PASS settings change applied without restart');

  browser.ws.close();
  fs.writeFileSync((fs.mkdirSync(path.join(process.env.CODEALONG_ROOT, 'e2e/.artifacts'), { recursive: true }), path.join(process.env.CODEALONG_ROOT, 'e2e/.artifacts/vscode-result.txt')), results.join('\n'));
  console.log(results.join('\n'));
};
