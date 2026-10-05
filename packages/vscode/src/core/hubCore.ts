import type {
  ControlAction,
  HubStatus,
  StatusPhase,
  TutorialInfo,
  VideoCause,
  VideoCommand,
  VideoState,
} from '@codealong/protocol';

/**
 * The CodeAlong "brain": a pure, synchronous state machine.
 *
 * - No I/O and no timers. Time is passed in with every event, and the shell asks
 *   `nextDeadline()` when it should deliver the next `tick`. Because deadlines live in the
 *   state, a stale timer can never act on an outdated decision: if the deadline moved or was
 *   cleared, the tick simply finds nothing to do.
 * - The browser is authoritative about *who* paused the video. The core only ever asks it to
 *   resume a specific CodeAlong pause (`pauseId`); the browser refuses if anything changed.
 * - At most one pause/resume command is in flight at a time.
 */

export interface CoreSettings {
  enabled: boolean;
  pauseOnTyping: boolean;
  resumeOnIdle: boolean;
  idleDelayMs: number;
  resumeOnSave: boolean;
  resumeOnFocus: boolean;
  rewindBeforeResume: boolean;
  rewindSeconds: number;
}

export const DEFAULT_SETTINGS: CoreSettings = {
  enabled: true,
  pauseOnTyping: true,
  resumeOnIdle: true,
  idleDelayMs: 5_000,
  resumeOnSave: true,
  resumeOnFocus: false,
  rewindBeforeResume: true,
  rewindSeconds: 2,
};

/** How long after a manual save we wait for more typing before treating the save as "done". */
export const SAVE_SETTLE_MS = 1_000;
/** A pause/resume command without a matching video report within this time is given up on. */
export const COMMAND_TIMEOUT_MS = 3_000;

export type CoreEvent =
  | { type: 'settings'; settings: CoreSettings }
  | { type: 'browserConnected' }
  | { type: 'browserDisconnected' }
  | { type: 'tutorial'; tutorial: TutorialInfo | null }
  | { type: 'video'; video: VideoState; cause: VideoCause }
  | { type: 'edit' }
  | { type: 'save' }
  | { type: 'tutorialFocus'; focused: boolean }
  | { type: 'control'; action: ControlAction }
  | { type: 'tick' };

export type LogEventName =
  | 'ENABLED'
  | 'DISABLED'
  | 'BROWSER_CONNECTED'
  | 'CONNECTION_LOST'
  | 'CONNECTION_RESTORED'
  | 'TUTORIAL_CHANGED'
  | 'VIDEO_PLAYING'
  | 'VIDEO_CHANGED'
  | 'VIDEO_SEEKED'
  | 'VIDEO_ENDED'
  | 'TYPING_STARTED'
  | 'TYPING_IDLE'
  | 'PAUSE_REQUESTED'
  | 'PAUSE_SKIPPED'
  | 'VIDEO_PAUSED_BY_CODEALONG'
  | 'ADOPTED_CODEALONG_PAUSE'
  | 'FILE_SAVED'
  | 'SAVE_RESUME_CANCELLED'
  | 'TUTORIAL_FOCUSED'
  | 'AUTO_RESUME'
  | 'VIDEO_RESUMED'
  | 'MANUAL_PAUSE'
  | 'MANUAL_PLAY'
  | 'MANUAL_TOGGLE'
  | 'DONE'
  | 'COMMAND_FAILED'
  | 'COMMAND_TIMEOUT';

export type CoreEffect =
  | { type: 'send'; command: VideoCommand }
  | { type: 'log'; event: LogEventName; detail?: string };

type Pending = { kind: 'pause' | 'resume'; pauseId: string; deadline: number };

export class HubCore {
  private settings: CoreSettings;
  private browserConnected = false;
  private everConnected = false;
  private tutorial: TutorialInfo | null = null;
  private video: VideoState | null = null;

