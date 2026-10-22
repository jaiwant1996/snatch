/**
 * Phaser scene: draws the arena and whatever ViewState the active driver
 * provides. It owns no game rules — the host simulation (or the guest's
 * snapshot buffer) is the source of truth. Rendering runs on Phaser's loop,
 * independent of the 60 Hz simulation and the 20 Hz network snapshots.
 */
import Phaser from 'phaser';
import { COLORS, EVENTS, PLAYER, TOKEN, WORLD } from '../config/gameConfig';
import { reducedMotion } from '../ui/prefs';
import { sound } from '../ui/audio';
import { BOOST_PADS, GATES, OBSTACLES } from './arena';
import type { SimEvent } from './simulation';
import type { ViewState } from './view';

export interface SceneDriver {
  /** Called once per rendered frame. Return null when nothing to draw yet. */
  getView(now: number, dt: number): ViewState | null;
  readonly selfIndex: 0 | 1;
  readonly names: [string, string];
  onFrame?(view: ViewState): void;
}

const PLAYER_COLORS = [COLORS.cyan, COLORS.orange] as const;

interface PlayerGfx {
  root: Phaser.GameObjects.Container;
  body: Phaser.GameObjects.Graphics;
  pointer: Phaser.GameObjects.Graphics;
  ring: Phaser.GameObjects.Graphics;
  label: Phaser.GameObjects.Text;
  trail: Phaser.GameObjects.Particles.ParticleEmitter;
  wasDashing: boolean;
}

export class ArenaScene extends Phaser.Scene {
  private driver: SceneDriver | null = null;
  private pendingEvents: SimEvent[] = [];
  private players: PlayerGfx[] = [];
  private token!: Phaser.GameObjects.Container;
  private tokenGlow!: Phaser.GameObjects.Arc;
  private tokenStar!: Phaser.GameObjects.Graphics;
  private carrierHalo!: Phaser.GameObjects.Graphics;
  private pads!: Phaser.GameObjects.Graphics;
  private overdriveFrame!: Phaser.GameObjects.Graphics;
  private gateGlow: Phaser.GameObjects.Graphics[] = [];
  private bursts: Record<'cyan' | 'orange' | 'token' | 'white' | 'boost', Phaser.GameObjects.Particles.ParticleEmitter> =
    {} as never;
  private ready = false;
  private zoom = 1;

  constructor() {
    super('arena');
  }

  setDriver(driver: SceneDriver | null): void {
    this.driver = driver;
    this.pendingEvents = [];
    if (this.ready && driver) this.applyNames(driver);
  }

  pushEvents(events: SimEvent[]): void {
    this.pendingEvents.push(...events);
  }

  create(): void {
    this.zoom = this.scale.width / WORLD.width;
    const cam = this.cameras.main;
    cam.setZoom(this.zoom);
    cam.centerOn(WORLD.width / 2, WORLD.height / 2);

    this.makeTextures();
    this.drawArena();

    this.pads = this.add.graphics().setDepth(1);
    this.overdriveFrame = this.add.graphics().setDepth(1);

    this.carrierHalo = this.add.graphics().setDepth(4);

    for (const i of [0, 1] as const) this.players.push(this.makePlayer(i));

    this.tokenGlow = this.add.circle(0, 0, TOKEN.radius * 2.4, COLORS.token, 0.16);
    const core = this.add.circle(0, 0, TOKEN.radius, COLORS.token);
    core.setStrokeStyle(3, COLORS.tokenCore, 1);
    this.tokenStar = this.add.graphics();
    this.tokenStar.lineStyle(2, 0xffffff, 0.9);
    for (let k = 0; k < 4; k++) {
      const a = (k * Math.PI) / 2;
      this.tokenStar.lineBetween(Math.cos(a) * 4, Math.sin(a) * 4, Math.cos(a) * 7, Math.sin(a) * 7);
    }
    this.token = this.add.container(WORLD.width / 2, WORLD.height / 2, [this.tokenGlow, core, this.tokenStar]).setDepth(6);

    const mk = (tint: number) =>
      this.add
        .particles(0, 0, 'spark', {
          speed: { min: 80, max: 340 },
          lifespan: { min: 260, max: 620 },
          scale: { start: 1, end: 0 },
          alpha: { start: 1, end: 0 },
          tint,
          emitting: false,
          blendMode: Phaser.BlendModes.ADD,
        })
        .setDepth(8);
    this.bursts = {
      cyan: mk(COLORS.cyan),
      orange: mk(COLORS.orange),
      token: mk(COLORS.token),
      white: mk(0xffffff),
      boost: mk(COLORS.boost),
    };

    this.ready = true;
    if (this.driver) this.applyNames(this.driver);
    this.scale.on('resize', () => {
      this.zoom = this.scale.width / WORLD.width;
      this.cameras.main.setZoom(this.zoom);
      this.cameras.main.centerOn(WORLD.width / 2, WORLD.height / 2);
    });
  }

