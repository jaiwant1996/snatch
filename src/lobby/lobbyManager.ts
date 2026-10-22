/**
 * Session controller: the multiplayer state machine.
 *
 *   menu ──create──▶ lobby(host) ◀──────────────┐
 *   menu ──join────▶ connecting ──accepted──▶ lobby(guest)
 *   lobby ──both ready + host start──▶ match ──end──▶ results
 *   results ──both "Play Again"──▶ match            (connection reused)
 *   results ──"Lobby"──▶ lobby                     (both players)
 *   any ──peer leaves──▶ clear alert with Retry / Lobby / Menu
 *
 * The host's browser is authoritative for everything inside a match.
 * There is no host migration: if the host leaves, the match ends.
 */
import { NET } from '../config/gameConfig';
import type { ArenaScene } from '../game/ArenaScene';
import type { LocalInput } from '../game/input';
import { GuestMatch, HostMatch, type MatchHooks, type MatchResult } from '../game/match';
import { newMatchId, type ControlMsg, type HelloMsg, type RejectReason, type Role } from '../network/messages';
import { PeerRoom } from '../network/peerRoom';
import { sound } from '../ui/audio';
import { $, currentScreen, setText, showScreen, toast } from '../ui/dom';
import type { Hud } from '../ui/hud';
import { renderLobby } from '../ui/lobby';
import { hideAllOverlays, hideOverlay, isOverlayOpen, setRematchStatus, showAlert, showResults } from '../ui/overlays';
import { prefs, recordResult, savePrefs } from '../ui/prefs';
import { generateRoomCode } from './roomCode';

type Phase = 'idle' | 'connecting' | 'lobby' | 'match' | 'results';

export class Session {
  private gen = 0;
  private room: PeerRoom | null = null;
  private role: Role = 'host';
  private code = '';
  private myName = '';
  private myReady = false;
  private opp: { name: string; ready: boolean } | null = null;
  private eventsEnabled = prefs.arenaEvents;
  private phase: Phase = 'idle';
  private starting = false;
  private relayWarning: string | null = null;
  private host: HostMatch | null = null;
  private guest: GuestMatch | null = null;
  private currentMatchId = '';
  private lastResult: MatchResult | null = null;
  private rematch = { me: false, opp: false };
  private timers: Array<ReturnType<typeof setTimeout>> = [];
  private pingId: ReturnType<typeof setInterval> | null = null;
  private intervals: Array<ReturnType<typeof setInterval>> = [];

  constructor(
    private scene: ArenaScene,
    private input: LocalInput,
    private hud: Hud,
  ) {
    document.addEventListener('visibilitychange', () => this.onVisibility());
    window.addEventListener('pagehide', () => void this.room?.leave());
    input.onPause = () => this.togglePause();
  }

  // ------------------------------------------------------------------ entry

  createRoom(name: string): void {
    this.reset();
    this.role = 'host';
    this.code = generateRoomCode();
    this.myName = name;
    this.phase = 'lobby';
    this.openRoom();
    showScreen('lobby');
    this.render();
    this.scheduleRelayCheck();
  }

  joinRoom(code: string, name: string): void {
    this.reset();
    this.role = 'guest';
    this.code = code;
    this.myName = name;
    this.phase = 'connecting';
    this.openRoom();
    showScreen('connecting');
    setText($('#connecting-title'), `Joining room ${code}`);
    setText($('#connecting-detail'), 'Looking for the host… make sure your friend still has the lobby open.');
    const bar = $('#connecting-bar');
    const started = performance.now();
    bar.style.width = '0%';
    const gen = this.gen;
    this.intervals.push(
      setInterval(() => {
        if (gen !== this.gen) return;
        bar.style.width = `${Math.min(100, ((performance.now() - started) / NET.joinTimeoutMs) * 100)}%`;
      }, 250),
    );
    this.timers.push(
      setTimeout(() => {
        if (gen !== this.gen || this.phase !== 'connecting') return;
        const code = this.code;
        this.leave();
        showScreen('menu');
        showAlert({
          title: 'No host found',
          message:
            `Nobody answered in room ${code} within ${NET.joinTimeoutMs / 1000} seconds. Check the code and make sure ` +
            'your friend still has the lobby open. If the code is right, one of your networks may be blocking ' +
            'direct browser-to-browser connections (common on corporate Wi-Fi and some mobile carriers).',
          actions: [
            { label: 'Retry', kind: 'primary', onClick: () => this.joinRoom(code, this.myName) },
            { label: 'Main menu', kind: 'ghost', onClick: () => this.toMenu() },
          ],
        });
      }, NET.joinTimeoutMs),
    );
    this.scheduleRelayCheck();
  }

