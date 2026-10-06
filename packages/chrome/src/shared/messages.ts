import type {
  ControlAction,
  HubStatus,
  SharedSettings,
  StatusPhase,
  VideoCause,
  VideoCommand,
  VideoState,
} from '@codealong/protocol';
import type { ChromeSettings, SettingsPatch } from './settings';

/** Messages inside the Chrome extension (content scripts / popup <-> service worker). */

// Content script -> service worker
export interface AgentHello {
  type: 'agent:hello';
}
export interface AgentVideoReport {
  type: 'agent:video';
  /** null when the frame has no usable video. */
  state: VideoState | null;
  cause: VideoCause;
  area: number;
  /** Only sent by the top frame. */
  title?: string;
}
export interface AgentReply {
  active: boolean;
  debug: boolean;
}

// Service worker -> content script
export type ToAgent =
  | { type: 'agent:activate'; debug: boolean }
  | { type: 'agent:deactivate' }
  | { type: 'agent:sync' }
  | { type: 'agent:command'; command: VideoCommand }
  | { type: 'agent:overlay'; overlay: OverlayState | null };

/** What the on-video status label needs to know. */
export interface OverlayState {
  phase: StatusPhase;
  resumeAt: number | null;
  settings: SharedSettings;
}

// Popup -> service worker
export type PopupRequest =
  | { type: 'popup:getStatus' }
  | { type: 'popup:follow'; tabId: number }
  | { type: 'popup:unfollow' }
  | { type: 'popup:setSettings'; patch: SettingsPatch }
  | { type: 'popup:resetSettings' }
  | { type: 'popup:probe' }
  | { type: 'popup:control'; action: Exclude<ControlAction, 'toggleEnabled'> };

export type ConnectionState = 'off' | 'connecting' | 'connected' | 'error';

export interface PopupStatus {
  settings: ChromeSettings;
  defaults: ChromeSettings;
  extensionVersion: string;
  /** Version of CodeAlong for VS Code, when connected (null for versions before 0.2.0). */
  hubVersion: string | null;
  /** Whether the connected VS Code extension applies settings from Chrome (null: not connected). */
  hubSupportsSettings: boolean | null;
  connection: ConnectionState;
  /** The last connection attempt failed because the two extensions are incompatible versions. */
  incompatible: boolean;
  tutorial: { tabId: number; title: string; host: string } | null;
  video: VideoState | null;
  hub: HubStatus | null;
  log: string[];
}

export interface ProbeResult {
  /** CodeAlong for VS Code is running and reachable. */
  vscode: boolean;
  /** VS Code answered, but speaks another protocol version: one side needs an update. */
  incompatible: boolean;
}

export interface FollowResult {
  ok: boolean;
  error?: string;
}
