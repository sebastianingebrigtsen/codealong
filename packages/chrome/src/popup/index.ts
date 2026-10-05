import { describeStatus, type StatusPhase } from '@codealong/protocol';
import { PRIVACY_URL, VSCODE_EXTENSION_URL } from '../shared/links';
import type { FollowResult, PopupRequest, PopupStatus, ProbeResult } from '../shared/messages';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const el = {
  enabled: $<HTMLInputElement>('enabled'),
  headline: $('headline'),
  detail: $('detail'),
  vscode: $('vscode'),
  tutorial: $('tutorial'),
  video: $('video'),
  error: $('error'),
  follow: $<HTMLButtonElement>('follow'),
  toggle: $<HTMLButtonElement>('toggle'),
  done: $<HTMLButtonElement>('done'),
  debug: $<HTMLInputElement>('debug'),
  log: $('log'),
  privacy: $<HTMLAnchorElement>('privacy'),
};

const PHASE_DETAIL: Partial<Record<StatusPhase, string>> = {
  playing: 'Start typing in VS Code and the video pauses.',
  coding: 'Paused while you code. It continues when you stop typing or save.',
  codingWhilePlaying: 'You pressed play while coding, so CodeAlong lets it play.',
  waitingToResume: 'Paused by CodeAlong. Save, click "I\'m done" or press play to continue.',
  pausedByUser: "You paused the video, so CodeAlong won't start it again by itself.",
  noVideo: 'No video found on this tab yet. Start the video to let CodeAlong find it.',
  disabled: 'CodeAlong is turned off in VS Code.',
  ended: 'The video has ended.',
};

let currentTab: chrome.tabs.Tab | undefined;
let status: PopupStatus | undefined;
/** Result of the last "is VS Code there?" probe; null while unknown. */
let vscodeFound: boolean | null = null;
let incompatible = false;
let lastProbe = 0;

function request<T>(msg: PopupRequest): Promise<T> {
  return chrome.runtime.sendMessage(msg) as Promise<T>;
}

function setText(node: HTMLElement, text: string, tone: '' | 'ok' | 'warn' | 'bad' = ''): void {
  if (node.textContent !== text) node.textContent = text;
  node.title = text;
  node.className = tone;
}

function setMessage(headline: string, detail: string, link?: { href: string; label: string }): void {
  if (el.headline.textContent !== headline) el.headline.textContent = headline;
  const key = `${detail}|${link?.href ?? ''}`;
  if (el.detail.dataset.key === key) return;
  el.detail.dataset.key = key;
  el.detail.textContent = detail;
  if (link) {
    const a = document.createElement('a');
    a.href = link.href;
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = link.label;
    el.detail.append(' ', a);
  }
}

function showError(message: string | null): void {
  el.error.hidden = !message;
  el.error.textContent = message ?? '';
}

