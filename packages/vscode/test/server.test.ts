import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { DEV_CHROME_EXTENSION_ID, PROTOCOL_VERSION, parseHubMessage, type HubToClient } from '@codealong/protocol';
import { HubServer } from '../src/hub/server';

const ORIGIN = `chrome-extension://${DEV_CHROME_EXTENSION_ID}`;
const TOKEN = 'a'.repeat(64);

let server: HubServer | null = null;
afterEach(async () => {
  await server?.close();
  server = null;
});

async function startServer() {
  const events: string[] = [];
  const browserMessages: unknown[] = [];
  const incompatible: number[] = [];
  server = new HubServer(
    { allowedOrigins: () => [ORIGIN], editorToken: TOKEN, hubName: 'test' },
    {
      onBrowserConnected: () => events.push('connected'),
      onBrowserDisconnected: () => events.push('disconnected'),
      onBrowserMessage: (m) => browserMessages.push(m),
      onEditorMessage: (m) => browserMessages.push(m),
      onIncompatibleClient: (_role, protocol) => incompatible.push(protocol),
      log: () => undefined,
    },
  );
  await server.listen(0);
  return { port: server.address()!, events, browserMessages, incompatible };
}

/** Opens a client and collects parsed messages; resolves once the socket is open or fails. */
function client(port: number, headers: Record<string, string> = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, { headers });
  const messages: HubToClient[] = [];
  const opened = new Promise<'open' | number>((resolve) => {
    ws.on('open', () => resolve('open'));
    ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
    ws.on('error', () => resolve(-1));
  });
  const closed = new Promise<number>((resolve) => ws.on('close', (code) => resolve(code)));
  ws.on('message', (d) => {
    const m = parseHubMessage(d.toString());
    if (m) messages.push(m);
  });
  const hello = (extra: Record<string, unknown>) =>
    ws.send(JSON.stringify({ type: 'hello', protocol: PROTOCOL_VERSION, client: 'test', ...extra }));
  return { ws, messages, opened, closed, hello };
}

const waitFor = async (cond: () => boolean, ms = 1_000) => {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 5));
  }
};

describe('HubServer access control', () => {
  it('accepts the CodeAlong Chrome extension', async () => {
    const { port, events } = await startServer();
    const c = client(port, { Origin: ORIGIN });
    expect(await c.opened).toBe('open');
    c.hello({ role: 'browser' });
    await waitFor(() => c.messages.some((m) => m.type === 'welcome'));
    expect(events).toEqual(['connected']);
    c.ws.close();
    await waitFor(() => events.includes('disconnected'));
  });

  it('rejects web pages (any other Origin) before the WebSocket handshake', async () => {
    const { port, events } = await startServer();
    for (const origin of [
      'https://evil.example',
      'http://localhost:3000',
      'chrome-extension://abcdefghijklmnopabcdefghijklmnop',
      'null',
    ]) {
      const c = client(port, { Origin: origin });
      expect(await c.opened).toBe(403);
    }
    expect(events).toEqual([]);
  });

  it('rejects requests addressed to a non-loopback Host (DNS rebinding)', async () => {
    const { port } = await startServer();
    const c = client(port, { Origin: ORIGIN, Host: 'attacker.example' });
    expect(await c.opened).toBe(403);
  });

  it('requires the token for editor clients and does not let them pose as the browser', async () => {
    const { port, events } = await startServer();

    const noToken = client(port);
    await noToken.opened;
    noToken.hello({ role: 'editor' });
    expect(await noToken.closed).toBe(4005);

    const wrongToken = client(port);
    await wrongToken.opened;
    wrongToken.hello({ role: 'editor', token: 'b'.repeat(64) });
    expect(await wrongToken.closed).toBe(4005);

    const fakeBrowser = client(port);
    await fakeBrowser.opened;
    fakeBrowser.hello({ role: 'browser' });
    expect(await fakeBrowser.closed).toBe(4005);

    const editor = client(port);
    await editor.opened;
    editor.hello({ role: 'editor', token: TOKEN });
    await waitFor(() => editor.messages.some((m) => m.type === 'welcome'));
    expect(events).toEqual([]);
    editor.ws.close();
  });

  it('ignores messages before hello and closes clients that never say hello', async () => {
    const { port, browserMessages } = await startServer();
    const c = client(port, { Origin: ORIGIN });
    await c.opened;
    c.ws.send(JSON.stringify({ type: 'focus', tutorialFocused: true }));
    expect(await c.closed).toBe(4003);
    expect(browserMessages).toEqual([]);
  });

  it('rejects other protocol versions with a clear error', async () => {
    const { port, incompatible } = await startServer();
    const c = client(port, { Origin: ORIGIN });
    await c.opened;
    c.ws.send(JSON.stringify({ type: 'hello', protocol: 999, role: 'browser', client: 'x' }));
    expect(await c.closed).toBe(4004);
    expect(c.messages[0]).toMatchObject({ type: 'error', code: 'protocol-mismatch' });
    expect(incompatible).toEqual([999]); // VS Code can tell the user to update
  });

  it('a newer browser connection replaces the old one without a disconnect blip', async () => {
    const { port, events, browserMessages } = await startServer();
    const first = client(port, { Origin: ORIGIN });
    await first.opened;
    first.hello({ role: 'browser' });
    await waitFor(() => first.messages.some((m) => m.type === 'welcome'));

    const second = client(port, { Origin: ORIGIN });
    await second.opened;
    second.hello({ role: 'browser' });
    expect(await first.closed).toBe(4000);
    second.ws.send(JSON.stringify({ type: 'focus', tutorialFocused: true }));
    await waitFor(() => browserMessages.length === 1);
    expect(events).toEqual(['connected']);
    expect(server!.sendToBrowser({ type: 'ping' })).toBe(true);
    second.ws.close();
  });

  it('drops malformed messages', async () => {
    const { port, browserMessages } = await startServer();
    const c = client(port, { Origin: ORIGIN });
    await c.opened;
    c.hello({ role: 'browser' });
    await waitFor(() => c.messages.some((m) => m.type === 'welcome'));
    c.ws.send('not json');
    c.ws.send(JSON.stringify({ type: 'video', video: { status: 'exploded' }, cause: 'sync' }));
    await waitFor(() => c.messages.filter((m) => m.type === 'error').length === 2);
    expect(browserMessages).toEqual([]);
    c.ws.close();
  });
});
