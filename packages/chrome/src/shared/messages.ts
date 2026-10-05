import type { ControlAction, HubStatus, VideoCause, VideoCommand, VideoState } from '@codealong/protocol';

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
  | { type: 'agent:command'; command: VideoCommand };

// Popup -> service worker
export type PopupRequest =
  | { type: 'popup:getStatus' }
  | { type: 'popup:follow'; tabId: number }
  | { type: 'popup:unfollow' }
  | { type: 'popup:setEnabled'; enabled: boolean }
  | { type: 'popup:setDebug'; debug: boolean }
  | { type: 'popup:setPort'; port: number }
  | { type: 'popup:control'; action: ControlAction };

export type ConnectionState = 'off' | 'connecting' | 'connected' | 'error';

export interface PopupStatus {
  enabled: boolean;
  debug: boolean;
  port: number;
  connection: ConnectionState;
  connectionError: string | null;
  tutorial: { tabId: number; title: string; host: string } | null;
  video: VideoState | null;
  hub: HubStatus | null;
  log: string[];
}

export interface FollowResult {
  ok: boolean;
  error?: string;
}
