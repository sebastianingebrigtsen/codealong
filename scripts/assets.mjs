// Renders every image asset from assets/icon.svg and the real popup UI.
//
//   npm run build && npm run assets
//
// Requires Playwright's Chromium (npx playwright install chromium). The outputs are committed,
// so normal builds never need a browser. Re-run after changing the icon or the popup design.
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const svg = readFileSync(join(root, 'assets/icon.svg'), 'utf8');
const svgData = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
const out = (p) => {
  const file = join(root, p);
  mkdirSync(dirname(file), { recursive: true });
  return file;
};

const FONT = `system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif`;
const browser = await chromium.launch();

async function render(html, width, height, file, { scale = 1, transparent = false } = {}) {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: scale });
  await page.setContent(`<!doctype html><html><body style="margin:0">${html}</body></html>`);
  await page.waitForLoadState('networkidle');
  await page.screenshot({ path: out(file), omitBackground: transparent, clip: { x: 0, y: 0, width, height } });
  await page.close();
  console.log('wrote', file);
}

// --- Icons -------------------------------------------------------------------------------------
// Toolbar sizes use the full canvas; the 128 px store/extension icon keeps Chrome's recommended
// 16 px transparent padding (96 px artwork).
for (const size of [16, 32, 48]) {
  await render(
    `<img src="${svgData}" width="${size}" height="${size}">`,
    size,
    size,
    `packages/chrome/static/icons/${size}.png`,
    {
      transparent: true,
    },
  );
}
await render(
  `<div style="width:128px;height:128px;display:grid;place-items:center"><img src="${svgData}" width="96" height="96"></div>`,
  128,
  128,
  'packages/chrome/static/icons/128.png',
  { transparent: true },
);
await render(`<img src="${svgData}" width="256" height="256">`, 256, 256, 'packages/vscode/images/icon.png', {
  transparent: true,
});

// --- Popup screenshots (the real popup.html with a stubbed extension API) -------------------------
const shared = {
  enabled: true,
  resumeOnIdle: true,
  idleDelaySeconds: 5,
  resumeOnSave: true,
  rewindBeforeResume: true,
  rewindSeconds: 2,
  resumeOnFocus: false,
};
const popupStatus = {
  settings: { shared, showOverlay: true, debug: false },
  defaults: { shared, showOverlay: true, debug: false },
  extensionVersion: JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version,
  hubVersion: '0.2.0',
  hubSupportsSettings: true,
  connection: 'connected',
  incompatible: false,
  tutorial: { tabId: 7, title: 'Laravel From Scratch – Episode 3: Routing', host: 'laracasts.com' },
  video: { status: 'paused', owner: 'codealong', pauseId: 'x-1', currentTime: 312, duration: 1200 },
  hub: {
    phase: 'coding',
    enabled: true,
    browserConnected: true,
    tutorialTitle: 'Laravel From Scratch',
    resumeAt: null,
    settings: shared,
  },
  log: [],
};

async function renderPopup({ settingsOpen }) {
  const page = await browser.newPage({
    viewport: { width: 340, height: 900 },
    deviceScaleFactor: 2,
    colorScheme: 'light',
  });
  await page.addInitScript(
    ({ status, open }) => {
      localStorage.setItem('settingsOpen', open ? '1' : '0');
      const api = {
        runtime: {
          sendMessage: async (m) =>
            m.type === 'popup:getStatus'
              ? status
              : m.type === 'popup:probe'
                ? { vscode: true, incompatible: false }
                : { ok: true },
        },
        tabs: { query: async () => [{ id: 7, url: 'https://laracasts.com/series/laravel-from-scratch/episodes/3' }] },
        permissions: { request: async () => true },
      };
      Object.defineProperty(window, 'chrome', { value: api, configurable: true });
    },
    { status: popupStatus, open: settingsOpen },
  );
  await page.goto(pathToFileURL(join(root, 'packages/chrome/dist/popup.html')).href);
  await page.waitForTimeout(400);
  const height = await page.evaluate(() => document.body.scrollHeight);
  const png = await page.screenshot({ clip: { x: 0, y: 0, width: 340, height } });
  await page.close();
  return { data: `data:image/png;base64,${png.toString('base64')}`, height };
}

const popupClosed = await renderPopup({ settingsOpen: false });
const popupOpen = await renderPopup({ settingsOpen: true });

// The on-video label, styled like packages/chrome/src/content/overlay.ts.
const label = (title, sub) => `
  <div style="position:absolute;left:18px;top:18px;display:flex;align-items:center;gap:10px;padding:9px 14px 9px 11px;border-radius:10px;background:rgba(15,23,42,.88);box-shadow:0 6px 24px rgba(0,0,0,.35);font:14px/1.35 ${FONT};color:#fff">
    <div style="width:24px;height:24px;border-radius:6px;display:grid;place-items:center;background:linear-gradient(135deg,#3b82f6,#4338ca);font-weight:700;font-size:12px">II</div>
    <div><div style="font-weight:600">${title}</div><div style="color:#cbd5e1;font-size:13px">${sub}</div></div>
  </div>`;

