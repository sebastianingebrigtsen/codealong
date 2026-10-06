/**
 * Wire protocol shared by the VS Code extension (the "hub") and the Chrome extension.
 *
 * Transport: one WebSocket per client, JSON text frames, hub listens on 127.0.0.1 only.
 * Clients:
 *   - "browser": the Chrome extension service worker. Authenticated by its Origin header
 *     (chrome-extension://<id>), which web pages cannot forge. Only known IDs are accepted.
 *   - "editor": additional VS Code windows. Authenticated by a shared secret in a
 *     user-only token file. They must not send an Origin header.
 *
 * Source code never travels over this protocol – only activity signals and video state.
 * See docs/ARCHITECTURE.md and SECURITY.md.
 */

export const PROTOCOL_VERSION = 1;

/**
 * Loopback ports the hub may listen on, in order of preference. If another program already uses
 * the first one, the hub moves to the next and the browser finds it by probing the same list, so
 * nobody ever has to configure a port.
 */
export const HUB_PORTS: readonly number[] = [47390, 47391, 47392];

/**
 * Parses a comma-separated port list ("48390,48391"). Used only by tests and contributors (env var
 * CODEALONG_HUB_PORTS) so automated tests never collide with a real CodeAlong on the same machine.
 */
export function parsePortList(value: string | undefined): number[] | null {
  if (!value) return null;
  const ports = value.split(',').map((p) => Number(p.trim()));
  return ports.length > 0 && ports.every((p) => Number.isInteger(p) && p > 1024 && p < 65536) ? ports : null;
}

/**
 * ID of development builds of the Chrome extension. Pinned by the public `key` in
 * packages/chrome/manifest.json so "Load unpacked" always yields the same ID.
 */
export const DEV_CHROME_EXTENSION_ID = 'golihbblpnhanlhgnnngcfhmolomajoo';

/**
 * ID assigned by the Chrome Web Store (the store does not accept the `key` field and picks its
 * own ID on the first upload). Must be filled in before the first public release; the release
 * script refuses to package without it. See docs/RELEASING.md.
 */
export const STORE_CHROME_EXTENSION_ID: string | null = 'jhfmljdjpeaclncddhhifegcknjgfjij';
/** Chrome extensions allowed to connect to the hub. */
export const ALLOWED_CHROME_EXTENSION_IDS: readonly string[] = [
  DEV_CHROME_EXTENSION_ID,
  STORE_CHROME_EXTENSION_ID,
].filter((id): id is string => typeof id === 'string' && /^[a-p]{32}$/.test(id));

export const HEARTBEAT_INTERVAL_MS = 20_000;
export const MAX_MESSAGE_BYTES = 16 * 1024;

// ---------------------------------------------------------------------------
// Video state (reported by the browser, authoritative about who paused)
// ---------------------------------------------------------------------------

export type VideoStatus = 'none' | 'playing' | 'paused' | 'ended';
export type PauseOwner = 'codealong' | 'user';

/** Why the browser is sending a video report. Used for logging and for user-intent detection. */
export type VideoCause =
  | 'sync' // periodic/initial report, nothing in particular happened
  | 'play' // started playing (first play, autoplay, new source)
  | 'codealong-pause'
  | 'codealong-resume'
  | 'manual-pause'
  | 'manual-play'
  | 'seek'
  | 'ended'
  | 'source-changed'
  | 'command-failed';

export interface VideoState {
  status: VideoStatus;
  /** Who paused the video. Only set when status === 'paused'. */
  owner: PauseOwner | null;
  /** Identifier of the CodeAlong pause. Only set when owner === 'codealong'. */
  pauseId: string | null;
  currentTime: number;
  duration: number | null;
}

export interface TutorialInfo {
  tabId: number;
  title: string;
  host: string;
}

// ---------------------------------------------------------------------------
// Settings (owned and stored by the Chrome extension, applied by the hub)
// ---------------------------------------------------------------------------

/**
 * How CodeAlong behaves. The Chrome extension stores these (chrome.storage.local) and sends them
 * to the hub whenever it connects or the user changes something; the hub never persists them.
 * Chrome owns them because they only matter while Chrome is connected, Chrome is the side that
 * always (re)connects, and its popup is where users look for them.
 */
