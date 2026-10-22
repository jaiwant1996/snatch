/**
 * Peer-to-peer voice chat.
 *
 * The microphone track rides on the SAME WebRTC peer connection as the game
 * (Trystero adds the track and renegotiates over the existing data channel),
 * so audio goes directly browser-to-browser — no media server, no new service.
 *
 * Lifecycle: voice belongs to the room/opponent pairing, not to a match, so it
 * keeps working across lobby → match → results → rematch. Enabling the mic
 * asks for permission once; after that the button only mutes/unmutes the
 * track (no renegotiation, instant).
 */
import type { PeerRoom } from './peerRoom';

export type MicState = 'off' | 'requesting' | 'live' | 'muted' | 'error';

export interface VoiceState {
  mic: MicState;
  micError: string | null;
  /** Local input level 0..1 (only while live). */
  localLevel: number;
  /** Opponent's announced mic state. */
  remote: 'off' | 'live' | 'muted';
  /** We are receiving opponent audio. */
  remoteConnected: boolean;
  /** Opponent level 0..1. */
  remoteLevel: number;
  /** We silenced the opponent locally. */
  remoteSilenced: boolean;
  /** Browser refused to autoplay the opponent's audio — needs one tap. */
  needsGesture: boolean;
  supported: boolean;
}

export class VoiceChat {
  private room: PeerRoom | null = null;
  private local: MediaStream | null = null;
  private remoteStream: MediaStream | null = null;
  private audioEl: HTMLAudioElement;
  private ctx: AudioContext | null = null;
  private localAnalyser: AnalyserNode | null = null;
  private remoteAnalyser: AnalyserNode | null = null;
  private remoteSource: MediaStreamAudioSourceNode | null = null;
  private rafId = 0;
  private buf = new Uint8Array(512);
  readonly state: VoiceState;
  onChange: ((s: VoiceState) => void) | null = null;
  /** Called whenever our mic state changes so the session can tell the opponent. */
  onAnnounce: ((on: boolean, muted: boolean) => void) | null = null;

  constructor() {
    this.audioEl = document.createElement('audio');
    this.audioEl.autoplay = true;
    this.audioEl.setAttribute('playsinline', '');
    this.audioEl.hidden = true;
    document.body.appendChild(this.audioEl);
    this.state = {
      mic: 'off',
      micError: null,
      localLevel: 0,
      remote: 'off',
      remoteConnected: false,
      remoteLevel: 0,
      remoteSilenced: false,
      needsGesture: false,
      supported: VoiceChat.isSupported(),
    };
  }

  static isSupported(): boolean {
    return (
      typeof window !== 'undefined' &&
      window.isSecureContext &&
      !!navigator.mediaDevices &&
      typeof navigator.mediaDevices.getUserMedia === 'function' &&
      typeof RTCPeerConnection !== 'undefined'
    );
  }

  // ------------------------------------------------------------ room wiring

  /** Bind to the current room (or null when leaving it). */
  attachRoom(room: PeerRoom | null): void {
    if (this.room && this.room !== room && this.local) this.room.removeAudio(this.local);
    this.room = room;
    if (!room) {
      this.stopMic();
      this.dropRemote();
    }
  }

  /** A (new) opponent was accepted: send them our mic if it's on. */
  opponentJoined(): void {
    if (this.local && this.room) this.room.addAudio(this.local);
    this.announce();
  }

  opponentLeft(): void {
    // Release the mic too: nobody is listening, and the OS mic indicator should go off.
    this.stopMic();
    this.dropRemote();
    this.state.remote = 'off';
    this.emit();
  }

  /** Opponent's audio stream arrived from Trystero. */
  receiveStream(stream: MediaStream): void {
    this.remoteStream = stream;
    this.audioEl.srcObject = stream;
    this.audioEl.muted = this.state.remoteSilenced;
    this.state.remoteConnected = true;
    this.tryPlay();
    this.connectRemoteAnalyser();
    stream.getAudioTracks().forEach((t) =>
      t.addEventListener('ended', () => {
        if (this.remoteStream === stream) this.dropRemote();
      }),
    );
    this.emit();
    this.startMeters();
  }

  /** Opponent told us their mic status. */
  remoteStatus(on: boolean, muted: boolean): void {
    this.state.remote = !on ? 'off' : muted ? 'muted' : 'live';
    if (on) this.tryPlay();
    this.emit();
  }

  // --------------------------------------------------------------- controls

  /** Main mic button: off → (permission) live → muted → live … */
  async toggleMic(): Promise<void> {
    if (this.state.mic === 'requesting') return;
    if (this.local) {
      const track = this.local.getAudioTracks()[0];
      if (track) track.enabled = !track.enabled;
      this.state.mic = track?.enabled ? 'live' : 'muted';
      this.announce();
      this.emit();
      return;
    }
    await this.startMic();
  }

