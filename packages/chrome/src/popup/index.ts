import { SETTING_LIMITS, describeSettings, describeStatus, type StatusPhase } from '@codealong/protocol';
import { ISSUES_URL, PRIVACY_URL, VSCODE_EXTENSION_URL } from '../shared/links';
import type { FollowResult, PopupRequest, PopupStatus, ProbeResult } from '../shared/messages';
import { scrub } from '../shared/diagnostics';
import type { SettingsPatch } from '../shared/settings';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const el = {
  enabled: $<HTMLInputElement>('enabled'),
  enabledText: $('enabled-text'),
  headline: $('headline'),
  detail: $('detail'),
  vscode: $('vscode'),
  tutorial: $('tutorial'),
  video: $('video'),
  error: $('error'),
  follow: $<HTMLButtonElement>('follow'),
  toggle: $<HTMLButtonElement>('toggle'),
  done: $<HTMLButtonElement>('done'),
  settings: $<HTMLDetailsElement>('settings'),
  settingsSummary: $('settings-summary'),
  settingsNote: $('settings-note'),
  resumeOnIdle: $<HTMLInputElement>('resumeOnIdle'),
  idleDelaySeconds: $<HTMLInputElement>('idleDelaySeconds'),
  idleOut: $<HTMLOutputElement>('idleDelaySeconds-out'),
  idleRow: $('idle-row'),
  resumeOnSave: $<HTMLInputElement>('resumeOnSave'),
  rewindBeforeResume: $<HTMLInputElement>('rewindBeforeResume'),
  rewindSeconds: $<HTMLInputElement>('rewindSeconds'),
  rewindOut: $<HTMLOutputElement>('rewindSeconds-out'),
  rewindRow: $('rewind-row'),
  resumeOnFocus: $<HTMLInputElement>('resumeOnFocus'),
  showOverlay: $<HTMLInputElement>('showOverlay'),
  reset: $<HTMLButtonElement>('reset'),
  debug: $<HTMLInputElement>('debug'),
  copyDiagnostics: $<HTMLButtonElement>('copy-diagnostics'),
  log: $('log'),
  privacy: $<HTMLAnchorElement>('privacy'),
  issues: $<HTMLAnchorElement>('issues'),
  version: $('version'),
};

const PHASE_DETAIL: Partial<Record<StatusPhase, string>> = {
  playing: 'Start typing in VS Code and the video pauses.',
  coding: 'Paused while you code.',
  codingWhilePlaying: 'You pressed play while coding, so CodeAlong lets it play.',
  waitingToResume: 'Paused by CodeAlong. Save, click "I\'m done" or press play to continue.',
  pausedByUser: "You paused the video, so CodeAlong won't start it again by itself.",
  noVideo: 'No video found on this tab yet. Start the video to let CodeAlong find it.',
  ended: 'The video has ended.',
};

let currentTab: chrome.tabs.Tab | undefined;
let status: PopupStatus | undefined;
/** Result of the last "is VS Code there?" probe; null while unknown. */
let vscodeFound: boolean | null = null;
let incompatible = false;
let lastProbe = 0;
let renderedSettings = '';

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
  const shared = s.settings.shared;
  el.enabled.checked = shared.enabled;
  el.enabledText.textContent = shared.enabled ? 'On' : 'Off';
  el.debug.checked = s.settings.debug;
  const connected = s.connection === 'connected';
  if (connected) vscodeFound = true;
  const installLink = { href: VSCODE_EXTENSION_URL, label: 'Get CodeAlong for VS Code' };

  if (!connected && (s.incompatible || incompatible)) {
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
  } else if (!shared.enabled) {
    setMessage('Automatic pausing is off', 'Shortcuts still work. Turn it on with the switch above.');
  } else if (s.hub) {
    const detail =
      s.hub.phase === 'coding' ? `Paused while you code. ${describeSettings(shared)}.` : PHASE_DETAIL[s.hub.phase];
    setMessage(describeStatus(s.hub, Date.now()), detail ?? '');
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
  el.follow.disabled = !currentTab?.id || !isWebPage(currentTab.url);
  el.toggle.disabled = el.done.disabled = !s.tutorial || !v || v.status === 'none';

  renderSettings(s);
  el.version.textContent = `v${s.extensionVersion}`;

  el.log.replaceChildren(
    ...(s.settings.debug ? s.log : []).map((line) => {
      const li = document.createElement('li');
      li.textContent = line;
      return li;
    }),
  );
}

