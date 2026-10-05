import { describe, expect, it } from 'vitest';
import type { VideoCause, VideoCommand, VideoState } from '@codealong/protocol';
import {
  COMMAND_TIMEOUT_MS,
  DEFAULT_SETTINGS,
  HubCore,
  SAVE_SETTLE_MS,
  type CoreEvent,
  type CoreSettings,
  type LogEventName,
} from '../src/core/hubCore';

const IDLE = 5_000;

function playing(t = 10): VideoState {
  return { status: 'playing', owner: null, pauseId: null, currentTime: t, duration: 600 };
}
function pausedBy(owner: 'codealong' | 'user', pauseId: string | null = null, t = 10): VideoState {
  return { status: 'paused', owner, pauseId: owner === 'codealong' ? pauseId : null, currentTime: t, duration: 600 };
}

/** Drives a HubCore with a virtual clock, delivering ticks exactly at the core's deadlines. */
function harness(overrides: Partial<CoreSettings> = {}) {
  const core = new HubCore({ ...DEFAULT_SETTINGS, idleDelayMs: IDLE, ...overrides }, 'test');
  let now = 1_000;
  const sent: VideoCommand[] = [];
  const logs: LogEventName[] = [];

  const dispatch = (e: CoreEvent) => {
    for (const fx of core.dispatch(e, now)) {
      if (fx.type === 'send') sent.push(fx.command);
      else logs.push(fx.event);
    }
  };
  const advance = (ms: number) => {
    const target = now + ms;
    for (let d = core.nextDeadline(); d !== null && d <= target; d = core.nextDeadline()) {
      now = Math.max(now, d);
      dispatch({ type: 'tick' });
    }
    now = target;
  };
  const video = (v: VideoState, cause: VideoCause = 'sync') => dispatch({ type: 'video', video: v, cause });
  const connect = (v: VideoState = playing()) => {
    dispatch({ type: 'browserConnected' });
    dispatch({ type: 'tutorial', tutorial: { tabId: 1, title: 'Laravel from scratch', host: 'youtube.com' } });
    video(v, 'play');
  };
  /** Browser answers a pause command like the real VideoController would. */
  const ackPause = () => {
    const cmd = sent.at(-1);
    if (cmd?.command !== 'pause') throw new Error(`expected pause, got ${cmd?.command}`);
    video(pausedBy('codealong', cmd.pauseId), 'codealong-pause');
    return cmd.pauseId;
  };
  const ackResume = () => {
    const cmd = sent.at(-1);
    if (cmd?.command !== 'resume') throw new Error(`expected resume, got ${cmd?.command}`);
    video(playing(), 'codealong-resume');
    return cmd;
  };
  return {
    core,
    sent,
    logs,
    dispatch,
    advance,
    video,
    connect,
    ackPause,
    ackResume,
    edit: () => dispatch({ type: 'edit' }),
    save: () => dispatch({ type: 'save' }),
    get now() {
      return now;
    },
    commands: () => sent.map((c) => c.command),
  };
}

describe('pause on typing', () => {
  it('pauses once when the user starts typing while the tutorial plays', () => {
    const h = harness();
    h.connect();
    h.edit();
    h.edit();
    h.edit();
    expect(h.commands()).toEqual(['pause']);
    expect(h.logs).toContain('TYPING_STARTED');
    expect(h.logs).toContain('PAUSE_REQUESTED');
  });

  it('does not send another pause while the first is still in flight', () => {
    const h = harness();
    h.connect();
    h.edit();
    h.advance(100);
    h.edit();
    h.video(playing(), 'sync'); // a stale report from before the pause arrived
    h.edit();
    expect(h.commands()).toEqual(['pause']);
  });

  it('gives up on a pause that is never acknowledged and can try again later', () => {
    const h = harness();
    h.connect();
    h.edit();
    h.advance(COMMAND_TIMEOUT_MS + 10);
    expect(h.logs).toContain('COMMAND_TIMEOUT');
    h.edit();
    expect(h.commands()).toEqual(['pause', 'pause']);
  });

  it('does nothing when disabled, without a browser, or when pause-on-typing is off', () => {
    const off = harness({ enabled: false });
    off.connect();
    off.edit();
    expect(off.sent).toEqual([]);

    const noBrowser = harness();
    noBrowser.edit();
    expect(noBrowser.sent).toEqual([]);

    const noPause = harness({ pauseOnTyping: false });
    noPause.connect();
    noPause.edit();
    expect(noPause.sent).toEqual([]);
  });

  it('does not pause a video that is not playing (user-paused or ended)', () => {
    const h = harness();
    h.connect(pausedBy('user'));
    h.edit();
    const ended = harness();
    ended.connect({ status: 'ended', owner: null, pauseId: null, currentTime: 600, duration: 600 });
    ended.edit();
    expect(h.sent).toEqual([]);
    expect(ended.sent).toEqual([]);
  });
});

