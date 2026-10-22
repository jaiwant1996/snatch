/**
 * Local input: keyboard (WASD / arrows, Space / Shift) and touch
 * (virtual joystick + dash button). Produces an `InputState` the host
 * simulation or the guest's network sender can sample at any rate.
 *
 * Dash presses are counted, not sampled, so a quick tap between two network
 * sends is never lost.
 */
import type { InputState } from './simulation';

export class LocalInput {
  private keys = new Set<string>();
  private dashCount = 0;
  private joyX = 0;
  private joyY = 0;
  private enabled = false;
  private cleanup: Array<() => void> = [];
  onPause: (() => void) | null = null;

  constructor(private touchRoot: HTMLElement | null) {
    const down = (e: KeyboardEvent) => {
      if (e.code === 'Escape') {
        if (this.enabled || document.body.dataset.screen === 'game') this.onPause?.();
        return;
      }
      if (!this.enabled) return;
      if (isGameKey(e.code)) e.preventDefault();
      if ((e.code === 'Space' || e.code === 'ShiftLeft' || e.code === 'ShiftRight') && !e.repeat) {
        this.dashCount++;
      }
      this.keys.add(e.code);
    };
    const up = (e: KeyboardEvent) => this.keys.delete(e.code);
    const blur = () => {
      this.keys.clear();
      this.resetJoystick();
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', blur);
    this.cleanup.push(
      () => window.removeEventListener('keydown', down),
      () => window.removeEventListener('keyup', up),
      () => window.removeEventListener('blur', blur),
    );
    if (touchRoot) this.bindTouch(touchRoot);
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    if (!on) {
      this.keys.clear();
      this.resetJoystick();
    }
  }

  /** Dash counter resets per match so stale counts never leak across matches. */
  resetForMatch(): void {
    this.dashCount = 0;
    this.keys.clear();
    this.resetJoystick();
  }

  sample(): InputState {
    if (!this.enabled) return { x: 0, y: 0, dashCount: this.dashCount };
    let x = 0;
    let y = 0;
    const k = this.keys;
    if (k.has('KeyA') || k.has('ArrowLeft')) x -= 1;
    if (k.has('KeyD') || k.has('ArrowRight')) x += 1;
    if (k.has('KeyW') || k.has('ArrowUp')) y -= 1;
    if (k.has('KeyS') || k.has('ArrowDown')) y += 1;
    if (x === 0 && y === 0) {
      x = this.joyX;
      y = this.joyY;
    }
    const m = Math.hypot(x, y);
    if (m > 1) {
      x /= m;
      y /= m;
    }
    return { x, y, dashCount: this.dashCount };
  }

  private resetJoystick(): void {
    this.joyX = 0;
    this.joyY = 0;
    const knob = this.touchRoot?.querySelector<HTMLElement>('.joy-knob');
    if (knob) knob.style.transform = 'translate(-50%, -50%)';
    this.touchRoot?.querySelector('.joystick')?.classList.remove('active');
  }

  private bindTouch(root: HTMLElement): void {
    const joy = root.querySelector<HTMLElement>('.joystick');
    const knob = root.querySelector<HTMLElement>('.joy-knob');
    const dash = root.querySelector<HTMLElement>('.dash-btn');
    if (!joy || !knob || !dash) return;

    let pointer: number | null = null;
    let cx = 0;
    let cy = 0;
    const radius = () => joy.getBoundingClientRect().width * 0.42;

    const move = (e: PointerEvent) => {
      if (e.pointerId !== pointer) return;
      e.preventDefault();
      const r = radius();
      let dx = e.clientX - cx;
      let dy = e.clientY - cy;
      const d = Math.hypot(dx, dy);
      if (d > r) {
        dx = (dx / d) * r;
        dy = (dy / d) * r;
      }
      // Small dead zone, then a gentle response curve for fine control.
      const mag = Math.min(1, Math.hypot(dx, dy) / r);
      const eased = mag < 0.12 ? 0 : (mag - 0.12) / 0.88;
      const ang = Math.atan2(dy, dx);
      this.joyX = Math.cos(ang) * eased;
      this.joyY = Math.sin(ang) * eased;
      knob.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
    };
    const start = (e: PointerEvent) => {
      if (pointer !== null) return;
      e.preventDefault();
      pointer = e.pointerId;
      try {
        joy.setPointerCapture(e.pointerId);
      } catch {
        /* capture is a nicety; tracking still works without it */
      }
      const rect = joy.getBoundingClientRect();
      cx = rect.left + rect.width / 2;
      cy = rect.top + rect.height / 2;
      joy.classList.add('active');
      move(e);
    };
    const end = (e: PointerEvent) => {
      if (e.pointerId !== pointer) return;
      pointer = null;
      this.resetJoystick();
    };
    const dashDown = (e: PointerEvent) => {
      e.preventDefault();
      if (this.enabled) this.dashCount++;
      dash.classList.add('pressed');
    };
    const dashUp = () => dash.classList.remove('pressed');

    joy.addEventListener('pointerdown', start);
    joy.addEventListener('pointermove', move);
    joy.addEventListener('pointerup', end);
    joy.addEventListener('pointercancel', end);
    dash.addEventListener('pointerdown', dashDown);
    dash.addEventListener('pointerup', dashUp);
    dash.addEventListener('pointercancel', dashUp);
    dash.addEventListener('pointerleave', dashUp);
    this.cleanup.push(() => {
      joy.removeEventListener('pointerdown', start);
      joy.removeEventListener('pointermove', move);
      joy.removeEventListener('pointerup', end);
      joy.removeEventListener('pointercancel', end);
      dash.removeEventListener('pointerdown', dashDown);
      dash.removeEventListener('pointerup', dashUp);
      dash.removeEventListener('pointercancel', dashUp);
      dash.removeEventListener('pointerleave', dashUp);
    });
  }

  destroy(): void {
    for (const fn of this.cleanup) fn();
    this.cleanup = [];
  }
}

function isGameKey(code: string): boolean {
  return (
    code.startsWith('Arrow') ||
    code === 'Space' ||
    code === 'KeyW' ||
    code === 'KeyA' ||
    code === 'KeyS' ||
    code === 'KeyD'
  );
}
