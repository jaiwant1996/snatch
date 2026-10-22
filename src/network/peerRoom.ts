/**
 * Thin, typed wrapper around a Trystero room.
 *
 * Responsibilities:
 *  - join the room under SNATCH!'s app namespace
 *  - run the admission handshake (protocol version, roles, two-player cap)
 *  - expose exactly one accepted opponent and drop traffic from anyone else
 *  - validate every inbound message before handing it to game code
 *
 * Gameplay code never touches Trystero directly.
 */
import { joinRoom, getRelaySockets, type Room } from 'trystero';
import { NET } from '../config/gameConfig';
import {
  evaluateHello,
  parseControl,
  parseHello,
  parseInput,
  parseSnapshot,
  parseVerdict,
  type ControlMsg,
  type HelloMsg,
  type InputMsg,
  type RejectReason,
  type Role,
  type SnapshotMsg,
} from './messages';

export interface PeerRoomHandlers {
  onOpponentJoin: (hello: HelloMsg) => void;
  onOpponentLeave: () => void;
  /** Guest only: the host (or our own check) refused the pairing. */
  onRejected: (reason: RejectReason) => void;
  /** Transport-level failure before an opponent was accepted. */
  onJoinError: (message: string) => void;
  onControl: (msg: ControlMsg) => void;
  onInput: (msg: InputMsg) => void;
  onSnapshot: (msg: SnapshotMsg) => void;
  /** Opponent's microphone audio arrived (voice chat). */
  onOpponentStream?: (stream: MediaStream) => void;
}

export class PeerRoom {
  readonly code: string;
  readonly role: Role;
  private room: Room;
  private ctl;
  private inp;
  private snap;
  private opponentId: string | null = null;
  private pendingId: string | null = null;
  private pendingHello: HelloMsg | null = null;
  private pendingTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  /** Peers we refused on purpose (e.g. another guest) — their failures are not errors. */
  private refused = new Set<string>();
  private handlers: PeerRoomHandlers;
  private name: string;

  constructor(code: string, role: Role, name: string, handlers: PeerRoomHandlers) {
    this.code = code;
    this.role = role;
    this.name = name;
    this.handlers = handlers;

    this.room = joinRoom({ appId: NET.appId }, NET.roomPrefix + code, {
      handshakeTimeoutMs: NET.handshakeTimeoutMs,
      onPeerHandshake: (peerId, send, receive) => this.handshake(peerId, send, receive),
      onJoinError: (details) => {
        if (this.closed || this.opponentId) return; // an extra peer failing is not our problem
        if (this.refused.has(details.peerId)) return; // we rejected them deliberately
        this.handlers.onJoinError(details.error || 'Peer connection failed');
      },
    });

    this.ctl = this.room.makeAction<ControlMsgWire>('ctl');
    this.inp = this.room.makeAction<InputWire>('inp');
    this.snap = this.room.makeAction<SnapshotWire>('snap');

    this.ctl.onMessage = (data, { peerId }) => {
      if (peerId !== this.opponentId) return;
      const msg = parseControl(data);
      if (msg) this.handlers.onControl(msg);
    };
    this.inp.onMessage = (data, { peerId }) => {
      if (peerId !== this.opponentId || this.role !== 'host') return;
      const msg = parseInput(data);
      if (msg) this.handlers.onInput(msg);
    };
    this.snap.onMessage = (data, { peerId }) => {
      if (peerId !== this.opponentId || this.role !== 'guest') return;
      const msg = parseSnapshot(data);
      if (msg) this.handlers.onSnapshot(msg);
    };

    this.room.onPeerJoin = (peerId) => {
      if (this.closed) return;
      if (peerId !== this.pendingId || !this.pendingHello) return;
      this.clearPending(false);
      this.opponentId = peerId;
      this.handlers.onOpponentJoin(this.pendingHello);
      this.pendingHello = null;
    };
    this.room.onPeerStream = (stream, peerId) => {
      if (this.closed || peerId !== this.opponentId) return; // only the accepted opponent's audio
      this.handlers.onOpponentStream?.(stream);
    };
    this.room.onPeerLeave = (peerId) => {
      if (this.closed) return;
      if (peerId === this.pendingId) this.clearPending(true);
      if (peerId !== this.opponentId) return;
      this.opponentId = null;
      this.handlers.onOpponentLeave();
    };
  }

  private clearPending(dropHello: boolean): void {
    if (this.pendingTimer) clearTimeout(this.pendingTimer);
    this.pendingTimer = null;
    this.pendingId = null;
    if (dropHello) this.pendingHello = null;
  }

