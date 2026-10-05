import { PROTOCOL_VERSION, parseHubMessage } from '@codealong/protocol';
import type { SocketLike } from './connection';

const PROBE_TIMEOUT_MS = 1_500;

/**
 * Checks whether CodeAlong for VS Code is reachable, without becoming the active connection
 * (the hub answers a probe and closes it). Used by the popup and the welcome page.
 */
export type ProbeOutcome = 'found' | 'incompatible' | 'missing';

export async function probeHub(
  urls: readonly string[],
  createSocket: (url: string) => SocketLike = (url) => new WebSocket(url) as SocketLike,
): Promise<ProbeOutcome> {
  let outcome: ProbeOutcome = 'missing';
  for (const url of urls) {
    const r = await probeOne(url, createSocket);
    if (r === 'found') return r;
    if (r === 'incompatible') outcome = r;
  }
  return outcome;
}

function probeOne(url: string, createSocket: (url: string) => SocketLike): Promise<ProbeOutcome> {
  return new Promise((resolve) => {
    let socket: SocketLike;
    try {
      socket = createSocket(url);
    } catch {
      resolve('missing');
      return;
    }
    const finish = (r: ProbeOutcome) => {
      clearTimeout(timer);
      socket.onopen = socket.onclose = socket.onerror = socket.onmessage = null;
      try {
        socket.close();
      } catch {
        // already closed
      }
      resolve(r);
    };
    const timer = setTimeout(() => finish('missing'), PROBE_TIMEOUT_MS);
    socket.onopen = () =>
      socket.send(
        JSON.stringify({
          type: 'hello',
          protocol: PROTOCOL_VERSION,
          role: 'browser',
          client: 'chrome-probe',
          probe: true,
        }),
      );
    socket.onmessage = (ev) => {
      const msg = typeof ev.data === 'string' ? parseHubMessage(ev.data) : null;
      if (msg?.type === 'welcome') finish(msg.protocol === PROTOCOL_VERSION ? 'found' : 'incompatible');
      else if (msg?.type === 'error') finish(msg.code === 'protocol-mismatch' ? 'incompatible' : 'missing');
    };
    socket.onerror = () => finish('missing');
    socket.onclose = () => finish('missing');
  });
}
