import { PRIVACY_URL, VSCODE_EXTENSION_URL } from '../shared/links';
import type { PopupRequest, ProbeResult } from '../shared/messages';

const icon = document.getElementById('vscode-icon')!;
const text = document.getElementById('vscode-status')!;
const help = document.getElementById('vscode-help')!;
(document.getElementById('vscode-link') as HTMLAnchorElement).href = VSCODE_EXTENSION_URL;
(document.getElementById('privacy-link') as HTMLAnchorElement).href = PRIVACY_URL;

async function check(): Promise<void> {
  const { vscode } = (await chrome.runtime.sendMessage({ type: 'popup:probe' } satisfies PopupRequest)) as ProbeResult;
  icon.textContent = vscode ? '✓' : '✗';
  icon.className = vscode ? 'ok' : 'bad';
  text.textContent = vscode
    ? 'VS Code is running with CodeAlong. You are all set.'
    : 'VS Code with CodeAlong was not found.';
  help.hidden = vscode;
}

void check();
setInterval(() => void check(), 3_000);
