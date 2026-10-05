import type { VideoState } from '@codealong/protocol';
import { chooseCandidate } from '../shared/selection';

interface FrameInfo {
  state: VideoState;
  area: number;
}

/** Tracks the video reported by each frame of the tutorial tab and which frame is "the" tutorial. */
export class FrameTracker {
  private readonly frames = new Map<number, FrameInfo>();
  private primary: number | null = null;

  update(frameId: number, state: VideoState | null, area: number): void {
    if (state && state.status !== 'none') this.frames.set(frameId, { state, area });
    else this.frames.delete(frameId);
    this.choose();
  }

  remove(frameId: number): void {
    this.frames.delete(frameId);
    this.choose();
  }

  clear(): void {
    this.frames.clear();
    this.primary = null;
  }

  primaryFrameId(): number | null {
    return this.primary;
  }

  primaryState(): VideoState | null {
    return this.primary === null ? null : (this.frames.get(this.primary)?.state ?? null);
  }

  private choose(): void {
    const candidates = [...this.frames].map(([key, f]) => ({ key, area: f.area, playing: f.state.status === 'playing' }));
    this.primary = chooseCandidate(candidates, this.primary !== null && this.frames.has(this.primary) ? this.primary : null);
  }
}
