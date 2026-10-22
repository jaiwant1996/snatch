/**
 * Deterministic, renderer-free match simulation.
 *
 * Only the HOST runs `stepMatch`. The guest runs `stepPlayerMotion` /
 * `tryStartDash` for its own player as a *prediction* and always defers to the
 * host's snapshots. Nothing here touches the DOM, Phaser or the network, which
 * keeps the rules unit-testable.
 */
import { EVENTS, MATCH, PLAYER, TACKLE, TOKEN } from '../config/gameConfig';
import {
  BOOST_PADS,
  GATES,
  SPAWNS,
  TOKEN_SPAWN,
  collideWithWorld,
  placeTokenSafely,
  pointInRect,
} from './arena';

export type PlayerIndex = 0 | 1;
export type Slot = -1 | PlayerIndex;

export interface InputState {
  /** Analog direction, each axis in [-1, 1]; magnitude is clamped to 1. */
  x: number;
  y: number;
  /** Monotonic dash-press counter. A dash is requested when it increases. */
  dashCount: number;
}

export const NO_INPUT: Readonly<InputState> = Object.freeze({ x: 0, y: 0, dashCount: 0 });

export interface PlayerState {
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Facing (unit vector) — used when dashing with no direction held. */
  fx: number;
  fy: number;
  dashTime: number;
  dashCooldown: number;
  dashDirX: number;
  dashDirY: number;
  /** True once this dash has landed a hit (one hit per dash). */
  dashHit: boolean;
  dashBuffer: number;
  lastDashCount: number;
  stun: number;
  immunity: number;
  boost: number;
}

export interface TokenState {
  x: number;
  y: number;
  vx: number;
  vy: number;
  carrier: Slot;
  lockout: number;
  lastCarrier: Slot;
}

export type Phase = 'countdown' | 'playing' | 'goal' | 'kickoff' | 'ended';
export type ArenaEventKind = 'none' | 'boostPads' | 'overdrive';
export type EndReason = 'goals' | 'time' | 'suddenDeath';

export interface ArenaEventState {
  kind: ArenaEventKind;
  remaining: number;
  nextIn: number;
}

export interface MatchState {
  tick: number;
  phase: Phase;
  phaseTimer: number;
  timeLeft: number;
  /** Seconds of live play (excludes countdown / goal pauses). */
  elapsed: number;
  suddenDeath: boolean;
  scores: [number, number];
  players: [PlayerState, PlayerState];
  token: TokenState;
  winner: Slot;
  endReason: EndReason | null;
  eventsEnabled: boolean;
  event: ArenaEventState;
  rng: number;
  nextEventId: number;
  lastCountdownShown: number;
}

export type SimEventType =
  | 'countdown'
  | 'go'
  | 'pickup'
  | 'drop'
  | 'tackle'
  | 'bump'
  | 'clash'
  | 'dash'
  | 'goal'
  | 'suddenDeath'
  | 'end'
  | 'eventStart'
  | 'eventEnd'
  | 'boost'
  | 'reset';

export const SIM_EVENT_TYPES: readonly SimEventType[] = [
  'countdown', 'go', 'pickup', 'drop', 'tackle', 'bump', 'clash', 'dash',
  'goal', 'suddenDeath', 'end', 'eventStart', 'eventEnd', 'boost', 'reset',
];

export interface SimEvent {
  id: number;
  type: SimEventType;
  player: Slot;
  x: number;
  y: number;
  /** Type-specific number (countdown digit, event kind index, …). */
  value: number;
}

export const ARENA_EVENT_KINDS: readonly ArenaEventKind[] = ['none', 'boostPads', 'overdrive'];

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

function makePlayer(i: PlayerIndex): PlayerState {
  const s = SPAWNS[i];
  return {
    x: s.x,
    y: s.y,
    vx: 0,
    vy: 0,
    fx: i === 0 ? 1 : -1,
    fy: 0,
    dashTime: 0,
    dashCooldown: 0,
    dashDirX: 0,
    dashDirY: 0,
    dashHit: false,
    dashBuffer: 0,
    lastDashCount: 0,
    stun: 0,
    immunity: 0,
    boost: 0,
  };
}

