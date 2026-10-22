/**
 * Entry point: boots Phaser, wires the HTML UI to the Session controller.
 */
import Phaser from 'phaser';
import './styles/main.css';
import { WORLD } from './config/gameConfig';
import { ArenaScene } from './game/ArenaScene';
import { LocalInput } from './game/input';
import { Session } from './lobby/lobbyManager';
import { buildInviteUrl, normalizeRoomCode, readRoomFromQuery, roomCodeProblem } from './lobby/roomCode';
import { sanitizeName } from './network/messages';
import { sound } from './ui/audio';
import { $, copyText, ICONS, setText, toast } from './ui/dom';
import { Hud } from './ui/hud';
import { VoiceChat } from './network/voice';
import { VoiceDock } from './ui/voiceDock';
import { prefs, reducedMotion, savePrefs, stats } from './ui/prefs';

// ----------------------------------------------------------------- platform

const isTouch =
  typeof matchMedia === 'function' &&
  (matchMedia('(pointer: coarse)').matches || matchMedia('(any-pointer: coarse)').matches) &&
  'ontouchstart' in window;
document.body.classList.toggle('touch', isTouch);

// Block pinch-zoom / scroll gestures during play (iOS ignores user-scalable=no).
document.addEventListener(
  'touchmove',
  (e) => {
    if (document.body.dataset.screen === 'game') e.preventDefault();
  },
  { passive: false },
);
document.addEventListener('gesturestart', (e) => e.preventDefault());

// ----------------------------------------------------------------- Phaser

const renderScale = Math.min(2, Math.max(1, Math.round((window.devicePixelRatio || 1) * 2) / 2));
// ?renderer=canvas forces the Canvas renderer (fallback for flaky GPUs/drivers).
const forceCanvas = new URLSearchParams(location.search).get('renderer') === 'canvas';
const scene = new ArenaScene();
const game = new Phaser.Game({
  type: forceCanvas ? Phaser.CANVAS : Phaser.AUTO,
  parent: 'game-root',
  transparent: true, // let the page background show around the arena
  width: WORLD.width * renderScale,
  height: WORLD.height * renderScale,
  scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH },
  render: { antialias: true, roundPixels: false },
  input: { keyboard: false, mouse: false, touch: false, gamepad: false },
  audio: { noAudio: true },
  fps: { target: 60, smoothStep: true },
  banner: false,
  scene: [scene],
});
// The canvas lives inside a container that is display:none until a match starts.
// Outside a match the render loop sleeps, so menus and lobbies cost ~no CPU/GPU.
const refreshScale = () => {
  // refresh() only re-measures the parent if its cached size is updated first.
  game.scale.getParentBounds();
  game.scale.refresh();
};
let gameReady = false;
function syncRenderLoop(): void {
  if (!gameReady) return;
  if (document.body.dataset.screen === 'game') {
    if (!game.loop.running) game.loop.wake();
    refreshScale();
    requestAnimationFrame(refreshScale);
  } else if (game.loop.running) {
    game.loop.sleep();
  }
}
game.events.once('ready', () => {
  gameReady = true;
  syncRenderLoop();
});
new MutationObserver(syncRenderLoop).observe(document.body, {
  attributes: true,
  attributeFilter: ['data-screen'],
});
window.addEventListener('resize', refreshScale);
window.addEventListener('orientationchange', () => setTimeout(refreshScale, 250));

// ----------------------------------------------------------------- session

const input = new LocalInput($('#touch-controls'));
const hud = new Hud();
const voice = new VoiceChat();
const voiceDock = new VoiceDock(voice);
const session = new Session(scene, input, hud, voice, voiceDock);

// ----------------------------------------------------------------- prefs / audio

const muteBtn = $<HTMLButtonElement>('#btn-mute');
function applyPrefs(): void {
  sound.setMuted(prefs.muted);
  muteBtn.innerHTML = prefs.muted ? ICONS.soundOff : ICONS.soundOn;
  muteBtn.setAttribute('aria-label', prefs.muted ? 'Unmute sound' : 'Mute sound');
  $<HTMLInputElement>('#opt-mute').checked = prefs.muted;
  $<HTMLInputElement>('#opt-motion').checked = reducedMotion();
  document.body.classList.toggle('reduce-motion', prefs.reducedMotion === true);
}
applyPrefs();
muteBtn.addEventListener('click', () => {
  prefs.muted = !prefs.muted;
  savePrefs();
  applyPrefs();
});
$<HTMLInputElement>('#opt-mute').addEventListener('change', (e) => {
  prefs.muted = (e.target as HTMLInputElement).checked;
  savePrefs();
  applyPrefs();
});
$<HTMLInputElement>('#opt-motion').addEventListener('change', (e) => {
  prefs.reducedMotion = (e.target as HTMLInputElement).checked;
  savePrefs();
  applyPrefs();
});
// Audio can only start after a user gesture; unlock on the first one.
const unlock = () => sound.unlock();
window.addEventListener('pointerdown', unlock, { passive: true });
window.addEventListener('keydown', unlock);

