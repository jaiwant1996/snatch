/**
 * Render-side view model, plus the two "sources" that produce it:
 *  - host: interpolation between the last two fixed simulation steps
 *  - guest: snapshot interpolation (opponent, token) + prediction (own player)
 */
import { NET, PLAYER } from '../config/gameConfig';
import {
  decodeEvents,
  decodePlayer,
  END_REASONS,
  eventKindOf,
  PHASES,
  type SnapshotMsg,
} from '../network/messages';
import {
  stepPlayerMotion,
  tryStartDash,
  type ArenaEventKind,
  type EndReason,
  type InputState,
  type MatchState,
  type Phase,
  type PlayerState,
  type SimEvent,
  type Slot,
} from './simulation';

export interface ViewPlayer {
  x: number;
  y: number;
  vx: number;
  vy: number;
  fx: number;
  fy: number;
  dashing: boolean;
  /** 1 = dash ready, 0 = just used. */
  dashReady: number;
  stunned: boolean;
  immune: boolean;
  boosted: boolean;
}

export interface ViewState {
  phase: Phase;
  phaseTimer: number;
  timeLeft: number;
  elapsed: number;
  suddenDeath: boolean;
  scores: [number, number];
  winner: Slot;
  endReason: EndReason | null;
  players: [ViewPlayer, ViewPlayer];
  token: { x: number; y: number; carrier: Slot; locked: boolean };
  event: { kind: ArenaEventKind; remaining: number };
  /** 0 running, 1 paused because a peer stalled, 2 paused because a tab is hidden. */
  paused: 0 | 1 | 2;
}

export function viewPlayerOf(p: PlayerState, cooldownTotal: number = PLAYER.dashCooldown): ViewPlayer {
  return {
    x: p.x,
    y: p.y,
    vx: p.vx,
    vy: p.vy,
    fx: p.fx,
    fy: p.fy,
    dashing: p.dashTime > 0,
    dashReady: cooldownTotal > 0 ? 1 - Math.min(1, p.dashCooldown / cooldownTotal) : 1,
    stunned: p.stun > 0,
    immune: p.immunity > 0,
    boosted: p.boost > 0,
  };
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

function lerpPlayer(a: ViewPlayer, b: ViewPlayer, t: number): ViewPlayer {
  // Large jumps (goal reset) snap instead of sliding across the arena.
  if (Math.hypot(b.x - a.x, b.y - a.y) > 120) return b;
  return { ...b, x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t) };
}

export function viewFromMatch(s: MatchState, paused: 0 | 1 | 2): ViewState {
  return {
    phase: s.phase,
    phaseTimer: s.phaseTimer,
    timeLeft: s.timeLeft,
    elapsed: s.elapsed,
    suddenDeath: s.suddenDeath,
    scores: [s.scores[0], s.scores[1]],
    winner: s.winner,
    endReason: s.endReason,
    players: [viewPlayerOf(s.players[0]), viewPlayerOf(s.players[1])],
    token: { x: s.token.x, y: s.token.y, carrier: s.token.carrier, locked: s.token.lockout > 0 },
    event: { kind: s.event.kind, remaining: s.event.remaining },
    paused,
  };
}

/** Host-side: blend the previous and current fixed step for smooth rendering. */
export function blendViews(prev: ViewState, curr: ViewState, alpha: number): ViewState {
  const t = Math.max(0, Math.min(1, alpha));
  const tok =
    Math.hypot(curr.token.x - prev.token.x, curr.token.y - prev.token.y) > 120
      ? curr.token
      : { ...curr.token, x: lerp(prev.token.x, curr.token.x, t), y: lerp(prev.token.y, curr.token.y, t) };
  return {
    ...curr,
    players: [lerpPlayer(prev.players[0], curr.players[0], t), lerpPlayer(prev.players[1], curr.players[1], t)],
    token: tok,
  };
}

// ---------------------------------------------------------------------------
// Guest: snapshot buffer + interpolation
// ---------------------------------------------------------------------------

interface BufferedSnap {
  hostTime: number;
  view: ViewState;
  self: PlayerState;
  ack: number;
}

export class SnapshotBuffer {
  private snaps: BufferedSnap[] = [];
  private lastSeq = -1;
  private clockOffset: number | null = null;
  private lastEventId = 0;
  lastReceivedAt = 0;

  constructor(private readonly matchId: string) {}

  /**
   * Adds a snapshot; returns the new effect events it carried (deduplicated),
   * or null if the snapshot was stale / for another match.
   */
  push(msg: SnapshotMsg, now: number, selfIndex: 0 | 1): SimEvent[] | null {
    if (msg.m !== this.matchId) return null;
    if (msg.s <= this.lastSeq) return null; // out of order or duplicate
    this.lastSeq = msg.s;
    this.lastReceivedAt = now;

    const offset = msg.t - now;
    // Track the *minimum-latency* offset, drifting slowly so jitter doesn't shake the clock.
    if (this.clockOffset === null || offset > this.clockOffset) this.clockOffset = offset;
    else this.clockOffset += (offset - this.clockOffset) * 0.02;

    const p0 = decodePlayer(msg.p[0]);
    const p1 = decodePlayer(msg.p[1]);
    const view: ViewState = {
      phase: PHASES[msg.ph]!,
      phaseTimer: msg.pt,
      timeLeft: msg.tl,
      elapsed: msg.el,
      suddenDeath: msg.sd === 1,
      scores: [msg.sc[0], msg.sc[1]],
      winner: msg.w,
      endReason: msg.er >= 0 ? (END_REASONS[msg.er] ?? null) : null,
      players: [viewPlayerOf(p0), viewPlayerOf(p1)],
      token: { x: msg.k[0]!, y: msg.k[1]!, carrier: msg.k[4] as Slot, locked: msg.k[5]! > 0 },
      event: { kind: eventKindOf(msg.e[0]), remaining: msg.e[1] },
      paused: msg.pz,
    };
    this.snaps.push({ hostTime: msg.t, view, self: selfIndex === 0 ? p0 : p1, ack: msg.a });
    if (this.snaps.length > 30) this.snaps.splice(0, this.snaps.length - 30);

    const fresh = decodeEvents(msg.ev).filter((e) => e.id > this.lastEventId);
    if (fresh.length) this.lastEventId = Math.max(...fresh.map((e) => e.id));
    return fresh;
  }

