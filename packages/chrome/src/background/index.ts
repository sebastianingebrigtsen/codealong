import {
  DEFAULT_PORT,
  type CommandMessage,
  type HubStatus,
  type VideoCause,
  type VideoState,
} from '@codealong/protocol';
import type {
  AgentReply,
  AgentVideoReport,
  FollowResult,
  PopupRequest,
  PopupStatus,
  ToAgent,
} from '../shared/messages';
import { HubConnection } from './connection';
import { FrameTracker } from './frames';
import { isStaticallyCovered } from './hosts';

/**
 * Service worker. Responsibilities:
 *  - the Active Tutorial (one tab, persisted so it survives worker restarts / extension reloads)
 *  - the local connection to VS Code (only while a tutorial is active)
 *  - routing: hub commands -> the frame that holds the tutorial video, video reports -> hub
 *  - tutorial focus signal, keyboard shortcuts, badge
 *
 * All listeners are registered synchronously at top level (MV3 requirement); each one awaits
 * `ready` before touching state.
 */

interface Settings {
  enabled: boolean;
  debug: boolean;
  port: number;
}
interface ActiveTutorial {
  tabId: number;
  windowId: number;
  title: string;
  host: string;
}

const KEEPALIVE_ALARM = 'codealong-keepalive';
const LOG_LIMIT = 40;

let settings: Settings = { enabled: true, debug: false, port: DEFAULT_PORT };
let active: ActiveTutorial | null = null;
let hubStatus: HubStatus | null = null;
let lastFocusSent: boolean | null = null;
let focusedWindowId: number = chrome.windows.WINDOW_ID_NONE;
const frames = new FrameTracker();
const recentLog: string[] = [];

const connection = new HubConnection(() => `ws://127.0.0.1:${settings.port}`, {
  onConnected() {
    lastFocusSent = null;
    sendTutorialToHub();
    forwardPrimary('sync');
    void updateFocus();
    void broadcastToTab({ type: 'agent:sync' });
    updateBadge();
  },
  onDisconnected() {
    hubStatus = null;
    updateBadge();
  },
  onCommand: (cmd) => void routeCommand(cmd),
  onStatus(status) {
    hubStatus = status;
    updateBadge();
  },
  log,
});

const ready = init();

async function init(): Promise<void> {
  const stored = await chrome.storage.local.get(['settings', 'active']);
  settings = { ...settings, ...(stored.settings as Partial<Settings> | undefined) };
  const candidate = stored.active as ActiveTutorial | undefined;
  // storage.session survives service-worker restarts but not extension reloads.
  const { workerStarted } = await chrome.storage.session.get('workerStarted');
  await chrome.storage.session.set({ workerStarted: true });
  if (candidate && (await tabStillMatches(candidate))) {
    active = candidate;
    // Worker restart: the agents are alive, waking them up is enough. Extension reload: they are
    // orphaned, so inject fresh ones (they recover CodeAlong's pause from the marker on the video).
    if (!workerStarted) await inject(candidate.tabId, true);
    void broadcastToTab({ type: 'agent:activate', debug: settings.debug });
  } else if (candidate) {
    await chrome.storage.local.remove('active');
  }
  const win = await chrome.windows.getLastFocused().catch(() => undefined);
  if (win?.focused && win.id !== undefined) focusedWindowId = win.id;
  syncConnection();
}

// ---------------------------------------------------------------------------
// Active tutorial

async function follow(tabId: number): Promise<FollowResult> {
  const tab = await chrome.tabs.get(tabId).catch(() => undefined);
  if (!tab?.id) return { ok: false, error: 'Tab not found' };
  // Switching tutorials keeps the VS Code connection open (no disconnect blip).
  if (active && active.tabId !== tab.id) await unfollow({ switching: true });

  active = {
    tabId: tab.id,
    windowId: tab.windowId,
    title: tab.title ?? '',
    host: safeHost(tab.url),
  };
  frames.clear();
  await chrome.storage.local.set({ active });
  log('TUTORIAL_ACTIVATED', active.host);

  const injected = await inject(tab.id, true);
  if (!injected.ok) {
    await unfollow();
    return injected;
  }
  await broadcastToTab({ type: 'agent:activate', debug: settings.debug });
  syncConnection();
  sendTutorialToHub();
  void updateFocus();
  return { ok: true };
}