export function hashSeed(text: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h || 1;
}

export interface MatchOptions {
  eventsEnabled: boolean;
  seed: number;
  /** Skip the 3-2-1 countdown (used by tests). */
  skipCountdown?: boolean;
}

export function createMatch(opts: MatchOptions): MatchState {
  return {
    tick: 0,
    phase: opts.skipCountdown ? 'playing' : 'countdown',
    phaseTimer: opts.skipCountdown ? 0 : MATCH.countdownSeconds,
    timeLeft: MATCH.durationSeconds,
    elapsed: 0,
    suddenDeath: false,
    scores: [0, 0],
    players: [makePlayer(0), makePlayer(1)],
    token: {
      x: TOKEN_SPAWN.x,
      y: TOKEN_SPAWN.y,
      vx: 0,
      vy: 0,
      carrier: -1,
      lockout: 0,
      lastCarrier: -1,
    },
    winner: -1,
    endReason: null,
    eventsEnabled: opts.eventsEnabled,
    event: { kind: 'none', remaining: 0, nextIn: EVENTS.firstAfter },
    rng: opts.seed >>> 0 || 1,
    nextEventId: 1,
    lastCountdownShown: 0,
  };
}

// ---------------------------------------------------------------------------
// Input helpers
// ---------------------------------------------------------------------------

/** Clamp an untrusted input to a valid analog vector. */
export function sanitizeInput(raw: InputState): InputState {
  let x = Number.isFinite(raw.x) ? Math.max(-1, Math.min(1, raw.x)) : 0;
  let y = Number.isFinite(raw.y) ? Math.max(-1, Math.min(1, raw.y)) : 0;
  const m = Math.hypot(x, y);
  if (m > 1) {
    x /= m;
    y /= m;
  }
  if (m < 0.08) {
    x = 0;
    y = 0;
  }
  const dashCount =
    Number.isFinite(raw.dashCount) && raw.dashCount >= 0 ? Math.floor(raw.dashCount) : 0;
  return { x, y, dashCount };
}

// ---------------------------------------------------------------------------
// Player motion (shared with guest prediction)
// ---------------------------------------------------------------------------

export interface MotionModifiers {
  carrying: boolean;
  overdrive: boolean;
}

export function maxSpeedFor(p: PlayerState, carrying: boolean): number {
  let s = PLAYER.maxSpeed;
  if (carrying) s *= PLAYER.carrySpeedFactor;
  if (p.boost > 0) s *= EVENTS.boostPad.speedFactor;
  return s;
}

/**
 * Registers a dash request from the input counter and starts the dash if able.
 * Returns true when a dash actually started this call.
 */
export function tryStartDash(
  p: PlayerState,
  input: InputState,
  dt: number,
  mods: MotionModifiers,
  live: boolean,
): boolean {
  if (input.dashCount > p.lastDashCount) {
    p.lastDashCount = input.dashCount;
    if (live) p.dashBuffer = 0.12;
  }
  if (!live) {
    p.dashBuffer = 0;
    return false;
  }
  if (p.dashBuffer <= 0) return false;
  p.dashBuffer = Math.max(0, p.dashBuffer - dt);
  if (p.dashCooldown > 0 || p.dashTime > 0 || p.stun > 0) return false;

  let dx = input.x;
  let dy = input.y;
  const m = Math.hypot(dx, dy);
  if (m < 0.2) {
    dx = p.fx;
    dy = p.fy;
  } else {
    dx /= m;
    dy /= m;
  }
  p.dashBuffer = 0;
  p.dashTime = PLAYER.dashDuration;
  p.dashDirX = dx;
  p.dashDirY = dy;
  p.dashHit = false;
  p.dashCooldown =
    PLAYER.dashCooldown * (mods.overdrive ? EVENTS.overdrive.cooldownFactor : 1);
  const speed = dashSpeedFor(mods.carrying);
  p.vx = dx * speed;
  p.vy = dy * speed;
  return true;
}

