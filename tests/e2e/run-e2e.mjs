/**
 * Automated two-browser test.
 *
 *   npm run build:e2e && npm run test:e2e
 *
 * - Serves the e2e build under a GitHub-Pages-style sub-path (/snatch/).
 * - Runs a local Trystero WebSocket relay for peer discovery (no internet).
 * - Opens separate Chromium browser contexts (separate storage = separate "devices"
 *   on the same machine) and plays through: create → invite link → join →
 *   third-player rejection → ready → start → networked input → pickup →
 *   tackle/steal → goal → sudden death → results → rematch → disconnect →
 *   unknown room timeout.
 *
 * Real WebRTC data channels are used between the browsers. What this CANNOT
 * prove is NAT traversal across two different real-world networks.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createWsRelayServer } from '@trystero-p2p/ws-relay/server';

const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  ({ chromium } = require('/opt/npm-tools/node_modules/playwright'));
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DIST = path.join(ROOT, 'dist-e2e');
const SHOTS = process.env.E2E_SHOTS ?? path.join(ROOT, 'tests/e2e/screenshots');
const BASE = '/snatch/';
const PORT = 4799;
const SKIP_TIMEOUT_TEST = process.env.E2E_SKIP_TIMEOUT === '1';
fs.mkdirSync(SHOTS, { recursive: true });

// ---------------------------------------------------------------- servers
const relay = createWsRelayServer({ port: 8787 });
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (!url.pathname.startsWith(BASE)) {
    res.writeHead(404).end('not under base path');
    return;
  }
  let rel = url.pathname.slice(BASE.length) || 'index.html';
  const file = path.join(DIST, rel);
  if (!file.startsWith(DIST) || !fs.existsSync(file)) {
    res.writeHead(404).end('missing ' + rel);
    return;
  }
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
const SITE = `http://127.0.0.1:${PORT}${BASE}`;
// The sandbox has no GPU (WebGL falls back to ~4 fps software rendering), so the
// test forces Phaser's Canvas renderer. Real browsers use WebGL automatically.
const Q = process.env.E2E_WEBGL === '1' ? '' : '?renderer=canvas';
const roomUrl = (code) => `${SITE}${Q ? Q + '&' : '?'}room=${code}`;

// ---------------------------------------------------------------- helpers
const results = [];
let failed = 0;
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(page, fn, arg, timeout = 15000) {
  try {
    await page.waitForFunction(fn, arg, { timeout, polling: 50 });
    return true;
  } catch {
    return false;
  }
}
const screen = (page) => page.evaluate(() => document.body.dataset.screen);
const hostState = (page) =>
  page.evaluate(() => {
    const s = window.__snatch.session.host?.state;
    return s ? JSON.parse(JSON.stringify(s)) : null;
  });
const mutateHost = (page, code) => page.evaluate(code);

const browser = await chromium.launch({
  args: ['--disable-features=WebRtcHideLocalIpsWithMdns', '--autoplay-policy=no-user-gesture-required'],
});
const ctxA = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const ctxB = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const A = await ctxA.newPage();
const B = await ctxB.newPage();
const consoleErrors = [];
for (const [label, p] of [['A', A], ['B', B]]) {
  p.on('pageerror', (e) => consoleErrors.push(`${label}: ${e.message}`));
  p.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(`${label}: ${m.text()}`);
  });
}

try {
  // ------------------------------------------------------------ landing
  const resp = await A.goto(SITE + Q);
  check('1. landing page loads under sub-path ' + BASE, resp?.status() === 200 && (await screen(A)) === 'menu');
  check('   title + subtitle present', (await A.textContent('.tagline'))?.includes("Don't get robbed"));
  await A.screenshot({ path: path.join(SHOTS, '01-menu.png') });

  // ------------------------------------------------------------ create
  await A.fill('#nickname', 'Alice');
  await A.click('#btn-create');
  const code = (await A.textContent('#lobby-code'))?.trim();
  check('   host gets a 6-char room code', /^[A-HJKMNP-Z2-9]{6}$/.test(code ?? ''), code);
  check('   host status shows "Waiting for opponent"', (await A.textContent('#lobby-status'))?.includes('Waiting for opponent'));

  // ------------------------------------------------------------ join via invite link
  await B.goto(roomUrl(code));
  check('   invite link pre-fills the code', (await B.inputValue('#join-code')) === code);
  await B.fill('#nickname', 'Bob');
  await B.click('#btn-join');
  const joined = await waitFor(B, () => document.body.dataset.screen === 'lobby', null, 25000);
  check('2. guest joins the host lobby over WebRTC', joined);
  const hostSees = await waitFor(A, () => document.querySelector('#slot-1 .slot-name')?.textContent === 'Bob');
  check('   host sees guest name in slot 2', hostSees);
  check(
    '4. roles consistent (host=cyan slot 1, guest=orange slot 2)',
    (await B.textContent('#slot-0 .slot-name')) === 'Alice' && (await B.textContent('#slot-1 .slot-name')) === 'Bob' &&
      (await B.isVisible('#btn-start')) === false && (await A.isVisible('#btn-start')) === true,
  );

  // ------------------------------------------------------------ third player
  const ctxC = await browser.newContext();
  const C = await ctxC.newPage();
  await C.goto(roomUrl(code));
  await C.fill('#nickname', 'Carol');
  await C.click('#btn-join');
  const rejected = await waitFor(C, () => !document.querySelector('#overlay-alert').hidden, null, 25000);
  const cTitle = await C.textContent('#alert-title');
  check('5. third player is refused ("Room is full")', rejected && cTitle === 'Room is full', cTitle ?? '');
  await C.screenshot({ path: path.join(SHOTS, '05-room-full.png') });
  check(
    '   host lobby unaffected by the third peer',
    (await A.textContent('#slot-1 .slot-name')) === 'Bob' && (await B.textContent('#slot-0 .slot-name')) === 'Alice',
  );
  await ctxC.close();

  // ------------------------------------------------------------ ready + start
  check('   start disabled until both ready', await A.isDisabled('#btn-start'));
  await B.click('#btn-ready');
  const oppReady = await waitFor(A, () => document.querySelector('#lobby-status')?.textContent?.includes('Opponent ready'));
  check('6. host sees "Opponent ready"', oppReady);
  await A.click('#btn-ready');
  const canStart = await waitFor(A, () => !document.querySelector('#btn-start').disabled);
  check('   host can start once both ready', canStart);
  await A.screenshot({ path: path.join(SHOTS, '02-lobby-host.png') });
  await B.screenshot({ path: path.join(SHOTS, '03-lobby-guest.png') });
  await A.click('#btn-start');
  const bothInGame =
    (await waitFor(A, () => document.body.dataset.screen === 'game')) &&
    (await waitFor(B, () => document.body.dataset.screen === 'game'));
  check('   match start synchronised (both in game)', bothInGame);
  const countdownSeen = await waitFor(B, () => /^[123]$/.test(document.querySelector('#center-banner')?.textContent?.trim() ?? ''), null, 4000);
  check('   guest sees the shared 3-2-1 countdown', countdownSeen);
  await B.screenshot({ path: path.join(SHOTS, '04-countdown-guest.png') });
  const live = await waitFor(A, () => window.__snatch.session.host?.state.phase === 'playing', null, 6000);
  check('   countdown ends in live play', live);

  // ------------------------------------------------------------ guest input reaches host
  const before = (await hostState(A)).players[1].x;
  await B.keyboard.down('KeyA');
  await sleep(700);
  await B.keyboard.up('KeyA');
  const after = (await hostState(A)).players[1].x;
  check('   guest keyboard input moves the guest on the HOST simulation', after < before - 60, `${before.toFixed(0)} → ${after.toFixed(0)}`);

  // ------------------------------------------------------------ pickup sync
  await mutateHost(A, () => {
    const s = window.__snatch.session.host.state;
    s.players[0].x = s.token.x - 22;
    s.players[0].y = s.token.y;
    s.players[1].x = 860;
    s.players[1].y = 310;
  });
  const pickedHost = await waitFor(A, () => window.__snatch.session.host.state.token.carrier === 0, null, 3000);
  const pickedGuest = await waitFor(B, () => {
    const g = window.__snatch.session.guest;
    const snap = g && g.buffer.latest();
    return snap && snap.view.token.carrier === 0;
  }, null, 3000);
  check('7. both players see the same token carrier', pickedHost && pickedGuest);
  await sleep(150);
  await A.screenshot({ path: path.join(SHOTS, '06-host-carrying.png') });

  // ------------------------------------------------------------ guest tackles host
  await mutateHost(A, () => {
    const s = window.__snatch.session.host.state;
    s.players[0].x = 600; s.players[0].y = 310; s.players[0].vx = 0; s.players[0].vy = 0;
    s.players[0].immunity = 0;
    s.players[1].x = 600 + 19 * 2 + 40; s.players[1].y = 310; s.players[1].vx = 0; s.players[1].vy = 0;
    s.players[1].dashCooldown = 0;
  });
  await sleep(250); // let the guest's view catch up
  await B.evaluate(() => {
    window.__evs = [];
    const h = window.__snatch.session.hud;
    const orig = h.onEvents.bind(h);
    h.onEvents = (evs) => {
      window.__evs.push(...evs.map((e) => `${e.type}:${e.player}`));
      orig(evs);
    };
  });
  await B.keyboard.down('ArrowLeft');
  await B.keyboard.press('Space');
  const dropped = await waitFor(A, () => window.__snatch.session.host.state.token.carrier !== 0, null, 2000);
  await B.keyboard.up('ArrowLeft');
  const hs = await hostState(A);
  check('8. guest dash into the carrier knocks the token loose (host-validated)', dropped, `carrier now ${hs.token.carrier}`);
  const guestSawTackle = await waitFor(B, () => window.__evs.includes('tackle:1'), null, 1500);
  check('   guest receives the tackle event (SNATCHED! feedback)', guestSawTackle, (await B.evaluate(() => window.__evs.join(','))));
  await B.screenshot({ path: path.join(SHOTS, '07-guest-after-tackle.png') });

  // ------------------------------------------------------------ goal
  await mutateHost(A, () => {
    const s = window.__snatch.session.host.state;
    s.token.carrier = 1; s.token.lockout = 0;
    s.players[1].immunity = 5;
    s.players[1].x = 976 - 33; s.players[1].y = 310;
  });
  const scoredHost = await waitFor(A, () => window.__snatch.session.host.state.scores[1] === 1, null, 3000);
  const scoredGuest = await waitFor(B, () => document.querySelector('#hud-score-1')?.textContent === '1', null, 3000);
  const scoredHostHud = await waitFor(A, () => document.querySelector('#hud-score-1')?.textContent === '1', null, 3000);
  await sleep(1500);
  const hs2 = await hostState(A);
  check('9. carrying the token into own gate scores exactly one goal (both HUDs agree)', scoredHost && scoredGuest && scoredHostHud && hs2.scores[1] === 1, JSON.stringify(hs2.scores));
  const wrongGate = await mutateHost(A, async () => {
    const s = window.__snatch.session.host.state;
    await new Promise((r) => { const t = setInterval(() => { if (s.phase === 'playing') { clearInterval(t); r(); } }, 20); });
    s.token.carrier = 0; s.players[0].immunity = 5; s.players[0].x = 976 - 33; s.players[0].y = 310;
    await new Promise((r) => setTimeout(r, 300));
    return s.scores.slice();
  });
  check('   carrying into the OPPONENT gate does not score', wrongGate[0] === 0 && wrongGate[1] === 1, JSON.stringify(wrongGate));

  // ------------------------------------------------------------ sudden death
  await mutateHost(A, () => {
    const s = window.__snatch.session.host.state;
    s.token.carrier = -1; s.token.x = 500; s.token.y = 310;
    s.players[0].x = 300; s.players[0].y = 310;
    s.scores[0] = 1; s.scores[1] = 1;
    s.timeLeft = 0.4;
  });
  const sd = await waitFor(B, () => document.querySelector('#hud-timer')?.textContent === 'SUDDEN DEATH', null, 3000);
  check('10. tie at full time → sudden death shown to the guest', sd);
  await B.screenshot({ path: path.join(SHOTS, '08-sudden-death-guest.png') });
  await mutateHost(A, () => {
    const s = window.__snatch.session.host.state;
    s.token.carrier = 0; s.players[0].immunity = 5; s.players[0].x = 24 + 33; s.players[0].y = 310;
  });
  const resA = await waitFor(A, () => !document.querySelector('#overlay-results').hidden, null, 6000);
  const resB = await waitFor(B, () => !document.querySelector('#overlay-results').hidden, null, 6000);
  const outA = await A.textContent('#res-outcome');
  const outB = await B.textContent('#res-outcome');
  const scA = [await A.textContent('#res-score-0'), await A.textContent('#res-score-1')].join('-');
  const scB = [await B.textContent('#res-score-0'), await B.textContent('#res-score-1')].join('-');
  check('    sudden-death goal ends the match; results agree on both screens', resA && resB && outA === 'YOU WIN!' && outB === 'YOU LOSE' && scA === '2-1' && scB === '2-1', `${outA} / ${outB}  ${scA} vs ${scB}`);
  await A.screenshot({ path: path.join(SHOTS, '09-results-host.png') });
  await B.screenshot({ path: path.join(SHOTS, '10-results-guest.png') });

  // ------------------------------------------------------------ rematch
  await B.click('#btn-again');
  const askSeen = await waitFor(A, () => /wants a rematch/.test(document.querySelector('#res-rematch')?.textContent ?? ''), null, 3000);
  check('11. host sees the rematch request', askSeen);
  await A.click('#btn-again');
  const reA = await waitFor(A, () => window.__snatch.session.host?.state.phase === 'countdown', null, 4000);
  const reB = await waitFor(B, () => document.body.dataset.screen === 'game' && document.querySelector('#overlay-results').hidden, null, 4000);
  const fresh = await hostState(A);
  check('    rematch resets score, token, positions and timer', reA && reB && fresh.scores.join() === '0,0' && fresh.timeLeft === 90 && fresh.token.carrier === -1);
  const guestZero = await waitFor(B, () => document.querySelector('#hud-score-0')?.textContent === '0' && document.querySelector('#hud-score-1')?.textContent === '0', null, 3000);
  check('    guest HUD reset for the rematch', guestZero);
  await waitFor(A, () => window.__snatch.session.host?.state.phase === 'playing', null, 5000);
  await sleep(400);
  await A.screenshot({ path: path.join(SHOTS, '11-rematch-live-host.png') });
  // Arena event is host-driven and replicated in snapshots.
  await mutateHost(A, () => {
    const s = window.__snatch.session.host.state;
    s.eventsEnabled = true;
    s.event.nextIn = 0.01;
  });
  const evOnGuest = await waitFor(B, () => {
    const v = window.__snatch.session.guest?.buffer.latest()?.view;
    return v && v.event.kind !== 'none';
  }, null, 3000);
  const hostKind = (await hostState(A)).event.kind;
  check('    arena event chosen by host is replicated to the guest', evOnGuest, hostKind);
  await sleep(1500);
  await B.screenshot({ path: path.join(SHOTS, '11b-arena-event-guest.png') });

  // ------------------------------------------------------------ disconnect
  await ctxB.close();
  const dc = await waitFor(A, () => !document.querySelector('#overlay-alert').hidden, null, 20000);
  const dcTitle = await A.textContent('#alert-title');
  check('12. closing the guest tab → host sees "Opponent disconnected"', dc && dcTitle === 'Opponent disconnected', dcTitle ?? '');
  const hostStopped = await A.evaluate(() => window.__snatch.session.host === null);
  check('    match stopped, no automatic win recorded', hostStopped && (await A.evaluate(() => JSON.parse(localStorage.getItem('snatch.stats.v1') || '{}').played)) === 1);
  await A.screenshot({ path: path.join(SHOTS, '12-disconnected.png') });
  await A.click('#alert-actions .btn-primary');
  check('    host can return to the open lobby', (await screen(A)) === 'lobby' && (await A.textContent('#lobby-status'))?.includes('Waiting'));

  // ------------------------------------------------------------ mobile layout
  const ctxM = await browser.newContext({ viewport: { width: 844, height: 390 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  const M = await ctxM.newPage();
  await M.goto(roomUrl(code));
  check('13. touch device detected (mobile controls enabled)', await M.evaluate(() => document.body.classList.contains('touch')));
  await M.fill('#nickname', 'Mo');
  await M.click('#btn-join');
  const mJoined = await waitFor(M, () => document.body.dataset.screen === 'lobby', null, 25000);
  await M.click('#btn-ready');
  await waitFor(A, () => document.querySelector('#lobby-status')?.textContent?.includes('Opponent ready'));
  await A.click('#btn-ready');
  await waitFor(A, () => !document.querySelector('#btn-start').disabled);
  await A.click('#btn-start');
  const mGame = await waitFor(M, () => document.body.dataset.screen === 'game', null, 5000);
  await waitFor(A, () => window.__snatch.session.host?.state.phase === 'playing', null, 6000);
  const joy = await M.$('.joystick');
  const jb = await joy.boundingBox();
  const beforeM = (await hostState(A)).players[1].x;
  // Drag the virtual joystick to the left for ~700 ms.
  await M.evaluate(({ x, y }) => {
    const el = document.querySelector('.joystick');
    const ev = (type, cx) => el.dispatchEvent(new PointerEvent(type, { pointerId: 7, clientX: cx, clientY: y, bubbles: true, pointerType: 'touch' }));
    ev('pointerdown', x);
    ev('pointermove', x - 60);
    window.__joyRelease = () => ev('pointerup', x - 60);
  }, { x: jb.x + jb.width / 2, y: jb.y + jb.height / 2 });
  await sleep(700);
  await M.evaluate(() => window.__joyRelease());
  const afterM = (await hostState(A)).players[1].x;
  check('    virtual joystick drives the guest on the host', mJoined && mGame && afterM < beforeM - 50, `${beforeM.toFixed(0)} → ${afterM.toFixed(0)}`);
  const cdBefore = (await hostState(A)).players[1].dashCooldown;
  await M.dispatchEvent('.dash-btn', 'pointerdown', { pointerId: 9, pointerType: 'touch' });
  await M.dispatchEvent('.dash-btn', 'pointerup', { pointerId: 9, pointerType: 'touch' });
  const dashed = await waitFor(A, () => window.__snatch.session.host.state.players[1].dashCooldown > 0.5, null, 1500);
  check('    touch DASH button triggers a dash', cdBefore === 0 && dashed);
  const scrolled = await M.evaluate(() => getComputedStyle(document.body).touchAction === 'none' && getComputedStyle(document.body).position === 'fixed');
  check('    page scroll locked during play', scrolled);
  await M.screenshot({ path: path.join(SHOTS, '13-mobile-landscape.png') });
  await M.setViewportSize({ width: 390, height: 844 });
  await sleep(400);
  await M.screenshot({ path: path.join(SHOTS, '14-mobile-portrait.png') });
  await ctxM.close();
  await waitFor(A, () => !document.querySelector('#overlay-alert').hidden, null, 20000);

  // ------------------------------------------------------------ unknown room
  if (!SKIP_TIMEOUT_TEST) {
    const ctxD = await browser.newContext();
    const D = await ctxD.newPage();
    await D.goto(SITE + Q);
    await D.fill('#nickname', 'Dee');
    await D.fill('#join-code', 'ZZZZ22');
    await D.click('#btn-join');
    await sleep(3000);
    await D.screenshot({ path: path.join(SHOTS, '15-connecting.png') });
    const t0 = Date.now();
    const timedOut = await waitFor(D, () => !document.querySelector('#overlay-alert').hidden, null, 35000);
    const title = await D.textContent('#alert-title');
    check('12b. unknown room code → clear timeout message', timedOut && title === 'No host found', `${title} after ~${Math.round((Date.now() - t0) / 1000 + 3)}s`);
    await D.screenshot({ path: path.join(SHOTS, '16-no-host.png') });
    // Invalid code is rejected before connecting.
    await D.click('#alert-actions .btn-ghost');
    await D.fill('#join-code', 'ABC10O');
    await D.click('#btn-join');
    check('    invalid code explained without connecting', (await D.textContent('#join-error'))?.length > 0 && (await screen(D)) === 'menu');
    await ctxD.close();
  }

  check('no uncaught page errors', consoleErrors.filter((e) => !/relay|WebSocket|ERR_/i.test(e)).length === 0, consoleErrors.join(' | ').slice(0, 400));
} catch (err) {
  check('test run completed without exceptions', false, String(err?.stack ?? err));
} finally {
  await browser.close();
  server.close();
  relay.close?.();
  console.log(`\n${results.length - failed}/${results.length} checks passed.`);
  fs.writeFileSync(path.join(SHOTS, 'results.json'), JSON.stringify(results, null, 2));
  process.exit(failed ? 1 : 0);
}