  cancelJoin(): void {
    this.leave();
    this.toMenu();
  }

  // ----------------------------------------------------------- room wiring

  private openRoom(): void {
    const gen = ++this.gen;
    const guard =
      <A extends unknown[]>(fn: (...a: A) => void) =>
      (...a: A) => {
        if (gen === this.gen) fn(...a);
      };
    this.room = new PeerRoom(this.code, this.role, this.myName, {
      onOpponentJoin: guard((hello: HelloMsg) => this.onOpponentJoin(hello)),
      onOpponentLeave: guard(() => this.onOpponentGone()),
      onRejected: guard((reason: RejectReason) => this.onRejected(reason)),
      onJoinError: guard((msg: string) => this.onJoinError(msg)),
      onControl: guard((msg: ControlMsg) => this.onControl(msg)),
      onInput: guard((msg) => this.host?.onGuestInput(msg)),
      onSnapshot: guard((msg) => this.guest?.onSnapshot(msg)),
    });
  }

  private scheduleRelayCheck(): void {
    const gen = this.gen;
    this.timers.push(
      setTimeout(() => {
        if (gen !== this.gen || this.opp) return;
        const h = PeerRoom.relayHealth();
        if (h.total > 0 && h.open === 0) {
          this.relayWarning =
            '⚠ Can’t reach the public signalling relays. Your network or an extension may be blocking them.';
          if (this.phase === 'connecting') setText($('#connecting-detail'), this.relayWarning);
          this.render();
        }
      }, NET.relayCheckMs),
    );
  }

  private onOpponentJoin(hello: HelloMsg): void {
    this.clearTimers();
    this.relayWarning = null;
    this.opp = { name: hello.name, ready: false };
    this.myReady = false;
    if (this.phase === 'connecting' || this.phase === 'lobby') {
      this.phase = 'lobby';
      showScreen('lobby');
    }
    sound.play('click');
    toast(this.role === 'host' ? `${hello.name} joined your room` : `Connected to ${hello.name}'s room`);
    this.sendLobby();
    this.startPing();
    this.render();
  }

  private onRejected(reason: RejectReason): void {
    if (this.phase !== 'connecting') return;
    const code = this.code;
    this.leave();
    const messages: Record<RejectReason, [string, string]> = {
      full: ['Room is full', `Room ${code} already has two players. Ask your friend for a fresh code.`],
      version: [
        'Version mismatch',
        'You and the host are running different versions of SNATCH!. Both of you should refresh the page, then try again.',
      ],
      role: ['Couldn’t join', 'The room handshake failed. Try again.'],
      room: ['Couldn’t join', 'The room handshake failed. Try again.'],
      busy: ['Match in progress', 'That room is busy right now.'],
    };
    const [title, message] = messages[reason];
    showScreen('menu');
    showAlert({
      title,
      message,
      actions: [
        { label: 'Retry', kind: 'primary', onClick: () => this.joinRoom(code, this.myName) },
        { label: 'Main menu', kind: 'ghost', onClick: () => this.toMenu() },
      ],
    });
  }

