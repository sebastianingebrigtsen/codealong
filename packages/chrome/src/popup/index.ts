import { describeStatus } from '@codealong/protocol';
import type { FollowResult, PopupRequest, PopupStatus } from '../shared/messages';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const el = {
  enabled: $<HTMLInputElement>('enabled'),
  connection: $('connection'),
  tutorial: $('tutorial'),
  video: $('video'),
  phase: $('phase'),
  error: $('error'),
  follow: $<HTMLButtonElement>('follow'),
  toggle: $<HTMLButtonElement>('toggle'),
  done: $<HTMLButtonElement>('done'),
  port: $<HTMLInputElement>('port'),
  debug: $<HTMLInputElement>('debug'),
  log: $('log'),
};

let currentTab: chrome.tabs.Tab | undefined;
let status: PopupStatus | undefined;

function request<T>(msg: PopupRequest): Promise<T> {
  return chrome.runtime.sendMessage(msg) as Promise<T>;
}

function showError(message: string | null): void {
  el.error.hidden = !message;
  el.error.textContent = message ?? '';
}

function setValue(node: HTMLElement, text: string, tone: '' | 'ok' | 'warn' | 'bad' = ''): void {
  node.textContent = text;
  node.title = text;
  node.className = `value ${tone}`;
}

function render(s: PopupStatus): void {
  status = s;
  el.enabled.checked = s.enabled;
  el.debug.checked = s.debug;
  if (document.activeElement !== el.port) el.port.value = String(s.port);

  const conn = {
    off: ['Not connected', ''],
    connecting: ['Connecting…', 'warn'],
    connected: ['Connected', 'ok'],
    error: [s.connectionError ?? 'Not reachable', 'bad'],
  } as const;
  const [connText, connTone] = s.enabled ? conn[s.connection] : (['CodeAlong is off', ''] as const);
  setValue(el.connection, connText, connTone);

  setValue(el.tutorial, s.tutorial ? s.tutorial.title || s.tutorial.host : 'None');
  const v = s.video;
  const videoText = !s.tutorial
    ? '–'
    : !v
      ? 'No video found yet'
      : v.status === 'paused'
        ? v.owner === 'codealong'
          ? 'Paused by CodeAlong'
          : 'Paused by you'
        : v.status === 'playing'
          ? 'Playing'
          : v.status === 'ended'
            ? 'Ended'
            : 'No video';
  setValue(el.video, videoText);
  setValue(el.phase, s.hub ? describeStatus(s.hub, Date.now()) : '–');

  const isThisTab = !!s.tutorial && s.tutorial.tabId === currentTab?.id;
  el.follow.textContent = isThisTab ? 'Stop following' : s.tutorial ? 'Follow this tab instead' : 'Follow this tab';
  el.follow.classList.toggle('primary', !isThisTab);
  el.follow.disabled = !s.enabled || !currentTab?.id;
  el.toggle.disabled = el.done.disabled = !s.tutorial || !v;

  el.log.replaceChildren(
    ...(s.debug ? s.log : []).map((line) => {
      const li = document.createElement('li');
      li.textContent = line;
      return li;
    }),
  );
}

async function refresh(): Promise<void> {
  render(await request<PopupStatus>({ type: 'popup:getStatus' }));
}

/** Known sites are covered by the manifest; for anything else ask for access to just that site. */
async function ensureHostAccess(url: string | undefined): Promise<boolean> {
  if (!url) return false;
  let origin: string;
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
    origin = `${u.protocol}//${u.hostname}/*`;
  } catch {
    return false;
  }
  // Called without any prior await so the click's user gesture is still valid. Resolves to true
  // immediately (no prompt) when access is already granted, e.g. for the sites in the manifest.
  return chrome.permissions.request({ origins: [origin] });
}

el.follow.addEventListener('click', async () => {
  showError(null);
  if (!currentTab?.id) return;
  if (status?.tutorial?.tabId === currentTab.id) {
    await request({ type: 'popup:unfollow' });
  } else {
    const granted = await ensureHostAccess(currentTab.url).catch(() => false);
    if (!granted) {
      showError('CodeAlong needs access to this site to control its video.');
      return;
    }
    const result = await request<FollowResult>({ type: 'popup:follow', tabId: currentTab.id });
    if (!result.ok) showError(result.error ?? 'Could not follow this tab.');
  }
  await refresh();
});

el.enabled.addEventListener('change', async () => {
  await request({ type: 'popup:setEnabled', enabled: el.enabled.checked });
  await refresh();
});
el.debug.addEventListener('change', async () => {
  await request({ type: 'popup:setDebug', debug: el.debug.checked });
  await refresh();
});
el.port.addEventListener('change', async () => {
  const result = await request<FollowResult>({ type: 'popup:setPort', port: Number(el.port.value) });
  showError(result.ok ? null : (result.error ?? 'Invalid port'));
  await refresh();
});
el.toggle.addEventListener('click', () => void request({ type: 'popup:control', action: 'toggle' }).then(refresh));
el.done.addEventListener('click', () => void request({ type: 'popup:control', action: 'done' }).then(refresh));

void (async () => {
  [currentTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  await refresh();
  setInterval(() => void refresh(), 500);
})();
