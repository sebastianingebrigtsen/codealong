/**
 * Real-browser end-to-end test.
 *
 * - Loads the built Chrome extension (packages/chrome/dist) into Playwright's Chromium.
 * - Maps www.youtube.com and player.vimeo.com to a local HTTPS server (self-signed cert), so the
 *   statically declared content scripts run exactly as they would on the real sites – including
 *   the cross-origin iframe case (Vimeo embeds) and web-component players (Mux on Laracasts).
 * - Runs the real VS Code-side hub (HubNode) in this process; "typing" is simulated by calling
 *   node.activity('edit'), which is what the VS Code extension does on a document change.
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as https from 'node:https';
import type * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type BrowserContext, type Frame, type Page, type Worker } from 'playwright';
import { DEV_CHROME_EXTENSION_ID, type HubStatus } from '@codealong/protocol';
import { DEFAULT_SETTINGS } from '../packages/vscode/src/core/hubCore';
import { HubNode } from '../packages/vscode/src/hub/hubNode';
import { loadOrCreateEditorToken } from '../packages/vscode/src/hub/token';

const ROOT = path.resolve(__dirname, '..');
// A separate build with test-only ports, so a real CodeAlong running on this machine is never touched.
const EXTENSION_DIR = path.join(ROOT, 'e2e/.artifacts/chrome');
const TEST_PORTS = [48390, 48391];
const IDLE_MS = 800;

let tmp: string;
let server: https.Server;
let httpsPort: number;
let hubPort: number;
let context: BrowserContext;
let node: HubNode;
let hubStatus: HubStatus | null = null;
const hubEvents: string[] = [];

/** 60 s of silent 8 kHz mono WAV. A <video> element plays it fine and it needs no codecs. */
function silentWav(seconds: number): Buffer {
  const rate = 8000;
  const data = Buffer.alloc(rate * seconds, 128);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + data.length, 4);
  h.write('WAVE', 8);
  h.write('fmt ', 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate, 28);
  h.writeUInt16LE(1, 32);
  h.writeUInt16LE(8, 34);
  h.write('data', 36);
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

const PAGES: Record<string, string> = {
  // Watch page: the tutorial video plus a small decoy video (like a hover preview).
  '/watch': `<!doctype html><title>Laravel From Scratch – Episode 1</title>
    <video id="main" src="/media.wav" style="width:960px;height:540px;display:block"></video>
    <video id="decoy" src="/media.wav" muted loop style="width:120px;height:68px"></video>`,
  // Lesson page with the video in a cross-origin Vimeo iframe.
  '/lesson': `<!doctype html><title>Lesson with embedded player</title>
    <h1>Lesson</h1>
    <iframe id="player" src="https://player.vimeo.com/video/42" style="width:960px;height:540px" allow="autoplay"></iframe>`,
  // Laracasts-style web-component player (Mux): <mux-player> -> shadow -> <mux-video> -> shadow -> <video>.
  '/mux': `<!doctype html><title>Mux lesson</title>
    <mux-player id="player" style="display:block;width:960px;height:540px"></mux-player>
    <script>
      customElements.define('mux-video', class extends HTMLElement {
        constructor() {
          super();
          this.attachShadow({ mode: 'open' }).innerHTML =
            '<video id="main" src="/media.wav" style="width:960px;height:540px;display:block"></video>';
        }
      });
      customElements.define('mux-player', class extends HTMLElement {
        constructor() {
          super();
          this.attachShadow({ mode: 'open' }).innerHTML = '<mux-video></mux-video>';
        }
        get media() { return this.shadowRoot.querySelector('mux-video').shadowRoot.querySelector('video'); }
      });
    </script>`,
  '/video/42': `<!doctype html><title>player</title>
    <video id="main" src="/media.wav" style="width:100%;height:520px;display:block"></video>`,
};