  private onJoinError(detail: string): void {
    if (this.phase === 'connecting') {
      const code = this.code;
      this.leave();
      showScreen('menu');
      showAlert({
        title: 'Direct connection failed',
        message:
          'The host was found, but your browsers could not open a direct peer-to-peer connection. This usually ' +
          'means a strict firewall or NAT on one side. Try again, or switch one player to a different network ' +
          `(e.g. phone hotspot). Details: ${detail}`,
        actions: [
          { label: 'Retry', kind: 'primary', onClick: () => this.joinRoom(code, this.myName) },
          { label: 'Main menu', kind: 'ghost', onClick: () => this.toMenu() },
        ],
      });
    } else if (this.role === 'host' && !this.opp) {
      toast('Someone tried to join, but a direct connection could not be made.', 4000);
    }
  }

  /** Opponent left (graceful 'leave' message or transport drop). Idempotent. */
  private onOpponentGone(): void {
    if (!this.opp) return;
    const name = this.opp.name;
    this.opp = null;
    this.myReady = false;
    this.starting = false;
    this.stopPing();
    const wasPlaying = this.phase === 'match' || this.phase === 'results';
    this.stopMatch();

    if (this.role === 'host') {
      if (wasPlaying) {
        showAlert({
          title: 'Opponent disconnected',
          message: `${name} left or lost their connection. The match was stopped — no result was recorded. Your room stays open for a new opponent.`,
          actions: [
            { label: 'Back to lobby', kind: 'primary', onClick: () => this.toLobby() },
            { label: 'Main menu', kind: 'ghost', onClick: () => { this.leave(); this.toMenu(); } },
          ],
        });
      } else {
        toast(`${name} left the room`);
        this.render();
      }
      return;
    }

    const code = this.code;
    this.leave();
    if (!wasPlaying) showScreen('menu');
    showAlert({
      title: wasPlaying ? 'Host disconnected' : 'Host left the room',
      message: wasPlaying
        ? `${name} left or lost their connection. The host’s browser runs the match, so it can’t continue without them.`
        : `${name} closed the room.`,
      actions: [
        { label: 'Rejoin room', kind: 'primary', onClick: () => this.joinRoom(code, this.myName) },
        { label: 'Main menu', kind: 'ghost', onClick: () => this.toMenu() },
      ],
    });
  }

  // --------------------------------------------------------------- control

  private onControl(msg: ControlMsg): void {
    switch (msg.t) {
      case 'lobby':
        if (!this.opp) return;
        this.opp.name = msg.name;
        this.opp.ready = msg.ready;
        if (this.role === 'guest') this.eventsEnabled = msg.events;
        if (this.phase === 'lobby') this.render();
        break;

      case 'start':
        if (this.role !== 'guest' || msg.matchId === this.currentMatchId) return; // duplicates ignored
        if ((this.phase === 'lobby' && this.myReady) || (this.phase === 'results' && this.rematch.me)) {
          this.eventsEnabled = msg.events;
          this.beginMatch(msg.matchId);
        } else {
          this.room?.sendControl({ t: 'abort', matchId: msg.matchId });
        }
        break;

      case 'abort':
        if (this.role === 'host' && this.host && msg.matchId === this.host.matchId && this.phase === 'match') {
          this.stopMatch();
          this.toLobby();
          toast('Opponent wasn’t ready — match cancelled.');
        }
        break;

      case 'end':
        if (this.role === 'guest' && this.guest && msg.matchId === this.guest.matchId && this.phase === 'match') {
          this.finishMatch({ matchId: msg.matchId, winner: msg.winner, scores: msg.scores, duration: msg.duration, reason: msg.reason });
        }
        break;

      case 'rematch':
        if (!this.lastResult || msg.matchId !== this.lastResult.matchId || this.phase !== 'results') return;
        this.rematch.opp = msg.want;
        this.updateRematchStatus();
        if (this.role === 'host' && this.rematch.me && this.rematch.opp) this.startMatch();
        break;

      case 'toLobby':
        if (this.phase === 'results' || this.phase === 'match') {
          toast(`${this.opp?.name ?? 'Opponent'} went back to the lobby`);
          this.toLobby();
        }
        break;

      case 'leave':
        this.onOpponentGone();
        break;

      case 'focus':
        if (this.role === 'host') this.host?.setGuestHidden(msg.hidden);
        break;
    }
  }

