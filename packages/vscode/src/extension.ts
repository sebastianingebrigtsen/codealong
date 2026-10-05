import * as vscode from 'vscode';
import { HUB_PORTS, parsePortList } from '@codealong/protocol';
import { createThrottle, isTrackedDocument, isUserEdit } from './activity';
import { HubNode } from './hub/hubNode';
import { loadOrCreateEditorToken } from './hub/token';
import { CHROME_EXTENSION_URL } from './links';
import { ALLOWED_ORIGINS, readSettings, type ExtensionSettings } from './settings';
import { StatusBar } from './statusBar';

/** Edits are forwarded at most this often; the first keystroke always goes out immediately. */
const EDIT_THROTTLE_MS = 200;
const WELCOMED_KEY = 'codealong.welcomed';

let currentNode: HubNode | null = null;

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('CodeAlong');
  const statusBar = new StatusBar();
  context.subscriptions.push(output, statusBar);

  let settings: ExtensionSettings = loadSettings();
  const info = (message: string) => output.appendLine(`${timestamp()} ${message}`);
  const debug = (message: string) => {
    if (settings.debugLogging) output.appendLine(`${timestamp()} ${message}`);
  };

  registerCommands(
    context,
    () => currentNode,
    () => settings,
    output,
  );

  let warnedIncompatible = false;
  let token: string;
  try {
    token = loadOrCreateEditorToken();
  } catch (err) {
    const message = `CodeAlong could not create its local key file: ${(err as Error).message}`;
    info(message);
    statusBar.update(null, 'error', message);
    return;
  }

  const node = new HubNode(
    {
      // CODEALONG_HUB_PORTS is for automated tests only; users never set it.
      ports: parsePortList(process.env.CODEALONG_HUB_PORTS) ?? HUB_PORTS,
      editorToken: token,
      allowedOrigins: () => ALLOWED_ORIGINS,
      settings: () => settings.core,
    },
    {
      onStatus: (status, role) => statusBar.update(status, role, node.lastError),
      onEvent: (event, detail) => debug(detail ? `${event} (${detail})` : event),
      info,
      onIncompatible: () => {
        if (warnedIncompatible) return;
        warnedIncompatible = true;
        void vscode.window.showWarningMessage(
          'The CodeAlong extensions in Chrome and VS Code are different versions and cannot work together. Update both to the latest version.',
        );
      },
    },
  );
  node.start();
  currentNode = node;

  // --- Activity signals (never the code itself) ---------------------------------------------

  const editThrottle = createThrottle(EDIT_THROTTLE_MS);
  const manualSaves = new Set<string>();

  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((e) => {
      const ctx = {
        activeDocument: vscode.window.activeTextEditor?.document,
        windowFocused: vscode.window.state.focused,
      };
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
      settings = loadSettings();
      node.settingsChanged();
    }),
  );

  info(`CodeAlong ${String(context.extension.packageJSON.version)} started.`);
  void showWelcomeOnce(context);
}

export async function deactivate(): Promise<void> {
  // Release the port promptly so another VS Code window can take over.
  await currentNode?.stop();
  currentNode = null;
}

function registerCommands(
  context: vscode.ExtensionContext,
  node: () => HubNode | null,
  settings: () => ExtensionSettings,
  output: vscode.OutputChannel,
): void {
  const mac = process.platform === 'darwin';
  const keys = { toggle: mac ? '⌃⌥P' : 'Ctrl+Alt+P', done: mac ? '⌃⌥D' : 'Ctrl+Alt+D' };

  context.subscriptions.push(
    vscode.commands.registerCommand('codealong.togglePlayback', () => node()?.control('toggle')),
    vscode.commands.registerCommand('codealong.done', () => node()?.control('done')),
    vscode.commands.registerCommand('codealong.toggleEnabled', async () => {
      const enabled = !settings().core.enabled;
      await vscode.workspace
        .getConfiguration('codealong')
        .update('enabled', enabled, vscode.ConfigurationTarget.Global);
      void vscode.window.setStatusBarMessage(enabled ? 'CodeAlong turned on' : 'CodeAlong turned off', 2_500);
    }),
    vscode.commands.registerCommand('codealong.showLog', () => output.show(true)),
    vscode.commands.registerCommand('codealong.getChromeExtension', () =>
      vscode.env.openExternal(vscode.Uri.parse(CHROME_EXTENSION_URL)),
    ),
    vscode.commands.registerCommand('codealong.openWalkthrough', () =>
      vscode.commands.executeCommand(
        'workbench.action.openWalkthrough',
        `${context.extension.id}#codealong.gettingStarted`,
        false,
      ),
    ),
    vscode.commands.registerCommand('codealong.showMenu', async () => {
      const enabled = settings().core.enabled;
      const items: (vscode.QuickPickItem & { command: string; args?: unknown[] })[] = [
        {
          label: '$(debug-continue) Pause or Play Tutorial',
          description: keys.toggle,
          command: 'codealong.togglePlayback',
        },
        { label: "$(check) I'm Done – Continue Tutorial", description: keys.done, command: 'codealong.done' },
        {
          label: enabled ? '$(circle-slash) Turn Off CodeAlong' : '$(play-circle) Turn On CodeAlong',
          command: 'codealong.toggleEnabled',
        },
        { label: '$(gear) Settings', command: 'workbench.action.openSettings', args: ['@ext:' + context.extension.id] },
        { label: '$(book) How CodeAlong Works', command: 'codealong.openWalkthrough' },
        { label: '$(globe) Get the Chrome Extension', command: 'codealong.getChromeExtension' },
        { label: '$(output) Show Log', command: 'codealong.showLog' },
      ];
      const pick = await vscode.window.showQuickPick(items, { placeHolder: 'CodeAlong' });
      if (pick) await vscode.commands.executeCommand(pick.command, ...(pick.args ?? []));
    }),
  );
}

/** One short, dismissible hint on first install. Everything else lives in the walkthrough. */
async function showWelcomeOnce(context: vscode.ExtensionContext): Promise<void> {
  if (context.globalState.get<boolean>(WELCOMED_KEY)) return;
  await context.globalState.update(WELCOMED_KEY, true);
  const choice = await vscode.window.showInformationMessage(
    'CodeAlong is installed. Add the CodeAlong extension to Chrome, then click "Follow this tab" on a tutorial.',
    'Get Chrome Extension',
    'How It Works',
  );
  if (choice === 'Get Chrome Extension') await vscode.commands.executeCommand('codealong.getChromeExtension');
  if (choice === 'How It Works') await vscode.commands.executeCommand('codealong.openWalkthrough');
}

function loadSettings(): ExtensionSettings {
  return readSettings(vscode.workspace.getConfiguration('codealong'));
}

function timestamp(): string {
  return new Date().toLocaleTimeString();
}