  /** The user is in a coding session (typed recently). */
  private coding = false;
  /** The user explicitly let the video play during this coding session: do not auto-pause again. */
  private suppressAutoPause = false;
  /** When the current coding session is considered over (idle). */
  private idleDeadline: number | null = null;
  /** When a manual save turns into a resume, unless the user keeps typing. */
  private saveResumeAt: number | null = null;

  private pending: Pending | null = null;
  private readonly knownPauseIds = new Set<string>();
  private pauseCounter = 0;

  private effects: CoreEffect[] = [];

  constructor(
    settings: CoreSettings = DEFAULT_SETTINGS,
    /** Prefix making pause ids unique across hub restarts. */
    private readonly idPrefix = Math.random().toString(36).slice(2, 8),
  ) {
    this.settings = { ...settings };
  }

  dispatch(event: CoreEvent, now: number): CoreEffect[] {
    this.effects = [];
    switch (event.type) {
      case 'settings':
        this.onSettings(event.settings);
        break;
      case 'browserConnected':
        this.browserConnected = true;
        this.log(this.everConnected ? 'CONNECTION_RESTORED' : 'BROWSER_CONNECTED');
        this.everConnected = true;
        break;
      case 'browserDisconnected':
        if (this.browserConnected) this.log('CONNECTION_LOST');
        this.browserConnected = false;
        this.tutorial = null;
        this.video = null;
        this.pending = null;
        this.saveResumeAt = null;
        break;
      case 'tutorial':
        this.onTutorial(event.tutorial);
        break;
      case 'video':
        this.onVideo(event.video, event.cause, now);
        break;
      case 'edit':
        this.onEdit(now);
        break;
      case 'save':
        this.onSave(now);
        break;
      case 'tutorialFocus':
        this.onTutorialFocus(event.focused, now);
        break;
      case 'control':
        this.onControl(event.action, now);
        break;
      case 'tick':
        this.onTick(now);
        break;
    }
    return this.effects;
  }

  /** Earliest time at which `tick` must be dispatched, or null if nothing is scheduled. */
  nextDeadline(): number | null {
    const candidates = [this.idleDeadline, this.saveResumeAt, this.pending?.deadline ?? null].filter(
      (d): d is number => d !== null,
    );
    return candidates.length ? Math.min(...candidates) : null;
  }

  getStatus(): HubStatus {
    return {
      phase: this.phase(),
      enabled: this.settings.enabled,
      browserConnected: this.browserConnected,
      tutorialTitle: this.tutorial?.title ?? null,
      resumeAt: this.expectedResumeAt(),
    };
  }

  /** Exposed for tests and debugging. */
  snapshot() {
    return {
      coding: this.coding,
      suppressAutoPause: this.suppressAutoPause,
      idleDeadline: this.idleDeadline,
      saveResumeAt: this.saveResumeAt,
      pending: this.pending ? { ...this.pending } : null,
      video: this.video ? { ...this.video } : null,
    };
  }

  // -------------------------------------------------------------------------

  private onSettings(next: CoreSettings): void {
    const wasEnabled = this.settings.enabled;
    this.settings = { ...next };
    if (wasEnabled && !next.enabled) {
      this.log('DISABLED');
      this.endCodingSession();
      this.pending = null;
    } else if (!wasEnabled && next.enabled) {
      this.log('ENABLED');
    }
    if (!next.resumeOnSave) this.saveResumeAt = null;
  }

  private onTutorial(tutorial: TutorialInfo | null): void {
    const changed = tutorial?.tabId !== this.tutorial?.tabId;
    this.tutorial = tutorial;
    if (changed) {
      this.log('TUTORIAL_CHANGED', tutorial ? tutorial.host : 'none');
      this.video = null;
      this.pending = null;
      this.saveResumeAt = null;
    }
  }

