import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NET } from '../../src/config/gameConfig';
import { DIRECTORY, LobbyDirectory, parseDirectoryMsg } from '../../src/network/directory';
import { pickRelays, type DirectoryTransport } from '../../src/network/directoryTransport';

/** In-memory "relay": every connected transport receives everyone else's messages. */
class Bus {
  members = new Set<FakeTransport>();
  deliver(from: FakeTransport, msg: unknown): void {
    for (const m of this.members) if (m !== from && m.connected) m.onMessage?.(JSON.parse(JSON.stringify(msg)), from.id);
  }
}

class FakeTransport implements DirectoryTransport {
  onMessage: ((msg: unknown, from: string) => void) | null = null;
  onConnect: (() => void) | null = null;
  connected = false;
  sent: unknown[] = [];
  constructor(
    private bus: Bus,
    readonly id: string,
  ) {
    bus.members.add(this);
  }
  connect() {
    this.connected = true;
    this.onConnect?.();
  }
  close() {
    this.connected = false;
  }
  publish(msg: unknown) {
    if (!this.connected) return;
    this.sent.push(msg);
    this.bus.deliver(this, msg);
  }
  health() {
    return { open: this.connected ? 1 : 0, total: 1 };
  }
}

let bus: Bus;
const make = (id: string) => {
  const t = new FakeTransport(bus, id);
  return { t, d: new LobbyDirectory(t) };
};

beforeEach(() => {
  vi.useFakeTimers();
  bus = new Bus();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('lobby directory', () => {
  it('a visitor who arrives later sees an existing public room (query → answer)', () => {
    const host = make('host');
    host.d.setHosted({ code: 'ABC234', name: 'Alice', events: true });
    const visitor = make('visitor');
    visitor.d.setBrowsing(true);
    expect(visitor.d.list()).toHaveLength(0); // the host hasn't answered yet
    vi.advanceTimersByTime(DIRECTORY.answerGapMs + 1200);
    const list = visitor.d.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ code: 'ABC234', name: 'Alice', events: true });
  });

  it('periodic announcements reach visitors who are already browsing', () => {
    const visitor = make('visitor');
    visitor.d.setBrowsing(true);
    const host = make('host');
    host.d.setHosted({ code: 'ABC234', name: 'Alice', events: false });
    expect(visitor.d.list().map((l) => l.code)).toEqual(['ABC234']);
  });

  it('closing (room filled / left / made private) removes the listing at once', () => {
    const visitor = make('visitor');
    visitor.d.setBrowsing(true);
    const host = make('host');
    host.d.setHosted({ code: 'ABC234', name: 'Alice', events: false });
    expect(visitor.d.list()).toHaveLength(1);
    host.d.setHosted(null);
    expect(visitor.d.list()).toHaveLength(0);
  });

  it('listings expire when the host goes silent (tab closed without goodbye)', () => {
    const visitor = make('visitor');
    visitor.d.setBrowsing(true);
    const host = make('host');
    host.d.setHosted({ code: 'ABC234', name: 'Alice', events: false });
    host.t.close(); // vanishes without sending "closed"
    vi.advanceTimersByTime(DIRECTORY.expireAfterMs + 2_500);
    expect(visitor.d.list()).toHaveLength(0);
  });

  it('a live host keeps its listing alive indefinitely', () => {
    const visitor = make('visitor');
    visitor.d.setBrowsing(true);
    const host = make('host');
    host.d.setHosted({ code: 'ABC234', name: 'Alice', events: false });
    vi.advanceTimersByTime(5 * 60_000);
    expect(visitor.d.list()).toHaveLength(1);
  });

  it('only the original announcer can update or close a listing', () => {
    const visitor = make('visitor');
    visitor.d.setBrowsing(true);
    const host = make('host');
    host.d.setHosted({ code: 'ABC234', name: 'Alice', events: false });
    const troll = make('troll');
    troll.t.connect();
    troll.t.publish({ v: 1, t: 'x', c: 'ABC234' });
    troll.t.publish({ v: 1, t: 'a', c: 'ABC234', n: 'Hijack', e: true, p: NET.protocolVersion, up: 0 });
    expect(visitor.d.list()).toEqual([expect.objectContaining({ code: 'ABC234', name: 'Alice' })]);
  });

  it('hides rooms from incompatible game versions', () => {
    const visitor = make('visitor');
    visitor.d.setBrowsing(true);
    const old = make('old');
    old.t.connect();
    old.t.publish({ v: 1, t: 'a', c: 'ABC234', n: 'Old', e: false, p: NET.protocolVersion - 1, up: 0 });
    expect(visitor.d.list()).toHaveLength(0);
  });

  it('caps the number of listings', () => {
    const visitor = make('visitor');
    visitor.d.setBrowsing(true);
    const spam = make('spam');
    spam.t.connect();
    const A = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
    for (let i = 0; i < 100; i++) {
      const code = 'AA' + A[i % 31] + A[Math.floor(i / 31)] + 'ZZ';
      spam.t.publish({ v: 1, t: 'a', c: code, n: 'x', e: false, p: NET.protocolVersion, up: 0 });
    }
    expect(visitor.d.list().length).toBe(DIRECTORY.maxListings);
  });

  it('sorts longest-waiting first and estimates age without trusting clocks', () => {
    const visitor = make('visitor');
    visitor.d.setBrowsing(true);
    const a = make('a');
    a.d.setHosted({ code: 'AAAAAA', name: 'New', events: false });
    const b = make('b');
    b.t.connect();
    b.t.publish({ v: 1, t: 'a', c: 'BBBBBB', n: 'Old', e: false, p: NET.protocolVersion, up: 120 });
    const list = visitor.d.list();
    expect(list.map((l) => l.name)).toEqual(['Old', 'New']);
    expect(Date.now() - list[0]!.openedAt).toBeGreaterThanOrEqual(119_000);
  });

  it('does not list your own room back to you', () => {
    const host = make('host');
    host.d.setHosted({ code: 'ABC234', name: 'Me', events: false });
    host.d.setBrowsing(true);
    // A relay echo of our own announcement (same code) is ignored.
    host.t.onMessage?.({ v: 1, t: 'a', c: 'ABC234', n: 'Me', e: false, p: NET.protocolVersion, up: 0 }, 'host');
    expect(host.d.list()).toHaveLength(0);
  });

  it('closes relay sockets when idle and reopens on demand', () => {
    const v = make('v');
    v.d.setBrowsing(true);
    expect(v.t.connected).toBe(true);
    v.d.setBrowsing(false);
    vi.advanceTimersByTime(DIRECTORY.idleCloseMs + 10);
    expect(v.t.connected).toBe(false);
    v.d.setBrowsing(true);
    expect(v.t.connected).toBe(true);
  });

  it('rate-limits answers to a flood of queries', () => {
    const host = make('host');
    host.d.setHosted({ code: 'ABC234', name: 'Alice', events: false });
    const flooder = make('flooder');
    flooder.t.connect();
    const before = host.t.sent.length;
    for (let i = 0; i < 50; i++) flooder.t.publish({ v: 1, t: 'q' });
    vi.advanceTimersByTime(DIRECTORY.answerGapMs + 1100);
    expect(host.t.sent.length - before).toBe(1);
  });
});