  latest(): BufferedSnap | null {
    return this.snaps[this.snaps.length - 1] ?? null;
  }

  /** Interpolated view `interpolationDelayMs` in the past. */
  sample(now: number): ViewState | null {
    const n = this.snaps.length;
    if (n === 0 || this.clockOffset === null) return null;
    const target = now + this.clockOffset - NET.interpolationDelayMs;
    const last = this.snaps[n - 1]!;
    if (n === 1 || target >= last.hostTime) return last.view;
    for (let i = n - 1; i > 0; i--) {
      const a = this.snaps[i - 1]!;
      const b = this.snaps[i]!;
      if (target >= a.hostTime) {
        const span = Math.max(1, b.hostTime - a.hostTime);
        const t = (target - a.hostTime) / span;
        return {
          ...b.view,
          players: [lerpPlayer(a.view.players[0], b.view.players[0], t), lerpPlayer(a.view.players[1], b.view.players[1], t)],
          token:
            Math.hypot(b.view.token.x - a.view.token.x, b.view.token.y - a.view.token.y) > 120
              ? b.view.token
              : { ...b.view.token, x: lerp(a.view.token.x, b.view.token.x, t), y: lerp(a.view.token.y, b.view.token.y, t) },
        };
      }
    }
    return this.snaps[0]!.view;
  }
}

// ---------------------------------------------------------------------------
// Guest: own-player prediction with server reconciliation
// ---------------------------------------------------------------------------

interface SentInput {
  seq: number;
  input: InputState;
  at: number;
}

const STEP = 1 / 60;

export class GuestPredictor {
  private pending: SentInput[] = [];
  private pred: PlayerState | null = null;
  private offX = 0;
  private offY = 0;
  private acc = 0;
  private ackedDashCount = 0;

  recordSent(seq: number, input: InputState, at: number): void {
    this.pending.push({ seq, input: { ...input }, at });
    if (this.pending.length > 120) this.pending.shift();
  }

  /** Rebuild the prediction from an authoritative state and replay unacknowledged inputs. */
  reconcile(auth: PlayerState, ack: number, now: number, mods: { carrying: boolean; overdrive: boolean }, live: boolean): void {
    const acked = this.pending.filter((p) => p.seq <= ack);
    if (acked.length) this.ackedDashCount = acked[acked.length - 1]!.input.dashCount;
    this.pending = this.pending.filter((p) => p.seq > ack);

    const base: PlayerState = { ...auth, lastDashCount: this.ackedDashCount, dashBuffer: 0 };
    if (live) {
      for (let i = 0; i < this.pending.length; i++) {
        const cur = this.pending[i]!;
        const until = this.pending[i + 1]?.at ?? now;
        let remaining = Math.min(0.25, Math.max(0, (until - cur.at) / 1000));
        while (remaining > 1e-4) {
          const dt = Math.min(STEP, remaining);
          tryStartDash(base, cur.input, dt, mods, true);
          stepPlayerMotion(base, cur.input, dt, mods);
          remaining -= dt;
        }
      }
    }
    if (this.pred) {
      const ex = this.pred.x + this.offX - base.x;
      const ey = this.pred.y + this.offY - base.y;
      if (Math.hypot(ex, ey) > 90 || !live) {
        this.offX = 0;
        this.offY = 0;
      } else {
        this.offX = ex;
        this.offY = ey;
      }
    }
    this.pred = base;
    this.acc = 0;
  }

  /** Advance the prediction by one render frame. */
  advance(dt: number, input: InputState, mods: { carrying: boolean; overdrive: boolean }, live: boolean): void {
    if (!this.pred) return;
    const decay = Math.exp(-dt * 12);
    this.offX *= decay;
    this.offY *= decay;
    if (!live) return;
    this.acc += Math.min(dt, 0.1);
    while (this.acc >= STEP) {
      tryStartDash(this.pred, input, STEP, mods, true);
      stepPlayerMotion(this.pred, input, STEP, mods);
      this.acc -= STEP;
    }
  }

  view(): ViewPlayer | null {
    if (!this.pred) return null;
    const v = viewPlayerOf(this.pred);
    v.x += this.offX;
    v.y += this.offY;
    return v;
  }

  reset(): void {
    this.pending = [];
    this.pred = null;
    this.offX = this.offY = 0;
    this.acc = 0;
    this.ackedDashCount = 0;
  }
}