export function dashSpeedFor(carrying: boolean): number {
  return (
    PLAYER.maxSpeed * PLAYER.dashSpeedFactor * (carrying ? PLAYER.carrierDashFactor : 1)
  );
}

function approach(current: number, target: number, maxDelta: number): number {
  if (current < target) return Math.min(target, current + maxDelta);
  return Math.max(target, current - maxDelta);
}

/** Integrates one fixed step of movement for a single player, including world collision. */
export function stepPlayerMotion(
  p: PlayerState,
  input: InputState,
  dt: number,
  mods: MotionModifiers,
): void {
  p.dashCooldown = Math.max(0, p.dashCooldown - dt);
  p.immunity = Math.max(0, p.immunity - dt);
  p.boost = Math.max(0, p.boost - dt);

  if (p.dashTime > 0) {
    p.dashTime = Math.max(0, p.dashTime - dt);
    if (!p.dashHit) {
      const speed = dashSpeedFor(mods.carrying);
      p.vx = p.dashDirX * speed;
      p.vy = p.dashDirY * speed;
    }
  } else if (p.stun > 0) {
    p.stun = Math.max(0, p.stun - dt);
    // Stunned players slide with reduced friction — the knockback reads clearly.
    const f = PLAYER.friction * 0.45 * dt;
    const sp = Math.hypot(p.vx, p.vy);
    if (sp > 0) {
      const ns = Math.max(0, sp - f);
      p.vx *= ns / sp;
      p.vy *= ns / sp;
    }
  } else {
    const max = maxSpeedFor(p, mods.carrying);
    const tx = input.x * max;
    const ty = input.y * max;
    const steering = input.x !== 0 || input.y !== 0;
    const rate = (steering ? PLAYER.acceleration : PLAYER.friction) * dt;
    // Approach along the vector (not per-axis) so diagonals feel identical.
    const dvx = tx - p.vx;
    const dvy = ty - p.vy;
    const dl = Math.hypot(dvx, dvy);
    if (dl <= rate) {
      p.vx = tx;
      p.vy = ty;
    } else {
      p.vx += (dvx / dl) * rate;
      p.vy += (dvy / dl) * rate;
    }
    // Post-dash overspeed bleeds off quickly but smoothly.
    const sp = Math.hypot(p.vx, p.vy);
    if (sp > max * 1.02) {
      const ns = approach(sp, max, PLAYER.friction * 1.6 * dt);
      p.vx *= ns / sp;
      p.vy *= ns / sp;
    }
    if (steering) {
      const m = Math.hypot(input.x, input.y);
      p.fx = input.x / m;
      p.fy = input.y / m;
    }
  }

  p.x += p.vx * dt;
  p.y += p.vy * dt;
  collideWithWorld(p, PLAYER.radius, 0);
}

// ---------------------------------------------------------------------------
// Full match step (host only)
// ---------------------------------------------------------------------------