  private onVideo(video: VideoState, cause: VideoCause, now: number): void {
    this.video = video;
    this.settlePending(video, cause);

    switch (cause) {
      case 'play':
        this.log('VIDEO_PLAYING');
        break;
      case 'manual-play':
        this.log('MANUAL_PLAY');
        // The user deliberately started the video while coding: respect it for this session.
        if (this.coding) this.suppressAutoPause = true;
        this.saveResumeAt = null;
        break;
      case 'manual-pause':
        this.log('MANUAL_PAUSE');
        this.saveResumeAt = null;
        break;
      case 'seek':
        this.log('VIDEO_SEEKED');
        // Scrubbing during a CodeAlong pause usually means "let me look at that code again":
        // treat it as activity so the video does not resume under the user's cursor.
        if (video.owner === 'codealong' && this.idleDeadline !== null) {
          this.idleDeadline = Math.max(this.idleDeadline, now + this.settings.idleDelayMs);
        }
        break;
      case 'ended':
        this.log('VIDEO_ENDED');
        this.saveResumeAt = null;
        break;
      case 'source-changed':
        this.log('VIDEO_CHANGED');
        this.saveResumeAt = null;
        break;
      case 'command-failed':
        this.log('COMMAND_FAILED');
        break;
      case 'codealong-pause':
      case 'codealong-resume':
      case 'sync':
        break;
    }

    if (video.owner === 'codealong' && video.pauseId) {
      // A CodeAlong pause we did not create (hub restarted, or another VS Code window was the hub).
      if (!this.knownPauseIds.has(video.pauseId)) {
        this.knownPauseIds.add(video.pauseId);
        this.log('ADOPTED_CODEALONG_PAUSE');
      }
      // A CodeAlong pause with nothing scheduled to end it (e.g. the idle period ran out while the
      // browser was disconnected): give the user one more idle period, then resume.
      const nothingScheduled = this.idleDeadline === null && this.saveResumeAt === null && !this.pending;
      if (!this.coding && nothingScheduled && this.settings.enabled && this.settings.resumeOnIdle) {
        this.idleDeadline = now + this.settings.idleDelayMs;
      }
    }
  }

  private settlePending(video: VideoState, cause: VideoCause): void {
    const p = this.pending;
    if (!p) return;
    if (p.kind === 'pause') {
      if (video.status === 'paused' && video.owner === 'codealong' && video.pauseId === p.pauseId) {
        this.pending = null;
        this.log('VIDEO_PAUSED_BY_CODEALONG');
      } else if (video.status !== 'playing' || cause === 'command-failed') {
        // Paused by the user at the same moment, ended, or gone: our pause is moot.
        this.pending = null;
      }
    } else {
      if (video.status === 'playing') {
        this.pending = null;
        if (cause === 'codealong-resume') this.log('VIDEO_RESUMED');
      } else if (video.owner !== 'codealong' || video.pauseId !== p.pauseId || cause === 'command-failed') {
        this.pending = null;
      }
    }
  }

  private onEdit(now: number): void {
    if (!this.settings.enabled) return;
    if (!this.coding) {
      this.coding = true;
      this.suppressAutoPause = false;
      this.log('TYPING_STARTED');
    }
    this.idleDeadline = now + this.settings.idleDelayMs;
    if (this.saveResumeAt !== null) {
      this.saveResumeAt = null;
      this.log('SAVE_RESUME_CANCELLED', 'typing continued after save');
    }

    if (!this.settings.pauseOnTyping || !this.browserConnected) return;
    if (this.video?.status !== 'playing' || this.pending) return;
    if (this.suppressAutoPause) {
      this.log('PAUSE_SKIPPED', 'video was started manually during this coding session');
      return;
    }
    const pauseId = `${this.idPrefix}-${++this.pauseCounter}`;
    this.knownPauseIds.add(pauseId);
    this.pending = { kind: 'pause', pauseId, deadline: now + COMMAND_TIMEOUT_MS };
    this.send({ command: 'pause', pauseId });
    this.log('PAUSE_REQUESTED');
  }

  private onSave(now: number): void {
    if (!this.settings.enabled) return;
    this.log('FILE_SAVED');
    if (!this.settings.resumeOnSave || !this.isCodeAlongPaused()) return;
    // Do not resume instantly: people save in the middle of typing. Resume only if no edit follows.
    this.saveResumeAt = now + SAVE_SETTLE_MS;
  }