export interface SharedSettings {
  /** Master switch for automatic pausing and resuming. Manual shortcuts always work. */
  enabled: boolean;
  resumeOnIdle: boolean;
  idleDelaySeconds: number;
  resumeOnSave: boolean;
  rewindBeforeResume: boolean;
  rewindSeconds: number;
  /** Continue when the tutorial tab gets focus again (handy on a single screen). */
  resumeOnFocus: boolean;
}

export const DEFAULT_SHARED_SETTINGS: Readonly<SharedSettings> = Object.freeze({
  enabled: true,
  resumeOnIdle: true,
  idleDelaySeconds: 5,
  resumeOnSave: true,
  rewindBeforeResume: true,
  rewindSeconds: 2,
  resumeOnFocus: false,
});

export const SETTING_LIMITS = Object.freeze({
  idleDelaySeconds: { min: 1, max: 30 },
  rewindSeconds: { min: 1, max: 15 },
});

/**
 * Turns anything (stored data from an older version, a message from the wire, a partial patch
 * merged onto the current settings) into valid settings: unknown fields are dropped, wrong types
 * fall back to the default, numbers are rounded and clamped. Never throws.
 */
export function sanitizeSettings(value: unknown, base: SharedSettings = DEFAULT_SHARED_SETTINGS): SharedSettings {
  const v = isObject(value) ? value : {};
  const bool = (key: keyof SharedSettings): boolean =>
    typeof v[key] === 'boolean' ? (v[key] as boolean) : (base[key] as boolean);
  const num = (key: 'idleDelaySeconds' | 'rewindSeconds'): number => {
    const { min, max } = SETTING_LIMITS[key];
    const raw = v[key];
    return isFiniteNumber(raw) ? Math.min(max, Math.max(min, Math.round(raw))) : base[key];
  };
  return {
    enabled: bool('enabled'),
    resumeOnIdle: bool('resumeOnIdle'),
    idleDelaySeconds: num('idleDelaySeconds'),
    resumeOnSave: bool('resumeOnSave'),
    rewindBeforeResume: bool('rewindBeforeResume'),
    rewindSeconds: num('rewindSeconds'),
    resumeOnFocus: bool('resumeOnFocus'),
  };
}

/** One-line, human summary of when CodeAlong continues, e.g. "Continues 5 s after you stop typing or save · rewinds 2 s". */
export function describeSettings(s: SharedSettings): string {
  if (!s.enabled) return 'Automatic pausing is off';
  const when: string[] = [];
  if (s.resumeOnIdle) when.push(`${s.idleDelaySeconds}\u00a0s after you stop typing`);
  if (s.resumeOnSave) when.push('when you save');
  if (s.resumeOnFocus) when.push('when you switch back to the tutorial');
  const head = when.length ? `Continues ${joinOr(when)}` : 'Continues only when you say so';
  return s.rewindBeforeResume ? `${head} · rewinds ${s.rewindSeconds}\u00a0s` : head;
}

function joinOr(parts: string[]): string {
  return parts.length <= 1 ? (parts[0] ?? '') : `${parts.slice(0, -1).join(', ')} or ${parts.at(-1)}`;
}

/** Capabilities a hub advertises in its welcome message (absent = an older hub). */
export type HubFeature = 'settings';

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export type ClientRole = 'browser' | 'editor';

export interface HelloMessage {
  type: 'hello';
  protocol: number;
  role: ClientRole;
  /** Required for role "editor". */
  token?: string;
  client: string;
  /**
   * Only checks that a hub is reachable (used by the browser's onboarding/popup and by VS Code
   * windows looking for an existing hub). The hub answers with "welcome" and closes; a probe
   * never replaces the active browser connection.
   */
  probe?: boolean;
}

export interface WelcomeMessage {
  type: 'welcome';
  protocol: number;
  hub: string;
  /** Version of the CodeAlong VS Code extension (absent before 0.2.0). */
  version?: string;
  /** Optional capabilities; additive so older and newer extensions keep working together. */
  features?: HubFeature[];
}

export interface ErrorMessage {
  type: 'error';
  code: 'protocol-mismatch' | 'unauthorized' | 'bad-message';
  message: string;
}

export interface PingMessage {
  type: 'ping';
}
export interface PongMessage {
  type: 'pong';
}

