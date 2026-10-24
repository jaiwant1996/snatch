/**
 * Public lobby directory — "who is hosting an open room right now?"
 *
 * No server keeps a list. Instead:
 *  - A host whose room is PUBLIC and still waiting for an opponent announces
 *    it every few seconds (and immediately when someone asks).
 *  - Visitors on the home page ask "who's open?" when they arrive and then
 *    listen. Each listing expires if its host stops announcing.
 *  - When the room fills, or the host leaves/turns listing off, the host
 *    publishes "closed" so it vanishes from everyone's list at once.
 *
 * Everything received is untrusted: messages are validated, names sanitised,
 * only the original announcer may update or close a listing, and the list is
 * capped. Joining a listed room still goes through the normal handshake, so
 * a fake or stale listing just ends in "No host found" / "Room is full".
 */
import { NET } from '../config/gameConfig';
import { isValidRoomCode } from '../lobby/roomCode';
import type { DirectoryTransport } from './directoryTransport';
import { sanitizeName } from './messages';

export const DIRECTORY = {
  /** Host re-announces this often while open. */
  announceEveryMs: 12_000,
  /** A listing disappears if not refreshed for this long. */
  expireAfterMs: 45_000,
  /** Minimum gap between answers to "who's open?" queries. */
  answerGapMs: 3_000,
  /** Minimum gap between our own queries (refresh button spam). */
  queryGapMs: 4_000,
  /** Visitors re-ask now and then in case an announcement was missed. */
  requeryEveryMs: 40_000,
  /** Close relay sockets after this long with nothing to do. */
  idleCloseMs: 20_000,
  maxListings: 40,
  version: 1,
} as const;

export interface Listing {
  code: string;
  name: string;
  events: boolean;
  /** Local timestamp (ms) when the host opened the room (skew-free estimate). */
  openedAt: number;
  /** Local timestamp (ms) of the last announcement. */
  seenAt: number;
  owner: string;
}

export interface HostedRoom {
  code: string;
  name: string;
  events: boolean;
}

type Wire =
  | { v: 1; t: 'q' }
  | { v: 1; t: 'a'; c: string; n: string; e: boolean; p: number; up: number }
  | { v: 1; t: 'x'; c: string };

/** Validates an untrusted directory message. */
export function parseDirectoryMsg(raw: unknown): Wire | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const m = raw as Record<string, unknown>;
  if (m.v !== DIRECTORY.version) return null;
  if (m.t === 'q') return { v: 1, t: 'q' };
  if (typeof m.c !== 'string' || !isValidRoomCode(m.c)) return null;
  if (m.t === 'x') return { v: 1, t: 'x', c: m.c };
  if (m.t !== 'a') return null;
  if (typeof m.e !== 'boolean' || typeof m.p !== 'number' || !Number.isInteger(m.p)) return null;
  if (typeof m.up !== 'number' || !Number.isFinite(m.up) || m.up < 0 || m.up > 86_400) return null;
  return { v: 1, t: 'a', c: m.c, n: sanitizeName(m.n, 'Player'), e: m.e, p: m.p, up: m.up };
}

export class LobbyDirectory {
  private listings = new Map<string, Listing>();
  private hosted: HostedRoom | null = null;
  private hostedSince = 0;
  private browsing = false;
  private connected = false;
  private announceTimer: ReturnType<typeof setInterval> | null = null;
  private requeryTimer: ReturnType<typeof setInterval> | null = null;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private answerTimer: ReturnType<typeof setTimeout> | null = null;
  private lastAnswer = 0;
  private lastQuery = 0;
  private startedAt = 0;
  /** Fired when the visible list (or its status) changes. */
  onChange: (() => void) | null = null;

  constructor(
    private transport: DirectoryTransport,
    private now: () => number = () => Date.now(),
  ) {
    transport.onMessage = (msg, from) => this.receive(msg, from);
    transport.onConnect = () => {
      // A relay just (re)connected: catch up on what we missed.
      if (this.browsing) this.query(true);
      if (this.hosted) this.announce();
      this.onChange?.();
    };
  }

  // ------------------------------------------------------------ public API

  /** Show/hide the home-page list (subscribes while visible). */
  setBrowsing(on: boolean): void {
    if (on === this.browsing) return;
    this.browsing = on;
    if (on) {
      this.ensureConnected();
      this.query(true);
      this.requeryTimer = setInterval(() => this.query(true), DIRECTORY.requeryEveryMs);
    } else if (this.requeryTimer) {
      clearInterval(this.requeryTimer);
      this.requeryTimer = null;
    }
    this.scheduleIdle();
  }