  private onTutorialFocus(focused: boolean, now: number): void {
    if (!focused || !this.settings.enabled) return;
    this.log('TUTORIAL_FOCUSED');
    if (!this.settings.resumeOnFocus || !this.isCodeAlongPaused()) return;
    this.endCodingSession();
    this.tryAutoResume('focus', now);
  }

  private onControl(action: ControlAction, now: number): void {
    if (!this.browserConnected || !this.video || this.video.status === 'none') {
      this.log(action === 'done' ? 'DONE' : 'MANUAL_TOGGLE', 'ignored: no tutorial video');
      return;
    }
    if (action === 'toggle') {
      this.log('MANUAL_TOGGLE');
      this.send({ command: 'userToggle' });
      return;
    }
    // "I'm done": end the coding session and continue the tutorial.
    this.log('DONE');
    this.endCodingSession();
    if (this.isCodeAlongPaused()) {
      this.tryAutoResume('done', now);
    } else if (this.video.status === 'paused') {
      this.send({ command: 'userPlay' });
    }
  }

  private onTick(now: number): void {
    if (this.pending && now >= this.pending.deadline) {
      this.log('COMMAND_TIMEOUT', this.pending.kind);
      this.pending = null;
    }
    if (this.idleDeadline !== null && now >= this.idleDeadline) {
      this.idleDeadline = null;
      if (this.coding) {
        this.coding = false;
        this.log('TYPING_IDLE');
      }
      this.suppressAutoPause = false;
      if (this.settings.resumeOnIdle) this.tryAutoResume('idle', now);
    }
    if (this.saveResumeAt !== null && now >= this.saveResumeAt) {
      this.saveResumeAt = null;
      this.endCodingSession();
      this.tryAutoResume('save', now);
    }
  }

  private tryAutoResume(reason: 'idle' | 'save' | 'focus' | 'done', now: number): void {
    if (!this.settings.enabled || !this.browserConnected || this.pending) return;
    const v = this.video;
    if (!v || v.status !== 'paused' || v.owner !== 'codealong' || !v.pauseId) return;
    const rewindSeconds = this.settings.rewindBeforeResume ? Math.max(0, this.settings.rewindSeconds) : 0;
    this.pending = { kind: 'resume', pauseId: v.pauseId, deadline: now + COMMAND_TIMEOUT_MS };
    this.send({ command: 'resume', pauseId: v.pauseId, rewindSeconds });
    this.log('AUTO_RESUME', `reason=${reason} rewind=${rewindSeconds}s`);
  }

  private endCodingSession(): void {
    this.coding = false;
    this.suppressAutoPause = false;
    this.idleDeadline = null;
    this.saveResumeAt = null;
  }

  private isCodeAlongPaused(): boolean {
    return this.video?.status === 'paused' && this.video.owner === 'codealong';
  }

  private expectedResumeAt(): number | null {
    if (!this.settings.enabled || !this.isCodeAlongPaused()) return null;
    const candidates: number[] = [];
    if (this.settings.resumeOnIdle && this.idleDeadline !== null) candidates.push(this.idleDeadline);
    if (this.saveResumeAt !== null) candidates.push(this.saveResumeAt);
    return candidates.length ? Math.min(...candidates) : null;
  }

  private phase(): StatusPhase {
    if (!this.settings.enabled) return 'disabled';
    if (!this.browserConnected) return 'waitingForBrowser';
    if (!this.tutorial) return 'noTutorial';
    const v = this.video;
    if (!v || v.status === 'none') return 'noVideo';
    if (v.status === 'ended') return 'ended';
    if (v.status === 'playing') return this.coding ? 'codingWhilePlaying' : 'playing';
    if (v.owner === 'codealong') return this.coding ? 'coding' : 'waitingToResume';
    return 'pausedByUser';
  }

  private send(command: VideoCommand): void {
    this.effects.push({ type: 'send', command });
  }

  private log(event: LogEventName, detail?: string): void {
    this.effects.push(detail === undefined ? { type: 'log', event } : { type: 'log', event, detail });
  }
}
