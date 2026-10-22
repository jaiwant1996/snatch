import { describe, expect, it } from 'vitest';
import { NET } from '../../src/config/gameConfig';
import { createMatch, stepMatch } from '../../src/game/simulation';
import {
  decodePlayer,
  encodeSnapshot,
  evaluateHello,
  newMatchId,
  parseControl,
  parseHello,
  parseInput,
  parseSnapshot,
  sanitizeName,
} from '../../src/network/messages';
import { SnapshotBuffer } from '../../src/game/view';

const hello = (over: Record<string, unknown> = {}) =>
  parseHello({ t: 'hello', app: 'snatch', proto: NET.protocolVersion, role: 'guest', name: 'Bo', room: 'ABC234', ...over });

describe('handshake', () => {
  it('accepts a guest into an empty host room', () => {
    expect(evaluateHello(hello(), { myRole: 'host', room: 'ABC234', hasOpponent: false })).toBeNull();
  });
  it('rejects a second guest (room full)', () => {
    expect(evaluateHello(hello(), { myRole: 'host', room: 'ABC234', hasOpponent: true })).toBe('full');
  });
  it('never pairs two guests or two hosts', () => {
    expect(evaluateHello(hello(), { myRole: 'guest', room: 'ABC234', hasOpponent: false })).toBe('role');
    expect(evaluateHello(hello({ role: 'host' }), { myRole: 'host', room: 'ABC234', hasOpponent: false })).toBe('role');
  });
  it('rejects protocol mismatches and malformed hellos', () => {
    expect(evaluateHello(hello({ proto: 999 }), { myRole: 'host', room: 'ABC234', hasOpponent: false })).toBe('version');
    expect(evaluateHello(parseHello({ t: 'hello' }), { myRole: 'host', room: 'ABC234', hasOpponent: false })).toBe('version');
    expect(evaluateHello(hello({ room: 'ZZZ999' }), { myRole: 'host', room: 'ABC234', hasOpponent: false })).toBe('room');
  });
});

describe('message validation', () => {
  it('sanitises nicknames', () => {
    expect(sanitizeName('  hi\u0000‮ there  ', 'x')).toBe('hi there');
    expect(sanitizeName('a'.repeat(40), 'x')).toHaveLength(16);
    expect(sanitizeName(42, 'fallback')).toBe('fallback');
  });

  it('rejects malformed control messages', () => {
    expect(parseControl(null)).toBeNull();
    expect(parseControl({ t: 'start', matchId: '../evil', events: true })).toBeNull();
    expect(parseControl({ t: 'end', matchId: 'abcdef12', winner: 3, scores: [1, 2], duration: 5, reason: 'goals' })).toBeNull();
    expect(parseControl({ t: 'nope' })).toBeNull();
    expect(parseControl({ t: 'lobby', name: 'Bo', ready: true, events: false })).toEqual({ t: 'lobby', name: 'Bo', ready: true, events: false });
  });

  it('clamps guest input and rejects garbage', () => {
    expect(parseInput({ m: 'abcdef12', s: 1, x: 9, y: -9, d: 3 })).toEqual({ m: 'abcdef12', s: 1, x: 1, y: -1, d: 3 });
    expect(parseInput({ m: 'abcdef12', s: 1, x: 'left', y: 0, d: 0 })).toBeNull();
    expect(parseInput({ m: 'abcdef12', s: -1, x: 0, y: 0, d: 0 })).toBeNull();
    // A guest can never send a position or score — only direction + dash counter exist.
    expect(Object.keys(parseInput({ m: 'abcdef12', s: 1, x: 0, y: 0, d: 0, px: 999, score: 3 })!)).toEqual(['m', 's', 'x', 'y', 'd']);
  });

  it('round-trips snapshots and rejects tampered ones', () => {
    const s = createMatch({ eventsEnabled: true, seed: 7, skipCountdown: true });
    const events = stepMatch(s, [{ x: 1, y: 0, dashCount: 1 }, { x: 0, y: 0, dashCount: 0 }], 1 / 60);
    const id = newMatchId();
    const snap = encodeSnapshot(s, { matchId: id, seq: 0, hostTime: 16, ack: -1, paused: 0, events });
    const wire = JSON.parse(JSON.stringify(snap));
    expect(parseSnapshot(wire)).not.toBeNull();
    const p = decodePlayer(wire.p[0]);
    expect(p.x).toBeCloseTo(s.players[0].x, 0);
    expect(parseSnapshot({ ...wire, p: [[1, 2, 3]] })).toBeNull();
    expect(parseSnapshot({ ...wire, k: [0, 0, 0, 0, 7, 0] })).toBeNull();
    expect(parseSnapshot({ ...wire, ph: 99 })).toBeNull();
  });
});

describe('snapshot buffer', () => {
  it('discards stale, duplicate and foreign-match snapshots and dedupes events', () => {
    const s = createMatch({ eventsEnabled: false, seed: 7, skipCountdown: true });
    const id = newMatchId();
    const ev = [{ id: 5, type: 'pickup' as const, player: 0 as const, x: 1, y: 2, value: 0 }];
    const mk = (seq: number, events = ev, matchId = id) =>
      parseSnapshot(JSON.parse(JSON.stringify(encodeSnapshot(s, { matchId, seq, hostTime: seq * 50, ack: 0, paused: 0, events }))))!;
    const buf = new SnapshotBuffer(id);
    expect(buf.push(mk(1), 1000, 1)).toHaveLength(1);
    expect(buf.push(mk(1), 1001, 1)).toBeNull(); // duplicate
    expect(buf.push(mk(0), 1002, 1)).toBeNull(); // out of order
    expect(buf.push(mk(2), 1050, 1)).toHaveLength(0); // same event id again → deduped
    expect(buf.push(mk(3, ev, newMatchId()), 1100, 1)).toBeNull(); // previous/other match
  });
});
