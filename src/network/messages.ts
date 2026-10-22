/**
 * Wire protocol: typed messages, validators, and compact snapshot encoding.
 *
 * Every message received from the network is `unknown` until a validator here
 * accepts it. Validators reject anything malformed instead of trying to repair
 * it — except guest input, which is clamped (sanitised) by the simulation.
 */
import { NET } from '../config/gameConfig';
import {
  ARENA_EVENT_KINDS,
  SIM_EVENT_TYPES,
  type ArenaEventKind,
  type EndReason,
  type MatchState,
  type Phase,
  type PlayerState,
  type SimEvent,
  type Slot,
} from '../game/simulation';

export type Role = 'host' | 'guest';

// ---------------------------------------------------------------------------
// Handshake (sent through Trystero's onPeerHandshake, before a peer is active)
// ---------------------------------------------------------------------------

export interface HelloMsg {
  t: 'hello';
  app: 'snatch';
  proto: number;
  role: Role;
  name: string;
  room: string;
}

export interface VerdictMsg {
  t: 'verdict';
  ok: boolean;
  reason: RejectReason | null;
}

export type RejectReason = 'full' | 'version' | 'role' | 'room' | 'busy';

// ---------------------------------------------------------------------------
// Control channel (reliable, low-rate)
// ---------------------------------------------------------------------------

export interface LobbyMsg {
  t: 'lobby';
  name: string;
  ready: boolean;
  /** Host-only setting, ignored when sent by the guest. */
  events: boolean;
}

export interface StartMsg {
  t: 'start';
  matchId: string;
  events: boolean;
}

export interface AbortMsg {
  t: 'abort';
  matchId: string;
}

export interface EndMsg {
  t: 'end';
  matchId: string;
  winner: Slot;
  scores: [number, number];
  duration: number;
  reason: EndReason;
}

export interface RematchMsg {
  t: 'rematch';
  matchId: string;
  want: boolean;
}

export interface ToLobbyMsg {
  t: 'toLobby';
}

export interface LeaveMsg {
  t: 'leave';
}

export interface FocusMsg {
  t: 'focus';
  hidden: boolean;
}

/** Voice-chat status, so each side can show the other's mic state. */
export interface VoiceMsg {
  t: 'voice';
  /** Microphone stream is attached. */
  on: boolean;
  /** Attached but muted (track disabled). */
  muted: boolean;
}

export type ControlMsg =
  | LobbyMsg
  | StartMsg
  | AbortMsg
  | EndMsg
  | RematchMsg
  | ToLobbyMsg
  | LeaveMsg
  | FocusMsg
  | VoiceMsg;

// ---------------------------------------------------------------------------
// Hot path
// ---------------------------------------------------------------------------

/** Guest → host, ~30 Hz. */
export interface InputMsg {
  m: string; // match id
  s: number; // input sequence
  x: number;
  y: number;
  d: number; // dash counter
}

/** Host → guest, ~20 Hz. Arrays keep the payload small. */
export interface SnapshotMsg {
  m: string;
  s: number; // snapshot sequence
  t: number; // host clock (ms since match start, always advancing)
  a: number; // last guest input seq processed
  ph: number; // phase index
  pt: number; // phase timer
  tl: number; // time left
  el: number; // elapsed live play
  sd: 0 | 1; // sudden death
  pz: 0 | 1 | 2; // 0 running, 1 paused (stall), 2 paused (tab hidden)
  sc: [number, number];
  w: Slot;
  er: number; // end reason index or -1
  p: [number[], number[]];
  k: number[]; // token: x, y, vx, vy, carrier, lockout
  e: [number, number]; // event kind index, remaining
  ev: number[][]; // [id, type, player, x, y, value]
}

export const PHASES: readonly Phase[] = ['countdown', 'playing', 'goal', 'kickoff', 'ended'];
export const END_REASONS: readonly EndReason[] = ['goals', 'time', 'suddenDeath'];

// ---------------------------------------------------------------------------
// Primitive validators
// ---------------------------------------------------------------------------

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isInt = (v: unknown): v is number => isNum(v) && Number.isInteger(v);
const isBool = (v: unknown): v is boolean => typeof v === 'boolean';
const isStr = (v: unknown, max = 64): v is string => typeof v === 'string' && v.length <= max;
const isSlot = (v: unknown): v is Slot => v === -1 || v === 0 || v === 1;
const isMatchId = (v: unknown): v is string => isStr(v, 32) && /^[A-Za-z0-9]{6,32}$/.test(v);

export function sanitizeName(raw: unknown, fallback: string): string {
  if (typeof raw !== 'string') return fallback;
  // Strip control characters and collapse whitespace; nicknames are display-only.
  const clean = raw
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 16);
  return clean || fallback;
}

