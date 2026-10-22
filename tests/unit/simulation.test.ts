import { describe, expect, it } from 'vitest';
import { MATCH, PLAYER, TOKEN } from '../../src/config/gameConfig';
import { GATES, OBSTACLES, SPAWNS, TOKEN_SPAWN } from '../../src/game/arena';
import {
  createMatch,
  sanitizeInput,
  stepMatch,
  type InputState,
  type MatchState,
  type SimEvent,
} from '../../src/game/simulation';

const DT = 1 / 60;
const idle: InputState = { x: 0, y: 0, dashCount: 0 };

function fresh(opts: Partial<{ events: boolean }> = {}): MatchState {
  return createMatch({ eventsEnabled: opts.events ?? false, seed: 42, skipCountdown: true });
}

function run(s: MatchState, steps: number, a: InputState = idle, b: InputState = idle): SimEvent[] {
  const all: SimEvent[] = [];
  for (let i = 0; i < steps; i++) all.push(...stepMatch(s, [a, b], DT));
  return all;
}

/** Puts player `i` at the gate centre carrying the token. */
function carryInto(s: MatchState, i: 0 | 1, gate = GATES[i]) {
  s.token.carrier = i;
  s.players[i].x = gate.x + gate.w / 2;
  s.players[i].y = gate.y + gate.h / 2;
}

describe('countdown', () => {
  it('counts 3-2-1 then GO, and nobody moves before GO', () => {
    const s = createMatch({ eventsEnabled: false, seed: 1 });
    const ev = run(s, Math.ceil(MATCH.countdownSeconds * 60) - 2, { x: 1, y: 0, dashCount: 0 });
    expect(ev.filter((e) => e.type === 'countdown').map((e) => e.value)).toEqual([3, 2, 1]);
    expect(s.players[0].x).toBe(SPAWNS[0].x);
    expect(s.phase).toBe('countdown');
    const more = run(s, 4);
    expect(more.some((e) => e.type === 'go')).toBe(true);
    expect(s.phase).toBe('playing');
  });

  it('a dash pressed during the countdown does not fire after GO', () => {
    const s = createMatch({ eventsEnabled: false, seed: 1 });
    run(s, 30, { x: 1, y: 0, dashCount: 1 });
    run(s, 200, { x: 0, y: 0, dashCount: 1 });
    expect(s.players[0].dashCooldown).toBe(0);
  });
});

describe('movement', () => {
  it('accelerates to (but not beyond) max speed', () => {
    const s = fresh();
    run(s, 60, { x: 0, y: -1, dashCount: 0 });
    const v = Math.hypot(s.players[0].vx, s.players[0].vy);
    expect(v).toBeGreaterThan(PLAYER.maxSpeed * 0.98);
    expect(v).toBeLessThanOrEqual(PLAYER.maxSpeed + 1e-6);
  });

  it('diagonal input is normalised', () => {
    const s = fresh();
    run(s, 60, { x: 1, y: 1, dashCount: 0 });
    expect(Math.hypot(s.players[0].vx, s.players[0].vy)).toBeLessThanOrEqual(PLAYER.maxSpeed + 1e-6);
  });

  it('stops quickly with no input (not slippery)', () => {
    const s = fresh();
    run(s, 60, { x: 0, y: 1, dashCount: 0 });
    run(s, 9);
    expect(Math.hypot(s.players[0].vx, s.players[0].vy)).toBe(0);
  });

  it('carrying the token is ~15% slower', () => {
    const s = fresh();
    s.token.carrier = 0;
    s.players[0].x = 400;
    s.players[0].y = 310;
    run(s, 60, { x: 0, y: 1, dashCount: 0 });
    const v = Math.hypot(s.players[0].vx, s.players[0].vy);
    expect(v).toBeCloseTo(PLAYER.maxSpeed * PLAYER.carrySpeedFactor, 0);
  });

  it('clamps out-of-range input from an untrusted peer', () => {
    const a = sanitizeInput({ x: 50, y: -50, dashCount: -3 });
    expect(a.x).toBeCloseTo(Math.SQRT1_2, 9);
    expect(a.y).toBeCloseTo(-Math.SQRT1_2, 9);
    expect(a.dashCount).toBe(0);
    expect(sanitizeInput({ x: NaN, y: Infinity, dashCount: 2.7 })).toEqual({ x: 0, y: 0, dashCount: 2 });
  });

  it('players never end up inside obstacles or outside the arena', () => {
    const s = fresh();
    const o = OBSTACLES[2]!;
    s.players[0].x = o.x - 60;
    s.players[0].y = o.y;
    run(s, 120, { x: 1, y: 0, dashCount: 0 });
    const d = Math.hypot(s.players[0].x - o.x, s.players[0].y - o.y);
    expect(d).toBeGreaterThanOrEqual(o.r + PLAYER.radius - 0.01);
    run(s, 300, { x: -1, y: -1, dashCount: 0 });
    expect(s.players[0].x).toBeGreaterThanOrEqual(24 + PLAYER.radius - 0.01);
    expect(s.players[0].y).toBeGreaterThanOrEqual(24 + PLAYER.radius - 0.01);
  });
});