// Browser -> hub
export interface TutorialMessage {
  type: 'tutorial';
  tutorial: TutorialInfo | null;
}
export interface VideoMessage {
  type: 'video';
  video: VideoState;
  cause: VideoCause;
}
export interface FocusMessage {
  type: 'focus';
  tutorialFocused: boolean;
}
/** Manual control initiated in the browser (popup button / Chrome shortcut). */
export interface BrowserControlMessage {
  type: 'control';
  action: ControlAction;
}
/** The browser's current settings; sent after connecting and whenever they change. */
export interface SettingsMessage {
  type: 'settings';
  settings: SharedSettings;
}

// Hub -> browser
export type VideoCommand =
  /** Pause because the user started coding. The browser records the pause as owned by CodeAlong. */
  | { command: 'pause'; pauseId: string }
  /** Resume a CodeAlong pause. Ignored unless the video is still paused by CodeAlong with this pauseId. */
  | { command: 'resume'; pauseId: string; rewindSeconds: number }
  /**
   * Explicit user action (hotkey): play if paused, pause if playing. Decided by the browser
   * against the real video state, so rapid double presses cannot race. Pauses are recorded as
   * user pauses and plays never rewind.
   */
  | { command: 'userToggle' }
  /** Explicit user action ("I'm done" while the user had paused): play without rewind. */
  | { command: 'userPlay' }
  /**
   * CodeAlong was turned off while it had the video paused: hand that pause over to the user, so
   * turning CodeAlong back on later never starts the video by surprise.
   */
  | { command: 'release'; pauseId: string };

export type CommandMessage = { type: 'command'; id: number } & VideoCommand;

export interface HubStatusMessage {
  type: 'status';
  status: HubStatus;
}

/** Ask the browser (which owns the settings) to change some of them, e.g. "turn off" from VS Code. */
export interface UpdateSettingsMessage {
  type: 'updateSettings';
  patch: Partial<SharedSettings>;
}

// Editor follower -> hub
export type ActivityKind = 'edit' | 'save';
export interface ActivityMessage {
  type: 'activity';
  kind: ActivityKind;
}
export type ControlAction = 'toggle' | 'done' | 'toggleEnabled';
export interface EditorControlMessage {
  type: 'control';
  action: ControlAction;
}

/** Short, display-oriented summary of the hub state. Sent to browsers and follower editors. */
export interface HubStatus {
  phase: StatusPhase;
  enabled: boolean;
  browserConnected: boolean;
  tutorialTitle: string | null;
  /** Epoch ms at which an automatic resume is expected, if one is scheduled. */
  resumeAt: number | null;
  /** Settings in effect (null until a browser has sent them, or from a hub older than 0.2.0). */
  settings: SharedSettings | null;
}

export type StatusPhase =
  | 'disabled'
  | 'waitingForBrowser'
  | 'noTutorial'
  | 'noVideo'
  | 'playing'
  | 'coding' // user is typing, video paused by CodeAlong
  | 'codingWhilePlaying' // user is typing but chose to let the video play
  | 'waitingToResume' // CodeAlong pause, user stopped typing, waiting for a resume signal
  | 'pausedByUser'
  | 'ended';

export type BrowserToHub =
  | HelloMessage
  | PongMessage
  | PingMessage
  | TutorialMessage
  | VideoMessage
  | FocusMessage
  | BrowserControlMessage
  | SettingsMessage;

export type EditorToHub = HelloMessage | PongMessage | PingMessage | ActivityMessage | EditorControlMessage;

export type HubToClient =
  WelcomeMessage | ErrorMessage | PingMessage | PongMessage | CommandMessage | HubStatusMessage | UpdateSettingsMessage;

// ---------------------------------------------------------------------------
// Validation (never trust the wire)
// ---------------------------------------------------------------------------

type Json = Record<string, unknown>;

function isObject(v: unknown): v is Json {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}
function isShortString(v: unknown, max = 512): v is string {
  return typeof v === 'string' && v.length <= max;
}

const VIDEO_STATUSES: readonly VideoStatus[] = ['none', 'playing', 'paused', 'ended'];
const VIDEO_CAUSES: readonly VideoCause[] = [
  'sync',
  'play',
  'codealong-pause',
  'codealong-resume',
  'manual-pause',
  'manual-play',
  'seek',
  'ended',
  'source-changed',
  'command-failed',
];
const CONTROL_ACTIONS: readonly ControlAction[] = ['toggle', 'done', 'toggleEnabled'];

