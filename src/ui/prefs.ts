/**
 * Local-only persistence (this browser, this device). Nothing here is ever
 * shared with the opponent or uploaded anywhere — these are NOT leaderboards.
 */
export interface Prefs {
  name: string;
  muted: boolean;
  reducedMotion: boolean | null; // null = follow the OS setting
  arenaEvents: boolean;
  /** Create rooms as public (listed on the home page). */
  publicRooms: boolean;
}

export interface LocalStats {
  played: number;
  wins: number;
  losses: number;
  goals: number;
  /** Last recorded match id, so a result is never counted twice. */
  lastMatchId: string;
}

const PREFS_KEY = 'snatch.prefs.v1';
const STATS_KEY = 'snatch.stats.v1';

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return { ...fallback, ...(JSON.parse(raw) as Partial<T>) };
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage may be disabled (private mode) — the game still works */
  }
}

export const prefs: Prefs = read<Prefs>(PREFS_KEY, {
  name: '',
  muted: false,
  reducedMotion: null,
  arenaEvents: true,
  publicRooms: true,
});

export function savePrefs(): void {
  write(PREFS_KEY, prefs);
}

export const stats: LocalStats = read<LocalStats>(STATS_KEY, {
  played: 0,
  wins: 0,
  losses: 0,
  goals: 0,
  lastMatchId: '',
});

export function recordResult(matchId: string, won: boolean | null, goals: number): void {
  if (stats.lastMatchId === matchId) return;
  stats.lastMatchId = matchId;
  stats.played++;
  if (won === true) stats.wins++;
  if (won === false) stats.losses++;
  stats.goals += goals;
  write(STATS_KEY, stats);
}

const motionQuery = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;

export function reducedMotion(): boolean {
  if (prefs.reducedMotion !== null) return prefs.reducedMotion;
  return motionQuery?.matches ?? false;
}
