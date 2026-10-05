import type { PauseOwner, VideoCause, VideoCommand, VideoState } from '@codealong/protocol';

/** The subset of HTMLVideoElement the controller relies on (lets tests use a fake). */
export interface VideoLike {
  paused: boolean;
  ended: boolean;
  currentTime: number;
  duration: number;
  isConnected: boolean;
  play(): Promise<void> | void;
  pause(): void;
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
}

export type ReportFn = (state: VideoState, cause: VideoCause) => void;

/**
 * Attribute that mirrors a CodeAlong pause onto the element. If the extension is reloaded,
 * the fresh content script can recognise "this video is still paused by CodeAlong" instead of
 * mistaking it for a user pause (or worse, the other way round). Format: `<pauseId>@<time>`.
 */
export const PAUSE_MARKER_ATTR = 'data-codealong-pause';

/** An expected self-caused media event that never arrives is forgotten after this long. */
const OWN_EVENT_TTL_MS = 2_000;
const SEEK_REPORT_THROTTLE_MS = 500;

type OwnEvent = 'pause' | 'play' | 'seeking';

/**
 * Wraps a single <video> and keeps track of *who* paused it.
 *
 * Every pause/play/seek CodeAlong performs is registered as an "own" event before calling the
 * media API. The resulting DOM event is then recognised and swallowed; every other media event
 * is by definition caused by the user (or the site's own player), which is what makes
 * "never auto-resume a video the user paused" hold.
 */
export class VideoController {
  private owner: PauseOwner | null = null;
  private pauseId: string | null = null;
  /** The user moved the playhead during a CodeAlong pause: respect their position, skip rewind. */
  private skipRewind = false;
  private readonly ownEvents: Record<OwnEvent, number[]> = { pause: [], play: [], seeking: [] };
  private lastSeekReport = 0;
  private readonly listeners: [string, () => void][];

  constructor(
    readonly video: VideoLike,
    private readonly report: ReportFn,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.listeners = [
      ['play', () => this.onPlay()],
      ['pause', () => this.onPause()],
      ['seeking', () => this.onSeeking()],
      ['ended', () => this.onEnded()],
      ['emptied', () => this.onEmptied()],
    ];
  }

  attach(): void {
    this.restoreFromMarker();
    if (this.video.paused && !this.video.ended && this.owner === null) {
      // Paused before CodeAlong started following it: that is the user's pause.
      this.owner = 'user';
    }
    for (const [type, fn] of this.listeners) this.video.addEventListener(type, fn);
  }

  detach(): void {
    for (const [type, fn] of this.listeners) this.video.removeEventListener(type, fn);
  }

  state(): VideoState {
    const v = this.video;
    const status = v.ended ? 'ended' : v.paused ? 'paused' : 'playing';
    const duration = Number.isFinite(v.duration) ? v.duration : null;
    return {
      status,
      owner: status === 'paused' ? (this.owner ?? 'user') : null,
      pauseId: status === 'paused' && this.owner === 'codealong' ? this.pauseId : null,
      currentTime: Number.isFinite(v.currentTime) ? Math.max(0, v.currentTime) : 0,
      duration,
    };
  }

  handle(cmd: VideoCommand): void {
    switch (cmd.command) {
      case 'pause':
        return this.codeAlongPause(cmd.pauseId);
      case 'resume':
        return this.codeAlongResume(cmd.pauseId, cmd.rewindSeconds);
      case 'userToggle':
        if (this.video.paused || this.video.ended) this.userPlay();
        else this.userPause();
        return;
      case 'userPlay':
        if (this.video.paused) this.userPlay();
        else this.report(this.state(), 'sync');
        return;
    }
  }

  // ---------------------------------------------------------------------------
  // Commands

  private codeAlongPause(pauseId: string): void {
    const v = this.video;
    if (v.paused || v.ended) {
      // Already paused (by the user, or ended): never take ownership of someone else's pause.
      this.report(this.state(), 'sync');
      return;
    }
    this.expect('pause');
    v.pause();
    if (!v.paused) {
      this.unexpect('pause');
      this.report(this.state(), 'command-failed');
      return;
    }
    this.setOwner('codealong', pauseId);
    this.skipRewind = false;
    this.report(this.state(), 'codealong-pause');
  }