describe('dash', () => {
  it('dashes at 2.4× speed for ~160 ms, then respects the cooldown', () => {
    const s = fresh();
    s.players[0].y = 310;
    const ev = run(s, 1, { x: 0, y: 1, dashCount: 1 });
    expect(ev.some((e) => e.type === 'dash' && e.player === 0)).toBe(true);
    expect(Math.hypot(s.players[0].vx, s.players[0].vy)).toBeCloseTo(PLAYER.maxSpeed * PLAYER.dashSpeedFactor, 3);
    run(s, Math.round(PLAYER.dashDuration * 60) + 1, { x: 0, y: 1, dashCount: 1 });
    expect(s.players[0].dashTime).toBe(0);
    // Second press while cooling down does nothing.
    const again = run(s, 5, { x: 0, y: 1, dashCount: 2 });
    expect(again.some((e) => e.type === 'dash')).toBe(false);
    // After the cooldown, a new press works.
    run(s, Math.ceil(PLAYER.dashCooldown * 60), { x: 0, y: 1, dashCount: 2 });
    const third = run(s, 2, { x: 0, y: 1, dashCount: 3 });
    expect(third.some((e) => e.type === 'dash')).toBe(true);
  });

  it('with no direction held, dashes along the facing direction', () => {
    const s = fresh();
    run(s, 1, { x: 0, y: 0, dashCount: 1 });
    expect(s.players[0].vx).toBeGreaterThan(0); // player 0 faces right at spawn
  });
});

describe('token pickup', () => {
  it('touching the token picks it up', () => {
    const s = fresh();
    s.players[0].x = TOKEN_SPAWN.x - 20;
    s.players[0].y = TOKEN_SPAWN.y;
    const ev = run(s, 1);
    expect(ev.some((e) => e.type === 'pickup' && e.player === 0)).toBe(true);
    expect(s.token.carrier).toBe(0);
  });

  it('carried token follows the carrier', () => {
    const s = fresh();
    s.token.carrier = 1;
    s.players[1].x = 700;
    s.players[1].y = 300;
    run(s, 10, idle, { x: 1, y: 0, dashCount: 0 });
    expect(s.token.x).toBeCloseTo(s.players[1].x, 5);
    expect(s.token.y).toBeCloseTo(s.players[1].y, 5);
  });
});

describe('tackles', () => {
  function setupTackle(): MatchState {
    const s = fresh();
    s.token.carrier = 1;
    s.players[1].x = 600;
    s.players[1].y = 310;
    s.players[0].x = 600 - PLAYER.radius * 2 - 30;
    s.players[0].y = 310;
    return s;
  }

  it('dashing into the carrier knocks the token loose near the collision', () => {
    const s = setupTackle();
    const ev = run(s, 10, { x: 1, y: 0, dashCount: 1 });
    const tackle = ev.find((e) => e.type === 'tackle');
    expect(tackle?.player).toBe(0);
    expect(ev.some((e) => e.type === 'drop' && e.player === 1)).toBe(true);
    expect(s.players[1].stun).toBeGreaterThan(0);
    expect(Math.hypot(s.token.x - tackle!.x, s.token.y - tackle!.y)).toBeLessThan(80);
  });

  it('the dropped token cannot be picked up for 300–400 ms', () => {
    expect(TOKEN.pickupLockout).toBeGreaterThanOrEqual(0.3);
    expect(TOKEN.pickupLockout).toBeLessThanOrEqual(0.4);
    const s = setupTackle();
    let t = 0;
    let dropAt = -1;
    let pickAt = -1;
    for (let i = 0; i < 120; i++) {
      // Attacker keeps chasing the loose token.
      const toward =
        i < 12
          ? { x: 1, y: 0, dashCount: 1 }
          : { x: Math.sign(s.token.x - s.players[0].x), y: Math.sign(s.token.y - s.players[0].y), dashCount: 1 };
      const ev = stepMatch(s, [toward, idle], DT);
      t += DT;
      if (dropAt < 0 && ev.some((e) => e.type === 'drop')) dropAt = t;
      if (dropAt >= 0 && pickAt < 0 && ev.some((e) => e.type === 'pickup')) pickAt = t;
    }
    expect(dropAt).toBeGreaterThan(0);
    expect(pickAt).toBeGreaterThan(0); // the chaser does get it eventually
    expect(pickAt - dropAt).toBeGreaterThanOrEqual(TOKEN.pickupLockout - DT);
  });

  it('a victim is immune right after being hit (no stun-lock)', () => {
    const s = setupTackle();
    run(s, 10, { x: 1, y: 0, dashCount: 1 });
    expect(s.players[1].immunity).toBeGreaterThan(0);
    // Give the token back and immediately try again — immunity blocks it.
    s.players[0].dashCooldown = 0;
    s.token.carrier = 1;
    s.players[0].x = s.players[1].x - PLAYER.radius * 2 - 4;
    s.players[0].y = s.players[1].y;
    const ev = run(s, 6, { x: 1, y: 0, dashCount: 2 });
    expect(ev.some((e) => e.type === 'tackle')).toBe(false);
    expect(s.token.carrier).toBe(1);
  });

  it('one dash can only land one hit', () => {
    const s = setupTackle();
    const ev = run(s, 12, { x: 1, y: 0, dashCount: 1 });
    expect(ev.filter((e) => e.type === 'tackle' || e.type === 'bump').length).toBe(1);
  });

  it('dashing into a non-carrier is just a bump', () => {
    const s = setupTackle();
    s.token.carrier = -1;
    s.token.x = 100;
    s.token.y = 100;
    const ev = run(s, 10, { x: 1, y: 0, dashCount: 1 });
    expect(ev.some((e) => e.type === 'bump')).toBe(true);
    expect(ev.some((e) => e.type === 'drop')).toBe(false);
  });

  it('walking (not dashing) into the carrier does not steal', () => {
    const s = setupTackle();
    const ev = run(s, 60, { x: 1, y: 0, dashCount: 0 });
    expect(ev.some((e) => e.type === 'tackle' || e.type === 'drop')).toBe(false);
    expect(s.token.carrier).toBe(1);
  });
});

