export interface Candidate<T> {
  key: T;
  /** Visible area in CSS pixels. */
  area: number;
  playing: boolean;
}

/** Videos smaller than this (e.g. 50x50 decorative loops) are never picked on size alone. */
export const MIN_AREA = 2_500;
/** A challenger must be at least this fraction of the current pick's size to take over. */
const TAKEOVER_RATIO = 0.5;

/**
 * Picks the tutorial video among several candidates (videos in a frame, or frames in a tab).
 *
 * Sticky by design: once a video is chosen we keep it, so a hover preview or a small ad that
 * starts playing while the tutorial is paused cannot steal control. We only switch when another,
 * comparably large video is playing while the current one is not (the user clearly moved on).
 */
export function chooseCandidate<T>(candidates: readonly Candidate<T>[], current: T | null): T | null {
  const bySize = (a: Candidate<T>, b: Candidate<T>) => b.area - a.area;
  const playing = candidates.filter((c) => c.playing).sort(bySize);
  const cur = current === null ? undefined : candidates.find((c) => c.key === current);

  if (cur) {
    const challenger = playing.find((c) => c.key !== cur.key);
    const takeover =
      !cur.playing && challenger !== undefined && challenger.area >= MIN_AREA && challenger.area >= cur.area * TAKEOVER_RATIO;
    return takeover ? challenger.key : cur.key;
  }

  const playingVisible = playing.find((c) => c.area >= MIN_AREA);
  if (playingVisible) return playingVisible.key;
  const largest = candidates.filter((c) => c.area >= MIN_AREA).sort(bySize)[0];
  return largest?.key ?? null;
}
