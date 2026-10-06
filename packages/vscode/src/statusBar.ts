import * as vscode from 'vscode';
import { describeSettings, describeStatus, type HubStatus, type StatusPhase } from '@codealong/protocol';
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
  waitingForBrowser:
    'Not connected to Chrome yet. In Chrome, open a tutorial, click the CodeAlong toolbar icon and choose "Follow this tab".',
  noTutorial: 'Connected to Chrome. Open a tutorial and choose "Follow this tab" in the CodeAlong toolbar icon.',
  noVideo: 'Following a tab, but no video was found on it yet. Start the video in Chrome.',
  playing: 'The tutorial is playing. Start typing and CodeAlong pauses it.',
  coding: 'Paused by CodeAlong while you code. It continues when you stop typing or save.',
  waitingToResume: 'Paused by CodeAlong. Save, use "I\'m Done", or press play to continue.',
  pausedByUser: 'You paused the video, so CodeAlong will not start it again by itself.',
  codingWhilePlaying: 'You pressed play while coding, so CodeAlong lets the video play.',
  disabled: 'Automatic pausing is off. Shortcuts still work. Turn it back on here or in the Chrome popup.',
};

export class StatusBar implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem('codealong.status', vscode.StatusBarAlignment.Left, 100);
  private status: HubStatus | null = null;
  private role: NodeRole = 'starting';
  private error: string | null = null;
  private countdown: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.item.name = 'CodeAlong';
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
      item.tooltip = `${this.error ?? 'CodeAlong could not start its local connection.'}\nClick for options.`;
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
    if (s.settings && s.browserConnected && s.phase !== 'disabled') lines.push(`${describeSettings(s.settings)}.`);
    if (this.role === 'follower') lines.push('(Connected through another VS Code window.)');
    lines.push('Click for options.');
    item.tooltip = lines.filter(Boolean).join('\n');
  }

  dispose(): void {
    if (this.countdown) clearInterval(this.countdown);
    this.item.dispose();
  }
}
