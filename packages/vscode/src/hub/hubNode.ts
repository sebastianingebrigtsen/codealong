import { WebSocket } from 'ws';
import {
  PROTOCOL_VERSION,
  parseHubMessage,
  type ActivityKind,
  type ControlAction,
  type EditorToHub,
  type HubStatus,
} from '@codealong/protocol';
import type { CoreSettings, LogEventName } from '../core/hubCore';
import { CoreRunner } from './coreRunner';
import { HubServer } from './server';

export type NodeRole = 'starting' | 'leader' | 'follower' | 'error' | 'stopped';

export interface HubNodeOptions {
  port: number;
  editorToken: string;
  allowedOrigins: () => readonly string[];
  settings: () => CoreSettings;
}

export interface HubNodeEvents {
  /** Hub status for the UI (null while this window is not attached to a hub). */
  onStatus(status: HubStatus | null, role: NodeRole): void;
  /** Core events (only produced in the window that hosts the hub). */
  onEvent(event: LogEventName, detail?: string): void;
  /** Connection-level information, always worth showing in the log. */
  info(message: string): void;
}

const HANDSHAKE_TIMEOUT_MS = 3_000;
const MAX_RETRY_MS = 5_000;
const FOREIGN_PORT_RETRY_MS = 10_000;

/**
 * Every VS Code window runs one HubNode. Exactly one of them – whoever binds the port first – is
 * the *leader*: it runs the WebSocket hub and the state machine. Other windows become
 * *followers*: they connect to the leader as authenticated "editor" clients and forward their
 * typing/save signals and hotkeys. When the leader window closes, followers race to bind the
 * port and one of them takes over. The Chrome extension simply reconnects.
 */
export class HubNode {
  role: NodeRole = 'starting';
  lastError: string | null = null;
  private server: HubServer | null = null;
  private runner: CoreRunner | null = null;
  private follower: WebSocket | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private failures = 0;
  private commandId = 0;
  private stopped = false;

  constructor(
    private readonly options: HubNodeOptions,
    private readonly events: HubNodeEvents,
  ) {}

  start(): void {
    this.stopped = false;
    void this.tryLead();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.role = 'stopped';
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.follower?.terminate();
    this.follower = null;
    this.runner?.dispose();
    this.runner = null;
    const server = this.server;
    this.server = null;
    await server?.close();
  }

  activity(kind: ActivityKind): void {
    if (this.runner) this.runner.dispatch({ type: kind });
    else this.sendToLeader({ type: 'activity', kind });
  }

  control(action: ControlAction): void {
    if (this.runner) this.runner.dispatch({ type: 'control', action });
    else this.sendToLeader({ type: 'control', action });
  }

  settingsChanged(): void {
    this.runner?.dispatch({ type: 'settings', settings: this.options.settings() });
  }

  // ---------------------------------------------------------------------------

  private async tryLead(): Promise<void> {
    if (this.stopped) return;
    const runner = new CoreRunner(this.options.settings(), {
      sendCommand: (command) => {
        this.server?.sendToBrowser({ type: 'command', id: ++this.commandId, ...command });
      },
      log: (event, detail) => this.events.onEvent(event, detail),
      onStatus: (status) => {
        this.server?.broadcast({ type: 'status', status });
        if (this.role === 'leader') this.events.onStatus(status, 'leader');
      },
    });
    const server = new HubServer(
      { allowedOrigins: this.options.allowedOrigins, editorToken: this.options.editorToken, hubName: 'vscode' },
      {
        onBrowserConnected: () => runner.dispatch({ type: 'browserConnected' }),
        onBrowserDisconnected: () => runner.dispatch({ type: 'browserDisconnected' }),
        onBrowserMessage: (msg) => {
          switch (msg.type) {
            case 'tutorial':
              return runner.dispatch({ type: 'tutorial', tutorial: msg.tutorial });
            case 'video':
              return runner.dispatch({ type: 'video', video: msg.video, cause: msg.cause });
            case 'focus':
              return runner.dispatch({ type: 'tutorialFocus', focused: msg.tutorialFocused });
            case 'control':
              return runner.dispatch({ type: 'control', action: msg.action });
          }
        },
        onEditorMessage: (msg) => {
          if (msg.type === 'activity') runner.dispatch({ type: msg.kind });
          else runner.dispatch({ type: 'control', action: msg.action });
        },
        log: (message) => this.events.info(message),
      },
    );

    try {
      await server.listen(this.options.port);
    } catch (err) {
      runner.dispose();
      if (this.stopped) return;
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EADDRINUSE') return this.tryFollow();
      this.fail(`Could not listen on 127.0.0.1:${this.options.port}: ${(err as Error).message}`, MAX_RETRY_MS);
      return;
    }
    if (this.stopped) {
      runner.dispose();
      await server.close();
      return;
    }
    this.server = server;
    this.runner = runner;
    this.role = 'leader';
    this.failures = 0;
    this.lastError = null;
    this.events.info(`Hub listening on 127.0.0.1:${this.options.port}`);
    runner.dispatch({ type: 'settings', settings: this.options.settings() });
    this.events.onStatus(runner.status(), 'leader');
  }