async function unfollow(options: { switching?: boolean } = {}): Promise<void> {
  const old = active;
  if (!old) return;
  active = null;
  frames.clear();
  await chrome.storage.local.remove('active');
  await chrome.tabs.sendMessage(old.tabId, { type: 'agent:deactivate' } satisfies ToAgent).catch(() => undefined);
  log('TUTORIAL_DEACTIVATED', old.host);
  if (options.switching) return;
  sendTutorialToHub();
  syncConnection();
}

/**
 * Makes sure every frame of the tab has a content-script agent.
 *
 * `always`: inject even on sites with static content scripts. Chrome does not run manifest
 * content scripts in pages that were already open when the extension was installed or reloaded,
 * so following a tab (or restoring one after a reload) must inject explicitly. Duplicate agents
 * are harmless: a new agent takes over from an older one in the same frame.
 * After a fresh page load on a known site the static scripts are already there.
 */
async function inject(tabId: number, always: boolean): Promise<FollowResult> {
  const tab = await chrome.tabs.get(tabId).catch(() => undefined);
  if (!tab) return { ok: false, error: 'Tab not found' };
  if (!always && tab.url && isStaticallyCovered(tab.url)) return { ok: true };
  try {
    await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ['content.js'] });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: `Cannot access this page: ${String((err as Error).message ?? err)}` };
  }
}

async function tabStillMatches(t: ActiveTutorial): Promise<boolean> {
  const tab = await chrome.tabs.get(t.tabId).catch(() => undefined);
  // Without a URL (no host access) we cannot verify; tab ids are reused after a browser restart.
  return !!tab?.url && safeHost(tab.url) === t.host;
}

// ---------------------------------------------------------------------------
// Connection & routing

function syncConnection(): void {
  if (settings.enabled && active) {
    connection.ensure();
    void chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.5 });
  } else {
    connection.stop();
    hubStatus = null;
    void chrome.alarms.clear(KEEPALIVE_ALARM);
  }
  updateBadge();
}

function sendTutorialToHub(): void {
  connection.send({
    type: 'tutorial',
    tutorial: active ? { tabId: active.tabId, title: active.title, host: active.host } : null,
  });
}

function forwardPrimary(cause: VideoCause): void {
  connection.send({ type: 'video', video: frames.primaryState() ?? noVideo(), cause });
}

async function routeCommand(cmd: CommandMessage): Promise<void> {
  const frameId = frames.primaryFrameId();
  if (!active || frameId === null) {
    connection.send({ type: 'video', video: noVideo(), cause: 'command-failed' });
    return;
  }
  const { type: _type, id: _id, ...command } = cmd;
  const msg: ToAgent = { type: 'agent:command', command };
  try {
    await chrome.tabs.sendMessage(active.tabId, msg, { frameId });
  } catch {
    // The frame went away (navigation, iframe removed). Pick another one and tell the hub.
    log('FRAME_GONE', String(frameId));
    frames.remove(frameId);
    forwardPrimary('command-failed');
  }
}

function onAgentReport(frameId: number, report: AgentVideoReport): void {
  if (!active) return;
  if (frameId === 0 && report.title !== undefined && report.title !== active.title) {
    active.title = report.title;
    void chrome.storage.local.set({ active });
    sendTutorialToHub();
  }
  const before = frames.primaryFrameId();
  frames.update(frameId, report.state, report.area);
  const after = frames.primaryFrameId();
  if (after === frameId) {
    connection.send({ type: 'video', video: report.state ?? noVideo(), cause: report.cause });
  } else if (after !== before) {
    forwardPrimary('source-changed');
  }
  if (report.cause !== 'sync') log(`VIDEO_${report.cause.toUpperCase().replace(/-/g, '_')}`);
  updateBadge();
}

