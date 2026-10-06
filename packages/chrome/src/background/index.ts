import {
  HUB_PORTS,
  parsePortList,
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
  ProbeResult,
  ToAgent,
} from '../shared/messages';
import {
  DEFAULT_CHROME_SETTINGS,
  LEGACY_STORAGE_KEY,
  STORAGE_KEY,
  applySettingsPatch,
  readStoredSettings,
  type ChromeSettings,
} from '../shared/settings';
import { HubConnection } from './connection';
import { FrameTracker } from './frames';
import { isStaticallyCovered } from './hosts';
import { probeHub } from './probe';

/**
 * Service worker. Responsibilities:
 *  - the Active Tutorial (one tab, persisted so it survives worker restarts / extension reloads)
 *  - the local connection to VS Code (only while a tutorial is active)
 *  - routing: hub commands -> the frame that holds the tutorial video, video reports -> hub
 *  - tutorial focus signal, keyboard shortcuts, badge
 *  - the user's settings: stored here and sent to VS Code, which applies them
 *
 * All listeners are registered synchronously at top level (MV3 requirement); each one awaits
 * `ready` before touching state.
 */

interface ActiveTutorial {
  tabId: number;
  windowId: number;
  title: string;
  host: string;
}

const KEEPALIVE_ALARM = 'codealong-keepalive';
const LOG_LIMIT = 40;

/** Set only in development builds made for automated tests (see scripts/build.mjs). */
declare const __CODEALONG_TEST_PORTS__: string;
const HUB_URLS = (parsePortList(__CODEALONG_TEST_PORTS__) ?? HUB_PORTS).map((port) => `ws://127.0.0.1:${port}`);

let settings: ChromeSettings = structuredClone(DEFAULT_CHROME_SETTINGS);
/** Frame that currently shows the on-video status label, so it can be cleared when that changes. */
let overlayFrameId: number | null = null;
let active: ActiveTutorial | null = null;
let hubStatus: HubStatus | null = null;
let lastFocusSent: boolean | null = null;
let focusedWindowId: number = chrome.windows.WINDOW_ID_NONE;
const frames = new FrameTracker();
const recentLog: string[] = [];

const connection = new HubConnection(() => HUB_URLS, {
  onConnected() {
    lastFocusSent = null;
    sendSettingsToHub();
    sendTutorialToHub();
    forwardPrimary('sync');
    void updateFocus();
    void broadcastToTab({ type: 'agent:sync' });
    updateBadge();
  },
  onDisconnected() {
    hubStatus = null;
    updateBadge();
    void updateOverlay();
  },
  onCommand: (cmd) => void routeCommand(cmd),
  onStatus(status) {
    hubStatus = status;
    updateBadge();
    void updateOverlay();
  },
  onUpdateSettings(patch) {
    log('SETTINGS_CHANGED_IN_VSCODE');
    void updateSettings(patch);
  },
  log,
});

const ready = init();

async function init(): Promise<void> {
  const stored = await chrome.storage.local.get([STORAGE_KEY, LEGACY_STORAGE_KEY, 'active']);
  settings = readStoredSettings(stored);
  if (stored[LEGACY_STORAGE_KEY] !== undefined) {
    // Migrate the 0.1.0 format once.
    await chrome.storage.local.set({ [STORAGE_KEY]: settings });
    await chrome.storage.local.remove(LEGACY_STORAGE_KEY);
  }
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
  // Tell the hub about the new tutorial *before* the agents start reporting: the hub forgets the
  // video when the tutorial changes, so a later announcement would discard their first reports.
  sendTutorialToHub();
  await chrome.storage.local.set({ active });
  log('TUTORIAL_ACTIVATED', active.host);

  const injected = await inject(tab.id, true);
  if (!injected.ok) {
    await unfollow();
    return injected;
  }
  await broadcastToTab({ type: 'agent:activate', debug: settings.debug });
  syncConnection();
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
  // Connected whenever a tutorial is followed, even while automatic pausing is turned off: the
  // shortcuts, the status and the on/off switch in VS Code keep working.
  if (active) {
    connection.ensure();
    void chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.5 });
  } else {
    connection.stop();
    hubStatus = null;
    void chrome.alarms.clear(KEEPALIVE_ALARM);
  }
  updateBadge();
}

function sendSettingsToHub(): void {
  // Hubs older than 0.2.0 don't know settings; they keep using their own VS Code settings.
  if (connection.hub?.features.includes('settings')) connection.send({ type: 'settings', settings: settings.shared });
}