describe('directory message validation', () => {
  it('rejects malformed or hostile messages', () => {
    expect(parseDirectoryMsg(null)).toBeNull();
    expect(parseDirectoryMsg({ v: 2, t: 'q' })).toBeNull();
    expect(parseDirectoryMsg({ v: 1, t: 'a', c: 'abc234', n: 'x', e: false, p: 2, up: 0 })).toBeNull(); // not normalised
    expect(parseDirectoryMsg({ v: 1, t: 'a', c: 'ABC23O', n: 'x', e: false, p: 2, up: 0 })).toBeNull(); // bad alphabet
    expect(parseDirectoryMsg({ v: 1, t: 'a', c: 'ABC234', n: 'x', e: 'yes', p: 2, up: 0 })).toBeNull();
    expect(parseDirectoryMsg({ v: 1, t: 'a', c: 'ABC234', n: 'x', e: false, p: 2, up: -5 })).toBeNull();
  });

  it('sanitises display names', () => {
    const m = parseDirectoryMsg({ v: 1, t: 'a', c: 'ABC234', n: '<b>‮Evil</b>' + 'x'.repeat(40), e: false, p: 2, up: 0 });
    expect(m && m.t === 'a' && m.n.length).toBeLessThanOrEqual(16);
    expect(m && m.t === 'a' && m.n.includes('‮')).toBe(false);
  });
});

describe('relay selection', () => {
  it('is deterministic so hosts and visitors meet on the same relays', () => {
    const all = Array.from({ length: 29 }, (_, i) => `wss://r${i}.example`);
    const a = pickRelays(all, 'topic', 6);
    expect(a).toEqual(pickRelays(all, 'topic', 6));
    expect(new Set(a).size).toBe(6);
  });
});
