/**
 * Runtime match drivers.
 *
 * HostMatch  — owns the authoritative MatchState, steps it at a fixed 60 Hz on
 *              its own timer (not Phaser's render loop), applies the guest's
 *              validated input, and broadcasts snapshots at ~20 Hz.
 * GuestMatch — sends input at ~30 Hz, buffers/interpolates snapshots and
 *              predicts its own player for responsiveness.
 */
import { MATCH, NET } from '../config/gameConfig';
import { encodeSnapshot, type InputMsg, type SnapshotMsg } from '../network/messages';
import type { PeerRoom } from '../network/peerRoom';
import type { LocalInput } from './input';
import type { SceneDriver } from './ArenaScene';
import {
  createMatch,
  hashSeed,
  NO_INPUT,
  stepMatch,
  type EndReason,
  type InputState,
  type MatchState,
  type SimEvent,
  type Slot,
} from './simulation';
import { blendViews, GuestPredictor, SnapshotBuffer, viewFromMatch, type ViewState } from './view';

export interface MatchResult {
  matchId: string;
  winner: Slot;
  scores: [number, number];
  duration: number;
  reason: EndReason;
}

export interface MatchHooks {
  onEvents(events: SimEvent[]): void;
  onEnd(result: MatchResult): void;
  onFrame(view: ViewState): void;
}

const STEP_MS = 1000 / NET.simHz;
const STEP_S = 1 / NET.simHz;

export class HostMatch implements SceneDriver {
  readonly selfIndex = 0 as const;
  readonly state: MatchState;
  private prevView: ViewState;
  private currView: ViewState;
  private acc = 0;
  private last = performance.now();
  private readonly startedAt = performance.now();
  private loopId: ReturnType<typeof setInterval> | null = null;
  private snapSeq = 0;
  private lastSnapAt = 0;
  private netEvents: SimEvent[] = [];
  private guestInput: InputState = { ...NO_INPUT };
  private lastGuestSeq = -1;
  private lastGuestInputAt = performance.now();
  private guestHidden = false;
  private localHidden = false;
  private paused: 0 | 1 | 2 = 0;
  private ended = false;
  private stopped = false;

  constructor(
    readonly matchId: string,
    eventsEnabled: boolean,
    readonly names: [string, string],
    private room: PeerRoom,
    private input: LocalInput,
    private hooks: MatchHooks,
  ) {
    this.state = createMatch({ eventsEnabled, seed: hashSeed(matchId) });
    this.currView = viewFromMatch(this.state, 0);
    this.prevView = this.currView;
    // setInterval keeps the simulation running independently of rendering.
    this.loopId = setInterval(() => this.loop(), 4);
  }

  private loop(): void {
    if (this.stopped) return;
    const now = performance.now();
    let elapsed = now - this.last;
    this.last = now;
    // Catch up through render hitches (the sim is cheap); beyond 1 s, slow down instead.
    if (elapsed > 1000) elapsed = 1000;

    const stalled = now - this.lastGuestInputAt > NET.guestStallMs;
    this.paused = this.localHidden || this.guestHidden ? 2 : stalled ? 1 : 0;

    if (this.paused === 0 && !this.ended) {
      this.acc += elapsed;
      let steps = 0;
      while (this.acc >= STEP_MS && steps < 60) {
        this.prevView = this.currView;
        const events = stepMatch(this.state, [this.input.sample(), this.guestInput], STEP_S);
        this.currView = viewFromMatch(this.state, 0);
        if (events.length) {
          this.netEvents.push(...events);
          this.hooks.onEvents(events);
        }
        this.acc -= STEP_MS;
        steps++;
        if (this.state.phase === 'ended' && !this.ended) {
          this.ended = true;
          this.sendSnapshot(now); // make sure the final state goes out immediately
          const result: MatchResult = {
            matchId: this.matchId,
            winner: this.state.winner,
            scores: [this.state.scores[0], this.state.scores[1]],
            duration: this.state.elapsed,
            reason: this.state.endReason ?? 'goals',
          };
          setTimeout(() => {
            if (!this.stopped) this.hooks.onEnd(result);
          }, MATCH.endPauseSeconds * 1000);
          break;
        }
      }
      if (steps === 60) this.acc = 0;
    } else {
      this.acc = 0;
      this.currView = { ...this.currView, paused: this.paused };
      this.prevView = this.currView;
    }

    if (now - this.lastSnapAt >= 1000 / NET.snapshotHz) this.sendSnapshot(now);
  }

