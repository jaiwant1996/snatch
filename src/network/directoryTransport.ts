/**
 * Pub/sub transport for the public lobby directory, over public Nostr relays.
 *
 * This is the same infrastructure Trystero already uses to pair browsers, and
 * the same kind of message: short-lived "ephemeral" Nostr events (kinds
 * 20000–29999) that relays forward to current subscribers but never store.
 * No server of ours is involved; nothing persists after a tab closes.
 *
 * The e2e build swaps this module for a localhost relay (see vite.config.ts).
 */
import { createEvent, defaultRelayUrls, subscribe } from 'trystero';

export interface DirectoryTransport {
  /** Publish a small JSON-serialisable message to everyone listening. */
  publish(msg: unknown): void;
  /** `from` is a per-tab sender id (Nostr pubkey). Own messages are not echoed. */
  onMessage: ((msg: unknown, from: string) => void) | null;
  /** Called whenever at least one relay (re)connects — a good moment to re-query. */
  onConnect: (() => void) | null;
  connect(): void;
  close(): void;
  health(): { open: number; total: number };
}

/** How many relays to use. Host and visitors pick the SAME set (deterministic). */
const RELAY_COUNT = 6;

/** Deterministic pick so every copy of the site talks to the same relays. */
export function pickRelays(all: readonly string[], seedText: string, n: number): string[] {
  let seed = 0;
  for (const ch of seedText) seed = (seed * 31 + ch.charCodeAt(0)) >>> 0;
  const a = [...all];
  for (let i = a.length - 1; i > 0; i--) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const j = seed % (i + 1);
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a.slice(0, n);
}

interface Conn {
  url: string;
  ws: WebSocket | null;
  retryMs: number;
  timer: ReturnType<typeof setTimeout> | null;
}

export function createDirectoryTransport(topic: string): DirectoryTransport {
  const urls = pickRelays(defaultRelayUrls, topic, RELAY_COUNT);
  const subId = 'snatch' + Math.random().toString(36).slice(2, 12);
  const conns: Conn[] = urls.map((url) => ({ url, ws: null, retryMs: 3000, timer: null }));
  const seen = new Set<string>(); // event ids already handled (relays overlap)
  const seenOrder: string[] = [];
  let active = false;

  const remember = (id: string) => {
    seen.add(id);
    seenOrder.push(id);
    if (seenOrder.length > 2000) seen.delete(seenOrder.shift()!);
  };

  const t: DirectoryTransport = {
    onMessage: null,
    onConnect: null,

    connect() {
      if (active) return;
      active = true;
      conns.forEach(open);
    },

    close() {
      active = false;
      for (const c of conns) {
        if (c.timer) clearTimeout(c.timer);
        c.timer = null;
        const ws = c.ws;
        c.ws = null;
        if (ws) {
          ws.onclose = null;
          try {
            if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(['CLOSE', subId]));
            ws.close();
          } catch {
            /* ignore */
          }
        }
      }
    },

    publish(msg) {
      if (!active) return;
      void createEvent(topic, JSON.stringify(msg))
        .then((wire) => {
          try {
            const id = (JSON.parse(wire) as [string, { id: string }])[1].id;
            remember(id); // don't hand our own event back to ourselves
          } catch {
            /* ignore */
          }
          for (const c of conns) if (c.ws?.readyState === WebSocket.OPEN) c.ws.send(wire);
        })
        .catch(() => {});
    },

    health() {
      return { open: conns.filter((c) => c.ws?.readyState === WebSocket.OPEN).length, total: conns.length };
    },
  };

  function open(c: Conn): void {
    if (!active) return;
    let ws: WebSocket;
    try {
      ws = new WebSocket(c.url);
    } catch {
      retry(c);
      return;
    }
    c.ws = ws;
    ws.onopen = () => {
      c.retryMs = 3000;
      ws.send(subscribe(subId, topic));
      t.onConnect?.();
    };
    ws.onmessage = (e) => {
      let data: unknown;
      try {
        data = JSON.parse(String(e.data));
      } catch {
        return;
      }
      if (!Array.isArray(data) || data[0] !== 'EVENT' || data[1] !== subId) return;
      const ev = data[2] as { id?: unknown; pubkey?: unknown; content?: unknown; tags?: unknown } | undefined;
      if (!ev || typeof ev.id !== 'string' || typeof ev.content !== 'string' || typeof ev.pubkey !== 'string') return;
      if (!Array.isArray(ev.tags) || !ev.tags.some((tg) => Array.isArray(tg) && tg[0] === 'x' && tg[1] === topic)) return;
      if (seen.has(ev.id)) return;
      remember(ev.id);
      if (ev.content.length > 2000) return;
      let msg: unknown;
      try {
        msg = JSON.parse(ev.content);
      } catch {
        return;
      }
      t.onMessage?.(msg, ev.pubkey);
    };
    ws.onerror = () => {
      /* onclose follows */
    };
    ws.onclose = () => {
      if (c.ws === ws) c.ws = null;
      retry(c);
    };
  }

  function retry(c: Conn): void {
    if (!active || c.timer) return;
    c.timer = setTimeout(() => {
      c.timer = null;
      open(c);
    }, c.retryMs);
    c.retryMs = Math.min(c.retryMs * 2, 60_000);
  }

  return t;
}
