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

// --- Popup screenshot (the real popup.html with a stubbed extension API) --------------------------
const popupStatus = {
  enabled: true,
  debug: false,
  connection: 'connected',
  connectionError: null,
  tutorial: { tabId: 7, title: 'Laravel From Scratch – Episode 3: Routing', host: 'laracasts.com' },
  video: { status: 'paused', owner: 'codealong', pauseId: 'x-1', currentTime: 312, duration: 1200 },
  hub: {
    phase: 'coding',
    enabled: true,
    browserConnected: true,
    tutorialTitle: 'Laravel From Scratch',
    resumeAt: null,
  },
  log: [],
};
const popupPage = await browser.newPage({
  viewport: { width: 340, height: 420 },
  deviceScaleFactor: 2,
  colorScheme: 'light',
});
await popupPage.addInitScript((status) => {
  const api = {
    runtime: {
      sendMessage: async (m) =>
        m.type === 'popup:getStatus' ? status : m.type === 'popup:probe' ? { vscode: true } : { ok: true },
    },
    tabs: { query: async () => [{ id: 7, url: 'https://laracasts.com/series/laravel-from-scratch/episodes/3' }] },
    permissions: { request: async () => true },
  };
  Object.defineProperty(window, 'chrome', { value: api, configurable: true });
}, popupStatus);
await popupPage.goto(pathToFileURL(join(root, 'packages/chrome/dist/popup.html')).href);
await popupPage.waitForTimeout(400);
const popupHeight = await popupPage.evaluate(() => document.body.scrollHeight);
const popupPng = await popupPage.screenshot({ clip: { x: 0, y: 0, width: 340, height: popupHeight } });
await popupPage.close();
const popupData = `data:image/png;base64,${popupPng.toString('base64')}`;

// --- Store screenshot 1280x800 -----------------------------------------------------------------
const screenshot = `
<div style="width:1280px;height:800px;background:linear-gradient(135deg,#0f172a,#1e1b4b);font-family:${FONT};color:#e2e8f0;position:relative;overflow:hidden">
  <div style="position:absolute;left:64px;top:56px">
    <div style="display:flex;align-items:center;gap:14px"><img src="${svgData}" width="44" height="44"><span style="font-size:30px;font-weight:700;color:#fff">CodeAlong</span></div>
    <div style="font-size:22px;margin-top:10px;color:#cbd5e1">Coding tutorials that wait for you.</div>
  </div>
  <div style="position:absolute;left:64px;top:170px;width:700px;height:394px;border-radius:12px;background:#020617;border:1px solid #334155;overflow:hidden;box-shadow:0 20px 50px rgba(0,0,0,.45)">
    <div style="position:absolute;inset:0;padding:28px 32px;font:15px/1.7 ui-monospace,Menlo,Consolas,monospace;color:#94a3b8">
      <div><span style="color:#c084fc">Route</span>::<span style="color:#60a5fa">get</span>(<span style="color:#86efac">'/jobs'</span>, <span style="color:#c084fc">function</span> () {</div>
      <div>&nbsp;&nbsp;&nbsp;&nbsp;<span style="color:#c084fc">return</span> <span style="color:#60a5fa">view</span>(<span style="color:#86efac">'jobs'</span>, [</div>
      <div>&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;<span style="color:#86efac">'jobs'</span> =&gt; <span style="color:#c084fc">Job</span>::<span style="color:#60a5fa">all</span>()</div>
      <div>&nbsp;&nbsp;&nbsp;&nbsp;]);</div>
      <div>});</div>
    </div>
    <div style="position:absolute;inset:0;display:grid;place-items:center;background:rgba(2,6,23,.55)">
      <div style="text-align:center">
        <div style="display:inline-flex;gap:12px"><span style="width:18px;height:64px;background:#fff;border-radius:5px"></span><span style="width:18px;height:64px;background:#fff;border-radius:5px"></span></div>
        <div style="margin-top:16px;font-size:20px;color:#fff;font-weight:600">Paused while you code</div>
      </div>
    </div>
    <div style="position:absolute;left:0;right:0;bottom:0;height:6px;background:#1e293b"><div style="width:26%;height:100%;background:#3b82f6"></div></div>
  </div>
  <div style="position:absolute;left:64px;top:600px;width:700px;border-radius:10px;background:#1e1e1e;border:1px solid #333;overflow:hidden;box-shadow:0 20px 50px rgba(0,0,0,.45)">
    <div style="padding:16px 20px;font:14px/1.6 ui-monospace,Menlo,Consolas,monospace;color:#d4d4d4">routes/web.php — <span style="color:#9cdcfe">Job</span>::<span style="color:#dcdcaa">all</span>()<span style="display:inline-block;width:8px;height:16px;background:#aeafad;vertical-align:-3px;margin-left:2px"></span></div>
    <div style="background:#007acc;color:#fff;font:13px ${FONT};padding:5px 12px">✎ CodeAlong: Coding... (resume in 3s)</div>
  </div>
  <div style="position:absolute;right:64px;top:170px;width:340px;border-radius:12px;overflow:hidden;box-shadow:0 20px 50px rgba(0,0,0,.5);background:#fff"><img src="${popupData}" width="340" style="display:block"></div>
  <div style="position:absolute;right:64px;top:${170 + popupHeight + 28}px;width:340px;font-size:17px;line-height:1.6;color:#cbd5e1">
    Start typing → the tutorial pauses.<br>Stop typing → it rewinds 2 s and continues.<br>Pause it yourself → it stays paused.
  </div>
</div>`;
await render(screenshot, 1280, 800, 'assets/store/chrome-screenshot-1280x800.png');

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
