import {
  PROTOCOL_VERSION,
  parseHubMessage,
  type BrowserToHub,
  type CommandMessage,
  type HubStatus,
} from '@codealong/protocol';
import type { ConnectionState } from '../shared/messages';

/** Minimal WebSocket surface, so tests can inject a fake. */
export interface SocketLike {
  readonly readyState: number;
  onopen: ((ev: unknown) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  send(data: string): void;
  close(): void;
}

export interface ConnectionEvents {
  onConnected(): void;
  onDisconnected(wasConnected: boolean): void;
  onCommand(cmd: CommandMessage): void;
  onStatus(status: HubStatus): void;
  log(event: string, detail?: string): void;
}

const OPEN = 1;
const HANDSHAKE_TIMEOUT_MS = 3_000;
/** The hub pings every 20 s; if we hear nothing for this long the socket is considered dead. */
const SILENCE_TIMEOUT_MS = 50_000;
const WATCHDOG_INTERVAL_MS = 10_000;
const MAX_BACKOFF_MS = 10_000;

/**
 * Client side of the local connection to the VS Code hub.
 *
 * - `ensure()` is idempotent and is called from many places (startup, alarms, content-script
 *   messages), so it is fine if the service worker was asleep or VS Code started later.
 * - Reconnects with exponential backoff while the service worker is alive; the keep-alive alarm
 *   covers the case where the worker was terminated in between.
 */
export class HubConnection {
  private socket: SocketLike | null = null;
  private welcomed = false;
  private wanted = false;
  private attempts = 0;
  private lastMessageAt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private handshakeTimer: ReturnType<typeof setTimeout> | null = null;
  private watchdogTimer: ReturnType<typeof setInterval> | null = null;
  state: ConnectionState = 'off';
  lastError: string | null = null;

  constructor(
    private readonly url: () => string,
    private readonly events: ConnectionEvents,
    private readonly createSocket: (url: string) => SocketLike = (url) => new WebSocket(url) as SocketLike,
    private readonly now: () => number = () => Date.now(),
  ) {}

  get connected(): boolean {
    return this.welcomed && this.socket?.readyState === OPEN;
  }

  ensure(): void {
    this.wanted = true;
    if (this.socket || this.reconnectTimer) return;
    this.connect();
  }

  stop(): void {
    this.wanted = false;
    this.clearReconnect();
    const s = this.socket;
    if (s) {
      this.teardown(s);
      s.close();
    }
    this.state = 'off';
  }

  /** Reconnect immediately (e.g. after the port setting changed). */
  restart(): void {
    const wanted = this.wanted;
    this.stop();
    this.attempts = 0;
    if (wanted) this.ensure();
  }

  send(msg: BrowserToHub): boolean {
    if (!this.connected || !this.socket) return false;
    try {
      this.socket.send(JSON.stringify(msg));
      return true;
    } catch {
      return false;
    }
  }

  private connect(): void {
    let socket: SocketLike;
    try {
      socket = this.createSocket(this.url());
    } catch (err) {
      this.lastError = String(err);
      this.state = 'error';
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    this.welcomed = false;
    this.state = 'connecting';

    socket.onopen = () => {
      this.lastMessageAt = this.now();
      socket.send(
        JSON.stringify({ type: 'hello', protocol: PROTOCOL_VERSION, role: 'browser', client: 'chrome-extension' }),
      );
      this.handshakeTimer = setTimeout(() => {
        this.lastError = 'No answer from VS Code (is another program using the port?)';
        socket.close();
      }, HANDSHAKE_TIMEOUT_MS);
    };
    socket.onmessage = (ev) => this.onMessage(socket, ev.data);
    socket.onerror = () => {
      // Details are not exposed for WebSocket errors; onclose follows.
    };
    socket.onclose = () => {
      if (this.socket !== socket) return;
      const wasConnected = this.welcomed;
      this.teardown(socket);
      if (wasConnected) this.events.log('CONNECTION_LOST');
      this.state = this.wanted ? 'error' : 'off';
      if (!this.lastError || wasConnected) this.lastError = 'VS Code is not reachable';
      this.events.onDisconnected(wasConnected);
      if (this.wanted) this.scheduleReconnect();
    };
  }

  private onMessage(socket: SocketLike, data: unknown): void {
    if (this.socket !== socket || typeof data !== 'string') return;
    this.lastMessageAt = this.now();
    const msg = parseHubMessage(data);
    if (!msg) return;

    if (!this.welcomed) {
      if (msg.type === 'welcome' && msg.protocol === PROTOCOL_VERSION) {
        this.welcomed = true;
        this.attempts = 0;
        this.lastError = null;
        this.state = 'connected';
        if (this.handshakeTimer) clearTimeout(this.handshakeTimer);
        this.handshakeTimer = null;
        this.watchdogTimer = setInterval(() => {
          if (this.now() - this.lastMessageAt > SILENCE_TIMEOUT_MS) {
            this.lastError = 'Connection timed out';
            socket.close();
          }
        }, WATCHDOG_INTERVAL_MS);
        this.events.log('CONNECTED', msg.hub);
        this.events.onConnected();
      } else if (msg.type === 'error') {
        this.lastError = msg.message;
        socket.close();
      }
      return;
    }

    switch (msg.type) {
      case 'ping':
        this.send({ type: 'pong' });
        break;
      case 'command':
        this.events.onCommand(msg);
        break;
      case 'status':
        this.events.onStatus(msg.status);
        break;
      case 'error':
        this.lastError = msg.message;
        this.events.log('HUB_ERROR', msg.message);
        break;
      default:
        break;
    }
  }

  private teardown(socket: SocketLike): void {
    socket.onopen = socket.onclose = socket.onerror = null;
    socket.onmessage = null;
    if (this.handshakeTimer) clearTimeout(this.handshakeTimer);
    if (this.watchdogTimer) clearInterval(this.watchdogTimer);
    this.handshakeTimer = null;
    this.watchdogTimer = null;
    if (this.socket === socket) this.socket = null;
    this.welcomed = false;
  }

  private scheduleReconnect(): void {
    this.clearReconnect();
    const delay = Math.min(MAX_BACKOFF_MS, 1_000 * 2 ** this.attempts);
    this.attempts++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.wanted && !this.socket) this.connect();
    }, delay);
  }

  private clearReconnect(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }
}
