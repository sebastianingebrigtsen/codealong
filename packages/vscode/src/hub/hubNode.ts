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
  /** Candidate loopback ports, in order of preference (normally HUB_PORTS). */
  ports: readonly number[];
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
  /** The other side (Chrome or another VS Code window) runs an incompatible CodeAlong version. */
  onIncompatible?(): void;
}

type PortProbe = 'follower' | 'free' | 'foreign';

const HANDSHAKE_TIMEOUT_MS = 1_500;
const ALL_PORTS_BUSY_RETRY_MS = 15_000;

/**
 * Every VS Code window runs one HubNode. Exactly one of them is the *leader*: it runs the local
 * hub (server + state machine). The other windows are *followers*: they connect to the leader as
 * authenticated "editor" clients and forward their typing/save signals and hotkeys.
 *
 * Election, run on start and whenever a follower loses its leader:
 *   1. Try each candidate port in order and join the first one that answers as a CodeAlong hub.
 *   2. Otherwise listen on the first port that is free (ports used by other programs are skipped).
 *   3. If that bind races with another window (EADDRINUSE), start over shortly; the winner will
 *      then be found in step 1.
 * The Chrome extension probes the same port list, so neither side needs a configured port.
 */
export class HubNode {
  role: NodeRole = 'starting';
  lastError: string | null = null;
  /** Port of the hub this window leads or follows. */
  port: number | null = null;
  private server: HubServer | null = null;
  private runner: CoreRunner | null = null;
  private follower: WebSocket | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private commandId = 0;
  private stopped = false;
  private electing = false;

  constructor(
    private readonly options: HubNodeOptions,
    private readonly events: HubNodeEvents,
  ) {}

  start(): void {
    this.stopped = false;
    void this.elect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.role = 'stopped';
    this.port = null;
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

  private async elect(): Promise<void> {
    if (this.stopped || this.electing) return;
    this.electing = true;
    try {
      const probes = new Map<number, PortProbe>();
      for (const port of this.options.ports) {
        const result = await this.tryFollow(port);
        if (this.stopped) return;
        if (result === 'follower') return;
        probes.set(port, result);
      }
      for (const port of this.options.ports) {
        if (probes.get(port) !== 'free') continue;
        const outcome = await this.tryLead(port);
        if (outcome === 'leader' || this.stopped) return;
        if (outcome === 'raced') {
          // Another window bound this port a moment ago: it is the hub now, go and join it.
          this.scheduleRetry(100 + Math.random() * 300);
          return;
        }
      }
      this.fail(
        'CodeAlong could not start its local connection: all of its ports are used by other programs.',
        ALL_PORTS_BUSY_RETRY_MS,
      );
    } finally {
      this.electing = false;
    }
  }

  private async tryLead(port: number): Promise<'leader' | 'raced' | 'failed'> {
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
        onIncompatibleClient: () => this.events.onIncompatible?.(),
        log: (message) => this.events.info(message),
      },
    );

    try {
      await server.listen(port);
    } catch (err) {
      runner.dispose();
      return (err as NodeJS.ErrnoException).code === 'EADDRINUSE' ? 'raced' : 'failed';
    }
    if (this.stopped) {
      runner.dispose();
      await server.close();
      return 'failed';
    }
    this.server = server;
    this.runner = runner;
    this.role = 'leader';
    this.port = port;
    this.lastError = null;
    this.events.info(`Local connection ready (127.0.0.1:${port}); this window hosts CodeAlong.`);
    runner.dispatch({ type: 'settings', settings: this.options.settings() });
    this.events.onStatus(runner.status(), 'leader');
    return 'leader';
  }

  /** Resolves 'follower' once welcomed (and stays connected), 'free' if nothing listens, else 'foreign'. */
  private tryFollow(port: number): Promise<PortProbe> {
    return new Promise((resolve) => {
      let settled = false;
      let welcomed = false;
      const settle = (r: PortProbe) => {
        if (!settled) {
          settled = true;
          resolve(r);
        }
      };
      const ws = new WebSocket(`ws://127.0.0.1:${port}`, {
        maxPayload: 64 * 1024,
        handshakeTimeout: HANDSHAKE_TIMEOUT_MS,
      });
      const handshake = setTimeout(() => ws.terminate(), HANDSHAKE_TIMEOUT_MS);

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
            if (this.stopped) {
              ws.terminate();
              return;
            }
            welcomed = true;
            clearTimeout(handshake);
            this.follower = ws;
            this.role = 'follower';
            this.port = port;
            this.lastError = null;
            this.events.info('Connected to CodeAlong in another VS Code window.');
            this.events.onStatus(null, 'follower');
            settle('follower');
            break;
          case 'status':
            this.events.onStatus(msg.status, 'follower');
            break;
          case 'ping':
            ws.send(JSON.stringify({ type: 'pong' }));
            break;
          case 'error':
            this.events.info(`Port ${port} refused this window: ${msg.message}`);
            if (msg.code === 'protocol-mismatch') this.events.onIncompatible?.();
            break;
          default:
            break;
        }
      });
      ws.on('error', (err: NodeJS.ErrnoException) => {
        if (!welcomed && err.code === 'ECONNREFUSED') settle('free');
      });
      ws.on('close', () => {
        clearTimeout(handshake);
        settle('foreign'); // no-op if already settled
        if (!welcomed) return;
        if (this.follower === ws) this.follower = null;
        if (this.stopped) return;
        this.events.info('The VS Code window hosting CodeAlong closed; taking over or reconnecting.');
        this.role = 'starting';
        this.port = null;
        this.events.onStatus(null, 'starting');
        // Small random delay so several followers do not all race at the same instant.
        this.scheduleRetry(150 + Math.random() * 350);
      });
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

  private scheduleRetry(ms: number): void {
    if (this.stopped) return;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.elect();
    }, ms);
  }
}
