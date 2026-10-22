import { ROOM_CODE } from '../config/gameConfig';

const ALPHABET = ROOM_CODE.alphabet;

/**
 * Generates a six-character room code from an unambiguous alphabet
 * (no O/0, I/1/L). Uses crypto.getRandomValues with rejection sampling so
 * every character is uniformly likely; falls back to Math.random only where
 * Web Crypto is missing.
 */
export function generateRoomCode(
  randomBytes: (n: number) => Uint8Array = defaultRandomBytes,
): string {
  const limit = 256 - (256 % ALPHABET.length); // reject to avoid modulo bias
  let code = '';
  while (code.length < ROOM_CODE.length) {
    const bytes = randomBytes(16);
    for (const b of bytes) {
      if (b >= limit) continue;
      code += ALPHABET[b % ALPHABET.length];
      if (code.length === ROOM_CODE.length) break;
    }
  }
  return code;
}

function defaultRandomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  const c = globalThis.crypto;
  if (c && typeof c.getRandomValues === 'function') {
    c.getRandomValues(out);
  } else {
    for (let i = 0; i < n; i++) out[i] = Math.floor(Math.random() * 256);
  }
  return out;
}

/**
 * Normalises user-typed codes: trims, upper-cases, strips spaces/dashes, and
 * maps commonly confused characters onto the alphabet (O→0 is not in the
 * alphabet, so O is left to fail validation rather than silently changed).
 */
export function normalizeRoomCode(input: string): string {
  return input
    .toUpperCase()
    .replace(/[\s\-_.]/g, '')
    .slice(0, 16);
}

export function isValidRoomCode(code: string): boolean {
  if (code.length !== ROOM_CODE.length) return false;
  for (const ch of code) if (!ALPHABET.includes(ch)) return false;
  return true;
}

/** Describes why a code is invalid, for the join form. */
export function roomCodeProblem(code: string): string | null {
  if (code.length === 0) return 'Enter the six-character room code.';
  if (code.length !== ROOM_CODE.length) return `Room codes are ${ROOM_CODE.length} characters.`;
  const bad = [...code].find((ch) => !ALPHABET.includes(ch));
  if (bad) {
    if (bad === 'O' || bad === '0') return 'Room codes never contain O or 0 — check the code.';
    if (bad === 'I' || bad === '1' || bad === 'L') return 'Room codes never contain I, L or 1 — check the code.';
    return `“${bad}” can't appear in a room code.`;
  }
  return null;
}

/** Builds an invite link that works under any GitHub Pages sub-path. */
export function buildInviteUrl(code: string, loc: Pick<Location, 'origin' | 'pathname'> = location): string {
  const url = new URL(loc.pathname, loc.origin);
  url.searchParams.set('room', code);
  return url.toString();
}

/** Reads ?room=CODE from a query string; returns null if absent or invalid. */
export function readRoomFromQuery(search: string): string | null {
  const raw = new URLSearchParams(search).get('room');
  if (!raw) return null;
  const code = normalizeRoomCode(raw);
  return isValidRoomCode(code) ? code : null;
}