  private codeAlongResume(pauseId: string, rewindSeconds: number): void {
    const v = this.video;
    if (!v.paused || v.ended || this.owner !== 'codealong' || this.pauseId !== pauseId) {
      // Anything changed since CodeAlong paused (user played, paused, new video...): do nothing.
      this.report(this.state(), 'sync');
      return;
    }
    const rewind = this.skipRewind ? 0 : Math.max(0, rewindSeconds);
    if (rewind > 0 && Number.isFinite(v.currentTime)) {
      this.expect('seeking');
      v.currentTime = Math.max(0, v.currentTime - rewind);
    }
    this.setOwner(null, null);
    this.skipRewind = false;
    this.startPlayback('codealong-resume');
  }

  private userPause(): void {
    this.expect('pause');
    this.video.pause();
    if (!this.video.paused) {
      this.unexpect('pause');
      return;
    }
    this.setOwner('user', null);
    this.report(this.state(), 'manual-pause');
  }

  private userPlay(): void {
    this.setOwner(null, null);
    this.startPlayback('manual-play');
  }

  private startPlayback(cause: 'codealong-resume' | 'manual-play'): void {
    const v = this.video;
    const wasPaused = v.paused;
    if (wasPaused) this.expect('play');
    let result: Promise<void> | void;
    try {
      result = v.play();
    } catch {
      result = Promise.reject(new Error('play() threw'));
    }
    this.report(this.state(), cause);
    if (result && typeof result.catch === 'function') {
      result.catch(() => {
        if (!this.video.paused) return; // e.g. AbortError after something else started playback
        // Autoplay policy or similar. Hand the decision back to the user: never retry by ourselves.
        this.ownEvents.play = [];
        this.setOwner('user', null);
        this.report(this.state(), 'command-failed');
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Media events

  private onPlay(): void {
    if (this.consume('play')) return;
    const hadPause = this.owner !== null;
    this.setOwner(null, null);
    this.skipRewind = false;
    this.report(this.state(), hadPause ? 'manual-play' : 'play');
  }

  private onPause(): void {
    if (this.consume('pause')) return;
    if (this.video.ended) return; // reaching the end fires "pause" then "ended"
    this.setOwner('user', null);
    this.report(this.state(), 'manual-pause');
  }

  private onSeeking(): void {
    if (this.consume('seeking')) return;
    if (this.owner === 'codealong') this.skipRewind = true;
    const t = this.now();
    if (t - this.lastSeekReport < SEEK_REPORT_THROTTLE_MS) return;
    this.lastSeekReport = t;
    this.report(this.state(), 'seek');
  }

  private onEnded(): void {
    this.setOwner(null, null);
    this.report(this.state(), 'ended');
  }

  private onEmptied(): void {
    // New source (e.g. YouTube SPA navigation to another video): forget everything about the old one.
    this.setOwner(this.video.paused ? 'user' : null, null);
    this.skipRewind = false;
    this.ownEvents.pause = [];
    this.ownEvents.play = [];
    this.ownEvents.seeking = [];
    this.report(this.state(), 'source-changed');
  }

  // ---------------------------------------------------------------------------

  private setOwner(owner: PauseOwner | null, pauseId: string | null): void {
    this.owner = owner;
    this.pauseId = owner === 'codealong' ? pauseId : null;
    try {
      if (this.owner === 'codealong' && this.pauseId) {
        this.video.setAttribute(PAUSE_MARKER_ATTR, `${this.pauseId}@${this.video.currentTime}`);
      } else {
        this.video.removeAttribute(PAUSE_MARKER_ATTR);
      }
    } catch {
      // Attribute writes are best effort.
    }
  }

  private restoreFromMarker(): void {
    const marker = this.video.getAttribute(PAUSE_MARKER_ATTR);
    if (!marker) return;
    const at = marker.lastIndexOf('@');
    const pauseId = marker.slice(0, at);
    const time = Number(marker.slice(at + 1));
    const stillOurs =
      at > 0 && this.video.paused && !this.video.ended && Math.abs(this.video.currentTime - time) < 0.5;
    if (stillOurs) {
      this.setOwner('codealong', pauseId);
    } else {
      this.video.removeAttribute(PAUSE_MARKER_ATTR);
    }
  }

  private expect(kind: OwnEvent): void {
    this.ownEvents[kind].push(this.now() + OWN_EVENT_TTL_MS);
  }

  private unexpect(kind: OwnEvent): void {
    this.ownEvents[kind].pop();
  }

  private consume(kind: OwnEvent): boolean {
    const t = this.now();
    const live = this.ownEvents[kind].filter((deadline) => deadline >= t);
    const own = live.length > 0;
    if (own) live.shift();
    this.ownEvents[kind] = live;
    return own;
  }
}