  private makeTextures(): void {
    if (this.textures.exists('spark')) return;
    const g = this.make.graphics({ x: 0, y: 0 }, false);
    g.fillStyle(0xffffff, 1);
    g.fillCircle(6, 6, 6);
    g.generateTexture('spark', 12, 12);
    g.clear();
    g.fillStyle(0xffffff, 1);
    g.fillCircle(PLAYER.radius, PLAYER.radius, PLAYER.radius);
    g.generateTexture('ghost-circle', PLAYER.radius * 2, PLAYER.radius * 2);
    g.clear();
    const r = PLAYER.radius;
    g.fillStyle(0xffffff, 1);
    g.fillPoints(
      [
        new Phaser.Math.Vector2(r, 0),
        new Phaser.Math.Vector2(r * 2, r),
        new Phaser.Math.Vector2(r, r * 2),
        new Phaser.Math.Vector2(0, r),
      ],
      true,
    );
    g.generateTexture('ghost-diamond', r * 2, r * 2);
    g.destroy();
  }

  private drawArena(): void {
    const b = WORLD.bounds;
    const g = this.add.graphics().setDepth(0);
    // Floor
    g.fillStyle(COLORS.floor, 1);
    g.fillRoundedRect(b.left, b.top, b.right - b.left, b.bottom - b.top, 22);
    // Grid
    g.lineStyle(1, COLORS.grid, 1);
    for (let x = b.left + 40; x < b.right; x += 40) g.lineBetween(x, b.top + 4, x, b.bottom - 4);
    for (let y = b.top + 40; y < b.bottom; y += 40) g.lineBetween(b.left + 4, y, b.right - 4, y);
    // Halves tint
    g.fillStyle(COLORS.cyan, 0.025);
    g.fillRect(b.left, b.top, WORLD.width / 2 - b.left, b.bottom - b.top);
    g.fillStyle(COLORS.orange, 0.025);
    g.fillRect(WORLD.width / 2, b.top, b.right - WORLD.width / 2, b.bottom - b.top);
    // Center line + circle
    g.lineStyle(2, COLORS.wall, 0.8);
    g.lineBetween(WORLD.width / 2, b.top, WORLD.width / 2, 128 - 52);
    g.lineBetween(WORLD.width / 2, 492 + 52, WORLD.width / 2, b.bottom);
    g.strokeCircle(WORLD.width / 2, WORLD.height / 2, 64);
    g.fillStyle(COLORS.wall, 0.35);
    g.fillCircle(WORLD.width / 2, WORLD.height / 2, 6);

    // Gates
    GATES.forEach((gate, i) => {
      const col = PLAYER_COLORS[i]!;
      const gg = this.add.graphics().setDepth(0);
      gg.fillStyle(col, 0.1);
      gg.fillRect(gate.x, gate.y, gate.w, gate.h);
      gg.lineStyle(3, col, 0.9);
      const open = i === 0 ? gate.x + gate.w : gate.x;
      const back = i === 0 ? gate.x : gate.x + gate.w;
      gg.lineBetween(back, gate.y, open, gate.y);
      gg.lineBetween(back, gate.y + gate.h, open, gate.y + gate.h);
      gg.lineBetween(back, gate.y, back, gate.y + gate.h);
      // Chevrons pointing into the gate
      gg.lineStyle(3, col, 0.35);
      const dir = i === 0 ? -1 : 1;
      for (let k = 0; k < 3; k++) {
        const cx = open + dir * (14 + k * 16);
        const cy = gate.y + gate.h / 2;
        gg.lineBetween(cx - dir * 6, cy - 12, cx + dir * 6, cy);
        gg.lineBetween(cx + dir * 6, cy, cx - dir * 6, cy + 12);
      }
      // Shape emblem (circle for cyan, diamond for orange) for colour-blind readability
      const ex = gate.x + gate.w / 2;
      const ey = gate.y - 22;
      gg.lineStyle(3, col, 0.9);
      if (i === 0) gg.strokeCircle(ex, ey, 9);
      else gg.strokePoints([{ x: ex, y: ey - 11 }, { x: ex + 11, y: ey }, { x: ex, y: ey + 11 }, { x: ex - 11, y: ey }], true);
      this.add
        .text(ex, gate.y + gate.h + 18, 'HOME', {
          fontFamily: 'system-ui, sans-serif',
          fontSize: '26px',
          fontStyle: '900',
          color: i === 0 ? '#2ee6f0' : '#ff8a2a',
        })
        .setOrigin(0.5)
        .setAlpha(0.7)
        .setScale(0.5); // drawn at 2× and scaled down: crisp on high-DPI in both renderers
      const glow = this.add.graphics().setDepth(0).setAlpha(0);
      glow.fillStyle(col, 0.45);
      glow.fillRect(gate.x, gate.y, gate.w, gate.h);
      this.gateGlow.push(glow);
    });

    // Obstacles
    for (const o of OBSTACLES) {
      g.fillStyle(0x000000, 0.35);
      g.fillCircle(o.x + 3, o.y + 5, o.r);
      g.fillStyle(COLORS.obstacle, 1);
      g.fillCircle(o.x, o.y, o.r);
      g.lineStyle(3, COLORS.obstacleEdge, 1);
      g.strokeCircle(o.x, o.y, o.r);
      g.lineStyle(2, COLORS.obstacleEdge, 0.35);
      g.strokeCircle(o.x, o.y, o.r * 0.55);
    }

    // Outer wall
    g.lineStyle(5, COLORS.wall, 1);
    g.strokeRoundedRect(b.left - 2, b.top - 2, b.right - b.left + 4, b.bottom - b.top + 4, 24);
  }