async function control(action: 'toggle' | 'done'): Promise<void> {
  if (action === 'done' && connection.connected) {
    connection.send({ type: 'control', action: 'done' });
    return;
  }
  // Toggle works even without VS Code: talk to the video directly.
  if (!active) return;
  const frameId = frames.primaryFrameId();
  if (frameId === null) return;
  const command = action === 'toggle' ? ({ command: 'userToggle' } as const) : ({ command: 'userPlay' } as const);
  await chrome.tabs.sendMessage(active.tabId, { type: 'agent:command', command } satisfies ToAgent, { frameId }).catch(() => undefined);
}

async function broadcastToTab(msg: ToAgent): Promise<void> {
  if (!active) return;
  await chrome.tabs.sendMessage(active.tabId, msg).catch(() => undefined);
}

// ---------------------------------------------------------------------------
// Focus: "is the tutorial tab the one in front?" (only a signal; never required)

async function updateFocus(): Promise<void> {
  if (!active) return;
  const tab = await chrome.tabs.get(active.tabId).catch(() => undefined);
  if (!tab || !active) return;
  active.windowId = tab.windowId;
  const focused = tab.active && tab.windowId === focusedWindowId;
  if (focused === lastFocusSent) return;
  if (connection.send({ type: 'focus', tutorialFocused: focused })) lastFocusSent = focused;
}

// ---------------------------------------------------------------------------
// Status & logging

function noVideo(): VideoState {
  return { status: 'none', owner: null, pauseId: null, currentTime: 0, duration: null };
}

function popupStatus(): PopupStatus {
  return {
    enabled: settings.enabled,
    debug: settings.debug,
    port: settings.port,
    connection: active && settings.enabled ? connection.state : 'off',
    connectionError: connection.lastError,
    tutorial: active ? { tabId: active.tabId, title: active.title, host: active.host } : null,
    video: frames.primaryState(),
    hub: hubStatus,
    log: [...recentLog],
  };
}

function updateBadge(): void {
  let text = '';
  let color = '#6b7280';
  if (settings.enabled && active) {
    if (!connection.connected) {
      text = '…';
    } else if (hubStatus?.phase === 'disabled') {
      text = 'OFF';
    } else if (hubStatus?.phase === 'coding' || hubStatus?.phase === 'waitingToResume') {
      text = 'II';
      color = '#d97706';
    } else {
      text = 'ON';
      color = '#16a34a';
    }
  }
  void chrome.action.setBadgeText({ text });
  void chrome.action.setBadgeBackgroundColor({ color });
}

function log(event: string, detail?: string): void {
  const line = `${new Date().toLocaleTimeString()} ${event}${detail ? ` ${detail}` : ''}`;
  recentLog.unshift(line);
  recentLog.length = Math.min(recentLog.length, LOG_LIMIT);
  if (settings.debug) console.debug('[CodeAlong]', line);
}

async function saveSettings(patch: Partial<Settings>): Promise<void> {
  settings = { ...settings, ...patch };
  await chrome.storage.local.set({ settings });
}

