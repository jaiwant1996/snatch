/** Voice-chat controls: your mic button + the opponent's voice button. */
import type { VoiceChat, VoiceState } from '../network/voice';
import { $, toast } from './dom';

const ICON = {
  mic: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>',
  micOff:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 9.4V6a3 3 0 0 0-5.7-1.3M9 9v2a3 3 0 0 0 4.6 2.5M5 11a7 7 0 0 0 11.3 5.5M19 11a7 7 0 0 1-.6 2.8M12 18v3M3 3l18 18"/></svg>',
  ear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 14v-2a9 9 0 0 1 18 0v2"/><rect x="3" y="14" width="4" height="6" rx="1.5"/><rect x="17" y="14" width="4" height="6" rx="1.5"/></svg>',
  earOff:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 14v-2a9 9 0 0 1 14.5-7.1M21 12v2"/><rect x="3" y="14" width="4" height="6" rx="1.5"/><rect x="17" y="14" width="4" height="6" rx="1.5"/><path d="M3 3l18 18"/></svg>',
};

export class VoiceDock {
  private dock = $('#voice-dock');
  private mic = $<HTMLButtonElement>('#btn-mic');
  private opp = $<HTMLButtonElement>('#btn-opp-voice');
  private lastMicKey = '';
  private lastOppKey = '';
  private lastError: string | null = null;
  private oppName = 'Opponent';

  constructor(private voice: VoiceChat) {
    voice.onChange = (s) => this.render(s);
    this.mic.addEventListener('click', () => void voice.toggleMic());
    this.opp.addEventListener('click', () => {
      if (voice.state.needsGesture) voice.resumePlayback();
      else voice.toggleRemoteSilenced();
    });
    // Any tap unblocks remote audio if autoplay was refused.
    window.addEventListener(
      'pointerdown',
      () => {
        if (voice.state.needsGesture) voice.resumePlayback();
      },
      { passive: true },
    );
    // "V" toggles the mic (ignored while typing in a text field).
    window.addEventListener('keydown', (e) => {
      if (e.code !== 'KeyV' || e.repeat || this.dock.hidden) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
      void voice.toggleMic();
    });
    this.render(voice.state);
  }

  /** Show the dock only while paired with an opponent. */
  setVisible(on: boolean, opponentName?: string): void {
    if (opponentName) this.oppName = opponentName;
    this.dock.hidden = !on;
    document.body.classList.toggle('voice-ui', on);
    this.lastOppKey = '';
    this.render(this.voice.state);
  }

  private render(s: VoiceState): void {
    // ---- my mic
    const micKey = `${s.mic}|${s.supported}`;
    if (micKey !== this.lastMicKey) {
      this.lastMicKey = micKey;
      const live = s.mic === 'live';
      this.mic.innerHTML = live || s.mic === 'requesting' ? ICON.mic : ICON.micOff;
      this.mic.dataset.state = s.mic;
      const label =
        s.mic === 'off' || s.mic === 'error'
          ? 'Turn on voice chat (V)'
          : s.mic === 'requesting'
            ? 'Waiting for microphone permission…'
            : live
              ? 'Mute your mic (V)'
              : 'Unmute your mic (V)';
      this.mic.title = label;
      this.mic.setAttribute('aria-label', label);
      this.mic.setAttribute('aria-pressed', String(live));
    }
    this.mic.style.setProperty('--lvl', s.mic === 'live' ? s.localLevel.toFixed(2) : '0');

    // ---- opponent
    const oppKey = `${s.remote}|${s.remoteConnected}|${s.remoteSilenced}|${s.needsGesture}|${this.oppName}`;
    if (oppKey !== this.lastOppKey) {
      this.lastOppKey = oppKey;
      const state = s.needsGesture
        ? 'gesture'
        : s.remoteSilenced
          ? 'silenced'
          : s.remote === 'live' && s.remoteConnected
            ? 'live'
            : s.remote === 'muted'
              ? 'muted'
              : 'off';
      this.opp.dataset.state = state;
      this.opp.innerHTML = state === 'silenced' ? ICON.earOff : ICON.ear;
      const label =
        state === 'gesture'
          ? `Tap to hear ${this.oppName}`
          : state === 'silenced'
            ? `${this.oppName} is silenced — tap to listen`
            : state === 'live'
              ? `Listening to ${this.oppName} — tap to silence`
              : state === 'muted'
                ? `${this.oppName} muted their mic`
                : `${this.oppName}'s mic is off`;
      this.opp.title = label;
      this.opp.setAttribute('aria-label', label);
    }
    this.opp.style.setProperty('--lvl', s.remoteLevel.toFixed(2));

    if (s.micError && s.micError !== this.lastError) toast(s.micError, 5000);
    this.lastError = s.micError;
  }
}
