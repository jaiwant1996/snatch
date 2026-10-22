/** In-match heads-up display: scores, timer, event pill, banners, touch dash meter. */
import type { SimEvent } from '../game/simulation';
import type { ViewState } from '../game/view';
import { $, escapeHtml, formatClock, setText } from './dom';

export class Hud {
  private names: [string, string] = ['Cyan', 'Orange'];
  private selfIndex: 0 | 1 = 0;
  private lastScores: [number, number] = [0, 0];
  private bannerTimer: ReturnType<typeof setTimeout> | null = null;
  private bannerSticky = false;
  private timer = $('#hud-timer');
  private eventPill = $('#hud-event');
  private banner = $('#center-banner');
  private dashBtn = $('#touch-controls .dash-btn');
  private net = $('#net-pill');
  private score = [$('#hud-score-0'), $('#hud-score-1')] as const;
  private nameEls = [$('#hud-name-0'), $('#hud-name-1')] as const;

  reset(names: [string, string], selfIndex: 0 | 1): void {
    this.names = names;
    this.selfIndex = selfIndex;
    this.lastScores = [0, 0];
    this.nameEls.forEach((el, i) => {
      setText(el, names[i]!);
      el.classList.toggle('me', i === selfIndex);
    });
    this.score.forEach((el) => setText(el, '0'));
    setText(this.timer, '1:30');
    this.timer.className = 'hud-timer';
    setText(this.eventPill, '');
    this.clearBanner(true);
    this.setNet('', false);
    this.dashBtn.style.setProperty('--btn-color', selfIndex === 0 ? 'var(--cyan)' : 'var(--orange)');
  }

  update(v: ViewState): void {
    for (const i of [0, 1] as const) {
      if (v.scores[i] !== this.lastScores[i]) {
        setText(this.score[i], String(v.scores[i]));
        if (v.scores[i] > this.lastScores[i]) {
          this.score[i].classList.remove('bump');
          void this.score[i].offsetWidth; // restart animation
          this.score[i].classList.add('bump');
        }
        this.lastScores[i] = v.scores[i];
      }
    }

    if (v.suddenDeath) {
      setText(this.timer, 'SUDDEN DEATH');
      this.timer.className = 'hud-timer sudden';
    } else {
      setText(this.timer, formatClock(v.timeLeft));
      this.timer.className = v.timeLeft <= 10 && v.phase === 'playing' ? 'hud-timer low' : 'hud-timer';
    }

    const ev =
      v.event.kind === 'boostPads'
        ? `⚡ Boost pads · ${Math.ceil(v.event.remaining)}s`
        : v.event.kind === 'overdrive'
          ? `⚡ Overdrive — fast dashes · ${Math.ceil(v.event.remaining)}s`
          : '';
    setText(this.eventPill, ev);

    const me = v.players[this.selfIndex];
    this.dashBtn.style.setProperty('--ready', me.dashReady.toFixed(3));
    this.dashBtn.classList.toggle('cooling', me.dashReady < 1);

    if (v.paused && v.phase !== 'ended') {
      this.showBanner(
        `<div class="warn">${v.paused === 2 ? '⏸ Paused — a player switched tabs' : '⏳ Connection hiccup — waiting for opponent…'}</div>`,
        0,
        true,
      );
    } else if (this.bannerSticky) {
      this.clearBanner(true);
    }
  }

  onEvents(events: SimEvent[]): void {
    for (const e of events) {
      switch (e.type) {
        case 'countdown':
          this.showBanner(`<div class="big token">${e.value}</div>`, 900);
          break;
        case 'go':
          this.showBanner(`<div class="big go">GO!</div>`, 700);
          break;
        case 'goal': {
          const cls = e.player === 0 ? 'cyan' : 'orange';
          const who = e.player === this.selfIndex ? 'YOU SCORE!' : `${escapeHtml(this.names[e.player === 1 ? 1 : 0])} SCORES`;
          this.showBanner(`<div class="mid ${cls}">${who}</div>`, 1300);
          break;
        }
        case 'tackle':
          if (e.player === this.selfIndex) this.showBanner(`<div class="mid token">SNATCHED!</div>`, 700);
          else this.showBanner(`<div class="mid orange" style="color:var(--danger)">ROBBED!</div>`, 700);
          break;
        case 'suddenDeath':
          this.showBanner(`<div class="mid token">SUDDEN DEATH<span class="sub">Next goal wins</span></div>`, 1800);
          break;
        case 'eventStart':
          this.showBanner(
            `<div class="mid go">${e.value === 1 ? 'BOOST PADS' : 'OVERDRIVE'}<span class="sub">${e.value === 1 ? 'Run over the green pads for speed' : 'Dash cooldown slashed'}</span></div>`,
            1400,
          );
          break;
        case 'end': {
          const won = e.player === this.selfIndex;
          this.showBanner(`<div class="big ${won ? 'go' : 'orange'}" style="${won ? '' : 'color:var(--muted)'}">${won ? 'VICTORY' : 'DEFEAT'}</div>`, 1400);
          break;
        }
        default:
          break;
      }
    }
  }

  showBanner(html: string, ms: number, sticky = false): void {
    if (sticky && this.bannerSticky) return;
    if (this.bannerSticky && !sticky) return; // pause notice wins
    if (this.bannerTimer) clearTimeout(this.bannerTimer);
    this.bannerSticky = sticky;
    this.banner.innerHTML = html;
    if (ms > 0) this.bannerTimer = setTimeout(() => this.clearBanner(), ms);
  }

  clearBanner(force = false): void {
    if (this.bannerSticky && !force) return;
    if (this.bannerTimer) clearTimeout(this.bannerTimer);
    this.bannerTimer = null;
    this.bannerSticky = false;
    this.banner.innerHTML = '';
  }

  setNet(text: string, bad: boolean): void {
    setText(this.net, text);
    this.net.classList.toggle('bad', bad);
  }
}
