import { describe, expect, it } from 'vitest';
import type { VideoCause, VideoState } from '@codealong/protocol';
import { PAUSE_MARKER_ATTR, VideoController } from '../src/content/videoController';
import { FakeVideo, flush } from '../../../test/fakeVideo';

function setup(opts: { playing?: boolean; time?: number } = {}) {
  const video = new FakeVideo();
  video.currentTime = opts.time ?? 30;
  if (opts.playing ?? true) void video.play();
  const reports: { state: VideoState; cause: VideoCause }[] = [];
  const controller = new VideoController(video, (state, cause) => reports.push({ state, cause }));
  return { video, controller, reports, causes: () => reports.map((r) => r.cause) };
}

async function attached(opts?: { playing?: boolean; time?: number }) {
  const s = setup(opts);
  await flush(); // let the setup's own events pass before we listen
  s.controller.attach();
  return s;
}

describe('ownership', () => {
  it('a CodeAlong pause is owned by CodeAlong and its pause event is not mistaken for the user', async () => {
    const { video, controller, causes } = await attached();
    controller.handle({ command: 'pause', pauseId: 'p1' });
    await flush();
    expect(video.paused).toBe(true);
    expect(controller.state()).toMatchObject({ status: 'paused', owner: 'codealong', pauseId: 'p1' });
    expect(causes()).toEqual(['codealong-pause']);
  });

  it('a pause by the user is owned by the user', async () => {
    const { video, controller, causes } = await attached();
    video.pause();
    await flush();
    expect(controller.state()).toMatchObject({ status: 'paused', owner: 'user', pauseId: null });
    expect(causes()).toEqual(['manual-pause']);
  });

  it('never takes ownership of a video that is already paused', async () => {
    const { controller, causes } = await attached({ playing: false });
    controller.handle({ command: 'pause', pauseId: 'p1' });
    expect(controller.state()).toMatchObject({ owner: 'user', pauseId: null });
    expect(causes()).toEqual(['sync']);
  });

  it('a video that was paused before CodeAlong attached counts as paused by the user', async () => {
    const { controller } = await attached({ playing: false });
    expect(controller.state()).toMatchObject({ status: 'paused', owner: 'user' });
  });
});

describe('resume', () => {
  it('resumes its own pause with rewind', async () => {
    const { video, controller, causes } = await attached({ time: 30 });
    controller.handle({ command: 'pause', pauseId: 'p1' });
    await flush();
    controller.handle({ command: 'resume', pauseId: 'p1', rewindSeconds: 2 });
    await flush();
    expect(video.paused).toBe(false);
    expect(video.currentTime).toBe(28);
    expect(causes()).toEqual(['codealong-pause', 'codealong-resume']); // own seeking/play events swallowed
  });

  it('never rewinds below zero', async () => {
    const { video, controller } = await attached({ time: 1 });
    controller.handle({ command: 'pause', pauseId: 'p1' });
    controller.handle({ command: 'resume', pauseId: 'p1', rewindSeconds: 5 });
    await flush();
    expect(video.currentTime).toBe(0);
  });

  it('refuses to resume when the user paused after CodeAlong', async () => {
    const { video, controller, reports } = await attached();
    controller.handle({ command: 'pause', pauseId: 'p1' });
    await flush();
    void video.play(); // user plays...
    await flush();
    video.pause(); // ...and pauses again
    await flush();
    controller.handle({ command: 'resume', pauseId: 'p1', rewindSeconds: 2 });
    await flush();
    expect(video.paused).toBe(true);
    expect(reports.map((r) => r.cause)).toEqual(['codealong-pause', 'manual-play', 'manual-pause', 'sync']);
  });

  it('refuses a resume with a stale pauseId', async () => {
    const { video, controller } = await attached();
    controller.handle({ command: 'pause', pauseId: 'p2' });
    controller.handle({ command: 'resume', pauseId: 'p1', rewindSeconds: 2 });
    await flush();
    expect(video.paused).toBe(true);
  });

  it('a duplicate resume does nothing (no double rewind)', async () => {
    const { video, controller } = await attached({ time: 30 });
    controller.handle({ command: 'pause', pauseId: 'p1' });
    controller.handle({ command: 'resume', pauseId: 'p1', rewindSeconds: 2 });
    controller.handle({ command: 'resume', pauseId: 'p1', rewindSeconds: 2 });
    await flush();
    expect(video.currentTime).toBe(28);
    expect(video.paused).toBe(false);
  });

  it('skips the rewind when the user moved the playhead during the pause', async () => {
    const { video, controller, causes } = await attached({ time: 30 });
    controller.handle({ command: 'pause', pauseId: 'p1' });
    await flush();
    video.currentTime = 12; // user scrubs back to look at the code
    await flush();
    expect(controller.state()).toMatchObject({ owner: 'codealong', pauseId: 'p1' });
    controller.handle({ command: 'resume', pauseId: 'p1', rewindSeconds: 2 });
    await flush();
    expect(video.currentTime).toBe(12);
    expect(video.paused).toBe(false);
    expect(causes()).toContain('seek');
  });

  it('when play() is rejected, gives the decision back to the user', async () => {
    const { video, controller, causes } = await attached();
    controller.handle({ command: 'pause', pauseId: 'p1' });
    await flush();
    video.rejectPlay = true;
    controller.handle({ command: 'resume', pauseId: 'p1', rewindSeconds: 0 });
    await flush();
    expect(controller.state()).toMatchObject({ status: 'paused', owner: 'user' });
    expect(causes().at(-1)).toBe('command-failed');
  });
});

