import * as vscode from 'vscode';
import { describeStatus, type HubStatus, type StatusPhase } from '@codealong/protocol';
import type { NodeRole } from './hub/hubNode';

const ICONS: Record<StatusPhase, string> = {
  disabled: '$(circle-slash)',
  waitingForBrowser: '$(plug)',
  noTutorial: '$(check)',
  noVideo: '$(question)',
  playing: '$(play)',
  coding: '$(edit)',
  codingWhilePlaying: '$(edit)',
  waitingToResume: '$(debug-pause)',
  pausedByUser: '$(debug-pause)',
  ended: '$(pass)',
};

const TOOLTIPS: Partial<Record<StatusPhase, string>> = {
  waitingForBrowser: 'Open a tutorial in Chrome and click "Follow this tab" in the CodeAlong extension.',
  noTutorial: 'Chrome is connected. Choose a tutorial tab with "Follow this tab".',
  noVideo: 'No playable video found in the tutorial tab yet.',
  coding: 'Paused by CodeAlong while you code.',
  waitingToResume: 'Paused by CodeAlong. Save, press the "done" hotkey or play the video to continue.',
  pausedByUser: 'You paused the video. CodeAlong will not resume it automatically.',
  codingWhilePlaying: 'You started the video while coding, so CodeAlong lets it play.',
};

export class StatusBar implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  private status: HubStatus | null = null;
  private role: NodeRole = 'starting';
  private error: string | null = null;
  private countdown: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.item.command = 'codealong.showMenu';
    this.render();
    this.item.show();
  }

  update(status: HubStatus | null, role: NodeRole, error: string | null): void {
    // Followers get a null status until the hub's first broadcast; keep showing the last one.
    if (status || role !== 'follower') this.status = status;
    this.role = role;
    this.error = error;
    this.render();
    const needsCountdown = !!this.status?.resumeAt;
    if (needsCountdown && !this.countdown) this.countdown = setInterval(() => this.render(), 250);
    if (!needsCountdown && this.countdown) {
      clearInterval(this.countdown);
      this.countdown = null;
    }
  }

  private render(): void {
    const item = this.item;
    if (this.role === 'error') {
      item.text = '$(error) CodeAlong: Error';
      item.tooltip = this.error ?? 'CodeAlong could not start its local hub.';
      return;
    }
    if (!this.status) {
      item.text = this.role === 'follower' ? '$(sync) CodeAlong: Connected' : '$(sync~spin) CodeAlong';
      item.tooltip = 'Starting…';
      return;
    }
    const s = this.status;
    item.text = `${ICONS[s.phase]} CodeAlong: ${describeStatus(s, Date.now())}`;
    const lines = [TOOLTIPS[s.phase] ?? '', s.tutorialTitle ? `Tutorial: ${s.tutorialTitle}` : ''];
    if (this.role === 'follower') lines.push('(Hub runs in another VS Code window.)');
    lines.push('Click for options.');
    item.tooltip = lines.filter(Boolean).join('\n');
  }

  dispose(): void {
    if (this.countdown) clearInterval(this.countdown);
    this.item.dispose();
  }
}
