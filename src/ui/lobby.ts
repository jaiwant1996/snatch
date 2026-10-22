/** Renders the lobby screen from plain state. All behaviour lives in the Session. */
import type { Role } from '../network/messages';
import { $, setText } from './dom';

export interface LobbyViewState {
  code: string;
  role: Role;
  myName: string;
  myReady: boolean;
  opp: { name: string; ready: boolean } | null;
  eventsEnabled: boolean;
  starting: boolean;
  relayWarning: string | null;
}

type StatusKind = 'waiting' | 'connected' | 'ready' | 'starting' | 'lost';

export function renderLobby(s: LobbyViewState): void {
  setText($('#lobby-code'), s.code);

  // Slot 0 is always the host (cyan), slot 1 the guest (orange).
  const host = s.role === 'host' ? { name: s.myName, ready: s.myReady, me: true } : s.opp ? { ...s.opp, me: false } : null;
  const guest = s.role === 'guest' ? { name: s.myName, ready: s.myReady, me: true } : s.opp ? { ...s.opp, me: false } : null;
  renderSlot(0, host, s.role === 'guest' && !s.opp);
  renderSlot(1, guest, false);

  let kind: StatusKind;
  let text: string;
  if (s.starting) {
    kind = 'starting';
    text = 'Starting…';
  } else if (!s.opp) {
    kind = s.role === 'host' ? 'waiting' : 'lost';
    text = s.role === 'host' ? 'Waiting for opponent' : 'Connection lost';
  } else if (s.myReady && s.opp.ready) {
    kind = 'ready';
    text = s.role === 'host' ? 'Both ready — start the match!' : `Both ready — waiting for ${s.opp.name} to start`;
  } else if (s.opp.ready) {
    kind = 'ready';
    text = 'Opponent ready';
  } else if (s.myReady) {
    kind = 'connected';
    text = `Connected — waiting for ${s.opp.name} to ready up`;
  } else {
    kind = 'connected';
    text = 'Connected';
  }
  const status = $('#lobby-status');
  status.dataset.kind = kind;
  setText($('.text', status), text);

  const ready = $<HTMLButtonElement>('#btn-ready');
  ready.textContent = s.myReady ? 'Cancel Ready' : 'Ready';
  ready.classList.toggle('is-ready', s.myReady);
  ready.disabled = !s.opp || s.starting;

  const start = $<HTMLButtonElement>('#btn-start');
  start.hidden = s.role !== 'host';
  start.disabled = !(s.opp && s.opp.ready && s.myReady) || s.starting;
  $('.lobby-actions').style.gridTemplateColumns = s.role === 'host' ? '1fr 1fr' : '1fr';

  const ev = $<HTMLInputElement>('#events-toggle');
  ev.checked = s.eventsEnabled;
  ev.disabled = s.role !== 'host' || s.starting;
  $('#events-toggle-wrap').classList.toggle('locked', s.role !== 'host');

  let hint = '';
  if (s.relayWarning) hint = s.relayWarning;
  else if (!s.opp && s.role === 'host') hint = 'Send the code or invite link to one friend. Keep this tab open.';
  else if (s.opp && !s.myReady) hint = 'Press Ready when you are set.';
  else if (s.role === 'guest' && s.opp && s.myReady && s.opp.ready) hint = 'The host starts the match.';
  else if (s.role === 'guest') hint = 'Arena events are chosen by the host.';
  setText($('#lobby-hint'), hint);
}

function renderSlot(i: 0 | 1, p: { name: string; ready: boolean; me: boolean } | null, connecting: boolean): void {
  const el = $(`#slot-${i}`);
  el.classList.toggle('empty', !p);
  el.classList.toggle('connected', !!p);
  el.classList.toggle('ready', !!p?.ready);
  el.classList.toggle('me', !!p?.me);
  setText($('.slot-name', el), p ? p.name : connecting ? 'Connecting…' : 'Waiting…');
  setText($('.slot-ready', el), p ? (p.ready ? 'Ready' : 'Not ready') : '—');
}
