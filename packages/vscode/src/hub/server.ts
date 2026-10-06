import { timingSafeEqual } from 'node:crypto';
import * as http from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  HEARTBEAT_INTERVAL_MS,
  MAX_MESSAGE_BYTES,
  PROTOCOL_VERSION,
  parseBrowserMessage,
  parseEditorMessage,
  type BrowserToHub,
  type ClientRole,
  type EditorToHub,
  type HubToClient,
} from '@codealong/protocol';

export interface HubServerOptions {
  /** Origins allowed to connect as "browser", e.g. chrome-extension://<id>. */
  allowedOrigins: () => readonly string[];
  /** Shared secret for "editor" clients (other VS Code windows). */
  editorToken: string;
  hubName: string;
  /** Extension version, advertised in the welcome message. */
  version?: string;
}

export interface HubServerEvents {
  onBrowserConnected(): void;
  onBrowserDisconnected(): void;
  onBrowserMessage(msg: Exclude<BrowserToHub, { type: 'hello' | 'ping' | 'pong' }>): void;
  onEditorMessage(msg: Exclude<EditorToHub, { type: 'hello' | 'ping' | 'pong' }>): void;
  /** A client speaks another protocol version: one of the extensions needs an update. */
  onIncompatibleClient?(role: ClientRole, protocol: number): void;
  log(message: string): void;
}

interface Client {
  ws: WebSocket;
  expectedRole: ClientRole;
  role: ClientRole | null;
  lastSeen: number;
  helloTimer: ReturnType<typeof setTimeout>;
}

const HELLO_TIMEOUT_MS = 3_000;
const DEAD_AFTER_MS = HEARTBEAT_INTERVAL_MS * 3;

/**
 * Local WebSocket hub, bound to 127.0.0.1 only.
 *
 * Who may connect:
 *  - Requests with an Origin header come from a browser. Only allow-listed extension origins
 *    are accepted (checked before the WebSocket upgrade). Web pages cannot fake their Origin,
 *    so a random site open in the browser can never talk to – let alone control – CodeAlong.
 *  - Requests without an Origin header are local processes and must present the editor token,
 *    which lives in a file only the current OS user can read.
 * At most one browser connection is active; a newer one replaces the older (the service worker
 * may have been restarted and left a half-dead socket behind).
 */