async function waitFor<T>(fn: () => T | Promise<T>, what: string, ms = 8_000): Promise<NonNullable<T>> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v as NonNullable<T>;
    if (Date.now() - start > ms) throw new Error(`timed out waiting for: ${what} (hub: ${JSON.stringify(hubStatus)})`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function extensionPage(): Promise<Page> {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${DEV_CHROME_EXTENSION_ID}/popup.html`);
  return page;
}

async function sendToWorker<T>(msg: unknown): Promise<T> {
  const page = await extensionPage();
  try {
    return (await page.evaluate((m) => chrome.runtime.sendMessage(m), msg)) as T;
  } finally {
    await page.close();
  }
}

async function tabIdFor(urlPrefix: string): Promise<number> {
  const page = await extensionPage();
  try {
    return await page.evaluate(async (prefix) => {
      const tabs = await chrome.tabs.query({});
      return tabs.find((t) => t.url?.startsWith(prefix))?.id ?? -1;
    }, urlPrefix);
  } finally {
    await page.close();
  }
}

const videoState = (frame: Page | Frame) =>
  frame.evaluate(() => {
    const v = document.getElementById('main') as HTMLVideoElement;
    return { paused: v.paused, time: v.currentTime, marker: v.getAttribute('data-codealong-pause') };
  });

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codealong-e2e-'));
  const key = path.join(tmp, 'key.pem');
  const cert = path.join(tmp, 'cert.pem');
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      key,
      '-out',
      cert,
      '-days',
      '1',
      '-subj',
      '/CN=codealong-e2e',
      '-addext',
      'subjectAltName=DNS:www.youtube.com,DNS:player.vimeo.com',
    ],
    { stdio: 'ignore' },
  );

  const wav = silentWav(60);
  server = https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) }, (req, res) => {
    const url = (req.url ?? '/').split('?')[0]!;
    if (url === '/media.wav') {
      // Support range requests so seeking works like on a real CDN.
      const range = /bytes=(\d+)-(\d*)/.exec(req.headers.range ?? '');
      if (range) {
        const start = Number(range[1]);
        const end = range[2] ? Number(range[2]) : wav.length - 1;
        res.writeHead(206, {
          'content-type': 'audio/wav',
          'content-range': `bytes ${start}-${end}/${wav.length}`,
          'accept-ranges': 'bytes',
          'content-length': end - start + 1,
        });
        return res.end(wav.subarray(start, end + 1));
      }
      res.writeHead(200, { 'content-type': 'audio/wav', 'accept-ranges': 'bytes', 'content-length': wav.length });
      return res.end(wav);
    }
    const html = PAGES[url];
    if (!html) return res.writeHead(404).end();
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(html);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  httpsPort = (server.address() as net.AddressInfo).port;

  execFileSync(
    process.execPath,
    [path.join(ROOT, 'scripts/build.mjs'), '--chrome-only', '--chrome-out=e2e/.artifacts/chrome'],
    {
      env: { ...process.env, CODEALONG_HUB_PORTS: TEST_PORTS.join(',') },
      stdio: 'ignore',
    },
  );
  hubPort = TEST_PORTS[0]!;
  node = new HubNode(
    {
      ports: TEST_PORTS,
      editorToken: loadOrCreateEditorToken(path.join(tmp, 'token')),
      allowedOrigins: () => [`chrome-extension://${DEV_CHROME_EXTENSION_ID}`],
      settings: () => ({ ...DEFAULT_SETTINGS, idleDelayMs: IDLE_MS }),
    },
    {
      onStatus: (s) => {
        if (s) hubStatus = s;
      },
      onEvent: (e) => hubEvents.push(e),
      info: () => undefined,
    },
  );
  node.start();

  context = await chromium.launchPersistentContext(path.join(tmp, 'profile'), {
    channel: 'chromium',
    headless: true,
    ignoreHTTPSErrors: true,
    args: [
      `--disable-extensions-except=${EXTENSION_DIR}`,
      `--load-extension=${EXTENSION_DIR}`,
      `--host-resolver-rules=MAP www.youtube.com 127.0.0.1:${httpsPort}, MAP player.vimeo.com 127.0.0.1:${httpsPort}`,
      '--ignore-certificate-errors',
      '--autoplay-policy=no-user-gesture-required',
    ],
  });
  if (process.env.E2E_DEBUG) {
    context.on('weberror', (e) => console.log('PAGE ERROR', e.error().message));
    context.on('console', (m) => {
      if (m.type() === 'error' || m.text().includes('CodeAlong'))
        console.log('CONSOLE', m.type(), m.text().slice(0, 300));
    });
  }
  const worker: Worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  expect(worker.url()).toContain(DEV_CHROME_EXTENSION_ID); // the pinned key gives the expected ID
  if (process.env.E2E_DEBUG) await sendToWorker({ type: 'popup:setDebug', debug: true });
}, 60_000);