  /** Advertise (or stop advertising, with null) our open room. */
  setHosted(room: HostedRoom | null): void {
    const prev = this.hosted;
    const same = prev && room && prev.code === room.code && prev.name === room.name && prev.events === room.events;
    if (same) return;
    if (prev && (!room || room.code !== prev.code)) this.send({ v: 1, t: 'x', c: prev.code });
    if (room && (!prev || prev.code !== room.code)) this.hostedSince = this.now();
    this.hosted = room;
    if (this.announceTimer) clearInterval(this.announceTimer);
    this.announceTimer = null;
    if (room) {
      this.ensureConnected();
      this.announce();
      this.announceTimer = setInterval(() => this.announce(), DIRECTORY.announceEveryMs);
    }
    this.scheduleIdle();
  }

  /** User pressed refresh. */
  refresh(): void {
    this.ensureConnected();
    this.query(false);
  }

  /** Current open rooms, longest-waiting first. */
  list(): Listing[] {
    this.sweep(false);
    return [...this.listings.values()].sort((a, b) => a.openedAt - b.openedAt);
  }

  status(): 'connecting' | 'ok' | 'unreachable' {
    const h = this.transport.health();
    if (h.open > 0) return 'ok';
    return this.now() - this.startedAt > 9_000 ? 'unreachable' : 'connecting';
  }

  /** Remove a listing locally (e.g. we just tried it and it was dead). */
  forget(code: string): void {
    if (this.listings.delete(code)) this.onChange?.();
  }

  dispose(): void {
    this.setHosted(null);
    this.setBrowsing(false);
    this.disconnect();
  }

  // ------------------------------------------------------------ internals

  private ensureConnected(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    if (this.connected) return;
    this.connected = true;
    this.startedAt = this.now();
    this.transport.connect();
    this.sweepTimer = setInterval(() => this.sweep(true), 2_000);
  }

  private scheduleIdle(): void {
    if (this.browsing || this.hosted || !this.connected || this.idleTimer) return;
    // Give a pending "closed" message time to go out before dropping sockets.
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (!this.browsing && !this.hosted) this.disconnect();
    }, DIRECTORY.idleCloseMs);
  }

  private disconnect(): void {
    if (!this.connected) return;
    this.connected = false;
    this.transport.close();
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
    this.listings.clear();
  }

  private send(msg: Wire): void {
    if (this.connected) this.transport.publish(msg);
  }

  private query(automatic: boolean): void {
    const t = this.now();
    if (!automatic && t - this.lastQuery < DIRECTORY.queryGapMs) return;
    this.lastQuery = t;
    this.send({ v: 1, t: 'q' });
  }

  private announce(): void {
    const r = this.hosted;
    if (!r) return;
    this.lastAnswer = this.now();
    this.send({
      v: 1,
      t: 'a',
      c: r.code,
      n: r.name,
      e: r.events,
      p: NET.protocolVersion,
      up: Math.round((this.now() - this.hostedSince) / 1000),
    });
  }

  private receive(raw: unknown, from: string): void {
    const m = parseDirectoryMsg(raw);
    if (!m) return;
    if (m.t === 'q') {
      // Someone just opened the home page — answer soon, but not in lock-step
      // with every other host, and not more than once every few seconds.
      if (!this.hosted || this.answerTimer) return;
      const wait = Math.max(0, DIRECTORY.answerGapMs - (this.now() - this.lastAnswer));
      this.answerTimer = setTimeout(() => {
        this.answerTimer = null;
        this.announce();
      }, wait + 150 + Math.random() * 900);
      return;
    }
    if (m.c === this.hosted?.code) return; // our own room, echoed by a relay
    const existing = this.listings.get(m.c);
    if (existing && existing.owner !== from) return; // only the announcer may update/close it
    if (m.t === 'x') {
      if (existing) {
        this.listings.delete(m.c);
        this.onChange?.();
      }
      return;
    }
    if (m.p !== NET.protocolVersion) return; // other versions can't play us
    if (!existing && this.listings.size >= DIRECTORY.maxListings) return;
    const t = this.now();
    this.listings.set(m.c, {
      code: m.c,
      name: m.n,
      events: m.e,
      openedAt: existing ? Math.min(existing.openedAt, t - m.up * 1000) : t - m.up * 1000,
      seenAt: t,
      owner: from,
    });
    if (!existing || existing.name !== m.n || existing.events !== m.e) this.onChange?.();
  }

  private sweep(notify: boolean): void {
    const cutoff = this.now() - DIRECTORY.expireAfterMs;
    let changed = false;
    for (const [code, l] of this.listings) {
      if (l.seenAt < cutoff) {
        this.listings.delete(code);
        changed = true;
      }
    }
    if (notify && (changed || this.browsing)) this.onChange?.();
  }
}
