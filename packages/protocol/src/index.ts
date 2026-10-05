/**
 * Wire protocol shared by the VS Code extension (the "hub") and the Chrome extension.
 *
 * Transport: one WebSocket per client, JSON text frames, hub listens on 127.0.0.1 only.
 * Clients:
 *   - "browser": the Chrome extension service worker. Authenticated by its Origin header
 *     (chrome-extension://<pinned id>), which web pages cannot forge.
 *   - "editor": additional VS Code windows. Authenticated by a shared secret in a
 *     user-only (0600) token file. They must not send an Origin header.
 *
 * Source code never travels over this protocol – only activity signals and video state.
 */

export const PROTOCOL_VERSION = 1;
export const DEFAULT_PORT = 47390;

/** ID of the Chrome extension, pinned via the "key" field in its manifest. */
export const CHROME_EXTENSION_ID = 'golihbblpnhanlhgnnngcfhmolomajoo';

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
}

export interface WelcomeMessage {
  type: 'welcome';
  protocol: number;
  hub: string;
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
  | { command: 'userPlay' };

export type CommandMessage = { type: 'command'; id: number } & VideoCommand;

export interface HubStatusMessage {
  type: 'status';
  status: HubStatus;
}

// Editor follower -> hub
export type ActivityKind = 'edit' | 'save';
export interface ActivityMessage {
  type: 'activity';
  kind: ActivityKind;
}
export type ControlAction = 'toggle' | 'done';
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
  | BrowserControlMessage;

export type EditorToHub = HelloMessage | PongMessage | PingMessage | ActivityMessage | EditorControlMessage;

export type HubToClient = WelcomeMessage | ErrorMessage | PingMessage | PongMessage | CommandMessage | HubStatusMessage;

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
const CONTROL_ACTIONS: readonly ControlAction[] = ['toggle', 'done'];

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
  return { type: 'hello', protocol: m.protocol, role: m.role, token: m.token as string | undefined, client: m.client };
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
    default:
      return null;
  }
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
  };
}

export function parseHubMessage(raw: string): HubToClient | null {
  const m = safeJson(raw);
  if (!m) return null;
  switch (m.type) {
    case 'welcome':
      return isFiniteNumber(m.protocol) && isShortString(m.hub, 128)
        ? { type: 'welcome', protocol: m.protocol, hub: m.hub }
        : null;
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
          return isShortString(m.pauseId, 64) ? { type: 'command', id: m.id, command: 'pause', pauseId: m.pauseId } : null;
        case 'resume':
          return isShortString(m.pauseId, 64) && isFiniteNumber(m.rewindSeconds) && m.rewindSeconds >= 0
            ? { type: 'command', id: m.id, command: 'resume', pauseId: m.pauseId, rewindSeconds: m.rewindSeconds }
            : null;
        case 'userToggle':
        case 'userPlay':
          return { type: 'command', id: m.id, command: m.command };
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
