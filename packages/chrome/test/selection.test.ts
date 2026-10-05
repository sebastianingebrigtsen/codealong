import { describe, expect, it } from 'vitest';
import { chooseCandidate, MIN_AREA } from '../src/shared/selection';
import { FrameTracker } from '../src/background/frames';
import { isStaticallyCovered } from '../src/background/hosts';
import type { VideoState } from '@codealong/protocol';

const BIG = 1280 * 720;
const THUMB = 168 * 94;

describe('chooseCandidate', () => {
  it('prefers a playing video, then the largest visible one', () => {
    expect(
      chooseCandidate(
        [
          { key: 'a', area: BIG, playing: false },
          { key: 'b', area: BIG / 2, playing: true },
        ],
        null,
      ),
    ).toBe('b');
    expect(
      chooseCandidate(
        [
          { key: 'a', area: BIG / 2, playing: false },
          { key: 'b', area: BIG, playing: false },
        ],
        null,
      ),
    ).toBe('b');
  });

  it('ignores tiny or invisible videos', () => {
    expect(chooseCandidate([{ key: 'a', area: MIN_AREA - 1, playing: true }], null)).toBeNull();
    expect(chooseCandidate([{ key: 'a', area: 0, playing: false }], null)).toBeNull();
  });

  it('is sticky: a hover preview playing next to a paused tutorial does not steal control', () => {
    const picked = chooseCandidate(
      [
        { key: 'main', area: BIG, playing: false },
        { key: 'preview', area: THUMB, playing: true },
      ],
      'main',
    );
    expect(picked).toBe('main');
  });

  it('switches when another large video plays while the current one does not', () => {
    const picked = chooseCandidate(
      [
        { key: 'old', area: BIG, playing: false },
        { key: 'new', area: BIG, playing: true },
      ],
      'old',
    );
    expect(picked).toBe('new');
  });

  it('drops a current video that disappeared', () => {
    expect(chooseCandidate([{ key: 'b', area: BIG, playing: false }], 'gone')).toBe('b');
  });
});

describe('FrameTracker', () => {
  const state = (status: VideoState['status']): VideoState => ({
    status,
    owner: status === 'paused' ? 'user' : null,
    pauseId: null,
    currentTime: 0,
    duration: 10,
  });

  it('routes to the frame holding the tutorial video (e.g. a Vimeo iframe)', () => {
    const t = new FrameTracker();
    t.update(0, null, 0); // top frame without video (Laracasts page)
    t.update(7, state('playing'), BIG); // player.vimeo.com iframe
    expect(t.primaryFrameId()).toBe(7);
    expect(t.primaryState()?.status).toBe('playing');
  });

  it('forgets frames that went away', () => {
    const t = new FrameTracker();
    t.update(7, state('playing'), BIG);
    t.remove(7);
    expect(t.primaryFrameId()).toBeNull();
    t.update(3, state('paused'), BIG);
    expect(t.primaryFrameId()).toBe(3);
    t.update(3, null, 0);
    expect(t.primaryFrameId()).toBeNull();
  });
});

describe('isStaticallyCovered', () => {
  it('matches the sites declared in the manifest', () => {
    expect(isStaticallyCovered('https://www.youtube.com/watch?v=x')).toBe(true);
    expect(isStaticallyCovered('https://player.vimeo.com/video/1')).toBe(true);
    expect(isStaticallyCovered('https://laracasts.com/series/x')).toBe(true);
    expect(isStaticallyCovered('https://notyoutube.com/')).toBe(false);
    expect(isStaticallyCovered('https://www.udemy.com/course/x')).toBe(false);
    expect(isStaticallyCovered('http://www.youtube.com/')).toBe(false);
    expect(isStaticallyCovered('not a url')).toBe(false);
  });
});