  private sendLobby(): void {
    this.room?.sendControl({ t: 'lobby', name: this.myName, ready: this.myReady, events: this.eventsEnabled });
  }

  // ----------------------------------------------------------------- lobby

  toggleReady(): void {
    if (this.phase !== 'lobby' || !this.opp || this.starting) return;
    this.myReady = !this.myReady;
    sound.play('click');
    this.sendLobby();
    this.render();
  }

  setEventsEnabled(on: boolean): void {
    if (this.role !== 'host') return;
    this.eventsEnabled = on;
    prefs.arenaEvents = on;
    savePrefs();
    this.sendLobby();
    this.render();
  }

  hostStart(): void {
    if (this.role !== 'host' || this.phase !== 'lobby' || !this.opp?.ready || !this.myReady || this.starting) return;
    this.startMatch();
  }

  // ----------------------------------------------------------------- match

  private startMatch(): void {
    if (this.role !== 'host' || !this.room?.connected) return;
    const matchId = newMatchId();
    this.starting = true;
    this.render();
    this.room.sendControl({ t: 'start', matchId, events: this.eventsEnabled });
    this.beginMatch(matchId);
  }

  private names(): [string, string] {
    const opp = this.opp?.name ?? 'Opponent';
    return this.role === 'host' ? [this.myName, opp] : [opp, this.myName];
  }

  private beginMatch(matchId: string): void {
    if (!this.room) return;
    this.stopMatch();
    hideAllOverlays();
    this.currentMatchId = matchId;
    this.phase = 'match';
    this.starting = false;
    this.rematch = { me: false, opp: false };
    this.lastResult = null;

    const names = this.names();
    const selfIndex = this.role === 'host' ? 0 : 1;
    const hooks: MatchHooks = {
      onEvents: (events) => {
        this.scene.pushEvents(events);
        this.hud.onEvents(events);
        if (events.some((e) => e.type === 'end')) this.input.setEnabled(false);
      },
      onEnd: (result) => {
        this.room?.sendControl({
          t: 'end',
          matchId: result.matchId,
          winner: result.winner,
          scores: result.scores,
          duration: result.duration,
          reason: result.reason,
        });
        this.finishMatch(result);
      },
      onFrame: (view) => this.hud.update(view),
    };

    this.input.resetForMatch();
    this.input.setEnabled(true);
    this.hud.reset(names, selfIndex);
    this.scene.clearEffects();
    if (this.role === 'host') {
      this.host = new HostMatch(matchId, this.eventsEnabled, names, this.room, this.input, hooks);
      this.scene.setDriver(this.host);
    } else {
      this.guest = new GuestMatch(matchId, names, this.room, this.input, hooks);
      this.scene.setDriver(this.guest);
    }
    if (document.hidden) this.onVisibility();
    showScreen('game');
  }

  private finishMatch(result: MatchResult): void {
    if (this.phase !== 'match') return;
    this.phase = 'results';
    this.lastResult = result;
    this.rematch = { me: false, opp: false };
    this.input.setEnabled(false);
    this.host?.stop();
    this.guest?.stop();
    const selfIndex = this.role === 'host' ? 0 : 1;
    const won = result.winner === -1 ? null : result.winner === selfIndex;
    recordResult(result.matchId, won, result.scores[selfIndex]);
    sound.play(won ? 'win' : 'lose');
    showResults(result, this.names(), selfIndex);
  }

  private stopMatch(): void {
    this.host?.stop();
    this.guest?.stop();
    this.host = null;
    this.guest = null;
    this.input.setEnabled(false);
    hideOverlay('pause');
  }