function nextRandom(s: MatchState): number {
  // mulberry32
  let t = (s.rng = (s.rng + 0x6d2b79f5) >>> 0);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

function emit(
  s: MatchState,
  out: SimEvent[],
  type: SimEventType,
  player: Slot = -1,
  x = 0,
  y = 0,
  value = 0,
): void {
  out.push({ id: s.nextEventId++, type, player, x, y, value });
}

export function resetPositions(s: MatchState): void {
  for (const i of [0, 1] as const) {
    const keepCount = s.players[i].lastDashCount;
    s.players[i] = makePlayer(i);
    s.players[i].lastDashCount = keepCount;
  }
  const t = s.token;
  t.x = TOKEN_SPAWN.x;
  t.y = TOKEN_SPAWN.y;
  t.vx = 0;
  t.vy = 0;
  t.carrier = -1;
  t.lastCarrier = -1;
  t.lockout = 0;
}

function dropToken(s: MatchState, out: SimEvent[], x: number, y: number, dirX: number, dirY: number): void {
  const t = s.token;
  const from = t.carrier;
  t.lastCarrier = from;
  t.carrier = -1;
  t.x = x + dirX * 8;
  t.y = y + dirY * 8;
  placeTokenSafely(t);
  t.vx = dirX * TOKEN.dropSpeed;
  t.vy = dirY * TOKEN.dropSpeed;
  t.lockout = TOKEN.pickupLockout;
  emit(s, out, 'drop', from, t.x, t.y);
}

function resolveTackles(s: MatchState, out: SimEvent[]): void {
  const [a, b] = s.players;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dist = Math.hypot(dx, dy) || 0.0001;
  const reach = PLAYER.radius * 2 + PLAYER.tackleReach;
  if (dist > reach) return;

  const aHits = a.dashTime > 0 && !a.dashHit && b.immunity <= 0;
  const bHits = b.dashTime > 0 && !b.dashHit && a.immunity <= 0;
  if (!aHits && !bHits) return;

  const mx = (a.x + b.x) / 2;
  const my = (a.y + b.y) / 2;
  const nx = dx / dist;
  const ny = dy / dist;

  if (aHits && bHits) {
    // Head-on clash: both bounce, neither is robbed cleanly — the token pops loose.
    for (const [p, sx] of [
      [a, -1],
      [b, 1],
    ] as const) {
      p.dashTime = 0;
      p.dashHit = true;
      p.vx = nx * sx * TACKLE.clashKnockback;
      p.vy = ny * sx * TACKLE.clashKnockback;
      p.stun = TACKLE.bumpStun;
      p.immunity = TACKLE.immunity * 0.6;
    }
    if (s.token.carrier !== -1) {
      // Pop it sideways so neither player instantly re-grabs it.
      const side = (s.tick & 1) === 0 ? 1 : -1;
      dropToken(s, out, mx, my, -ny * side, nx * side);
    }
    emit(s, out, 'clash', -1, mx, my);
    return;
  }

  const attackerIdx: PlayerIndex = aHits ? 0 : 1;
  const victimIdx: PlayerIndex = aHits ? 1 : 0;
  const atk = s.players[attackerIdx];
  const vic = s.players[victimIdx];
  const dirX = atk.dashDirX;
  const dirY = atk.dashDirY;

  atk.dashHit = true;
  atk.dashTime = 0;
  const atkSpeed = dashSpeedFor(s.token.carrier === attackerIdx) * TACKLE.attackerRecoil;
  atk.vx = dirX * atkSpeed;
  atk.vy = dirY * atkSpeed;

  const robbed = s.token.carrier === victimIdx;
  const kb = robbed ? TACKLE.carrierKnockback : TACKLE.bumpKnockback;
  vic.dashTime = 0;
  vic.vx = dirX * kb;
  vic.vy = dirY * kb;
  vic.stun = robbed ? TACKLE.carrierStun : TACKLE.bumpStun;
  vic.immunity = TACKLE.immunity;
  vic.dashBuffer = 0;

  if (robbed) {
    dropToken(s, out, mx, my, dirX, dirY);
    emit(s, out, 'tackle', attackerIdx, mx, my);
  } else {
    emit(s, out, 'bump', attackerIdx, mx, my);
  }
}

function separatePlayers(s: MatchState): void {
  const [a, b] = s.players;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const min = PLAYER.radius * 2;
  const d2 = dx * dx + dy * dy;
  if (d2 >= min * min) return;
  const d = Math.sqrt(d2) || 0.0001;
  const nx = d2 === 0 ? 1 : dx / d;
  const ny = d2 === 0 ? 0 : dy / d;
  const push = (min - d) / 2;
  a.x -= nx * push;
  a.y -= ny * push;
  b.x += nx * push;
  b.y += ny * push;
  // Remove closing velocity.
  const rel = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
  if (rel < 0) {
    a.vx += (rel / 2) * nx;
    a.vy += (rel / 2) * ny;
    b.vx -= (rel / 2) * nx;
    b.vy -= (rel / 2) * ny;
  }
  collideWithWorld(a, PLAYER.radius, 0);
  collideWithWorld(b, PLAYER.radius, 0);
}

function stepToken(s: MatchState, dt: number): void {
  const t = s.token;
  t.lockout = Math.max(0, t.lockout - dt);
  if (t.carrier !== -1) {
    const c = s.players[t.carrier];
    t.x = c.x;
    t.y = c.y;
    t.vx = 0;
    t.vy = 0;
    return;
  }
  const sp = Math.hypot(t.vx, t.vy);
  if (sp > 0) {
    const ns = Math.max(0, sp - TOKEN.friction * dt);
    t.vx *= ns / sp;
    t.vy *= ns / sp;
  }
  t.x += t.vx * dt;
  t.y += t.vy * dt;
  collideWithWorld(t, TOKEN.radius, TOKEN.bounce);
}

function tryPickup(s: MatchState, out: SimEvent[]): void {
  const t = s.token;
  if (t.carrier !== -1 || t.lockout > 0) return;
  const reach = PLAYER.radius + TOKEN.radius;
  let best: Slot = -1;
  let bestD = Infinity;
  for (const i of [0, 1] as const) {
    const p = s.players[i];
    if (p.stun > 0) continue;
    const d = Math.hypot(p.x - t.x, p.y - t.y);
    if (d > reach) continue;
    // Exact ties go to the player who did NOT just lose it.
    if (d < bestD || (d === bestD && t.lastCarrier === best)) {
      best = i;
      bestD = d;
    }
  }
  if (best === -1) return;
  t.carrier = best;
  t.lastCarrier = best;
  t.vx = 0;
  t.vy = 0;
  emit(s, out, 'pickup', best, t.x, t.y);
}

function checkGoal(s: MatchState, out: SimEvent[]): void {
  const c = s.token.carrier;
  if (c === -1) return;
  const p = s.players[c];
  // A player scores only in their OWN home gate.
  if (!pointInRect(p.x, p.y, GATES[c])) return;
  s.scores[c] += 1;
  emit(s, out, 'goal', c, p.x, p.y, s.scores[c]);
  s.token.carrier = -1;
  if (s.scores[c] >= MATCH.goalsToWin || s.suddenDeath) {
    endMatch(s, out, c, s.suddenDeath ? 'suddenDeath' : 'goals');
  } else {
    s.phase = 'goal';
    s.phaseTimer = MATCH.goalPauseSeconds;
  }
}

function endMatch(s: MatchState, out: SimEvent[], winner: Slot, reason: EndReason): void {
  s.phase = 'ended';
  s.phaseTimer = MATCH.endPauseSeconds;
  s.winner = winner;
  s.endReason = reason;
  s.event.kind = 'none';
  s.event.remaining = 0;
  emit(s, out, 'end', winner, 0, 0, ['goals', 'time', 'suddenDeath'].indexOf(reason));
}

function stepArenaEvent(s: MatchState, out: SimEvent[], dt: number): void {
  if (!s.eventsEnabled) return;
  const e = s.event;
  if (e.kind === 'none') {
    e.nextIn -= dt;
    if (e.nextIn <= 0) {
      const kinds: ArenaEventKind[] = ['boostPads', 'overdrive'];
      e.kind = kinds[Math.floor(nextRandom(s) * kinds.length)] ?? 'boostPads';
      e.remaining = EVENTS.duration;
      emit(s, out, 'eventStart', -1, 0, 0, ARENA_EVENT_KINDS.indexOf(e.kind));
    }
    return;
  }
  e.remaining -= dt;
  if (e.remaining <= 0) {
    const ended = e.kind;
    e.kind = 'none';
    e.remaining = 0;
    e.nextIn = EVENTS.interval;
    emit(s, out, 'eventEnd', -1, 0, 0, ARENA_EVENT_KINDS.indexOf(ended));
  }
}

function applyBoostPads(s: MatchState, out: SimEvent[]): void {
  if (s.event.kind !== 'boostPads') return;
  for (const i of [0, 1] as const) {
    const p = s.players[i];
    for (const pad of BOOST_PADS) {
      if (Math.hypot(p.x - pad.x, p.y - pad.y) <= pad.r) {
        if (p.boost <= 0.05) emit(s, out, 'boost', i, pad.x, pad.y);
        p.boost = EVENTS.boostPad.boostDuration;
      }
    }
  }
}

/**
 * Advances the authoritative match by one fixed step. Mutates `s` and returns
 * the events that happened during this step (for effects and sound).
 */
export function stepMatch(
  s: MatchState,
  inputs: readonly [InputState, InputState],
  dt: number,
): SimEvent[] {
  const out: SimEvent[] = [];
  s.tick++;
  const live = s.phase === 'playing';
  const clean = [sanitizeInput(inputs[0]), sanitizeInput(inputs[1])] as const;

  switch (s.phase) {
    case 'countdown': {
      s.phaseTimer -= dt;
      const shown = Math.ceil(s.phaseTimer);
      if (shown !== s.lastCountdownShown && shown > 0) {
        s.lastCountdownShown = shown;
        emit(s, out, 'countdown', -1, 0, 0, shown);
      }
      if (s.phaseTimer <= 0) {
        s.phase = 'playing';
        s.phaseTimer = 0;
        emit(s, out, 'go');
      }
      break;
    }
    case 'goal': {
      s.phaseTimer -= dt;
      if (s.phaseTimer <= 0) {
        resetPositions(s);
        s.phase = 'kickoff';
        s.phaseTimer = 0.6;
        emit(s, out, 'reset');
      }
      break;
    }
    case 'kickoff': {
      s.phaseTimer -= dt;
      if (s.phaseTimer <= 0) {
        s.phase = 'playing';
        s.phaseTimer = 0;
        emit(s, out, 'go');
      }
      break;
    }
    case 'ended':
      s.phaseTimer = Math.max(0, s.phaseTimer - dt);
      break;
    case 'playing':
      break;
  }

  // Consume dash presses even while frozen so a pre-GO press doesn't fire late.
  for (const i of [0, 1] as const) {
    const p = s.players[i];
    const mods: MotionModifiers = {
      carrying: s.token.carrier === i,
      overdrive: s.event.kind === 'overdrive',
    };
    if (tryStartDash(p, clean[i], dt, mods, live)) emit(s, out, 'dash', i, p.x, p.y);
  }

  if (!live) return out;

  for (const i of [0, 1] as const) {
    stepPlayerMotion(s.players[i], clean[i], dt, {
      carrying: s.token.carrier === i,
      overdrive: s.event.kind === 'overdrive',
    });
  }

  resolveTackles(s, out);
  separatePlayers(s);
  applyBoostPads(s, out);
  stepToken(s, dt);
  tryPickup(s, out);
  stepToken(s, 0); // snap a fresh pickup onto its carrier
  checkGoal(s, out);
  if (s.phase !== 'playing') return out;

  s.elapsed += dt;
  stepArenaEvent(s, out, dt);

  if (!s.suddenDeath) {
    s.timeLeft = Math.max(0, s.timeLeft - dt);
    if (s.timeLeft <= 0) {
      if (s.scores[0] !== s.scores[1]) {
        endMatch(s, out, s.scores[0] > s.scores[1] ? 0 : 1, 'time');
      } else {
        s.suddenDeath = true;
        emit(s, out, 'suddenDeath');
      }
    }
  }
  return out;
}