describe('resume after idle', () => {
  it('resumes with rewind after the idle delay, measured from the last keystroke', () => {
    const h = harness();
    h.connect();
    h.edit();
    const pauseId = h.ackPause();
    h.advance(3_000);
    h.edit(); // still typing: idle timer restarts
    h.advance(IDLE - 1);
    expect(h.commands()).toEqual(['pause']);
    h.advance(1);
    expect(h.sent.at(-1)).toEqual({ command: 'resume', pauseId, rewindSeconds: 2 });
    expect(h.logs).toContain('TYPING_IDLE');
    expect(h.logs).toContain('AUTO_RESUME');
  });

  it('respects rewind settings', () => {
    const h = harness({ rewindBeforeResume: false });
    h.connect();
    h.edit();
    h.ackPause();
    h.advance(IDLE);
    expect(h.sent.at(-1)).toMatchObject({ command: 'resume', rewindSeconds: 0 });

    const h2 = harness({ rewindSeconds: 4 });
    h2.connect();
    h2.edit();
    h2.ackPause();
    h2.advance(IDLE);
    expect(h2.sent.at(-1)).toMatchObject({ command: 'resume', rewindSeconds: 4 });
  });

  it('never resumes a video the user paused themselves', () => {
    const h = harness();
    h.connect(pausedBy('user'));
    h.edit();
    h.advance(IDLE * 3);
    h.save();
    h.advance(SAVE_SETTLE_MS * 2);
    h.dispatch({ type: 'tutorialFocus', focused: true });
    expect(h.sent).toEqual([]);
  });

  it('never resumes when the user paused again after CodeAlong (idle arrives late)', () => {
    const h = harness();
    h.connect();
    h.edit();
    h.ackPause();
    // User clicks play then pause in the browser while still typing.
    h.video(playing(), 'manual-play');
    h.video(pausedBy('user'), 'manual-pause');
    h.advance(IDLE * 2);
    expect(h.commands()).toEqual(['pause']);
  });

  it('does not resume when the user already resumed manually', () => {
    const h = harness();
    h.connect();
    h.edit();
    h.ackPause();
    h.video(playing(), 'manual-play');
    h.advance(IDLE * 2);
    expect(h.commands()).toEqual(['pause']);
  });

  it('only one resume is sent even if several "done" signals arrive', () => {
    const h = harness();
    h.connect();
    h.edit();
    h.ackPause();
    h.save();
    h.advance(SAVE_SETTLE_MS); // save -> resume sent, not yet acknowledged
    h.dispatch({ type: 'control', action: 'done' });
    h.dispatch({ type: 'tutorialFocus', focused: true });
    h.advance(1_000);
    expect(h.commands()).toEqual(['pause', 'resume']);
    h.ackResume();
    h.advance(IDLE * 2);
    expect(h.commands()).toEqual(['pause', 'resume']);
  });

  it('retries an unacknowledged resume with the same pauseId (the browser makes it idempotent)', () => {
    const h = harness();
    h.connect();
    h.edit();
    const pauseId = h.ackPause();
    h.advance(IDLE);
    h.advance(COMMAND_TIMEOUT_MS);
    h.dispatch({ type: 'control', action: 'done' });
    expect(h.sent.slice(1)).toEqual([
      { command: 'resume', pauseId, rewindSeconds: 2 },
      { command: 'resume', pauseId, rewindSeconds: 2 },
    ]);
  });

  it('resume-after-idle can be turned off; the user then stays in control', () => {
    const h = harness({ resumeOnIdle: false, resumeOnSave: false });
    h.connect();
    h.edit();
    h.ackPause();
    h.advance(IDLE * 3);
    expect(h.commands()).toEqual(['pause']);
    expect(h.core.getStatus().phase).toBe('waitingToResume');
    h.dispatch({ type: 'control', action: 'done' });
    expect(h.sent.at(-1)).toMatchObject({ command: 'resume', rewindSeconds: 2 });
  });
});