describe('scoring', () => {
  it('carrying the token into your OWN gate scores exactly one goal', () => {
    const s = fresh();
    carryInto(s, 0);
    const ev = run(s, 1);
    expect(ev.filter((e) => e.type === 'goal')).toHaveLength(1);
    expect(s.scores).toEqual([1, 0]);
    // Staying in the gate during the celebration does not score again.
    run(s, 30);
    expect(s.scores).toEqual([1, 0]);
  });

  it("entering the OPPONENT's gate does not score", () => {
    const s = fresh();
    carryInto(s, 0, GATES[1]);
    run(s, 5);
    expect(s.scores).toEqual([0, 0]);
  });

  it('cannot score without the token', () => {
    const s = fresh();
    s.players[0].x = GATES[0].x + GATES[0].w / 2;
    s.players[0].y = GATES[0].y + GATES[0].h / 2;
    run(s, 5);
    expect(s.scores).toEqual([0, 0]);
  });

  it('after a goal, positions and token reset to their spawns', () => {
    const s = fresh();
    carryInto(s, 1);
    run(s, 1);
    expect(s.phase).toBe('goal');
    run(s, Math.ceil((MATCH.goalPauseSeconds + 0.7) * 60));
    expect(s.phase).toBe('playing');
    expect(s.players[0].x).toBe(SPAWNS[0].x);
    expect(s.players[1].x).toBe(SPAWNS[1].x);
    expect(s.token.carrier).toBe(-1);
    expect(s.token.x).toBe(TOKEN_SPAWN.x);
  });

  it('first to three wins immediately', () => {
    const s = fresh();
    s.scores = [2, 1];
    carryInto(s, 0);
    const ev = run(s, 1);
    expect(s.phase).toBe('ended');
    expect(s.winner).toBe(0);
    expect(s.endReason).toBe('goals');
    expect(ev.some((e) => e.type === 'end' && e.player === 0)).toBe(true);
  });
});

describe('timer', () => {
  it('the leader wins when time expires', () => {
    const s = fresh();
    s.scores = [0, 1];
    s.timeLeft = 0.05;
    run(s, 5);
    expect(s.phase).toBe('ended');
    expect(s.winner).toBe(1);
    expect(s.endReason).toBe('time');
  });

  it('a tie at full time enters sudden death; the next goal wins', () => {
    const s = fresh();
    s.scores = [1, 1];
    s.timeLeft = 0.05;
    const ev = run(s, 5);
    expect(ev.some((e) => e.type === 'suddenDeath')).toBe(true);
    expect(s.phase).toBe('playing');
    expect(s.suddenDeath).toBe(true);
    run(s, 600); // the clock no longer ends the match
    expect(s.phase).toBe('playing');
    carryInto(s, 1);
    run(s, 1);
    expect(s.phase).toBe('ended');
    expect(s.winner).toBe(1);
    expect(s.endReason).toBe('suddenDeath');
  });

  it('the clock does not run during goal celebrations', () => {
    const s = fresh();
    carryInto(s, 0);
    run(s, 1);
    const t = s.timeLeft;
    run(s, 60);
    expect(s.timeLeft).toBe(t);
  });
});

describe('arena events', () => {
  it('are host-scheduled and deterministic for a given seed', () => {
    const a = fresh({ events: true });
    const b = fresh({ events: true });
    const ea = run(a, 60 * 20).filter((e) => e.type === 'eventStart');
    const eb = run(b, 60 * 20).filter((e) => e.type === 'eventStart');
    expect(ea.length).toBe(1);
    expect(ea.map((e) => e.value)).toEqual(eb.map((e) => e.value));
    expect(a.event.kind).not.toBe('none');
  });

  it('never trigger when disabled', () => {
    const s = fresh({ events: false });
    const ev = run(s, 60 * 40);
    expect(ev.some((e) => e.type === 'eventStart')).toBe(false);
  });
});