  private makePlayer(i: 0 | 1): PlayerGfx {
    const col = PLAYER_COLORS[i]!;
    const deep = i === 0 ? COLORS.cyanDeep : COLORS.orangeDeep;
    const r = PLAYER.radius;
    const body = this.add.graphics();
    body.fillStyle(0x000000, 0.35);
    if (i === 0) {
      body.fillCircle(2, 4, r);
      body.fillStyle(deep, 1);
      body.fillCircle(0, 0, r);
      body.lineStyle(4, col, 1);
      body.strokeCircle(0, 0, r - 2);
      body.fillStyle(col, 1);
      body.fillCircle(0, 0, 5);
    } else {
      const pts = (s: number, ox = 0, oy = 0) => [
        { x: ox, y: oy - s }, { x: ox + s, y: oy }, { x: ox, y: oy + s }, { x: ox - s, y: oy },
      ];
      body.fillPoints(pts(r + 2, 2, 4), true);
      body.fillStyle(deep, 1);
      body.fillPoints(pts(r + 2), true);
      body.lineStyle(4, col, 1);
      body.strokePoints(pts(r - 1), true);
      body.fillStyle(col, 1);
      body.fillRect(-4, -4, 8, 8);
    }
    const pointer = this.add.graphics();
    pointer.fillStyle(0xffffff, 0.9);
    pointer.fillTriangle(r + 4, -6, r + 13, 0, r + 4, 6);
    const ring = this.add.graphics();
    const label = this.add
      .text(0, -r - 18, '', {
        fontFamily: 'system-ui, sans-serif',
        fontSize: '26px',
        fontStyle: '800',
        color: '#eef1f6',
      })
      .setOrigin(0.5)
      .setScale(0.5)
      .setAlpha(0.85);
    const root = this.add.container(0, 0, [ring, body, pointer, label]).setDepth(5);
    const trail = this.add
      .particles(0, 0, i === 0 ? 'ghost-circle' : 'ghost-diamond', {
        lifespan: 240,
        frequency: 16,
        scale: { start: 0.95, end: 0.35 },
        alpha: { start: 0.45, end: 0 },
        tint: col,
        emitting: false,
        blendMode: Phaser.BlendModes.ADD,
      })
      .setDepth(3);
    trail.startFollow(root);
    return { root, body, pointer, ring, label, trail, wasDashing: false };
  }

  private applyNames(d: SceneDriver): void {
    this.players.forEach((p, i) => {
      const name = d.names[i] ?? '';
      p.label.setText(i === d.selfIndex ? `${name} · YOU` : name);
      p.label.setColor(i === d.selfIndex ? '#ffffff' : '#98a1b2');
    });
  }

