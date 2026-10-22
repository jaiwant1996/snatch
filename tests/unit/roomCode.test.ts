import { describe, expect, it } from 'vitest';
import { ROOM_CODE } from '../../src/config/gameConfig';
import {
  buildInviteUrl,
  generateRoomCode,
  isValidRoomCode,
  normalizeRoomCode,
  readRoomFromQuery,
  roomCodeProblem,
} from '../../src/lobby/roomCode';

describe('room codes', () => {
  it('generates six characters from the unambiguous alphabet', () => {
    for (let i = 0; i < 500; i++) {
      const code = generateRoomCode();
      expect(code).toHaveLength(6);
      expect(isValidRoomCode(code)).toBe(true);
      expect(code).not.toMatch(/[O0I1L]/);
    }
  });

  it('rejects biased bytes (rejection sampling)', () => {
    // Bytes ≥ 248 (= 256 - 256 % 31) must be skipped, not wrapped.
    let call = 0;
    const code = generateRoomCode(() => {
      call++;
      return call === 1 ? new Uint8Array([255, 250, 248, 0, 1, 2, 3, 4, 5, 255, 255, 255, 255, 255, 255, 255]) : new Uint8Array(16);
    });
    expect(code).toBe(ROOM_CODE.alphabet.slice(0, 6));
  });

  it('is reasonably unique', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 2000; i++) seen.add(generateRoomCode());
    expect(seen.size).toBeGreaterThan(1990);
  });

  it('normalises user input', () => {
    expect(normalizeRoomCode(' abc-234 ')).toBe('ABC234');
    expect(normalizeRoomCode('ab c2 34')).toBe('ABC234');
  });

  it('validates and explains problems', () => {
    expect(roomCodeProblem('')).toMatch(/Enter/);
    expect(roomCodeProblem('ABC')).toMatch(/6 characters/);
    expect(roomCodeProblem('ABCDE0')).toMatch(/O or 0/);
    expect(roomCodeProblem('ABCDE1')).toMatch(/I, L or 1/);
    expect(roomCodeProblem('ABC234')).toBeNull();
    expect(isValidRoomCode('abc234')).toBe(false); // must be normalised first
  });

  it('builds invite links that keep the GitHub Pages sub-path', () => {
    const url = buildInviteUrl('ABC234', { origin: 'https://me.github.io', pathname: '/snatch/' });
    expect(url).toBe('https://me.github.io/snatch/?room=ABC234');
    const url2 = buildInviteUrl('ABC234', { origin: 'https://me.github.io', pathname: '/snatch/index.html' });
    expect(url2).toBe('https://me.github.io/snatch/index.html?room=ABC234');
  });

  it('reads ?room= from the query string', () => {
    expect(readRoomFromQuery('?room=abc234')).toBe('ABC234');
    expect(readRoomFromQuery('?room=nope')).toBeNull();
    expect(readRoomFromQuery('')).toBeNull();
  });
});