  requestRematch(): void {
    if (this.phase !== 'results' || !this.lastResult || !this.opp) return;
    this.rematch.me = true;
    sound.play('click');
    this.room?.sendControl({ t: 'rematch', matchId: this.lastResult.matchId, want: true });
    const btn = $<HTMLButtonElement>('#btn-again');
    btn.disabled = true;
    btn.textContent = 'Ready for more';
    this.updateRematchStatus();
    if (this.role === 'host' && this.rematch.opp) this.startMatch();
  }

  private updateRematchStatus(): void {
    const name = this.opp?.name ?? 'Opponent';
    if (this.rematch.me && this.rematch.opp) setRematchStatus('Rematch! Starting…');
    else if (this.rematch.me) setRematchStatus(`Waiting for ${name}…`);
    else if (this.rematch.opp) setRematchStatus(`${name} wants a rematch!`);
    else setRematchStatus('');
  }

  resultsToLobby(): void {
    this.room?.sendControl({ t: 'toLobby' });
    this.toLobby();
  }

  // ------------------------------------------------------------ navigation

  private toLobby(): void {
    this.stopMatch();
    hideAllOverlays();
    this.scene.setDriver(null);
    this.phase = 'lobby';
    this.starting = false;
    this.myReady = false;
    if (this.opp) this.opp.ready = false;
    this.currentMatchId = '';
    this.sendLobby();
    showScreen('lobby');
    this.render();
  }

  toMenu(): void {
    hideAllOverlays();
    this.scene.setDriver(null);
    this.phase = 'idle';
    showScreen('menu');
    document.dispatchEvent(new CustomEvent('snatch:menu'));
  }

  /** Leave the room entirely (sends a goodbye if connected). */
  leave(): void {
    this.stopMatch();
    this.stopPing();
    this.clearTimers();
    this.gen++; // invalidate callbacks from the old room
    const r = this.room;
    this.room = null;
    this.opp = null;
    this.myReady = false;
    this.starting = false;
    this.phase = 'idle';
    void r?.leave();
  }

  leaveToMenu(): void {
    this.leave();
    this.toMenu();
  }

  private reset(): void {
    this.leave();
    hideAllOverlays();
    this.relayWarning = null;
    this.lastResult = null;
    this.currentMatchId = '';
    this.eventsEnabled = prefs.arenaEvents;
  }

  // ----------------------------------------------------------------- misc

  togglePause(): void {
    if (currentScreen() !== 'game' || this.phase !== 'match') return;
    const open = isOverlayOpen('pause');
    $('#overlay-pause').hidden = open;
    this.input.setEnabled(open); // closing the menu re-enables controls
  }

  private onVisibility(): void {
    if (this.phase !== 'match') return;
    if (this.role === 'host') this.host?.setLocalHidden(document.hidden);
    else this.room?.sendControl({ t: 'focus', hidden: document.hidden });
  }

  private startPing(): void {
    this.stopPing();
    const gen = this.gen;
    this.pingId = setInterval(async () => {
        if (gen !== this.gen || this.phase !== 'match') return;
        const age = this.guest?.lastSnapshotAge ?? 0;
        const ms = await this.room?.ping();
        if (gen !== this.gen) return;
        if (age > NET.hostStallMs) this.hud.setNet('connection unstable', true);
        else if (ms == null) this.hud.setNet('', false);
        else this.hud.setNet(`${Math.round(ms)} ms`, ms > 180);
      }, 2000);
  }

  private stopPing(): void {
    if (this.pingId) clearInterval(this.pingId);
    this.pingId = null;
  }

  private clearTimers(): void {
    for (const t of this.timers) clearTimeout(t);
    for (const i of this.intervals) clearInterval(i);
    this.timers = [];
    this.intervals = [];
  }

  private render(): void {
    if (this.phase !== 'lobby' && this.phase !== 'connecting') return;
    renderLobby({
      code: this.code,
      role: this.role,
      myName: this.myName,
      myReady: this.myReady,
      opp: this.opp,
      eventsEnabled: this.eventsEnabled,
      starting: this.starting,
      relayWarning: this.relayWarning,
    });
  }

  get roomCode(): string {
    return this.code;
  }
}