// ---------------------------------------------------------------------------
// Message validators
// ---------------------------------------------------------------------------

export function parseHello(v: unknown): HelloMsg | null {
  if (!isObj(v) || v.t !== 'hello' || v.app !== 'snatch') return null;
  if (!isInt(v.proto)) return null;
  if (v.role !== 'host' && v.role !== 'guest') return null;
  if (!isStr(v.room, 32)) return null;
  return {
    t: 'hello',
    app: 'snatch',
    proto: v.proto,
    role: v.role,
    name: sanitizeName(v.name, v.role === 'host' ? 'Host' : 'Guest'),
    room: v.room,
  };
}

export function parseVerdict(v: unknown): VerdictMsg | null {
  if (!isObj(v) || v.t !== 'verdict' || !isBool(v.ok)) return null;
  const reasons: RejectReason[] = ['full', 'version', 'role', 'room', 'busy'];
  const reason = reasons.includes(v.reason as RejectReason) ? (v.reason as RejectReason) : null;
  return { t: 'verdict', ok: v.ok, reason };
}

export interface HandshakeContext {
  myRole: Role;
  room: string;
  /** Host only: is a guest already accepted (or mid-handshake)? */
  hasOpponent: boolean;
}

/**
 * Pure decision used by both peers after exchanging hellos.
 * Returns null to accept, or the reason to reject.
 */
export function evaluateHello(hello: HelloMsg | null, ctx: HandshakeContext): RejectReason | null {
  if (!hello) return 'version';
  if (hello.proto !== NET.protocolVersion) return 'version';
  if (hello.room !== ctx.room) return 'room';
  // Exactly one host and one guest — two guests (or two hosts) never pair up.
  if (hello.role === ctx.myRole) return 'role';
  if (ctx.myRole === 'host' && ctx.hasOpponent) return 'full';
  return null;
}

export function parseControl(v: unknown): ControlMsg | null {
  if (!isObj(v) || typeof v.t !== 'string') return null;
  switch (v.t) {
    case 'lobby':
      if (!isBool(v.ready) || !isBool(v.events)) return null;
      return { t: 'lobby', name: sanitizeName(v.name, 'Player'), ready: v.ready, events: v.events };
    case 'start':
      if (!isMatchId(v.matchId) || !isBool(v.events)) return null;
      return { t: 'start', matchId: v.matchId, events: v.events };
    case 'abort':
      if (!isMatchId(v.matchId)) return null;
      return { t: 'abort', matchId: v.matchId };
    case 'end': {
      if (!isMatchId(v.matchId) || !isSlot(v.winner) || !isNum(v.duration)) return null;
      const sc = v.scores;
      if (!Array.isArray(sc) || sc.length !== 2 || !sc.every((n) => isInt(n) && n >= 0 && n < 100)) return null;
      if (!END_REASONS.includes(v.reason as EndReason)) return null;
      return {
        t: 'end',
        matchId: v.matchId,
        winner: v.winner,
        scores: [sc[0] as number, sc[1] as number],
        duration: Math.max(0, Math.min(3600, v.duration)),
        reason: v.reason as EndReason,
      };
    }
    case 'rematch':
      if (!isMatchId(v.matchId) || !isBool(v.want)) return null;
      return { t: 'rematch', matchId: v.matchId, want: v.want };
    case 'toLobby':
      return { t: 'toLobby' };
    case 'leave':
      return { t: 'leave' };
    case 'focus':
      if (!isBool(v.hidden)) return null;
      return { t: 'focus', hidden: v.hidden };
    case 'voice':
      if (!isBool(v.on) || !isBool(v.muted)) return null;
      return { t: 'voice', on: v.on, muted: v.muted };
    default:
      return null;
  }
}

export function parseInput(v: unknown): InputMsg | null {
  if (!isObj(v) || !isMatchId(v.m) || !isInt(v.s) || v.s < 0) return null;
  if (!isNum(v.x) || !isNum(v.y) || !isInt(v.d) || v.d < 0) return null;
  // Clamping happens here AND in the simulation; never trust the sender.
  return {
    m: v.m,
    s: v.s,
    x: Math.max(-1, Math.min(1, v.x)),
    y: Math.max(-1, Math.min(1, v.y)),
    d: Math.min(v.d, 1_000_000),
  };
}

const PLAYER_FIELDS = 14;
const numArray = (v: unknown, len: number): v is number[] =>
  Array.isArray(v) && v.length === len && v.every(isNum);