  override update(time: number, delta: number): void {
    if (!this.ready || !this.driver) return;
    const dt = Math.min(0.1, delta / 1000);
    const view = this.driver.getView(performance.now(), dt);
    if (!view) return;
    const calm = reducedMotion();

    // Players
    view.players.forEach((pv, i) => {
      const g = this.players[i]!;
      g.root.setPosition(pv.x, pv.y);
      const ang = Math.atan2(pv.fy, pv.fx);
      g.pointer.setRotation(ang);
      // Idle "breathing" + squash while dashing
      const breathe = calm ? 1 : 1 + Math.sin(time / 260 + i) * 0.025;
      g.body.setScale(pv.dashing ? 1.12 : breathe, pv.dashing ? 0.9 : breathe);
      g.body.setRotation(pv.dashing ? ang : 0);
      g.root.setAlpha(pv.immune && Math.floor(time / 80) % 2 === 0 ? 0.55 : 1);
      g.body.setPosition(pv.stunned && !calm ? Math.sin(time / 18) * 2.5 : 0, 0);

      // Dash readiness ring
      g.ring.clear();
      const col = PLAYER_COLORS[i]!;
      if (pv.dashReady < 1) {
        g.ring.lineStyle(3, col, 0.5);
        g.ring.beginPath();
        g.ring.arc(0, 0, PLAYER.radius + 7, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * pv.dashReady);
        g.ring.strokePath();
      } else if (i === this.driver!.selfIndex) {
        g.ring.lineStyle(2, col, 0.22 + 0.12 * Math.sin(time / 180));
        g.ring.strokeCircle(0, 0, PLAYER.radius + 7);
      }
      if (pv.boosted) {
        g.ring.lineStyle(3, COLORS.boost, 0.8);
        g.ring.strokeCircle(0, 0, PLAYER.radius + 11);
      }

      if (pv.dashing && !g.wasDashing) {
        g.trail.emitting = true;
      } else if (!pv.dashing && g.wasDashing) {
        g.trail.emitting = false;
      }
      g.wasDashing = pv.dashing;
    });

    // Token
    const t = view.token;
    this.carrierHalo.clear();
    if (t.carrier !== -1) {
      const c = view.players[t.carrier];
      this.token.setPosition(c.x, c.y - PLAYER.radius - 2);
      this.token.setScale(0.85);
      this.carrierHalo.lineStyle(3, COLORS.token, 0.55 + 0.25 * Math.sin(time / 120));
      this.carrierHalo.strokeCircle(c.x, c.y, PLAYER.radius + 14);
    } else {
      const bob = calm ? 0 : Math.sin(time / 220) * 2;
      this.token.setPosition(t.x, t.y + bob);
      this.token.setScale(1);
    }
    this.tokenStar.setRotation(calm ? 0 : time / 400);
    this.tokenGlow.setScale(calm ? 1 : 1 + Math.sin(time / 180) * 0.12);
    this.token.setAlpha(t.locked ? (Math.floor(time / 60) % 2 === 0 ? 0.45 : 1) : 1);
    // Token is hidden while a scored goal is being celebrated.
    this.token.setVisible(view.phase !== 'goal' && !(view.phase === 'ended' && view.endReason !== 'time'));

    // Arena event visuals
    this.pads.clear();
    this.overdriveFrame.clear();
    if (view.event.kind === 'boostPads') {
      const fade = Math.min(1, view.event.remaining / 1.0);
      for (const p of BOOST_PADS) {
        const pulse = calm ? 0 : Math.sin(time / 140) * 3;
        this.pads.fillStyle(COLORS.boost, 0.12 * fade);
        this.pads.fillCircle(p.x, p.y, p.r + pulse);
        this.pads.lineStyle(3, COLORS.boost, 0.8 * fade);
        this.pads.strokeCircle(p.x, p.y, p.r + pulse);
        this.pads.lineStyle(3, COLORS.boost, 0.6 * fade);
        for (let k = -1; k <= 1; k += 2) {
          this.pads.lineBetween(p.x - 8, p.y + k * 4 - 6, p.x, p.y + k * 4 - 12);
          this.pads.lineBetween(p.x, p.y + k * 4 - 12, p.x + 8, p.y + k * 4 - 6);
        }
      }
    } else if (view.event.kind === 'overdrive') {
      const b = WORLD.bounds;
      this.overdriveFrame.lineStyle(6, COLORS.boost, 0.35 + (calm ? 0 : 0.25 * Math.sin(time / 90)));
      this.overdriveFrame.strokeRoundedRect(b.left - 2, b.top - 2, b.right - b.left + 4, b.bottom - b.top + 4, 24);
    }

    // Effects for events that happened since last frame
    if (this.pendingEvents.length) {
      const evs = this.pendingEvents;
      this.pendingEvents = [];
      for (const e of evs) this.playEvent(e, view, calm);
    }

    this.driver.onFrame?.(view);
  }

