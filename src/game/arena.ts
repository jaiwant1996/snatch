import { EVENTS, PLAYER, TOKEN, WORLD } from '../config/gameConfig';

/** Static arena geometry shared by the simulation, prediction and renderer. */

export interface Circle {
  x: number;
  y: number;
  r: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const B = WORLD.bounds;
const CY = WORLD.height / 2;

/** Mirrored pillar layout. Center lane stays open so the token is always reachable. */
export const OBSTACLES: readonly Circle[] = [
  { x: 500, y: 128, r: 40 },
  { x: 500, y: 492, r: 40 },
  { x: 318, y: 222, r: 24 },
  { x: 318, y: 398, r: 24 },
  { x: 682, y: 222, r: 24 },
  { x: 682, y: 398, r: 24 },
];

/**
 * Scoring gates. Player 0 (cyan) scores in the LEFT gate (its home);
 * player 1 (orange) scores in the RIGHT gate.
 */
export const GATES: readonly [Rect, Rect] = [
  { x: B.left, y: CY - 62, w: 66, h: 124 },
  { x: B.right - 66, y: CY - 62, w: 66, h: 124 },
];

export const SPAWNS: readonly [{ x: number; y: number }, { x: number; y: number }] = [
  { x: 156, y: CY },
  { x: WORLD.width - 156, y: CY },
];

export const TOKEN_SPAWN = { x: WORLD.width / 2, y: CY } as const;

/** Boost pads used by the "boostPads" arena event (mirrored, away from the lanes). */
export const BOOST_PADS: readonly Circle[] = [
  { x: 214, y: 116, r: EVENTS.boostPad.radius },
  { x: 786, y: 116, r: EVENTS.boostPad.radius },
  { x: 214, y: 504, r: EVENTS.boostPad.radius },
  { x: 786, y: 504, r: EVENTS.boostPad.radius },
];

export function pointInRect(x: number, y: number, r: Rect): boolean {
  return x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
}

export interface Body {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

/**
 * Keeps a circular body inside the arena and outside every obstacle.
 * `bounce` = 0 slides along surfaces (players), > 0 reflects (token).
 * Returns true if any contact happened.
 */
export function collideWithWorld(b: Body, radius: number, bounce = 0): boolean {
  let hit = false;
  const minX = B.left + radius;
  const maxX = B.right - radius;
  const minY = B.top + radius;
  const maxY = B.bottom - radius;
  if (b.x < minX) {
    b.x = minX;
    if (b.vx < 0) b.vx = -b.vx * bounce;
    hit = true;
  } else if (b.x > maxX) {
    b.x = maxX;
    if (b.vx > 0) b.vx = -b.vx * bounce;
    hit = true;
  }
  if (b.y < minY) {
    b.y = minY;
    if (b.vy < 0) b.vy = -b.vy * bounce;
    hit = true;
  } else if (b.y > maxY) {
    b.y = maxY;
    if (b.vy > 0) b.vy = -b.vy * bounce;
    hit = true;
  }
  for (const o of OBSTACLES) {
    const dx = b.x - o.x;
    const dy = b.y - o.y;
    const min = o.r + radius;
    const d2 = dx * dx + dy * dy;
    if (d2 >= min * min) continue;
    const d = Math.sqrt(d2) || 0.0001;
    const nx = dx / d;
    const ny = dy / d;
    b.x = o.x + nx * min;
    b.y = o.y + ny * min;
    const vn = b.vx * nx + b.vy * ny;
    if (vn < 0) {
      b.vx -= (1 + bounce) * vn * nx;
      b.vy -= (1 + bounce) * vn * ny;
    }
    hit = true;
  }
  return hit;
}

/** Nudge a point out of obstacles/walls — used when the token is dropped. */
export function placeTokenSafely(p: { x: number; y: number }): void {
  const body = { x: p.x, y: p.y, vx: 0, vy: 0 };
  collideWithWorld(body, TOKEN.radius + 1);
  p.x = body.x;
  p.y = body.y;
}

export const PLAYER_RADIUS = PLAYER.radius;