export function parseSnapshot(v: unknown): SnapshotMsg | null {
  if (!isObj(v) || !isMatchId(v.m)) return null;
  if (!isInt(v.s) || !isNum(v.t) || !isInt(v.a)) return null;
  if (!isInt(v.ph) || v.ph < 0 || v.ph >= PHASES.length) return null;
  if (!isNum(v.pt) || !isNum(v.tl) || !isNum(v.el)) return null;
  if (v.sd !== 0 && v.sd !== 1) return null;
  if (v.pz !== 0 && v.pz !== 1 && v.pz !== 2) return null;
  if (!numArray(v.sc, 2) || !isSlot(v.w) || !isInt(v.er)) return null;
  const p = v.p;
  if (!Array.isArray(p) || p.length !== 2 || !numArray(p[0], PLAYER_FIELDS) || !numArray(p[1], PLAYER_FIELDS)) return null;
  if (!numArray(v.k, 6) || !isSlot(v.k[4])) return null;
  if (!numArray(v.e, 2) || !isInt(v.e[0]) || v.e[0] < 0 || v.e[0] >= ARENA_EVENT_KINDS.length) return null;
  if (!Array.isArray(v.ev) || v.ev.length > 64) return null;
  for (const e of v.ev) {
    if (!numArray(e, 6) || !isInt(e[0]) || !isInt(e[1]) || e[1] < 0 || e[1] >= SIM_EVENT_TYPES.length || !isSlot(e[2])) return null;
  }
  return v as unknown as SnapshotMsg;
}

// ---------------------------------------------------------------------------
// Snapshot encode / decode
// ---------------------------------------------------------------------------

const r1 = (n: number) => Math.round(n * 10) / 10;
const r3 = (n: number) => Math.round(n * 1000) / 1000;

function encodePlayer(p: PlayerState): number[] {
  return [
    r1(p.x), r1(p.y), r1(p.vx), r1(p.vy),
    r3(p.fx), r3(p.fy),
    r3(p.dashTime), r3(p.dashCooldown),
    r3(p.dashDirX), r3(p.dashDirY),
    r3(p.stun), r3(p.immunity), r3(p.boost),
    p.dashHit ? 1 : 0,
  ];
}

export function encodeSnapshot(
  s: MatchState,
  meta: { matchId: string; seq: number; hostTime: number; ack: number; paused: 0 | 1 | 2; events: SimEvent[] },
): SnapshotMsg {
  const t = s.token;
  return {
    m: meta.matchId,
    s: meta.seq,
    t: Math.round(meta.hostTime),
    a: meta.ack,
    ph: PHASES.indexOf(s.phase),
    pt: r3(s.phaseTimer),
    tl: r3(s.timeLeft),
    el: r3(s.elapsed),
    sd: s.suddenDeath ? 1 : 0,
    pz: meta.paused,
    sc: [s.scores[0], s.scores[1]],
    w: s.winner,
    er: s.endReason ? END_REASONS.indexOf(s.endReason) : -1,
    p: [encodePlayer(s.players[0]), encodePlayer(s.players[1])],
    k: [r1(t.x), r1(t.y), r1(t.vx), r1(t.vy), t.carrier, r3(t.lockout)],
    e: [ARENA_EVENT_KINDS.indexOf(s.event.kind), r3(s.event.remaining)],
    ev: meta.events.slice(-64).map((e) => [e.id, SIM_EVENT_TYPES.indexOf(e.type), e.player, r1(e.x), r1(e.y), e.value]),
  };
}

export function decodePlayer(a: number[]): PlayerState {
  return {
    x: a[0]!, y: a[1]!, vx: a[2]!, vy: a[3]!,
    fx: a[4]!, fy: a[5]!,
    dashTime: a[6]!, dashCooldown: a[7]!,
    dashDirX: a[8]!, dashDirY: a[9]!,
    stun: a[10]!, immunity: a[11]!, boost: a[12]!,
    dashHit: a[13] === 1,
    dashBuffer: 0,
    lastDashCount: 0,
  };
}

export function decodeEvents(ev: number[][]): SimEvent[] {
  return ev.map((e) => ({
    id: e[0]!,
    type: SIM_EVENT_TYPES[e[1]!]!,
    player: e[2] as Slot,
    x: e[3]!,
    y: e[4]!,
    value: e[5]!,
  }));
}

export function eventKindOf(index: number): ArenaEventKind {
  return ARENA_EVENT_KINDS[index] ?? 'none';
}

/** Short random id for matches (alphanumeric, accepted by isMatchId). */
export function newMatchId(): string {
  const bytes = new Uint8Array(9);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => (b % 36).toString(36)).join('') + Date.now().toString(36);
}