  private async handshake(
    peerId: string,
    send: (data: never) => Promise<void>,
    receive: () => Promise<{ data: unknown }>,
  ): Promise<void> {
    if (this.closed) throw new Error('closed');
    const hello: HelloMsg = {
      t: 'hello',
      app: 'snatch',
      proto: NET.protocolVersion,
      role: this.role,
      name: this.name,
      room: this.code,
    };
    await send(hello as never);
    const theirs = parseHello((await receive()).data);
    const hasOpponent = this.opponentId !== null || this.pendingId !== null;
    const reason = evaluateHello(theirs, { myRole: this.role, room: this.code, hasOpponent });

    if (this.role === 'host') {
      await send({ t: 'verdict', ok: reason === null, reason } as never);
      if (reason) {
        this.refused.add(peerId);
        // Give the verdict time to arrive before the connection is torn down,
        // so the refused player sees "Room is full" rather than a timeout.
        await new Promise((r) => setTimeout(r, 400));
        throw new Error(`rejected: ${reason}`);
      }
    } else {
      if (reason) {
        this.refused.add(peerId);
        // Another guest is not news; a host speaking a different protocol is.
        if (reason === 'version' && theirs?.role === 'host') this.handlers.onRejected('version');
        throw new Error(`rejected: ${reason}`);
      }
      const verdict = parseVerdict((await receive()).data);
      if (!verdict?.ok) {
        this.refused.add(peerId);
        if (!this.opponentId) this.handlers.onRejected(verdict?.reason ?? 'full');
        throw new Error(`host refused: ${verdict?.reason ?? 'unknown'}`);
      }
    }

    // Accepted: hold the slot until Trystero activates the peer.
    this.pendingId = peerId;
    this.pendingHello = theirs;
    this.pendingTimer = setTimeout(() => this.clearPending(true), NET.handshakeTimeoutMs);
  }

  get connected(): boolean {
    return this.opponentId !== null;
  }

  sendControl(msg: ControlMsg): void {
    if (!this.opponentId || this.closed) return;
    void this.ctl.send(msg as unknown as ControlMsgWire, { target: this.opponentId }).catch(() => {});
  }

  sendInput(msg: InputMsg): void {
    if (!this.opponentId || this.closed || this.role !== 'guest') return;
    void this.inp.send(msg as unknown as InputWire, { target: this.opponentId }).catch(() => {});
  }

  sendSnapshot(msg: SnapshotMsg): void {
    if (!this.opponentId || this.closed || this.role !== 'host') return;
    void this.snap.send(msg as unknown as SnapshotWire, { target: this.opponentId }).catch(() => {});
  }

  /**
   * Voice chat: attach a local audio stream to the opponent's existing peer
   * connection. Trystero renegotiates the WebRTC session over the data channel,
   * so audio flows directly browser-to-browser like the game traffic.
   */
  addAudio(stream: MediaStream): void {
    if (!this.opponentId || this.closed) return;
    for (const p of this.room.addStream(stream, { target: this.opponentId, metadata: { kind: 'voice' } })) {
      void p.catch(() => {});
    }
  }

  removeAudio(stream: MediaStream): void {
    if (this.closed) return;
    try {
      this.room.removeStream(stream);
    } catch {
      /* peer already gone */
    }
  }

  async ping(): Promise<number | null> {
    if (!this.opponentId) return null;
    try {
      return await this.room.ping(this.opponentId);
    } catch {
      return null;
    }
  }

  /** How many signalling relays have an open socket right now. */
  static relayHealth(): { open: number; total: number } {
    try {
      const sockets = (getRelaySockets?.() ?? {}) as Record<string, WebSocket>;
      const all = Object.values(sockets);
      return { open: all.filter((s) => s && s.readyState === 1).length, total: all.length };
    } catch {
      return { open: -1, total: -1 };
    }
  }

  async leave(): Promise<void> {
    if (this.closed) return;
    if (this.opponentId) {
      try {
        await this.ctl.send({ t: 'leave' } as unknown as ControlMsgWire, { target: this.opponentId });
      } catch {
        /* best effort */
      }
    }
    this.closed = true;
    this.clearPending(true);
    this.ctl.onMessage = null;
    this.inp.onMessage = null;
    this.snap.onMessage = null;
    this.room.onPeerJoin = null;
    this.room.onPeerLeave = null;
    this.room.onPeerStream = null;
    this.opponentId = null;
    try {
      await this.room.leave();
    } catch {
      /* already gone */
    }
  }
}

// Trystero's payload type is a JSON value; our message interfaces are JSON-safe.
type ControlMsgWire = { [key: string]: import('trystero').JsonValue };
type InputWire = ControlMsgWire;
type SnapshotWire = ControlMsgWire;