describe('resume on save', () => {
  it('resumes shortly after a save if no more typing follows', () => {
    const h = harness();
    h.connect();
    h.edit();
    h.ackPause();
    h.advance(500);
    h.save();
    h.advance(SAVE_SETTLE_MS - 1);
    expect(h.commands()).toEqual(['pause']);
    h.advance(1);
    expect(h.commands()).toEqual(['pause', 'resume']);
    expect(h.logs).toContain('FILE_SAVED');
  });

  it('a save in the middle of typing does not resume', () => {
    const h = harness();
    h.connect();
    h.edit();
    h.ackPause();
    h.save();
    h.advance(300);
    h.edit();
    expect(h.logs).toContain('SAVE_RESUME_CANCELLED');
    h.advance(SAVE_SETTLE_MS * 2);
    expect(h.commands()).toEqual(['pause']);
    // ...but the idle timer still applies afterwards.
    h.advance(IDLE);
    expect(h.commands()).toEqual(['pause', 'resume']);
  });

  it('can be turned off', () => {
    const h = harness({ resumeOnSave: false });
    h.connect();
    h.edit();
    h.ackPause();
    h.save();
    h.advance(SAVE_SETTLE_MS * 2);
    expect(h.commands()).toEqual(['pause']);
  });
});

describe('resume on tutorial focus', () => {
  it('resumes when enabled and the tutorial gets focus', () => {
    const h = harness({ resumeOnFocus: true });
    h.connect();
    h.edit();
    h.ackPause();
    h.dispatch({ type: 'tutorialFocus', focused: false });
    h.dispatch({ type: 'tutorialFocus', focused: true });
    expect(h.commands()).toEqual(['pause', 'resume']);
  });

  it('is ignored by default (multi-monitor setups)', () => {
    const h = harness();
    h.connect();
    h.edit();
    h.ackPause();
    h.dispatch({ type: 'tutorialFocus', focused: true });
    expect(h.commands()).toEqual(['pause']);
  });
});

describe('manual control', () => {
  it('toggle hotkey lets the browser decide based on the real video state', () => {
    const h = harness();
    h.connect();
    h.dispatch({ type: 'control', action: 'toggle' });
    expect(h.sent.at(-1)).toEqual({ command: 'userToggle' });
  });

  it('a manual play during a coding session is respected until the session ends', () => {
    const h = harness();
    h.connect();
    h.edit();
    h.ackPause();
    h.video(playing(), 'manual-play');
    h.edit();
    h.edit();
    expect(h.commands()).toEqual(['pause']);
    expect(h.logs).toContain('PAUSE_SKIPPED');
    expect(h.core.getStatus().phase).toBe('codingWhilePlaying');
    // After the session goes idle, a new coding session pauses again.
    h.advance(IDLE);
    h.edit();
    expect(h.commands()).toEqual(['pause', 'pause']);
  });

  it('"done" resumes a CodeAlong pause with rewind and plays a user pause without', () => {
    const h = harness();
    h.connect();
    h.edit();
    const pauseId = h.ackPause();
    h.dispatch({ type: 'control', action: 'done' });
    expect(h.sent.at(-1)).toEqual({ command: 'resume', pauseId, rewindSeconds: 2 });

    const u = harness();
    u.connect(pausedBy('user'));
    u.dispatch({ type: 'control', action: 'done' });
    expect(u.sent.at(-1)).toEqual({ command: 'userPlay' });
  });

  it('ignores controls without a tutorial video', () => {
    const h = harness();
    h.dispatch({ type: 'control', action: 'toggle' });
    expect(h.sent).toEqual([]);
  });
});