export function parseVideoState(v: unknown): VideoState | null {
  if (!isObject(v)) return null;
  const { status, owner, pauseId, currentTime, duration } = v;
  if (!VIDEO_STATUSES.includes(status as VideoStatus)) return null;
  if (owner !== null && owner !== 'codealong' && owner !== 'user') return null;
  if (pauseId !== null && !isShortString(pauseId, 64)) return null;
  if (!isFiniteNumber(currentTime) || currentTime < 0) return null;
  if (duration !== null && !isFiniteNumber(duration)) return null;
  return {
    status: status as VideoStatus,
    owner: status === 'paused' ? (owner as PauseOwner | null) : null,
    pauseId: status === 'paused' && owner === 'codealong' ? (pauseId as string | null) : null,
    currentTime,
    duration: duration as number | null,
  };
}

function parseTutorial(v: unknown): TutorialInfo | null | undefined {
  if (v === null) return null;
  if (!isObject(v)) return undefined;
  if (!isFiniteNumber(v.tabId) || !isShortString(v.title, 1024) || !isShortString(v.host, 256)) return undefined;
  return { tabId: v.tabId, title: v.title, host: v.host };
}

function parseHello(m: Json): HelloMessage | null {
  if (!isFiniteNumber(m.protocol)) return null;
  if (m.role !== 'browser' && m.role !== 'editor') return null;
  if (m.token !== undefined && !isShortString(m.token, 256)) return null;
  if (!isShortString(m.client, 128)) return null;
  if (m.probe !== undefined && typeof m.probe !== 'boolean') return null;
  const hello: HelloMessage = { type: 'hello', protocol: m.protocol, role: m.role, client: m.client };
  if (m.token !== undefined) hello.token = m.token as string;
  if (m.probe) hello.probe = true;
  return hello;
}

export function parseBrowserMessage(raw: string): BrowserToHub | null {
  const m = safeJson(raw);
  if (!m) return null;
  switch (m.type) {
    case 'hello':
      return parseHello(m);
    case 'ping':
    case 'pong':
      return { type: m.type };
    case 'tutorial': {
      const tutorial = parseTutorial(m.tutorial);
      return tutorial === undefined ? null : { type: 'tutorial', tutorial };
    }
    case 'video': {
      const video = parseVideoState(m.video);
      if (!video || !VIDEO_CAUSES.includes(m.cause as VideoCause)) return null;
      return { type: 'video', video, cause: m.cause as VideoCause };
    }
    case 'focus':
      return typeof m.tutorialFocused === 'boolean' ? { type: 'focus', tutorialFocused: m.tutorialFocused } : null;
    case 'control':
      return CONTROL_ACTIONS.includes(m.action as ControlAction)
        ? { type: 'control', action: m.action as ControlAction }
        : null;
    case 'settings':
      return isObject(m.settings) ? { type: 'settings', settings: sanitizeSettings(m.settings) } : null;
    default:
      return null;
  }
}

/** Validates a settings patch: only known keys with the right type survive. */
export function parseSettingsPatch(v: unknown): Partial<SharedSettings> | null {
  if (!isObject(v)) return null;
  const full = sanitizeSettings(v);
  const patch: Partial<SharedSettings> = {};
  for (const key of Object.keys(DEFAULT_SHARED_SETTINGS) as (keyof SharedSettings)[]) {
    if (key in v && typeof v[key] === typeof DEFAULT_SHARED_SETTINGS[key]) {
      (patch as Record<string, unknown>)[key] = full[key];
    }
  }
  return Object.keys(patch).length ? patch : null;
}

export function parseEditorMessage(raw: string): EditorToHub | null {
  const m = safeJson(raw);
  if (!m) return null;
  switch (m.type) {
    case 'hello':
      return parseHello(m);
    case 'ping':
    case 'pong':
      return { type: m.type };
    case 'activity':
      return m.kind === 'edit' || m.kind === 'save' ? { type: 'activity', kind: m.kind } : null;
    case 'control':
      return CONTROL_ACTIONS.includes(m.action as ControlAction)
        ? { type: 'control', action: m.action as ControlAction }
        : null;
    default:
      return null;
  }
}

const STATUS_PHASES: readonly StatusPhase[] = [
  'disabled',
  'waitingForBrowser',
  'noTutorial',
  'noVideo',
  'playing',
  'coding',
  'codingWhilePlaying',
  'waitingToResume',
  'pausedByUser',
  'ended',
];

