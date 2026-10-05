import type { VideoCause, VideoState } from '@codealong/protocol';
import type { AgentReply, AgentVideoReport, ToAgent } from '../shared/messages';
import { chooseCandidate, type Candidate } from '../shared/selection';
import { VideoController } from './videoController';

/**
 * One agent runs in every frame of a page where the content script is present. It stays dormant
 * (no video listeners, nothing controlled) until the service worker says this tab is the
 * Active Tutorial. Only then does it pick a video and start reporting / obeying commands.
 */

const TAKEOVER_EVENT = 'codealong:takeover';
const SCAN_INTERVAL_MS = 1_500;
const HEARTBEAT_INTERVAL_MS = 10_000;

export class FrameAgent {
  private readonly instanceId = Math.random().toString(36).slice(2);
  private active = false;
  private disposed = false;
  private debug = false;
  private controller: VideoController | null = null;
  private scanTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private lastTitle: string | null = null;

  start(): void {
    // A previous agent in this frame (older injection, or one orphaned by an extension reload)
    // must let go of the video before we take it.
    document.dispatchEvent(new CustomEvent(TAKEOVER_EVENT, { detail: this.instanceId }));
    document.addEventListener(TAKEOVER_EVENT, this.onTakeover);
    chrome.runtime.onMessage.addListener(this.onMessage);
    void this.send({ type: 'agent:hello' }).then((reply) => {
      if (reply?.active) this.activate(reply.debug);
    });
  }

  private activate(debug: boolean): void {
    this.debug = debug;
    if (this.active || this.disposed) return;
    this.active = true;
    this.log('activated');
    document.addEventListener('play', this.onAnyPlay, true);
    this.scan(true);
    this.scanTimer = setInterval(() => this.scan(false), SCAN_INTERVAL_MS);
    this.heartbeatTimer = setInterval(() => this.reportCurrent('sync'), HEARTBEAT_INTERVAL_MS);
  }

  private deactivate(): void {
    if (!this.active) return;
    this.active = false;
    this.log('deactivated');
    document.removeEventListener('play', this.onAnyPlay, true);
    if (this.scanTimer) clearInterval(this.scanTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.scanTimer = this.heartbeatTimer = null;
    this.controller?.detach();
    this.controller = null;
  }

  private dispose(): void {
    if (this.disposed) return;
    this.deactivate();
    this.disposed = true;
    document.removeEventListener(TAKEOVER_EVENT, this.onTakeover);
    try {
      chrome.runtime.onMessage.removeListener(this.onMessage);
    } catch {
      // Orphaned context: nothing to remove from.
    }
  }

  private readonly onTakeover = (e: Event): void => {
    if ((e as CustomEvent<string>).detail !== this.instanceId) this.dispose();
  };

  private readonly onMessage = (
    msg: ToAgent,
    _sender: chrome.runtime.MessageSender,
    sendResponse: (r?: unknown) => void,
  ): void => {
    if (this.disposed) return;
    switch (msg.type) {
      case 'agent:activate':
        this.activate(msg.debug);
        this.reportCurrent('sync');
        break;
      case 'agent:deactivate':
        this.deactivate();
        break;
      case 'agent:sync':
        if (this.active) this.reportCurrent('sync');
        break;
      case 'agent:command':
        if (!this.active) break;
        this.log('command', msg.command.command);
        if (this.controller) this.controller.handle(msg.command);
        else this.report(null, 'command-failed');
        break;
    }
    sendResponse({ ok: true });
  };

  /** Any video starting to play in this frame may be the one the user actually watches. */
  private readonly onAnyPlay = (e: Event): void => {
    if (e.target instanceof HTMLVideoElement && e.target !== this.controller?.video) this.scan(false);
  };

  private scan(initial: boolean): void {
    if (!this.active) return;
    const videos = Array.from(document.querySelectorAll('video'));
    const candidates: Candidate<HTMLVideoElement>[] = videos
      .filter((v) => v.isConnected)
      .map((v) => ({ key: v, area: visibleArea(v), playing: !v.paused && !v.ended }));
    const current = this.controller?.video.isConnected ? (this.controller.video as HTMLVideoElement) : null;
    const chosen = chooseCandidate(candidates, current);
    if (chosen !== (this.controller?.video ?? null)) {
      this.bind(chosen);
    } else if (initial) {
      this.reportCurrent('sync');
    }
    this.maybeReportTitle();
  }

  private bind(video: HTMLVideoElement | null): void {
    const hadVideo = this.controller !== null;
    this.controller?.detach();
    this.controller = video ? new VideoController(video, (state, cause) => this.report(state, cause)) : null;
    this.controller?.attach();
    this.log('bound video', video ? `${video.currentSrc.slice(0, 80)}` : 'none');
    this.reportCurrent(hadVideo ? 'source-changed' : 'sync');
  }

  private reportCurrent(cause: VideoCause): void {
    this.report(this.controller?.state() ?? null, cause);
  }

  private report(state: VideoState | null, cause: VideoCause): void {
    if (!this.active) return;
    const msg: AgentVideoReport = {
      type: 'agent:video',
      state,
      cause,
      area: this.controller ? visibleArea(this.controller.video as HTMLVideoElement) : 0,
    };
    if (window === window.top) msg.title = document.title;
    this.log('report', `${cause} ${state ? `${state.status}/${state.owner ?? '-'}` : 'no video'}`);
    void this.send(msg).then((reply) => {
      // The service worker no longer considers this tab the tutorial (e.g. user switched tabs).
      if (reply && !reply.active) this.deactivate();
    });
  }

  private maybeReportTitle(): void {
    if (window !== window.top || document.title === this.lastTitle) return;
    this.lastTitle = document.title;
    this.reportCurrent('sync');
  }

  private async send(msg: AgentVideoReport | { type: 'agent:hello' }): Promise<AgentReply | undefined> {
    try {
      return (await chrome.runtime.sendMessage(msg)) as AgentReply | undefined;
    } catch (err) {
      if (!chrome.runtime?.id || String(err).includes('context invalidated')) {
        // The extension was reloaded or removed; this script is orphaned. Let go of everything.
        this.dispose();
      }
      return undefined;
    }
  }

  private log(...args: unknown[]): void {
    if (this.debug) console.debug('[CodeAlong]', ...args);
  }
}

function visibleArea(el: Element): number {
  const r = el.getBoundingClientRect();
  return Math.max(0, r.width) * Math.max(0, r.height);
}