// ----------------------------------------------------------------- menu

const nickname = $<HTMLInputElement>('#nickname');
const joinCode = $<HTMLInputElement>('#join-code');
const joinError = $('#join-error');
const DEFAULT_NAMES = ['Blitz', 'Viper', 'Ziggy', 'Bolt', 'Jinx', 'Pixel', 'Fizz', 'Turbo', 'Swipe', 'Gecko'];

nickname.value = prefs.name;

function currentName(): string {
  let name = sanitizeName(nickname.value, '');
  if (!name) {
    name = `${DEFAULT_NAMES[Math.floor(Math.random() * DEFAULT_NAMES.length)]}${Math.floor(Math.random() * 90 + 10)}`;
    nickname.value = name;
  }
  prefs.name = name;
  savePrefs();
  return name;
}

function renderStats(): void {
  setText(
    $('#local-stats'),
    stats.played > 0
      ? `This device: ${stats.played} played · ${stats.wins} W – ${stats.losses} L · ${stats.goals} goals`
      : '',
  );
}
renderStats();
document.addEventListener('snatch:menu', renderStats);

$('#btn-create').addEventListener('click', () => {
  sound.unlock();
  session.createRoom(currentName());
});

joinCode.addEventListener('input', () => {
  const pos = joinCode.selectionStart;
  joinCode.value = joinCode.value.toUpperCase();
  joinCode.setSelectionRange(pos, pos);
  setText(joinError, '');
});

$('#join-form').addEventListener('submit', (e) => {
  e.preventDefault();
  sound.unlock();
  const code = normalizeRoomCode(joinCode.value);
  const problem = roomCodeProblem(code);
  if (problem) {
    setText(joinError, problem);
    joinCode.focus();
    return;
  }
  joinCode.value = code;
  session.joinRoom(code, currentName());
});

// Invite links: ?room=CODE pre-fills the join form.
const invited = readRoomFromQuery(location.search);
if (invited) {
  joinCode.value = invited;
  const btn = $<HTMLButtonElement>('#btn-join');
  btn.textContent = `Join ${invited}`;
  btn.classList.replace('btn-secondary', 'btn-primary');
  setText($('.tagline'), `You’ve been invited to room ${invited}. Pick a name and join!`);
  (prefs.name ? btn : nickname).focus();
}

$('#btn-cancel-join').addEventListener('click', () => session.cancelJoin());

// ----------------------------------------------------------------- lobby

$('#btn-ready').addEventListener('click', () => session.toggleReady());
$('#btn-start').addEventListener('click', () => session.hostStart());
$('#btn-leave-lobby').addEventListener('click', () => session.leaveToMenu());
$<HTMLInputElement>('#events-toggle').addEventListener('change', (e) =>
  session.setEventsEnabled((e.target as HTMLInputElement).checked),
);
$('#btn-copy-code').addEventListener('click', async () => {
  toast((await copyText(session.roomCode)) ? `Copied ${session.roomCode}` : 'Copy failed — select the code manually');
});
$('#btn-share').addEventListener('click', async () => {
  const url = buildInviteUrl(session.roomCode);
  const text = `Duel me in SNATCH! Room ${session.roomCode}`;
  if (navigator.share && isTouch) {
    try {
      await navigator.share({ title: 'SNATCH!', text, url });
      return;
    } catch {
      /* cancelled — fall through to copy */
    }
  }
  toast((await copyText(url)) ? 'Invite link copied' : url, 4000);
});

// ----------------------------------------------------------------- game overlays

$('#btn-pause').addEventListener('click', () => session.togglePause());
$('#btn-resume').addEventListener('click', () => session.togglePause());
$('#btn-quit').addEventListener('click', () => session.leaveToMenu());
$('#btn-again').addEventListener('click', () => session.requestRematch());
$('#btn-res-lobby').addEventListener('click', () => session.resultsToLobby());
$('#btn-res-menu').addEventListener('click', () => session.leaveToMenu());

// Exposed for the automated two-browser test only (harmless in production).
(window as unknown as { __snatch?: unknown }).__snatch = { session, scene, voice };