/** Updates the settings controls, but never while the user is dragging or focused on one. */
function renderSettings(s: PopupStatus): void {
  const shared = s.settings.shared;
  el.settingsSummary.textContent = describeSettings(shared);

  if (s.connection === 'connected' && s.hubSupportsSettings === false) {
    el.settingsNote.textContent =
      'CodeAlong for VS Code is out of date and still uses its own settings. Update it to use these.';
    el.settingsNote.className = 'note warn';
  } else {
    el.settingsNote.textContent =
      s.connection === 'connected'
        ? 'Changes apply in VS Code right away.'
        : 'Saved here and used as soon as VS Code connects.';
    el.settingsNote.className = 'note';
  }

  const key = JSON.stringify(s.settings);
  if (key === renderedSettings) return;
  renderedSettings = key;
  const focused = document.activeElement;
  const set = (input: HTMLInputElement, apply: () => void) => {
    if (input !== focused) apply();
  };
  set(el.resumeOnIdle, () => (el.resumeOnIdle.checked = shared.resumeOnIdle));
  set(el.idleDelaySeconds, () => (el.idleDelaySeconds.value = String(shared.idleDelaySeconds)));
  set(el.resumeOnSave, () => (el.resumeOnSave.checked = shared.resumeOnSave));
  set(el.rewindBeforeResume, () => (el.rewindBeforeResume.checked = shared.rewindBeforeResume));
  set(el.rewindSeconds, () => (el.rewindSeconds.value = String(shared.rewindSeconds)));
  set(el.resumeOnFocus, () => (el.resumeOnFocus.checked = shared.resumeOnFocus));
  set(el.showOverlay, () => (el.showOverlay.checked = s.settings.showOverlay));
  updateSliderLabels();
  el.idleRow.hidden = !shared.resumeOnIdle;
  el.rewindRow.hidden = !shared.rewindBeforeResume;
}

function updateSliderLabels(): void {
  el.idleOut.value = `${el.idleDelaySeconds.value} s`;
  el.rewindOut.value = `${el.rewindSeconds.value} s`;
  el.idleDelaySeconds.setAttribute('aria-valuetext', `${el.idleDelaySeconds.value} seconds`);
  el.rewindSeconds.setAttribute('aria-valuetext', `${el.rewindSeconds.value} seconds`);
}

async function saveSettings(patch: SettingsPatch): Promise<void> {
  await request({ type: 'popup:setSettings', patch });
  await refresh();
}

async function refresh(): Promise<void> {
  const s = await request<PopupStatus>({ type: 'popup:getStatus' });
  render(s);
  if (s.connection !== 'connected' && Date.now() - lastProbe > 3_000) {
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

function diagnostics(s: PopupStatus): string {
  // Deliberately no page titles or URLs: safe to paste into a public issue.
  return [
    `CodeAlong for Chrome ${s.extensionVersion}`,
    `CodeAlong for VS Code: ${s.connection === 'connected' ? (s.hubVersion ?? 'older than 0.2.0') : 'not connected'}`,
    `Browser: ${navigator.userAgent}`,
    `Connection: ${s.connection}${s.incompatible ? ' (incompatible versions)' : ''}`,
    `Following a tab: ${s.tutorial ? 'yes' : 'no'}; video: ${s.video?.status ?? 'none'}`,
    `Status: ${s.hub?.phase ?? 'unknown'}`,
    `Settings: ${JSON.stringify(s.settings.shared)}; status on video: ${s.settings.showOverlay}`,
    '',
    'Recent events:',
    ...s.log.slice(0, 20).map(scrub),
  ].join('\n');
}

// --- Events ------------------------------------------------------------------------------------

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

el.enabled.addEventListener('change', () => void saveSettings({ enabled: el.enabled.checked }));
for (const key of ['resumeOnIdle', 'resumeOnSave', 'rewindBeforeResume', 'resumeOnFocus', 'showOverlay'] as const) {
  el[key].addEventListener('change', () => void saveSettings({ [key]: el[key].checked }));
}
for (const key of ['idleDelaySeconds', 'rewindSeconds'] as const) {
  const input = el[key];
  input.min = String(SETTING_LIMITS[key].min);
  input.max = String(SETTING_LIMITS[key].max);
  input.addEventListener('input', updateSliderLabels);
  input.addEventListener('change', () => void saveSettings({ [key]: Number(input.value) }));
}
el.reset.addEventListener('click', async () => {
  renderedSettings = '';
  await request({ type: 'popup:resetSettings' });
  await refresh();
});
el.debug.addEventListener('change', () => void saveSettings({ debug: el.debug.checked }));
el.copyDiagnostics.addEventListener('click', async () => {
  if (!status) return;
  await navigator.clipboard.writeText(diagnostics(status));
  el.copyDiagnostics.textContent = 'Copied – paste it into your issue';
  setTimeout(() => (el.copyDiagnostics.textContent = 'Copy diagnostics'), 2_500);
});
el.toggle.addEventListener('click', () => void request({ type: 'popup:control', action: 'toggle' }).then(refresh));
el.done.addEventListener('click', () => void request({ type: 'popup:control', action: 'done' }).then(refresh));
el.privacy.href = PRIVACY_URL;
el.issues.href = ISSUES_URL;

// Remember whether the settings section was open (a per-device convenience).
try {
  el.settings.open = localStorage.getItem('settingsOpen') === '1';
  el.settings.addEventListener('toggle', () => localStorage.setItem('settingsOpen', el.settings.open ? '1' : '0'));
} catch {
  // Storage unavailable: start collapsed.
}

void (async () => {
  [currentTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  await refresh();
  setInterval(() => void refresh(), 500);
})();
