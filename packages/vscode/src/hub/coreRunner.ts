import type { HubStatus, VideoCommand } from '@codealong/protocol';
import { HubCore, type CoreEvent, type CoreSettings, type LogEventName } from '../core/hubCore';

export interface RunnerDeps {
  sendCommand(command: VideoCommand): void;
  log(event: LogEventName, detail?: string): void;
  onStatus(status: HubStatus): void;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

/**
 * Runs the pure HubCore: feeds it events with the current time, executes its effects and keeps
 * exactly one timer armed for the core's next deadline.
 */
export class CoreRunner {
  private readonly core: HubCore;
  private timer: unknown = null;
  private lastStatusJson = '';
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  constructor(
    settings: CoreSettings,
    private readonly deps: RunnerDeps,
  ) {
    this.core = new HubCore(settings);
    this.now = deps.now ?? Date.now;
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  }

  dispatch(event: CoreEvent): void {
    const effects = this.core.dispatch(event, this.now());
    for (const effect of effects) {
      if (effect.type === 'send') this.deps.sendCommand(effect.command);
      else this.deps.log(effect.event, effect.detail);
    }
    this.arm();
    this.publishStatus();
  }

  status(): HubStatus {
    return this.core.getStatus();
  }

  dispose(): void {
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
  }

  private arm(): void {
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
    const deadline = this.core.nextDeadline();
    if (deadline === null) return;
    const delay = Math.max(0, deadline - this.now());
    this.timer = this.setTimer(() => {
      this.timer = null;
      this.dispatch({ type: 'tick' });
    }, delay + 1);
  }

  private publishStatus(): void {
    const status = this.core.getStatus();
    const json = JSON.stringify(status);
    if (json === this.lastStatusJson) return;
    this.lastStatusJson = json;
    this.deps.onStatus(status);
  }
}