describe('release (CodeAlong turned off)', () => {
  it('turns its own pause into a user pause, which is then never resumed', async () => {
    const { video, controller, causes } = await attached();
    controller.handle({ command: 'pause', pauseId: 'p1' });
    await flush();
    controller.handle({ command: 'release', pauseId: 'p1' });
    expect(controller.state()).toMatchObject({ status: 'paused', owner: 'user', pauseId: null });
    expect(video.getAttribute(PAUSE_MARKER_ATTR)).toBeNull();
    controller.handle({ command: 'resume', pauseId: 'p1', rewindSeconds: 2 });
    await flush();
    expect(video.paused).toBe(true);
    expect(causes()).toEqual(['codealong-pause', 'sync', 'sync']);
  });

  it('ignores a release for another pause', async () => {
    const { controller } = await attached();
    controller.handle({ command: 'pause', pauseId: 'p2' });
    controller.handle({ command: 'release', pauseId: 'p1' });
    expect(controller.state()).toMatchObject({ owner: 'codealong', pauseId: 'p2' });
  });
});

describe('user commands', () => {
  it('toggle pauses as the user and plays without rewind', async () => {
    const { video, controller, causes } = await attached({ time: 30 });
    controller.handle({ command: 'userToggle' });
    await flush();
    expect(controller.state()).toMatchObject({ status: 'paused', owner: 'user' });
    controller.handle({ command: 'userToggle' });
    await flush();
    expect(video.paused).toBe(false);
    expect(video.currentTime).toBe(30);
    expect(causes()).toEqual(['manual-pause', 'manual-play']);
  });

  it('a manual play of a CodeAlong pause is reported as manual', async () => {
    const { video, controller, causes } = await attached();
    controller.handle({ command: 'pause', pauseId: 'p1' });
    await flush();
    void video.play();
    await flush();
    expect(causes()).toEqual(['codealong-pause', 'manual-play']);
    expect(video.getAttribute(PAUSE_MARKER_ATTR)).toBeNull();
  });
});

describe('lifecycle', () => {
  it('reaching the end is reported as ended, not as a user pause', async () => {
    const { video, controller, causes } = await attached();
    video.reachEnd();
    await flush();
    expect(causes()).toEqual(['ended']);
    expect(controller.state().status).toBe('ended');
    controller.handle({ command: 'pause', pauseId: 'p1' });
    expect(controller.state().owner).toBeNull();
  });

  it('a new source forgets the CodeAlong pause', async () => {
    const { video, controller, causes } = await attached();
    controller.handle({ command: 'pause', pauseId: 'p1' });
    await flush();
    video.loadNewSource();
    await flush();
    expect(causes().at(-1)).toBe('source-changed');
    controller.handle({ command: 'resume', pauseId: 'p1', rewindSeconds: 2 });
    await flush();
    expect(video.paused).toBe(true);
  });

  it('a fresh controller (extension reloaded) recognises a CodeAlong pause from the marker', async () => {
    const { video, controller } = await attached({ time: 30 });
    controller.handle({ command: 'pause', pauseId: 'p1' });
    await flush();
    controller.detach();

    const next = new VideoController(video, () => undefined);
    next.attach();
    expect(next.state()).toMatchObject({ owner: 'codealong', pauseId: 'p1' });
  });

  it('ignores a stale marker when the video moved since (user changed things meanwhile)', async () => {
    const { video, controller } = await attached({ time: 30 });
    controller.handle({ command: 'pause', pauseId: 'p1' });
    await flush();
    controller.detach();
    video.currentTime = 100;
    await flush();

    const next = new VideoController(video, () => undefined);
    next.attach();
    expect(next.state()).toMatchObject({ owner: 'user', pauseId: null });
    expect(video.getAttribute(PAUSE_MARKER_ATTR)).toBeNull();
  });

  it('stops listening after detach', async () => {
    const { video, controller, reports } = await attached();
    controller.detach();
    video.pause();
    await flush();
    expect(reports).toEqual([]);
  });
});