const video = (overlay, progress) => `
  <div style="position:absolute;inset:0;padding:100px 32px 28px;font:15px/1.7 ui-monospace,Menlo,Consolas,monospace;color:#94a3b8">
    <div><span style="color:#c084fc">Route</span>::<span style="color:#60a5fa">get</span>(<span style="color:#86efac">'/jobs'</span>, <span style="color:#c084fc">function</span> () {</div>
    <div>&nbsp;&nbsp;&nbsp;&nbsp;<span style="color:#c084fc">return</span> <span style="color:#60a5fa">view</span>(<span style="color:#86efac">'jobs'</span>, [</div>
    <div>&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;<span style="color:#86efac">'jobs'</span> =&gt; <span style="color:#c084fc">Job</span>::<span style="color:#60a5fa">all</span>()</div>
    <div>&nbsp;&nbsp;&nbsp;&nbsp;]);</div>
    <div>});</div>
  </div>
  ${overlay}
  <div style="position:absolute;left:0;right:0;bottom:0;height:6px;background:#1e293b"><div style="width:${progress}%;height:100%;background:#3b82f6"></div></div>`;

const frame = (inner) => `
<div style="width:1280px;height:800px;background:linear-gradient(135deg,#0f172a,#1e1b4b);font-family:${FONT};color:#e2e8f0;position:relative;overflow:hidden">${inner}</div>`;

const heading = (title, sub) => `
  <div style="position:absolute;left:64px;top:56px">
    <div style="display:flex;align-items:center;gap:14px"><img src="${svgData}" width="44" height="44"><span style="font-size:30px;font-weight:700;color:#fff">${title}</span></div>
    <div style="font-size:22px;margin-top:10px;color:#cbd5e1">${sub}</div>
  </div>`;

const videoBox = (overlay, progress) => `
  <div style="position:absolute;left:64px;top:170px;width:700px;height:394px;border-radius:12px;background:#020617;border:1px solid #334155;overflow:hidden;box-shadow:0 20px 50px rgba(0,0,0,.45)">${video(overlay, progress)}</div>`;

// 1: what it does.
await render(
  frame(`
  ${heading('CodeAlong', 'Coding tutorials that wait for you.')}
  ${videoBox(label('Paused while you code', 'Continues 5 s after you stop typing'), 26)}
  <div style="position:absolute;left:64px;top:600px;width:700px;border-radius:10px;background:#1e1e1e;border:1px solid #333;overflow:hidden;box-shadow:0 20px 50px rgba(0,0,0,.45)">
    <div style="padding:16px 20px;font:14px/1.6 ui-monospace,Menlo,Consolas,monospace;color:#d4d4d4">routes/web.php — <span style="color:#9cdcfe">Job</span>::<span style="color:#dcdcaa">all</span>()<span style="display:inline-block;width:8px;height:16px;background:#aeafad;vertical-align:-3px;margin-left:2px"></span></div>
    <div style="background:#007acc;color:#fff;font:13px ${FONT};padding:5px 12px">✎ CodeAlong: Coding...</div>
  </div>
  <div style="position:absolute;right:64px;top:170px;width:340px;border-radius:12px;overflow:hidden;box-shadow:0 20px 50px rgba(0,0,0,.5);background:#fff"><img src="${popupClosed.data}" width="340" style="display:block"></div>
  <div style="position:absolute;right:64px;top:${Math.min(170 + popupClosed.height + 28, 680)}px;width:340px;font-size:17px;line-height:1.6;color:#cbd5e1">
    Start typing → the tutorial pauses.<br>Stop typing → it rewinds 2 s and continues.<br>Pause it yourself → it stays paused.
  </div>`),
  1280,
  800,
  'assets/store/chrome-screenshot-1280x800.png',
);

// 2: settings. The open popup is taller than the canvas, so it is shown scaled down.
const scale = Math.min(1, 640 / popupOpen.height);
await render(
  frame(`
  ${heading('Your pace, your rules', 'Timing lives in the popup and applies in VS Code instantly.')}
  ${videoBox(label('Continuing in 2…', 'Keep typing to stay paused'), 58)}
  <div style="position:absolute;left:64px;top:600px;width:700px;font-size:17px;line-height:1.7;color:#cbd5e1">
    Wait longer before continuing, rewind more, ignore saves, or continue when you<br>switch back to the tab. A label on the video always shows what happens next.
  </div>
  <div style="position:absolute;right:64px;top:132px;width:${Math.round(340 * scale)}px;border-radius:12px;overflow:hidden;box-shadow:0 20px 50px rgba(0,0,0,.5);background:#fff"><img src="${popupOpen.data}" width="${Math.round(340 * scale)}" style="display:block"></div>`),
  1280,
  800,
  'assets/store/chrome-screenshot-settings-1280x800.png',
);

// --- Promo tiles --------------------------------------------------------------------------------
const tile = (w, h, iconSize, titleSize, tagSize) => `
<div style="width:${w}px;height:${h}px;background:linear-gradient(135deg,#0f172a,#1e1b4b);display:flex;align-items:center;justify-content:center;gap:${Math.round(iconSize / 3)}px;font-family:${FONT}">
  <img src="${svgData}" width="${iconSize}" height="${iconSize}">
  <div><div style="font-size:${titleSize}px;font-weight:700;color:#fff">CodeAlong</div><div style="font-size:${tagSize}px;color:#cbd5e1;margin-top:4px">Coding tutorials that wait for you.</div></div>
</div>`;
await render(tile(440, 280, 84, 36, 15), 440, 280, 'assets/store/chrome-promo-small-440x280.png');
await render(tile(1400, 560, 200, 84, 34), 1400, 560, 'assets/store/chrome-promo-marquee-1400x560.png');
await render(tile(1280, 640, 180, 80, 32), 1280, 640, 'assets/social-preview-1280x640.png');

await browser.close();
