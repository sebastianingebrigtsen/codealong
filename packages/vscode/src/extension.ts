import * as vscode from 'vscode';
import { createThrottle, isTrackedDocument, isUserEdit } from './activity';
import { HubNode } from './hub/hubNode';
import { loadOrCreateEditorToken } from './hub/token';
import { readSettings, type ExtensionSettings } from './settings';
import { StatusBar } from './statusBar';

/** Edits are forwarded at most this often; the first keystroke always goes out immediately. */
const EDIT_THROTTLE_MS = 200;

let currentNode: HubNode | null = null;

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('CodeAlong');
  const statusBar = new StatusBar();
  context.subscriptions.push(output, statusBar);

  let settings: ExtensionSettings = loadSettings();
  const info = (message: string) => output.appendLine(`${timestamp()} ${message}`);
  const debug = (message: string) => {
    if (settings.debug) output.appendLine(`${timestamp()} ${message}`);
  };

  let token: string;
  try {
    token = loadOrCreateEditorToken();
  } catch (err) {
    info(`Could not create token file: ${(err as Error).message}`);
    statusBar.update(null, 'error', 'Could not create ~/.codealong/editor-token');
    return;
  }

  const createNode = () =>
    new HubNode(
      {
        port: settings.port,
        editorToken: token,
        allowedOrigins: () => settings.allowedOrigins,
        settings: () => settings.core,
      },
      {
        onStatus: (status, role) => statusBar.update(status, role, node.lastError),
        onEvent: (event, detail) => debug(detail ? `${event} (${detail})` : event),
        info,
      },
    );
  let node = createNode();
  node.start();
  currentNode = node;

  // --- Activity signals (never the code itself) ---------------------------------------------

  const editThrottle = createThrottle(EDIT_THROTTLE_MS);
  const manualSaves = new Set<string>();

  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((e) => {
      const ctx = { activeDocument: vscode.window.activeTextEditor?.document, windowFocused: vscode.window.state.focused };
      if (isUserEdit(e, ctx) && editThrottle()) node.activity('edit');
    }),
    // Only explicit saves (Cmd/Ctrl+S) count. Auto-save fires constantly and must not resume the video.
    vscode.workspace.onWillSaveTextDocument((e) => {
      if (e.reason === vscode.TextDocumentSaveReason.Manual && isTrackedDocument(e.document)) {
        manualSaves.add(e.document.uri.toString());
      }
    }),
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (manualSaves.delete(doc.uri.toString())) node.activity('save');
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration('codealong')) return;
      const previousPort = settings.port;
      settings = loadSettings();
      if (settings.port !== previousPort) {
        info(`Port changed to ${settings.port}; restarting`);
        const old = node;
        node = createNode();
        currentNode = node;
        void old.stop().then(() => node.start());
      } else {
        node.settingsChanged();
      }
    }),
  );

  // --- Commands --------------------------------------------------------------------------------

  context.subscriptions.push(
    vscode.commands.registerCommand('codealong.togglePlayback', () => node.control('toggle')),
    vscode.commands.registerCommand('codealong.done', () => node.control('done')),
    vscode.commands.registerCommand('codealong.toggleEnabled', async () => {
      await vscode.workspace
        .getConfiguration('codealong')
        .update('enabled', !settings.core.enabled, vscode.ConfigurationTarget.Global);
    }),
    vscode.commands.registerCommand('codealong.showLog', () => output.show(true)),
    vscode.commands.registerCommand('codealong.showMenu', async () => {
      const items: (vscode.QuickPickItem & { command: string; args?: unknown[] })[] = [
        { label: '$(debug-continue) Pause / resume tutorial', description: 'Ctrl+Alt+P', command: 'codealong.togglePlayback' },
        { label: "$(check) I'm done – continue tutorial", description: 'Ctrl+Alt+D', command: 'codealong.done' },
        {
          label: settings.core.enabled ? '$(circle-slash) Turn CodeAlong off' : '$(play-circle) Turn CodeAlong on',
          command: 'codealong.toggleEnabled',
        },
        { label: '$(gear) Settings', command: 'workbench.action.openSettings', args: ['codealong'] },
        { label: '$(output) Show log', command: 'codealong.showLog' },
      ];
      const pick = await vscode.window.showQuickPick(items, { placeHolder: 'CodeAlong' });
      if (pick) await vscode.commands.executeCommand(pick.command, ...(pick.args ?? []));
    }),
  );

  info(`CodeAlong started (debug logging ${settings.debug ? 'on' : 'off'})`);
}

export async function deactivate(): Promise<void> {
  // Release the port promptly so another VS Code window can take over as hub.
  await currentNode?.stop();
  currentNode = null;
}

function loadSettings(): ExtensionSettings {
  return readSettings(vscode.workspace.getConfiguration('codealong'));
}

function timestamp(): string {
  return new Date().toLocaleTimeString();
}