  private sendSnapshot(now: number): void {
    this.lastSnapAt = now;
    const msg = encodeSnapshot(this.state, {
      matchId: this.matchId,
      seq: this.snapSeq++,
      hostTime: now - this.startedAt,
      ack: this.lastGuestSeq,
      paused: this.paused,
      events: this.netEvents,
    });
    this.netEvents = [];
    this.room.sendSnapshot(msg);
  }

  onGuestInput(msg: InputMsg): void {
    if (msg.m !== this.matchId || msg.s <= this.lastGuestSeq) return; // stale / other match / reordered
    this.lastGuestSeq = msg.s;
    this.lastGuestInputAt = performance.now();
    this.guestInput = { x: msg.x, y: msg.y, dashCount: msg.d };
  }

  setGuestHidden(hidden: boolean): void {
    this.guestHidden = hidden;
    if (!hidden) this.lastGuestInputAt = performance.now();
  }

  setLocalHidden(hidden: boolean): void {
    this.localHidden = hidden;
    if (!hidden) this.lastGuestInputAt = performance.now();
  }

  get isEnded(): boolean {
    return this.ended;
  }

  getView(now: number): ViewState {
    const alpha = this.paused ? 1 : this.acc / STEP_MS;
    void now;
    return blendViews(this.prevView, this.currView, alpha);
  }

  onFrame(view: ViewState): void {
    this.hooks.onFrame(view);
  }

  stop(): void {
    this.stopped = true;
    if (this.loopId) clearInterval(this.loopId);
    this.loopId = null;
  }
}

export class GuestMatch implements SceneDriver {
  readonly selfIndex = 1 as const;
  private buffer: SnapshotBuffer;
  private predictor = new GuestPredictor();
  private seq = 0;
  private sendId: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private endedSeen = false;
  readonly createdAt = performance.now();

  constructor(
    readonly matchId: string,
    readonly names: [string, string],
    private room: PeerRoom,
    private input: LocalInput,
    private hooks: MatchHooks,
  ) {
    this.buffer = new SnapshotBuffer(matchId);
    this.sendId = setInterval(() => this.sendInput(), 1000 / NET.inputHz);
    this.sendInput();
  }

  private sendInput(): void {
    if (this.stopped) return;
    const inp = this.input.sample();
    const seq = this.seq++;
    const msg: InputMsg = { m: this.matchId, s: seq, x: round3(inp.x), y: round3(inp.y), d: inp.dashCount };
    this.room.sendInput(msg);
    this.predictor.recordSent(seq, inp, performance.now());
  }

  onSnapshot(msg: SnapshotMsg): void {
    if (this.stopped) return;
    const now = performance.now();
    const events = this.buffer.push(msg, now, this.selfIndex);
    if (events === null) return;
    const latest = this.buffer.latest()!;
    const live = latest.view.phase === 'playing' && latest.view.paused === 0;
    this.predictor.reconcile(latest.self, latest.ack, now, this.modsFrom(latest.view), live);
    if (events.length) this.hooks.onEvents(events);
    if (latest.view.phase === 'ended') this.endedSeen = true;
  }

  private modsFrom(v: ViewState): { carrying: boolean; overdrive: boolean } {
    return { carrying: v.token.carrier === this.selfIndex, overdrive: v.event.kind === 'overdrive' };
  }

  get hasEnded(): boolean {
    return this.endedSeen;
  }

  get lastSnapshotAge(): number {
    return this.buffer.lastReceivedAt ? performance.now() - this.buffer.lastReceivedAt : performance.now() - this.createdAt;
  }

  getView(now: number, dt: number): ViewState | null {
    const v = this.buffer.sample(now);
    const latest = this.buffer.latest();
    if (!v || !latest) return null;
    const stalled = now - this.buffer.lastReceivedAt > NET.hostStallMs;
    const live = latest.view.phase === 'playing' && latest.view.paused === 0 && !stalled;

    let out: ViewState = stalled && v.paused === 0 ? { ...v, paused: 1 } : v;
    if (NET.guestPrediction) {
      this.predictor.advance(dt, this.input.sample(), this.modsFrom(latest.view), live);
      const me = this.predictor.view();
      if (me && (live || latest.view.phase === 'playing')) {
        const players: ViewState['players'] = [out.players[0], out.players[1]];
        players[this.selfIndex] = me;
        out = { ...out, players };
        if (out.token.carrier === this.selfIndex) out = { ...out, token: { ...out.token, x: me.x, y: me.y } };
      }
    }
    return out;
  }

  onFrame(view: ViewState): void {
    this.hooks.onFrame(view);
  }

  stop(): void {
    this.stopped = true;
    if (this.sendId) clearInterval(this.sendId);
    this.sendId = null;
    this.predictor.reset();
  }
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;