  private async startMic(): Promise<void> {
    if (!this.state.supported) {
      this.fail(
        window.isSecureContext
          ? 'This browser does not support voice chat.'
          : 'Voice chat needs HTTPS — open the https:// address.',
      );
      return;
    }
    this.state.mic = 'requesting';
    this.state.micError = null;
    this.emit();
    try {
      this.local = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false,
      });
    } catch (err) {
      const name = (err as DOMException)?.name;
      this.fail(
        name === 'NotAllowedError' || name === 'SecurityError'
          ? 'Microphone permission was blocked. Allow it from the address-bar lock icon, then try again.'
          : name === 'NotFoundError' || name === 'OverconstrainedError'
            ? 'No microphone found on this device.'
            : name === 'NotReadableError'
              ? 'Your microphone is being used by another app.'
              : 'Could not start the microphone.',
      );
      return;
    }
    this.state.mic = 'live';
    this.local.getAudioTracks().forEach((t) =>
      t.addEventListener('ended', () => {
        // Device unplugged / permission revoked mid-call.
        this.stopMic();
        this.fail('Microphone disconnected.');
      }),
    );
    this.room?.addAudio(this.local);
    this.connectLocalAnalyser();
    this.startMeters();
    // Opening the mic is a user gesture — use it to unblock remote playback too.
    this.tryPlay();
    this.announce();
    this.emit();
  }

  /** Fully release the microphone (OS indicator turns off). */
  stopMic(): void {
    if (this.local) {
      this.room?.removeAudio(this.local);
      this.local.getTracks().forEach((t) => t.stop());
    }
    this.local = null;
    this.localAnalyser?.disconnect();
    this.localAnalyser = null;
    this.state.mic = 'off';
    this.state.localLevel = 0;
    this.announce();
    this.emit();
  }

  toggleRemoteSilenced(): void {
    this.state.remoteSilenced = !this.state.remoteSilenced;
    this.audioEl.muted = this.state.remoteSilenced;
    if (!this.state.remoteSilenced) this.tryPlay();
    this.emit();
  }

  /** Call from any user gesture when `needsGesture` is set. */
  resumePlayback(): void {
    this.tryPlay();
    void this.ctx?.resume().catch(() => {});
  }

  // ---------------------------------------------------------------- internals

  private fail(message: string): void {
    this.state.mic = this.local ? this.state.mic : 'error';
    this.state.micError = message;
    this.emit();
  }

  private announce(): void {
    const track = this.local?.getAudioTracks()[0];
    this.onAnnounce?.(!!this.local, !!track && !track.enabled);
  }

  private tryPlay(): void {
    if (!this.audioEl.srcObject) return;
    const p = this.audioEl.play();
    if (p && typeof p.then === 'function') {
      p.then(
        () => {
          if (this.state.needsGesture) {
            this.state.needsGesture = false;
            this.emit();
          }
        },
        () => {
          this.state.needsGesture = true;
          this.emit();
        },
      );
    }
  }

  private dropRemote(): void {
    this.remoteSource?.disconnect();
    this.remoteSource = null;
    this.remoteAnalyser = null;
    this.remoteStream = null;
    this.audioEl.srcObject = null;
    this.state.remoteConnected = false;
    this.state.remoteLevel = 0;
    this.state.needsGesture = false;
    this.emit();
  }

  private audioCtx(): AudioContext | null {
    if (this.ctx) return this.ctx;
    try {
      const Ctor =
        window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return null;
      this.ctx = new Ctor();
      return this.ctx;
    } catch {
      return null;
    }
  }

  private makeAnalyser(stream: MediaStream): { analyser: AnalyserNode; source: MediaStreamAudioSourceNode } | null {
    const ctx = this.audioCtx();
    if (!ctx) return null;
    try {
      void ctx.resume().catch(() => {});
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      source.connect(analyser); // meter only — never routed to the speakers
      return { analyser, source };
    } catch {
      return null;
    }
  }

  private connectLocalAnalyser(): void {
    if (!this.local) return;
    this.localAnalyser = this.makeAnalyser(this.local)?.analyser ?? null;
  }

  private connectRemoteAnalyser(): void {
    if (!this.remoteStream) return;
    this.remoteSource?.disconnect();
    const made = this.makeAnalyser(this.remoteStream);
    this.remoteAnalyser = made?.analyser ?? null;
    this.remoteSource = made?.source ?? null;
  }

  private level(a: AnalyserNode | null): number {
    if (!a) return 0;
    a.getByteTimeDomainData(this.buf);
    let sum = 0;
    for (let i = 0; i < a.fftSize; i++) {
      const v = (this.buf[i]! - 128) / 128;
      sum += v * v;
    }
    return Math.min(1, Math.sqrt(sum / a.fftSize) * 4);
  }

  private startMeters(): void {
    if (this.rafId) return;
    let last = 0;
    const tick = (t: number) => {
      this.rafId = requestAnimationFrame(tick);
      if (t - last < 80) return; // ~12 Hz is plenty for a speaking indicator
      last = t;
      const live = this.state.mic === 'live';
      const l = live ? this.level(this.localAnalyser) : 0;
      const r = this.state.remoteConnected && !this.state.remoteSilenced ? this.level(this.remoteAnalyser) : 0;
      if (Math.abs(l - this.state.localLevel) > 0.02 || Math.abs(r - this.state.remoteLevel) > 0.02) {
        this.state.localLevel = l;
        this.state.remoteLevel = r;
        this.emit();
      }
      if (!this.local && !this.remoteStream) {
        cancelAnimationFrame(this.rafId);
        this.rafId = 0;
      }
    };
    this.rafId = requestAnimationFrame(tick);
  }

  private emit(): void {
    this.onChange?.(this.state);
  }
}