function parseHubStatus(v: unknown): HubStatus | null {
  if (!isObject(v)) return null;
  if (!STATUS_PHASES.includes(v.phase as StatusPhase)) return null;
  if (typeof v.enabled !== 'boolean' || typeof v.browserConnected !== 'boolean') return null;
  if (v.tutorialTitle !== null && !isShortString(v.tutorialTitle, 1024)) return null;
  if (v.resumeAt !== null && !isFiniteNumber(v.resumeAt)) return null;
  return {
    phase: v.phase as StatusPhase,
    enabled: v.enabled,
    browserConnected: v.browserConnected,
    tutorialTitle: v.tutorialTitle as string | null,
    resumeAt: v.resumeAt as number | null,
    // Absent from hubs older than 0.2.0.
    settings: isObject(v.settings) ? sanitizeSettings(v.settings) : null,
  };
}

const HUB_FEATURES: readonly HubFeature[] = ['settings'];

export function parseHubMessage(raw: string): HubToClient | null {
  const m = safeJson(raw);
  if (!m) return null;
  switch (m.type) {
    case 'welcome': {
      if (!isFiniteNumber(m.protocol) || !isShortString(m.hub, 128)) return null;
      const welcome: WelcomeMessage = { type: 'welcome', protocol: m.protocol, hub: m.hub };
      if (isShortString(m.version, 32)) welcome.version = m.version;
      if (Array.isArray(m.features)) {
        welcome.features = m.features.filter((f): f is HubFeature => HUB_FEATURES.includes(f as HubFeature));
      }
      return welcome;
    }
    case 'updateSettings': {
      const patch = parseSettingsPatch(m.patch);
      return patch ? { type: 'updateSettings', patch } : null;
    }
    case 'error':
      return isShortString(m.code, 64) && isShortString(m.message, 1024)
        ? { type: 'error', code: m.code as ErrorMessage['code'], message: m.message }
        : null;
    case 'ping':
    case 'pong':
      return { type: m.type };
    case 'status': {
      const status = parseHubStatus(m.status);
      return status ? { type: 'status', status } : null;
    }
    case 'command': {
      if (!isFiniteNumber(m.id)) return null;
      switch (m.command) {
        case 'pause':
          return isShortString(m.pauseId, 64)
            ? { type: 'command', id: m.id, command: 'pause', pauseId: m.pauseId }
            : null;
        case 'resume':
          return isShortString(m.pauseId, 64) && isFiniteNumber(m.rewindSeconds) && m.rewindSeconds >= 0
            ? { type: 'command', id: m.id, command: 'resume', pauseId: m.pauseId, rewindSeconds: m.rewindSeconds }
            : null;
        case 'userToggle':
        case 'userPlay':
          return { type: 'command', id: m.id, command: m.command };
        case 'release':
          return isShortString(m.pauseId, 64)
            ? { type: 'command', id: m.id, command: 'release', pauseId: m.pauseId }
            : null;
        default:
          return null;
      }
    }
    default:
      return null;
  }
}

function safeJson(raw: string): Json | null {
  if (raw.length > MAX_MESSAGE_BYTES) return null;
  try {
    const v: unknown = JSON.parse(raw);
    return isObject(v) ? v : null;
  } catch {
    return null;
  }
}

/** Human readable status line, shared by the VS Code status bar and the Chrome popup. */
export function describeStatus(status: HubStatus, now: number): string {
  switch (status.phase) {
    case 'disabled':
      return 'Off';
    case 'waitingForBrowser':
      return 'Waiting for Chrome';
    case 'noTutorial':
      return 'Connected';
    case 'noVideo':
      return 'No video found';
    case 'playing':
      return 'Tutorial Playing';
    case 'coding':
      // Only show the countdown when it is close, so it does not flicker while the user types.
      if (status.resumeAt !== null && status.resumeAt - now <= 3_000) {
        const secs = Math.max(0, Math.ceil((status.resumeAt - now) / 1000));
        return `Coding... (resume in ${secs}s)`;
      }
      return 'Coding...';
    case 'codingWhilePlaying':
      return 'Coding (video playing)';
    case 'waitingToResume':
      return 'Paused – waiting for you';
    case 'pausedByUser':
      return 'Tutorial Paused';
    case 'ended':
      return 'Tutorial Ended';
  }
}
