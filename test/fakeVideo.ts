import type { VideoLike } from '../packages/chrome/src/content/videoController';

/**
 * Minimal HTMLMediaElement stand-in with the semantics the controller depends on:
 * `paused` flips synchronously, events are dispatched asynchronously (like queued media tasks),
 * reaching the end fires "pause" then "ended", setting currentTime fires "seeking".
 */
export class FakeVideo extends EventTarget implements VideoLike {
  paused = true;
  ended = false;
  duration = 600;
  isConnected = true;
  /** When set, play() rejects like Chrome's autoplay policy would. */
  rejectPlay = false;
  private time = 0;
  private readonly attrs = new Map<string, string>();

  get currentTime(): number {
    return this.time;
  }
  set currentTime(t: number) {
    this.time = t;
    this.ended = false;
    this.fire('seeking');
  }

  play(): Promise<void> {
    if (this.rejectPlay) return Promise.reject(new Error('NotAllowedError'));
    if (this.paused) {
      this.paused = false;
      this.ended = false;
      this.fire('play');
    }
    return Promise.resolve();
  }

  pause(): void {
    if (this.paused) return;
    this.paused = true;
    this.fire('pause');
  }

  /** Playback advances (no events, like normal timeupdate-free progress). */
  advance(seconds: number): void {
    this.time = Math.min(this.duration, this.time + seconds);
  }

  reachEnd(): void {
    this.time = this.duration;
    this.ended = true;
    this.paused = true;
    this.fire('pause');
    this.fire('ended');
  }

  loadNewSource(): void {
    this.time = 0;
    this.ended = false;
    this.paused = true;
    this.attrs.clear();
    this.fire('emptied');
  }

  getAttribute(name: string): string | null {
    return this.attrs.get(name) ?? null;
  }
  setAttribute(name: string, value: string): void {
    this.attrs.set(name, value);
  }
  removeAttribute(name: string): void {
    this.attrs.delete(name);
  }

  private fire(type: string): void {
    queueMicrotask(() => this.dispatchEvent(new Event(type)));
  }
}

/** Let queued media events (microtasks) and promise callbacks run. */
export async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}