  private ringBurst(x: number, y: number, color: number, maxR: number, dur = 380): void {
    const g = this.add.graphics().setDepth(7);
    const obj = { r: 6, a: 0.9 };
    this.tweens.add({
      targets: obj,
      r: maxR,
      a: 0,
      duration: dur,
      ease: 'Cubic.easeOut',
      onUpdate: () => {
        g.clear();
        g.lineStyle(4, color, obj.a);
        g.strokeCircle(x, y, obj.r);
      },
      onComplete: () => g.destroy(),
    });
  }

  private playEvent(e: SimEvent, view: ViewState, calm: boolean): void {
    const n = (k: number) => (calm ? Math.ceil(k / 3) : k);
    const colorKey = (p: number) => (p === 0 ? 'cyan' : 'orange');
    switch (e.type) {
      case 'pickup': {
        const p = view.players[e.player === 1 ? 1 : 0];
        this.bursts.token.explode(n(14), p.x, p.y);
        this.ringBurst(p.x, p.y, COLORS.token, 46, 300);
        this.tweens.add({ targets: this.token, scale: { from: 1.8, to: 0.85 }, duration: 260, ease: 'Back.easeOut' });
        sound.play('pickup');
        break;
      }
      case 'drop':
        this.bursts.token.explode(n(22), e.x, e.y);
        this.ringBurst(e.x, e.y, COLORS.token, 70, 420);
        sound.play('drop');
        break;
      case 'tackle':
        this.bursts.white.explode(n(18), e.x, e.y);
        this.bursts[colorKey(e.player)].explode(n(16), e.x, e.y);
        this.ringBurst(e.x, e.y, 0xffffff, 54, 260);
        if (!calm) this.cameras.main.shake(140, 0.009 / this.zoom);
        sound.play('tackle');
        break;
      case 'bump':
        this.bursts.white.explode(n(8), e.x, e.y);
        if (!calm) this.cameras.main.shake(70, 0.004 / this.zoom);
        sound.play('bump');
        break;
      case 'clash':
        this.bursts.cyan.explode(n(12), e.x, e.y);
        this.bursts.orange.explode(n(12), e.x, e.y);
        this.ringBurst(e.x, e.y, 0xffffff, 64, 300);
        if (!calm) this.cameras.main.shake(160, 0.01 / this.zoom);
        sound.play('tackle');
        break;
      case 'dash':
        if (e.player === this.driver?.selfIndex || !calm) sound.play('dash');
        break;
      case 'goal': {
        const gate = GATES[e.player === 1 ? 1 : 0];
        const gx = gate.x + gate.w / 2;
        const gy = gate.y + gate.h / 2;
        this.bursts[colorKey(e.player)].explode(n(60), gx, gy);
        this.bursts.token.explode(n(30), gx, gy);
        this.ringBurst(gx, gy, PLAYER_COLORS[e.player === 1 ? 1 : 0]!, 160, 700);
        const glow = this.gateGlow[e.player === 1 ? 1 : 0];
        if (glow) this.tweens.add({ targets: glow, alpha: { from: 1, to: 0 }, duration: 900, ease: 'Cubic.easeOut' });
        if (!calm) {
          const c = PLAYER_COLORS[e.player === 1 ? 1 : 0]!;
          this.cameras.main.flash(220, (c >> 16) & 255, (c >> 8) & 255, c & 255, true);
          this.cameras.main.shake(220, 0.008 / this.zoom);
        }
        sound.play('score');
        break;
      }
      case 'boost':
        this.bursts.boost.explode(n(14), e.x, e.y);
        break;
      case 'eventStart':
        sound.play('event');
        if (e.value === 1) for (const p of BOOST_PADS) this.ringBurst(p.x, p.y, COLORS.boost, EVENTS.boostPad.radius * 2.4, 600);
        break;
      case 'countdown':
        sound.play('tick');
        break;
      case 'go':
        sound.play('go');
        break;
      case 'reset':
        this.ringBurst(WORLD.width / 2, WORLD.height / 2, COLORS.token, 90, 500);
        break;
      default:
        break;
    }
  }

  /** Visual reset between matches. */
  clearEffects(): void {
    this.pendingEvents = [];
    for (const p of this.players) {
      p.trail.emitting = false;
      p.wasDashing = false;
    }
  }
}
