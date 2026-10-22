/**
 * Tiny synthesised sound kit (Web Audio, no files). Everything fails
 * silently: if audio is blocked or unsupported the game simply stays quiet.
 */
type Sfx = 'pickup' | 'dash' | 'tackle' | 'bump' | 'score' | 'tick' | 'go' | 'win' | 'lose' | 'drop' | 'event' | 'click';

class SoundKit {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  muted = false;

  /** Must be called from a user gesture at least once (autoplay policy). */
  unlock(): void {
    try {
      if (!this.ctx) {
        const Ctor =
          window.AudioContext ??
          (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (!Ctor) return;
        this.ctx = new Ctor();
        this.master = this.ctx.createGain();
        this.master.gain.value = 0.32;
        this.master.connect(this.ctx.destination);
      }
      if (this.ctx.state === 'suspended') void this.ctx.resume().catch(() => {});
    } catch {
      this.ctx = null;
    }
  }

  setMuted(m: boolean): void {
    this.muted = m;
  }

  private tone(
    freq: number,
    dur: number,
    opts: { type?: OscillatorType; to?: number; gain?: number; delay?: number } = {},
  ): void {
    const ctx = this.ctx;
    const out = this.master;
    if (!ctx || !out || this.muted || ctx.state !== 'running') return;
    try {
      const t0 = ctx.currentTime + (opts.delay ?? 0);
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = opts.type ?? 'square';
      osc.frequency.setValueAtTime(freq, t0);
      if (opts.to) osc.frequency.exponentialRampToValueAtTime(opts.to, t0 + dur);
      const peak = opts.gain ?? 0.25;
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(peak, t0 + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      osc.connect(g).connect(out);
      osc.start(t0);
      osc.stop(t0 + dur + 0.02);
    } catch {
      /* ignore */
    }
  }

  private noise(dur: number, gain = 0.3, delay = 0): void {
    const ctx = this.ctx;
    const out = this.master;
    if (!ctx || !out || this.muted || ctx.state !== 'running') return;
    try {
      const len = Math.floor(ctx.sampleRate * dur);
      const buf = ctx.createBuffer(1, len, ctx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
      const src = ctx.createBufferSource();
      src.buffer = buf;
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = 1400;
      const g = ctx.createGain();
      g.gain.value = gain;
      src.connect(f).connect(g).connect(out);
      src.start(ctx.currentTime + delay);
    } catch {
      /* ignore */
    }
  }

  play(s: Sfx): void {
    switch (s) {
      case 'pickup':
        this.tone(660, 0.08, { type: 'triangle', to: 1320, gain: 0.22 });
        break;
      case 'drop':
        this.tone(520, 0.14, { type: 'triangle', to: 180, gain: 0.2 });
        break;
      case 'dash':
        this.noise(0.09, 0.12);
        this.tone(240, 0.09, { type: 'sawtooth', to: 520, gain: 0.06 });
        break;
      case 'tackle':
        this.noise(0.16, 0.42);
        this.tone(160, 0.18, { type: 'square', to: 60, gain: 0.22 });
        break;
      case 'bump':
        this.noise(0.08, 0.18);
        break;
      case 'score':
        [523, 659, 784, 1046].forEach((f, i) => this.tone(f, 0.16, { type: 'square', gain: 0.14, delay: i * 0.07 }));
        break;
      case 'tick':
        this.tone(440, 0.09, { type: 'square', gain: 0.14 });
        break;
      case 'go':
        this.tone(880, 0.22, { type: 'square', gain: 0.16 });
        break;
      case 'win':
        [523, 659, 784, 1046, 1318].forEach((f, i) => this.tone(f, 0.22, { type: 'triangle', gain: 0.18, delay: i * 0.09 }));
        break;
      case 'lose':
        [392, 330, 262].forEach((f, i) => this.tone(f, 0.26, { type: 'triangle', gain: 0.14, delay: i * 0.12 }));
        break;
      case 'event':
        this.tone(300, 0.3, { type: 'sine', to: 900, gain: 0.14 });
        break;
      case 'click':
        this.tone(1200, 0.03, { type: 'square', gain: 0.05 });
        break;
    }
  }
}

export const sound = new SoundKit();
export type { Sfx };
