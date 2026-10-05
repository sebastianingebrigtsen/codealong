/**
 * End-to-end through the real code paths, minus Chrome and VS Code themselves:
 *   HubNode (VS Code side: server + state machine + leader election)
 *   <-> real WebSocket on 127.0.0.1 with the extension Origin
 *   <-> HubConnection (Chrome service worker side) <-> VideoController <-> FakeVideo
 */
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { CHROME_EXTENSION_ID, type HubStatus, type VideoCommand } from '@codealong/protocol';
import { HubConnection, type SocketLike } from '../packages/chrome/src/background/connection';
import { VideoController } from '../packages/chrome/src/content/videoController';
import { DEFAULT_SETTINGS, type CoreSettings } from '../packages/vscode/src/core/hubCore';
import { HubNode } from '../packages/vscode/src/hub/hubNode';
import { loadOrCreateEditorToken } from '../packages/vscode/src/hub/token';
import { FakeVideo } from './fakeVideo';

const IDLE_MS = 300;
const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

async function waitFor(cond: () => boolean, what: string, ms = 4_000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error(`timed out waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

function startNode(port: number, token: string, settings: Partial<CoreSettings> = {}) {
  const events: string[] = [];
  let status: HubStatus | null = null;
  const node = new HubNode(
    {
      port,
      editorToken: token,
      allowedOrigins: () => [`chrome-extension://${CHROME_EXTENSION_ID}`],
      settings: () => ({ ...DEFAULT_SETTINGS, idleDelayMs: IDLE_MS, ...settings }),
    },
    {
      onStatus: (s) => {
        if (s) status = s;
      },
      onEvent: (e) => events.push(e),
      info: () => undefined,
    },
  );
  node.start();
  cleanups.push(() => node.stop());
  return { node, events, status: () => status };
}

/** The Chrome side: service-worker connection + content-script controller on a fake video. */
function startBrowser(port: number) {
  const video = new FakeVideo();
  video.currentTime = 30;
  void video.play();
  const commands: VideoCommand[] = [];
  // The connection and the controller reference each other; the holder breaks the cycle.
  const holder: { controller?: VideoController } = {};

  const connection = new HubConnection(
    () => `ws://127.0.0.1:${port}`,
    {
      onConnected: () => {
        connection.send({ type: 'tutorial', tutorial: { tabId: 1, title: 'Tutorial', host: 'youtube.com' } });
        connection.send({ type: 'video', video: holder.controller!.state(), cause: 'sync' });
      },
      onDisconnected: () => undefined,
      onCommand: (cmd) => {
        const { type: _t, id: _i, ...command } = cmd;
        commands.push(command);
        holder.controller!.handle(command);
      },
      onStatus: () => undefined,
      log: () => undefined,
    },
    (url) => new WebSocket(url, { headers: { Origin: `chrome-extension://${CHROME_EXTENSION_ID}` } }) as unknown as SocketLike,
  );
  const controller = new VideoController(video, (state, cause) => connection.send({ type: 'video', video: state, cause }));
  holder.controller = controller;
  controller.attach();
  connection.ensure();
  cleanups.push(() => {
    connection.stop();
    controller.detach();
  });
  return { video, controller, connection, commands };
}

function tempTokenDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codealong-test-'));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

describe('full loop', () => {
  it('typing pauses, idle resumes with a 2 s rewind', async () => {
    const port = await freePort();
    const hub = startNode(port, loadOrCreateEditorToken(tempTokenDir()));
    const browser = startBrowser(port);
    await waitFor(() => hub.status()?.phase === 'playing', 'hub sees playing video');

    hub.node.activity('edit');
    hub.node.activity('edit');
    await waitFor(() => browser.video.paused, 'video paused');
    expect(browser.controller.state().owner).toBe('codealong');
    await waitFor(() => hub.status()?.phase === 'coding', 'coding phase');

    await waitFor(() => !browser.video.paused, 'video resumed after idle');
    expect(browser.video.currentTime).toBe(28);
    expect(browser.commands.map((c) => c.command)).toEqual(['pause', 'resume']);
    // The browser's acknowledgement travels over the socket after the video already plays.
    await waitFor(() => hub.events.includes('VIDEO_RESUMED'), 'hub got the resume acknowledgement');
    expect(hub.events).toEqual(
      expect.arrayContaining(['TYPING_STARTED', 'VIDEO_PAUSED_BY_CODEALONG', 'TYPING_IDLE', 'AUTO_RESUME', 'VIDEO_RESUMED']),
    );
  });

  it('a video the user paused is never started again', async () => {
    const port = await freePort();
    const hub = startNode(port, loadOrCreateEditorToken(tempTokenDir()));
    const browser = startBrowser(port);
    await waitFor(() => hub.status()?.phase === 'playing', 'playing');

    browser.video.pause(); // the user pauses in the browser
    await waitFor(() => hub.status()?.phase === 'pausedByUser', 'hub knows the user paused');
    hub.node.activity('edit');
    hub.node.activity('save');
    await new Promise((r) => setTimeout(r, IDLE_MS * 3));
    expect(browser.video.paused).toBe(true);
    expect(browser.commands).toEqual([]);
  });

  it('a user pause during the CodeAlong pause wins over the pending idle resume', async () => {
    const port = await freePort();
    const hub = startNode(port, loadOrCreateEditorToken(tempTokenDir()));
    const browser = startBrowser(port);
    await waitFor(() => hub.status()?.phase === 'playing', 'playing');
    hub.node.activity('edit');
    await waitFor(() => browser.video.paused, 'paused by CodeAlong');

    void browser.video.play(); // user peeks...
    browser.video.pause(); // ...and pauses again before idle fires
    await new Promise((r) => setTimeout(r, IDLE_MS * 3));
    expect(browser.video.paused).toBe(true);
    expect(browser.controller.state().owner).toBe('user');
  });

  it('a second VS Code window forwards typing, and takes over when the hub window closes', async () => {
    const port = await freePort();
    const token = loadOrCreateEditorToken(tempTokenDir());
    const first = startNode(port, token);
    await waitFor(() => first.node.role === 'leader', 'first window leads');
    const second = startNode(port, token);
    await waitFor(() => second.node.role === 'follower', 'second window follows');

    const browser = startBrowser(port);
    await waitFor(() => second.status()?.phase === 'playing', 'follower receives hub status');

    second.node.activity('edit');
    await waitFor(() => browser.video.paused, 'typing in the follower window pauses the video');

    await first.node.stop(); // hub window closes while the video is paused by CodeAlong
    await waitFor(() => second.node.role === 'leader', 'second window takes over', 6_000);
    await waitFor(() => browser.connection.connected, 'browser reconnects', 6_000);
    // The new hub adopts the CodeAlong pause and resumes it after one idle period.
    await waitFor(() => !browser.video.paused, 'video resumed by the new hub', 6_000);
    expect(second.events).toContain('ADOPTED_CODEALONG_PAUSE');
  }, 15_000);

  it('the browser keeps retrying when VS Code starts later', async () => {
    const port = await freePort();
    const browser = startBrowser(port);
    await new Promise((r) => setTimeout(r, 300));
    expect(browser.connection.connected).toBe(false);
    const hub = startNode(port, loadOrCreateEditorToken(tempTokenDir()));
    await waitFor(() => browser.connection.connected, 'browser connected after VS Code started', 6_000);
    await waitFor(() => hub.status()?.phase === 'playing', 'hub sees the video');
  }, 10_000);
});