async function updateSettings(patch: unknown): Promise<ChromeSettings> {
  const next = applySettingsPatch(settings, patch);
  const sharedChanged = JSON.stringify(next.shared) !== JSON.stringify(settings.shared);
  const debugChanged = next.debug !== settings.debug;
  settings = next;
  await chrome.storage.local.set({ [STORAGE_KEY]: settings });
  if (sharedChanged) {
    log('SETTINGS_SAVED');
    sendSettingsToHub();
  }
  if (debugChanged) await broadcastToTab({ type: 'agent:activate', debug: settings.debug });
  updateBadge();
  await updateOverlay();
  return settings;
}

/** Shows (or clears) the small status label on the tutorial video, in the frame that holds it. */
async function updateOverlay(): Promise<void> {
  if (!active) return;
  const frameId = frames.primaryFrameId();
  const show = settings.showOverlay && connection.connected && hubStatus !== null;
  const overlay =
    show && hubStatus ? { phase: hubStatus.phase, resumeAt: hubStatus.resumeAt, settings: settings.shared } : null;
  const tabId = active.tabId;
  if (overlayFrameId !== null && overlayFrameId !== frameId) {
    await chrome.tabs
      .sendMessage(tabId, { type: 'agent:overlay', overlay: null } satisfies ToAgent, { frameId: overlayFrameId })
      .catch(() => undefined);
  }
  overlayFrameId = frameId;
  if (frameId === null) return;
  await chrome.tabs
    .sendMessage(tabId, { type: 'agent:overlay', overlay } satisfies ToAgent, { frameId })
    .catch(() => undefined);
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
  if (after !== before) void updateOverlay();
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
  await chrome.tabs
    .sendMessage(active.tabId, { type: 'agent:command', command } satisfies ToAgent, { frameId })
    .catch(() => undefined);
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
    settings,
    defaults: DEFAULT_CHROME_SETTINGS,
    extensionVersion: chrome.runtime.getManifest().version,
    hubVersion: connection.hub?.version ?? null,
    hubSupportsSettings: connection.hub ? connection.hub.features.includes('settings') : null,
    connection: active ? connection.state : 'off',
    incompatible: connection.incompatible,
    tutorial: active ? { tabId: active.tabId, title: active.title, host: active.host } : null,
    video: frames.primaryState(),
    hub: hubStatus,
    log: [...recentLog],
  };
}

function updateBadge(): void {
  let text = '';
  let color = '#6b7280';
  if (active) {
    if (!connection.connected) {
      text = '…';
    } else if (!settings.shared.enabled || hubStatus?.phase === 'disabled') {
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

function safeHost(url: string | undefined): string {
  try {
    return url ? new URL(url).host : '';
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// Listeners (registered synchronously)

chrome.runtime.onMessage.addListener(
  (msg: AgentVideoReport | { type: 'agent:hello' } | PopupRequest, sender, sendResponse) => {
    void (async () => {
      await ready;
      if (msg.type === 'agent:hello' || msg.type === 'agent:video') {
        const isActiveTab = !!active && sender.tab?.id === active.tabId;
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
  },
);

async function handlePopup(msg: PopupRequest): Promise<unknown> {
  switch (msg.type) {
    case 'popup:getStatus':
      return popupStatus();
    case 'popup:follow':
      return follow(msg.tabId);
    case 'popup:unfollow':
      await unfollow();
      return { ok: true };
    case 'popup:setSettings':
      return { ok: true, settings: await updateSettings(msg.patch) };
    case 'popup:resetSettings':
      // Keeps the on/off switch and troubleshooting choice; resets timing and behaviour.
      return {
        ok: true,
        settings: await updateSettings({
          ...DEFAULT_CHROME_SETTINGS.shared,
          enabled: settings.shared.enabled,
          showOverlay: DEFAULT_CHROME_SETTINGS.showOverlay,
        }),
      };
    case 'popup:probe': {
      if (connection.connected) return { vscode: true, incompatible: false } satisfies ProbeResult;
      const outcome = await probeHub(HUB_URLS);
      return { vscode: outcome === 'found', incompatible: outcome === 'incompatible' } satisfies ProbeResult;
    }
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
chrome.runtime.onInstalled.addListener((details) => {
  void ready.then(syncConnection);
  // A short welcome page on first install only (never on updates).
  if (details.reason === chrome.runtime.OnInstalledReason.INSTALL) {
    void chrome.tabs.create({ url: chrome.runtime.getURL('welcome.html') });
  }
});

chrome.runtime.onStartup.addListener(() => {
  // Browser restart: tab ids from the previous session are meaningless.
  void ready.then(async () => {
    if (active && !(await tabStillMatches(active))) await unfollow();
  });
});
