import type { OverlayState } from '../shared/messages';

/**
 * A small label in the corner of the tutorial video that says why it is paused and when it will
 * continue ("Paused while you code · continues 5 s after you stop typing", then a countdown).
 * The video is what the user looks at, so this is where CodeAlong's behaviour should be visible.
 *
 * Isolated in a shadow root, never intercepts the mouse, follows the video (also in fullscreen)
 * and can be turned off in the popup.
 */

const COUNTDOWN_FROM_MS = 3_000;
const FLASH_MS = 1_800;

const CSS = `
  :host { all: initial; position: fixed; z-index: 2147483646; pointer-events: none; }
  .pill {
    display: flex; align-items: center; gap: 10px; max-width: 340px;
    padding: 8px 12px 8px 10px; border-radius: 10px;
    background: rgba(15, 23, 42, 0.86); color: #fff;
    font: 13px/1.35 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    box-shadow: 0 6px 24px rgba(0, 0, 0, 0.35);
    -webkit-backdrop-filter: blur(6px); backdrop-filter: blur(6px);
    opacity: 0; transform: translateY(-4px); transition: opacity 160ms ease, transform 160ms ease;
  }
  .pill.visible { opacity: 1; transform: none; }
  .mark { flex: none; width: 22px; height: 22px; border-radius: 6px; display: grid; place-items: center;
          background: linear-gradient(135deg, #3b82f6, #4338ca); font-weight: 700; font-size: 12px; }
  .title { font-weight: 600; }
  .sub { color: #cbd5e1; font-size: 12px; }
  @media (prefers-reduced-motion: reduce) { .pill { transition: none; } }
`;

export class VideoOverlay {
  private host: HTMLElement | null = null;
  private pill: HTMLElement | null = null;
  private title: HTMLElement | null = null;
  private sub: HTMLElement | null = null;
  private state: OverlayState | null = null;
  private flashUntil = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly mac = /Mac/.test(navigator.platform);

  constructor(private readonly video: () => HTMLElement | null) {}

  /** New status from VS Code (via the service worker); null hides the label. */
  update(state: OverlayState | null): void {
    this.state = state;
    this.render();
  }

  /** Briefly confirms an automatic resume ("Continuing · rewound 2 s"). */
  flashResumed(): void {
    if (!this.state) return; // overlay turned off
    this.flashUntil = Date.now() + FLASH_MS;
    this.render();
  }

  dispose(): void {
    this.stopTimer();
    this.host?.remove();
    this.host = null;
  }

  private render(): void {
    const text = this.text();
    if (!text) {
      this.hide();
      return;
    }
    this.ensureHost();
    this.title!.textContent = text.title;
    this.sub!.textContent = text.sub;
    this.sub!.hidden = !text.sub;
    this.position();
    this.pill!.classList.add('visible');
    this.startTimer();
  }

  private text(): { title: string; sub: string } | null {
    const s = this.state;
    if (!s) return null;
    if (Date.now() < this.flashUntil) {
      return {
        title: 'Continuing',
        sub: s.settings.rewindBeforeResume ? `Rewound ${s.settings.rewindSeconds} s` : '',
      };
    }
    const done = this.mac ? '⌃⌥D' : 'Ctrl+Alt+D';
    if (s.phase === 'coding') {
      const left = s.resumeAt === null ? null : s.resumeAt - Date.now();
      if (left !== null && left <= COUNTDOWN_FROM_MS) {
        return { title: `Continuing in ${Math.max(1, Math.ceil(left / 1000))}…`, sub: 'Keep typing to stay paused' };
      }
      const how = s.settings.resumeOnIdle
        ? `Continues ${s.settings.idleDelaySeconds} s after you stop typing`
        : s.settings.resumeOnSave
          ? 'Continues when you save'
          : `Press ${done} when you're done`;
      return { title: 'Paused while you code', sub: how };
    }
    if (s.phase === 'waitingToResume') {
      const how = s.settings.resumeOnSave ? `Save or press ${done} to continue` : `Press ${done} to continue`;
      return { title: 'Paused by CodeAlong', sub: how };
    }
    return null;
  }

  private ensureHost(): void {
    const parent = (document.fullscreenElement as HTMLElement | null) ?? document.body ?? document.documentElement;
    if (this.host && this.host.parentNode === parent) return;
    if (!this.host) {
      this.host = document.createElement('codealong-status');
      const root = this.host.attachShadow({ mode: 'open' });
      root.innerHTML = `<style>${CSS}</style><div class="pill" role="status" aria-live="polite"><div class="mark" aria-hidden="true">II</div><div><div class="title"></div><div class="sub"></div></div></div>`;
      this.pill = root.querySelector('.pill');
      this.title = root.querySelector('.title');
      this.sub = root.querySelector('.sub');
    }
    parent.appendChild(this.host);
  }

  private position(): void {
    const host = this.host;
    const el = this.video();
    if (!host || !el) return;
    const r = el.getBoundingClientRect();
    const visible = r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight;
    host.style.display = visible ? '' : 'none';
    host.style.left = `${Math.max(8, r.left + 12)}px`;
    host.style.top = `${Math.max(8, r.top + 12)}px`;
  }

  private hide(): void {
    this.stopTimer();
    this.pill?.classList.remove('visible');
  }

  /** Keeps the countdown and the position current while the label is visible. */
  private startTimer(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.render(), 250);
  }

  private stopTimer(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