  private tryFollow(): void {
    if (this.stopped) return;
    this.lastError = null;
    const ws = new WebSocket(`ws://127.0.0.1:${this.options.port}`, { maxPayload: 64 * 1024 });
    this.follower = ws;
    let welcomed = false;
    const handshake = setTimeout(() => {
      this.lastError = `Port ${this.options.port} is used by another program. Change "codealong.port" (and the port in the Chrome extension).`;
      ws.terminate();
    }, HANDSHAKE_TIMEOUT_MS);

    ws.on('open', () => {
      ws.send(
        JSON.stringify({
          type: 'hello',
          protocol: PROTOCOL_VERSION,
          role: 'editor',
          token: this.options.editorToken,
          client: 'vscode-window',
        } satisfies EditorToHub),
      );
    });
    ws.on('message', (data) => {
      const msg = parseHubMessage(data.toString());
      if (!msg) return;
      switch (msg.type) {
        case 'welcome':
          welcomed = true;
          clearTimeout(handshake);
          this.role = 'follower';
          this.failures = 0;
          this.lastError = null;
          this.events.info('Connected to the CodeAlong hub in another VS Code window');
          this.events.onStatus(null, 'follower');
          break;
        case 'status':
          this.events.onStatus(msg.status, 'follower');
          break;
        case 'ping':
          ws.send(JSON.stringify({ type: 'pong' }));
          break;
        case 'error':
          this.lastError = msg.message;
          this.events.info(`Hub refused this window: ${msg.message}`);
          break;
        default:
          break;
      }
    });
    ws.on('error', () => {
      // 'close' follows and handles it.
    });
    ws.on('close', () => {
      clearTimeout(handshake);
      if (this.follower === ws) this.follower = null;
      if (this.stopped) return;
      if (welcomed) {
        this.events.info('Hub window went away; taking over or reconnecting');
        this.role = 'starting';
        this.events.onStatus(null, 'starting');
        // Small random delay so several followers do not all race at the same instant.
        this.scheduleRetry(150 + Math.random() * 350);
      } else if (this.lastError) {
        this.fail(this.lastError, FOREIGN_PORT_RETRY_MS);
      } else {
        this.scheduleRetry(this.backoff());
      }
    });
  }

  private sendToLeader(msg: EditorToHub): void {
    if (this.role !== 'follower' || this.follower?.readyState !== WebSocket.OPEN) return;
    this.follower.send(JSON.stringify(msg));
  }

  private fail(message: string, retryMs: number): void {
    this.role = 'error';
    this.lastError = message;
    this.events.info(message);
    this.events.onStatus(null, 'error');
    this.scheduleRetry(retryMs);
  }

  private backoff(): number {
    this.failures++;
    return Math.min(MAX_RETRY_MS, 250 * 2 ** this.failures) + Math.random() * 250;
  }

  private scheduleRetry(ms: number): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.tryLead();
    }, ms);
  }
}