afterAll(async () => {
  await context?.close();
  await node?.stop();
  server?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('Chrome extension (real Chromium)', () => {
  let page: Page;

  it('opens the welcome page on first install, and it finds VS Code', async () => {
    const welcome = await waitFor(() => context.pages().find((p) => p.url().endsWith('/welcome.html')), 'welcome tab');
    await waitFor(
      async () => (await welcome.textContent('#vscode-status'))?.includes('VS Code is running'),
      'VS Code found',
    );
    await welcome.close();
  });

  it('follows a YouTube-like tab and connects to the hub', async () => {
    page = await context.newPage();
    await page.goto('https://www.youtube.com/watch');
    await page.evaluate(() => (document.getElementById('main') as HTMLVideoElement).play());
    const tabId = await tabIdFor('https://www.youtube.com/watch');
    expect(tabId).toBeGreaterThan(0);

    const result = await sendToWorker<{ ok: boolean; error?: string }>({ type: 'popup:follow', tabId });
    expect(result).toEqual({ ok: true });
    await waitFor(() => hubStatus?.phase === 'playing', 'hub sees the tutorial playing');
    expect(hubStatus?.tutorialTitle).toBe('Laravel From Scratch – Episode 1');

    // The popup explains the state in plain words.
    const popup = await extensionPage();
    await waitFor(async () => (await popup.textContent('#headline')) === 'Tutorial Playing', 'popup headline');
    expect(await popup.textContent('#vscode')).toBe('Connected');
    await popup.close();
  });

  it('pauses when the user types and resumes after idle with a ~2 s rewind', async () => {
    // Jump into the tutorial (as a user seek) so a rewind is measurable.
    await page.evaluate(() => {
      (document.getElementById('main') as HTMLVideoElement).currentTime = 20;
    });
    await page.waitForTimeout(500);
    node.activity('edit');
    const paused = await waitFor(async () => {
      const s = await videoState(page);
      return s.paused ? s : null;
    }, 'video paused by CodeAlong');
    expect(paused.marker).toMatch(/@/);
    expect(hubStatus?.phase).toBe('coding');

    // Keep typing for a while: the video must stay paused.
    for (let i = 0; i < 4; i++) {
      await page.waitForTimeout(IDLE_MS / 2);
      node.activity('edit');
    }
    expect((await videoState(page)).paused).toBe(true);

    const resumed = await waitFor(async () => {
      const s = await videoState(page);
      return s.paused ? null : s;
    }, 'video resumed after idle');
    expect(resumed.time).toBeLessThan(paused.time - 1.5);
    expect(resumed.time).toBeGreaterThan(paused.time - 2.6);
    expect(resumed.marker).toBeNull();
  });

  it('never resumes a video the user paused', async () => {
    await page.evaluate(() => (document.getElementById('main') as HTMLVideoElement).pause());
    await waitFor(() => hubStatus?.phase === 'pausedByUser', 'hub knows the user paused');
    node.activity('edit');
    node.activity('save');
    await page.waitForTimeout(IDLE_MS * 3);
    expect((await videoState(page)).paused).toBe(true);
  });

  it('the toggle hotkey plays and pauses as a user action', async () => {
    node.control('toggle');
    await waitFor(async () => !(await videoState(page)).paused, 'played via hotkey');
    node.control('toggle');
    await waitFor(async () => (await videoState(page)).paused, 'paused via hotkey');
    await waitFor(() => hubStatus?.phase === 'pausedByUser', 'recorded as user pause');
  });

  it('does not control the decoy video or other tabs', async () => {
    const other = await context.newPage();
    await other.goto('https://www.youtube.com/watch?v=other');
    await other.evaluate(() => (document.getElementById('main') as HTMLVideoElement).play());
    await page.evaluate(() => (document.getElementById('main') as HTMLVideoElement).play());
    await waitFor(() => hubStatus?.phase === 'playing', 'tutorial playing');
    node.activity('edit');
    await waitFor(async () => (await videoState(page)).paused, 'tutorial paused');
    expect((await videoState(other)).paused).toBe(false);
    const decoyPaused = await page.evaluate(() => (document.getElementById('decoy') as HTMLVideoElement).paused);
    expect(decoyPaused).toBe(true); // never started, never touched
    await other.close();
    node.control('done');
    await waitFor(async () => !(await videoState(page)).paused, 'done resumes');
  });

  it('a web page cannot connect to the local hub', async () => {
    const outcome = await page.evaluate(
      (port) =>
        new Promise<string>((resolve) => {
          const ws = new WebSocket(`ws://127.0.0.1:${port}`);
          ws.onopen = () => resolve('open');
          ws.onerror = () => resolve('error');
          setTimeout(() => resolve('timeout'), 3_000);
        }),
      hubPort,
    );
    expect(outcome).not.toBe('open');
  });

  it('controls a video inside a cross-origin iframe (Vimeo embed)', async () => {
    const lesson = await context.newPage();
    await lesson.goto('https://www.youtube.com/lesson');
    const frame = await waitFor(() => lesson.frames().find((f) => f.url().includes('player.vimeo.com')), 'iframe');
    await frame.waitForSelector('#main');
    await frame.evaluate(() => (document.getElementById('main') as HTMLVideoElement).play());

    const tabId = await tabIdFor('https://www.youtube.com/lesson');
    expect(await sendToWorker({ type: 'popup:follow', tabId })).toEqual({ ok: true });
    await waitFor(
      () => hubStatus?.phase === 'playing' && hubStatus.tutorialTitle === 'Lesson with embedded player',
      'hub follows lesson',
    );

    node.activity('edit');
    await waitFor(async () => (await videoState(frame)).paused, 'iframe video paused');
    await waitFor(async () => !(await videoState(frame)).paused, 'iframe video resumed');
    // The previous tutorial tab is no longer controlled.
    expect((await videoState(page)).paused).toBe(false);
    await lesson.close();
    // Without a tutorial the browser has nothing to do and disconnects.
    await waitFor(() => hubStatus?.phase === 'waitingForBrowser', 'closing the tutorial tab clears it');
  });

  it('finds and controls a video inside nested shadow roots (Laracasts / Mux Player)', async () => {
    const mux = await context.newPage();
    await mux.goto('https://www.youtube.com/mux');
    const muxState = () =>
      mux.evaluate(() => {
        const v = (document.getElementById('player') as HTMLElement & { media: HTMLVideoElement }).media;
        return { paused: v.paused, time: v.currentTime };
      });
    await mux.evaluate(() => {
      const v = (document.getElementById('player') as HTMLElement & { media: HTMLVideoElement }).media;
      v.currentTime = 10;
      return v.play();
    });
    const tabId = await tabIdFor('https://www.youtube.com/mux');
    expect(await sendToWorker({ type: 'popup:follow', tabId })).toEqual({ ok: true });
    await waitFor(
      () => hubStatus?.phase === 'playing' && hubStatus.tutorialTitle === 'Mux lesson',
      'hub sees the shadow-DOM video',
    );

    node.activity('edit');
    const paused = await waitFor(async () => {
      const st = await muxState();
      return st.paused ? st : null;
    }, 'shadow-DOM video paused');
    const resumed = await waitFor(async () => {
      const st = await muxState();
      return st.paused ? null : st;
    }, 'shadow-DOM video resumed');
    expect(resumed.time).toBeLessThan(paused.time - 1.5);
    await mux.close();
  });

  it('recovers when Chrome stops the service worker while the video is paused (MV3 lifecycle)', async () => {
    const tabId = await tabIdFor('https://www.youtube.com/watch');
    expect(await sendToWorker({ type: 'popup:follow', tabId })).toEqual({ ok: true });
    await waitFor(() => hubStatus?.phase === 'playing', 'following again');

    node.activity('edit');
    await waitFor(async () => (await videoState(page)).paused, 'paused by CodeAlong');
    const lostBefore = hubEvents.filter((e) => e === 'CONNECTION_LOST').length;
    const cdp = await context.newCDPSession(page);
    await cdp.send('ServiceWorker.enable');
    await cdp.send('ServiceWorker.stopAllWorkers');
    await waitFor(() => hubEvents.filter((e) => e === 'CONNECTION_LOST').length > lostBefore, 'worker stopped');

    // The idle period runs out while Chrome's side is gone. The page agent's heartbeat wakes the
    // worker, it reconnects, and the CodeAlong pause is resumed after one more idle period.
    await waitFor(async () => !(await videoState(page)).paused, 'resumed after the worker came back', 25_000);
    expect(hubStatus?.browserConnected).toBe(true);
    node.activity('edit');
    await waitFor(async () => (await videoState(page)).paused, 'pause works after the restart');
    node.control('done');
    await waitFor(async () => !(await videoState(page)).paused, 'done');
  }, 40_000);

  it('reconnects after the hub restarts (VS Code reloaded)', async () => {
    await waitFor(() => hubStatus?.phase === 'playing', 'tutorial playing');

    await node.stop();
    hubStatus = null;
    node.start();
    await waitFor(() => hubStatus?.browserConnected && hubStatus.phase === 'playing', 'browser reconnected', 15_000);
    node.activity('edit');
    await waitFor(async () => (await videoState(page)).paused, 'pause works after reconnect');
  }, 30_000);
});