function render(s: PopupStatus): void {
  status = s;
  el.enabled.checked = s.enabled;
  el.debug.checked = s.debug;
  const connected = s.connection === 'connected';
  if (connected) vscodeFound = true;
  const installLink = { href: VSCODE_EXTENSION_URL, label: 'Get CodeAlong for VS Code' };

  if (!s.enabled) {
    setMessage('CodeAlong is off', 'Turn it on to pause tutorials while you code.');
  } else if (!connected && (s.incompatible || incompatible)) {
    setMessage(
      'Update CodeAlong',
      'Your Chrome and VS Code extensions are different versions. Update both to the latest version.',
    );
  } else if (!s.tutorial) {
    if (vscodeFound === false) {
      setMessage(
        'VS Code not found',
        'CodeAlong needs its VS Code extension too. Install it and keep VS Code open.',
        installLink,
      );
    } else {
      setMessage('Ready when you are', 'Open a coding tutorial in this tab and click "Follow this tab".');
    }
  } else if (!connected) {
    if (vscodeFound === false) {
      setMessage(
        'Waiting for VS Code',
        'Open VS Code with the CodeAlong extension. It connects automatically.',
        installLink,
      );
    } else {
      setMessage('Connecting to VS Code…', '');
    }
  } else if (s.hub) {
    setMessage(describeStatus(s.hub, Date.now()), PHASE_DETAIL[s.hub.phase] ?? '');
  } else {
    setMessage('Connected to VS Code', '');
  }

  setText(
    el.vscode,
    connected ? 'Connected' : vscodeFound === null ? 'Checking…' : vscodeFound ? 'Running' : 'Not found',
    connected || vscodeFound ? 'ok' : vscodeFound === false ? 'bad' : '',
  );

  const isThisTab = !!s.tutorial && s.tutorial.tabId === currentTab?.id;
  setText(
    el.tutorial,
    s.tutorial ? `${s.tutorial.title || s.tutorial.host}${isThisTab ? '' : ' (other tab)'}` : 'None',
  );

  const v = s.video;
  const videoText = !s.tutorial
    ? '–'
    : !v || v.status === 'none'
      ? 'Not found yet'
      : v.status === 'playing'
        ? 'Playing'
        : v.status === 'ended'
          ? 'Ended'
          : v.owner === 'codealong'
            ? 'Paused by CodeAlong'
            : 'Paused by you';
  setText(el.video, videoText);

  el.follow.textContent = isThisTab ? 'Stop following' : s.tutorial ? 'Follow this tab instead' : 'Follow this tab';
  el.follow.classList.toggle('primary', !isThisTab);
  el.follow.disabled = !s.enabled || !currentTab?.id || !isWebPage(currentTab.url);
  el.toggle.disabled = el.done.disabled = !s.tutorial || !v || v.status === 'none';

  el.log.replaceChildren(
    ...(s.debug ? s.log : []).map((line) => {
      const li = document.createElement('li');
      li.textContent = line;
      return li;
    }),
  );
}

async function refresh(): Promise<void> {
  const s = await request<PopupStatus>({ type: 'popup:getStatus' });
  render(s);
  if (s.enabled && s.connection !== 'connected' && Date.now() - lastProbe > 3_000) {
    lastProbe = Date.now();
    const probe = await request<ProbeResult>({ type: 'popup:probe' });
    vscodeFound = probe.vscode || probe.incompatible;
    incompatible = probe.incompatible;
    if (status) render(status);
  }
}

function isWebPage(url: string | undefined): boolean {
  // Without a URL (no access yet) we still allow the click; the permission prompt decides.
  return url === undefined || /^https?:/.test(url);
}

/** Known video sites are covered by the manifest; anything else asks for access to that one site. */
function requestHostAccess(url: string | undefined): Promise<boolean> {
  if (!url) return Promise.resolve(false);
  let origin: string;
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return Promise.resolve(false);
    origin = `${u.protocol}//${u.hostname}/*`;
  } catch {
    return Promise.resolve(false);
  }
  // Called without any prior await so the click still counts as a user gesture. Resolves to true
  // immediately (no prompt) when access is already granted, e.g. for the sites in the manifest.
  return chrome.permissions.request({ origins: [origin] });
}

el.follow.addEventListener('click', async () => {
  showError(null);
  if (!currentTab?.id) return;
  if (status?.tutorial?.tabId === currentTab.id) {
    await request({ type: 'popup:unfollow' });
  } else {
    const granted = await requestHostAccess(currentTab.url).catch(() => false);
    if (!granted) {
      showError('CodeAlong needs access to this site to control its video. Nothing else on the site is read.');
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
el.toggle.addEventListener('click', () => void request({ type: 'popup:control', action: 'toggle' }).then(refresh));
el.done.addEventListener('click', () => void request({ type: 'popup:control', action: 'done' }).then(refresh));
el.privacy.href = PRIVACY_URL;

void (async () => {
  [currentTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  await refresh();
  setInterval(() => void refresh(), 500);
})();