function safeHost(url: string | undefined): string {
  try {
    return url ? new URL(url).host : '';
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// Listeners (registered synchronously)

chrome.runtime.onMessage.addListener((msg: AgentVideoReport | { type: 'agent:hello' } | PopupRequest, sender, sendResponse) => {
  void (async () => {
    await ready;
    if (msg.type === 'agent:hello' || msg.type === 'agent:video') {
      const isActiveTab = !!active && sender.tab?.id === active.tabId && settings.enabled;
      if (isActiveTab && msg.type === 'agent:video' && sender.frameId !== undefined) {
        onAgentReport(sender.frameId, msg);
        connection.ensure(); // a report also wakes the worker: make sure we are (re)connecting
      }
      sendResponse({ active: isActiveTab, debug: settings.debug } satisfies AgentReply);
      return;
    }
    // Popup requests are only accepted from the extension's own pages, never from content scripts.
    const fromExtensionPage = sender.id === chrome.runtime.id && !!sender.url?.startsWith(chrome.runtime.getURL(''));
    sendResponse(fromExtensionPage ? await handlePopup(msg) : { ok: false, error: 'forbidden' });
  })();
  return true; // async response
});

async function handlePopup(msg: PopupRequest): Promise<unknown> {
  switch (msg.type) {
    case 'popup:getStatus':
      return popupStatus();
    case 'popup:follow':
      return follow(msg.tabId);
    case 'popup:unfollow':
      await unfollow();
      return { ok: true };
    case 'popup:setEnabled':
      await saveSettings({ enabled: msg.enabled });
      log(msg.enabled ? 'ENABLED' : 'DISABLED');
      await broadcastToTab(msg.enabled ? { type: 'agent:activate', debug: settings.debug } : { type: 'agent:deactivate' });
      syncConnection();
      return { ok: true };
    case 'popup:setDebug':
      await saveSettings({ debug: msg.debug });
      await broadcastToTab({ type: 'agent:activate', debug: msg.debug });
      return { ok: true };
    case 'popup:setPort':
      if (!Number.isInteger(msg.port) || msg.port < 1024 || msg.port > 65535) return { ok: false, error: 'Invalid port' };
      await saveSettings({ port: msg.port });
      connection.restart();
      return { ok: true };
    case 'popup:control':
      await control(msg.action);
      return { ok: true };
  }
}

chrome.tabs.onRemoved.addListener((tabId) => {
  void ready.then(async () => {
    if (active?.tabId !== tabId) return;
    log('TUTORIAL_TAB_CLOSED');
    await unfollow();
  });
});

chrome.tabs.onUpdated.addListener((tabId, info) => {
  void ready.then(async () => {
    if (active?.tabId !== tabId) return;
    if (info.status === 'loading' && info.url) {
      // Full navigation: frames (and their agents) are gone. SPA navigations keep the frames.
      frames.clear();
      forwardPrimary('source-changed');
    }
    if (info.status === 'complete') {
      const injected = await inject(tabId, false);
      if (!injected.ok) log('INJECT_FAILED', injected.error);
      await broadcastToTab({ type: 'agent:activate', debug: settings.debug });
    }
    // Re-check after the awaits above: the tutorial may have been closed or switched meanwhile.
    if (info.url && active?.tabId === tabId) {
      active.host = safeHost(info.url) || active.host;
      await chrome.storage.local.set({ active });
    }
  });
});

chrome.windows.onFocusChanged.addListener((windowId) => {
  void ready.then(() => {
    focusedWindowId = windowId;
    return updateFocus();
  });
});
chrome.tabs.onActivated.addListener(() => void ready.then(updateFocus));
chrome.tabs.onAttached.addListener(() => void ready.then(updateFocus));

chrome.commands.onCommand.addListener((command) => {
  void ready.then(() => control(command === 'done' ? 'done' : 'toggle'));
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === KEEPALIVE_ALARM) void ready.then(syncConnection);
});

// Without a listener here Chrome would not start the worker after an install/update/reload, and
// the tutorial tab would stay orphaned until the user happened to open the popup.
chrome.runtime.onInstalled.addListener(() => {
  void ready.then(syncConnection);
});

chrome.runtime.onStartup.addListener(() => {
  // Browser restart: tab ids from the previous session are meaningless.
  void ready.then(async () => {
    if (active && !(await tabStillMatches(active))) await unfollow();
  });
});
