/**
 * TEST-ONLY stand-in for src/network/directoryTransport.ts (aliased in `--mode e2e`).
 * Same pub/sub semantics, carried by the local Trystero ws-relay instead of
 * public Nostr relays, so the two-browser test can run offline.
 */
import type { DirectoryTransport } from '../../src/network/directoryTransport';
export type { DirectoryTransport } from '../../src/network/directoryTransport';

const RELAY = (import.meta.env.VITE_E2E_RELAY as string | undefined) ?? 'ws://127.0.0.1:8787';

export function pickRelays(all: readonly string[], _seed: string, n: number): string[] {
  return all.slice(0, n);
}

export function createDirectoryTransport(topic: string): DirectoryTransport {
  const me = Math.random().toString(36).slice(2);
  let ws: WebSocket | null = null;
  let active = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const t: DirectoryTransport = {
    onMessage: null,
    onConnect: null,
    connect() {
      if (active) return;
      active = true;
      open();
    },
    close() {
      active = false;
      if (timer) clearTimeout(timer);
      timer = null;
      if (ws) {
        ws.onclose = null;
        ws.close();
      }
      ws = null;
    },
    publish(msg) {
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'publish', topic, payload: { from: me, msg } }));
    },
    health() {
      return { open: ws?.readyState === WebSocket.OPEN ? 1 : 0, total: 1 };
    },
  };

  function open(): void {
    if (!active) return;
    const s = new WebSocket(RELAY);
    ws = s;
    s.onopen = () => {
      s.send(JSON.stringify({ type: 'subscribe', topic }));
      t.onConnect?.();
    };
    s.onmessage = (e) => {
      try {
        const { topic: tp, payload } = JSON.parse(String(e.data));
        if (tp !== topic || !payload || payload.from === me) return;
        t.onMessage?.(payload.msg, String(payload.from));
      } catch {
        /* ignore */
      }
    };
    s.onclose = () => {
      if (ws === s) ws = null;
      if (active) timer = setTimeout(open, 1000);
    };
  }

  return t;
}