describe('connection changes', () => {
  it('forgets the video on disconnect and does not send commands', () => {
    const h = harness();
    h.connect();
    h.dispatch({ type: 'browserDisconnected' });
    h.edit();
    expect(h.sent).toEqual([]);
    expect(h.logs).toContain('CONNECTION_LOST');
    expect(h.core.getStatus().phase).toBe('waitingForBrowser');
  });

  it('resumes a CodeAlong pause after reconnecting, even if idle ran out while disconnected', () => {
    const h = harness();
    h.connect();
    h.edit();
    const pauseId = h.ackPause();
    h.dispatch({ type: 'browserDisconnected' });
    h.advance(IDLE * 2); // idle fires while disconnected: nothing to resume
    expect(h.commands()).toEqual(['pause']);
    h.dispatch({ type: 'browserConnected' });
    expect(h.logs).toContain('CONNECTION_RESTORED');
    h.dispatch({ type: 'tutorial', tutorial: { tabId: 1, title: 't', host: 'youtube.com' } });
    h.video(pausedBy('codealong', pauseId), 'sync');
    h.advance(IDLE);
    expect(h.sent.at(-1)).toEqual({ command: 'resume', pauseId, rewindSeconds: 2 });
  });

  it('adopts a CodeAlong pause created by a previous hub (VS Code restarted)', () => {
    const h = harness();
    h.connect(pausedBy('codealong', 'old-hub-7'));
    expect(h.logs).toContain('ADOPTED_CODEALONG_PAUSE');
    h.advance(IDLE);
    expect(h.sent.at(-1)).toEqual({ command: 'resume', pauseId: 'old-hub-7', rewindSeconds: 2 });
  });

  it('a new tutorial clears pending state', () => {
    const h = harness();
    h.connect();
    h.edit();
    h.dispatch({ type: 'tutorial', tutorial: { tabId: 2, title: 'Other', host: 'vimeo.com' } });
    expect(h.core.snapshot().pending).toBeNull();
    expect(h.core.getStatus().phase).toBe('noVideo');
  });
});

describe('video changes', () => {
  it('a new source while CodeAlong-paused is never resumed', () => {
    const h = harness();
    h.connect();
    h.edit();
    h.ackPause();
    h.video(pausedBy('user', null, 0), 'source-changed');
    h.advance(IDLE * 2);
    expect(h.commands()).toEqual(['pause']);
  });

  it('scrubbing during a CodeAlong pause postpones the idle resume', () => {
    const h = harness();
    h.connect();
    h.edit();
    const pauseId = h.ackPause();
    h.advance(IDLE - 500);
    h.video(pausedBy('codealong', pauseId, 4), 'seek'); // user scrubs back to read the code
    h.advance(1_000);
    expect(h.commands()).toEqual(['pause']);
    h.advance(IDLE);
    expect(h.commands()).toEqual(['pause', 'resume']);
  });

  it('a seek during a CodeAlong pause keeps the pause resumable', () => {
    const h = harness();
    h.connect();
    h.edit();
    const pauseId = h.ackPause();
    h.video(pausedBy('codealong', pauseId, 4), 'seek');
    h.advance(IDLE);
    expect(h.sent.at(-1)).toMatchObject({ command: 'resume', pauseId });
  });
});

describe('settings', () => {
  it('disabling ends the session and cancels any scheduled resume', () => {
    const h = harness();
    h.connect();
    h.edit();
    h.ackPause();
    h.dispatch({ type: 'settings', settings: { ...DEFAULT_SETTINGS, enabled: false } });
    h.advance(IDLE * 2);
    expect(h.commands()).toEqual(['pause']);
    expect(h.core.getStatus().phase).toBe('disabled');
  });
});

describe('status', () => {
  it('walks through the expected phases', () => {
    const h = harness();
    expect(h.core.getStatus().phase).toBe('waitingForBrowser');
    h.dispatch({ type: 'browserConnected' });
    expect(h.core.getStatus().phase).toBe('noTutorial');
    h.dispatch({ type: 'tutorial', tutorial: { tabId: 1, title: 'T', host: 'h' } });
    expect(h.core.getStatus().phase).toBe('noVideo');
    h.video(playing(), 'play');
    expect(h.core.getStatus().phase).toBe('playing');
    h.edit();
    h.ackPause();
    const s = h.core.getStatus();
    expect(s.phase).toBe('coding');
    expect(s.resumeAt).toBe(h.now + IDLE);
    expect(s.tutorialTitle).toBe('T');
    h.advance(IDLE);
    h.ackResume();
    expect(h.core.getStatus().phase).toBe('playing');
    h.video(pausedBy('user'), 'manual-pause');
    expect(h.core.getStatus().phase).toBe('pausedByUser');
  });
});