export class HubServer {
  private readonly http: http.Server;
  private readonly wss: WebSocketServer;
  private readonly clients = new Set<Client>();
  private browser: Client | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly options: HubServerOptions,
    private readonly events: HubServerEvents,
  ) {
    this.http = http.createServer((_req, res) => {
      res.writeHead(426, { 'content-type': 'text/plain' }).end('CodeAlong hub: WebSocket only\n');
    });
    this.wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });
    this.http.on('upgrade', (req, socket, head) => this.onUpgrade(req, socket, head));
  }

  listen(port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const onError = (err: Error) => {
        this.http.off('listening', onListening);
        reject(err);
      };
      const onListening = () => {
        this.http.off('error', onError);
        this.http.on('error', (err) => this.events.log(`server error: ${err.message}`));
        this.heartbeat = setInterval(() => this.checkClients(), HEARTBEAT_INTERVAL_MS);
        resolve();
      };
      this.http.once('error', onError);
      this.http.once('listening', onListening);
      this.http.listen(port, '127.0.0.1');
    });
  }

  get browserConnected(): boolean {
    return this.browser !== null;
  }

  address(): number | null {
    const a = this.http.address();
    return a && typeof a === 'object' ? a.port : null;
  }

  sendToBrowser(msg: HubToClient): boolean {
    if (!this.browser) return false;
    return send(this.browser.ws, msg);
  }

  broadcast(msg: HubToClient): void {
    for (const c of this.clients) if (c.role) send(c.ws, msg);
  }

  async close(): Promise<void> {
    if (this.heartbeat) clearInterval(this.heartbeat);
    for (const c of this.clients) c.ws.terminate();
    this.clients.clear();
    this.browser = null;
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
    await new Promise<void>((resolve) => (this.http.listening ? this.http.close(() => resolve()) : resolve()));
  }

  // ---------------------------------------------------------------------------

  private onUpgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer): void {
    const origin = req.headers.origin;
    const host = req.headers.host ?? '';
    // Defence in depth against DNS rebinding: only accept requests addressed to loopback.
    if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) return reject(socket, 403, 'bad host');
    if (origin !== undefined && !this.options.allowedOrigins().includes(origin)) {
      this.events.log(`rejected connection from origin ${origin}`);
      return reject(socket, 403, 'origin not allowed');
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => this.onConnection(ws, origin ? 'browser' : 'editor'));
  }

  private onConnection(ws: WebSocket, expectedRole: ClientRole): void {
    const client: Client = {
      ws,
      expectedRole,
      role: null,
      lastSeen: Date.now(),
      helloTimer: setTimeout(() => ws.close(4001, 'hello timeout'), HELLO_TIMEOUT_MS),
    };
    this.clients.add(client);
    ws.on('message', (data, isBinary) => {
      client.lastSeen = Date.now();
      if (isBinary) return ws.close(4002, 'binary not supported');
      this.onMessage(client, Buffer.isBuffer(data) ? data.toString('utf8') : String(data));
    });
    ws.on('close', () => this.onClose(client));
    ws.on('error', () => ws.terminate());
  }

  private onMessage(client: Client, raw: string): void {
    const msg = client.expectedRole === 'browser' ? parseBrowserMessage(raw) : parseEditorMessage(raw);
    if (!msg) {
      send(client.ws, { type: 'error', code: 'bad-message', message: 'Malformed message' });
      return;
    }

    if (!client.role) {
      if (msg.type !== 'hello') return client.ws.close(4003, 'hello expected');
      this.onHello(client, msg);
      return;
    }

    if (msg.type === 'ping') return void send(client.ws, { type: 'pong' });
    if (msg.type === 'pong' || msg.type === 'hello') return;

    if (client.role === 'browser') {
      if (client !== this.browser) return;
      this.events.onBrowserMessage(msg as Exclude<BrowserToHub, { type: 'hello' | 'ping' | 'pong' }>);
    } else {
      this.events.onEditorMessage(msg as Exclude<EditorToHub, { type: 'hello' | 'ping' | 'pong' }>);
    }
  }

  private onHello(
    client: Client,
    hello: { protocol: number; role: ClientRole; token?: string; probe?: boolean },
  ): void {
    clearTimeout(client.helloTimer);
    if (hello.protocol !== PROTOCOL_VERSION) {
      send(client.ws, {
        type: 'error',
        code: 'protocol-mismatch',
        message: `Protocol ${hello.protocol} not supported (hub speaks ${PROTOCOL_VERSION}). Update both extensions.`,
      });
      this.events.onIncompatibleClient?.(hello.role, hello.protocol);
      return client.ws.close(4004, 'protocol mismatch');
    }
    const authorised =
      hello.role === client.expectedRole &&
      (hello.role === 'browser' || (hello.token !== undefined && tokensEqual(hello.token, this.options.editorToken)));
    if (!authorised) {
      this.events.log(`rejected unauthorised ${hello.role} client`);
      send(client.ws, { type: 'error', code: 'unauthorized', message: 'Not authorised' });
      return client.ws.close(4005, 'unauthorized');
    }
    client.role = hello.role;
    send(client.ws, {
      type: 'welcome',
      protocol: PROTOCOL_VERSION,
      hub: this.options.hubName,
      ...(this.options.version ? { version: this.options.version } : {}),
      features: ['settings'],
    });
    if (hello.probe) {
      // "Is CodeAlong there?" – answered, never registered, never replaces the real browser.
      this.clients.delete(client);
      client.ws.close(1000, 'probe');
      return;
    }

    if (hello.role === 'browser') {
      const previous = this.browser;
      this.browser = client;
      if (previous) {
        // Detach first so its close event does not report a disconnect.
        this.clients.delete(previous);
        previous.ws.close(4000, 'replaced by newer connection');
      } else {
        this.events.onBrowserConnected();
      }
    }
  }

  private onClose(client: Client): void {
    clearTimeout(client.helloTimer);
    const known = this.clients.delete(client);
    if (known && client === this.browser) {
      this.browser = null;
      this.events.onBrowserDisconnected();
    }
  }

  private checkClients(): void {
    const now = Date.now();
    for (const c of this.clients) {
      if (now - c.lastSeen > DEAD_AFTER_MS) c.ws.terminate();
      else if (c.role) send(c.ws, { type: 'ping' });
    }
  }
}

function send(ws: WebSocket, msg: HubToClient): boolean {
  if (ws.readyState !== ws.OPEN) return false;
  ws.send(JSON.stringify(msg));
  return true;
}

function reject(socket: Duplex, code: number, reason: string): void {
  socket.write(`HTTP/1.1 ${code} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

function tokensEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
