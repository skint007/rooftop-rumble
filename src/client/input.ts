/**
 * Turns mouse drags, keys and gamepads into an aim (angle + power) and a throw.
 *
 * Mouse: a drag adjusts the current aim, as if continuing the last pull, and release
 * throws. A click without dragging throws the same shot again. By default you pull
 * back like a slingshot; "point" mode moves the aim the way you drag. Shift slows it.
 * Gamepad: left stick turns the aim, right stick (up/down) changes power. Both move
 * faster the further you push, so a light touch is a fine adjustment. Each d-pad tap
 * is one small step (hold to repeat). A throws.
 * Keys: arrows adjust, Shift for fine steps, Space or Enter throws.
 */
import { clamp, MAX_POWER, WORLD_H, WORLD_W } from '../shared/game.ts';

export type PadBinding = 'any' | number;
export type DragMode = 'slingshot' | 'point';

export interface Aim {
  angle: number;
  power: number;
}

const DRAG_FULL_POWER = 240; // world px of drag for 100% power
const DRAG_FINE = 0.25; // drag speed with Shift held
const CLICK_SLOP = 4; // world px a click may wander and still count as a click
const STICK_DEAD = 0.2;
const STICK_ANGLE_RATE = 45; // degrees/s at full tilt
const STICK_POWER_RATE = 40; // power %/s at full tilt
const DPAD_ANGLE_STEP = 0.5; // degrees per tap
const DPAD_POWER_STEP = 1; // power % per tap
const REPEAT_DELAY_MS = 350; // hold a d-pad direction this long to start repeating
const REPEAT_EVERY_MS = 60;

export class AimInput {
  dragMode: DragMode = 'slingshot';
  // `base` is the aim when the drag started; the drag is added on top of it.
  private drag: { id: number; x: number; y: number; cx: number; cy: number; base: Aim | null; moved: boolean } | null = null;
  private held = new Map<string, number>(); // pad button -> when it went down, for d-pad repeat
  private repeats = new Map<string, number>(); // pad button -> repeat ticks already applied
  private released = false;
  private keys = new Set<string>();
  private pressed = new Set<string>();
  private padPrev: boolean[][] = [];
  private cleanup: (() => void)[] = [];

  /** Hooks into the canvas and window. Call detach() when leaving the game. */
  attach(canvas: HTMLCanvasElement): void {
    this.endFrame(); // sample pad buttons now, so one already held doesn't count as a press
    const toWorld = (e: PointerEvent) => {
      const r = canvas.getBoundingClientRect();
      return { x: ((e.clientX - r.left) / r.width) * WORLD_W, y: ((e.clientY - r.top) / r.height) * WORLD_H };
    };
    const down = (e: PointerEvent) => {
      if (this.drag && this.drag.id !== e.pointerId) return; // a second finger doesn't take over
      if (e.button !== 0) return void (this.drag = null);
      const p = toWorld(e);
      this.drag = { id: e.pointerId, x: p.x, y: p.y, cx: p.x, cy: p.y, base: null, moved: false };
      canvas.setPointerCapture(e.pointerId);
    };
    const move = (e: PointerEvent) => {
      if (!this.drag || this.drag.id !== e.pointerId || this.released) return; // a released drag keeps its release point
      const p = toWorld(e);
      this.drag.cx = p.x;
      this.drag.cy = p.y;
    };
    const up = (e: PointerEvent) => {
      if (!this.drag || this.drag.id !== e.pointerId) return;
      const p = toWorld(e);
      this.drag.cx = p.x;
      this.drag.cy = p.y;
      this.released = true;
    };
    const keydown = (e: KeyboardEvent) => {
      // Keys aimed at a form control (e.g. Enter on a menu button) aren't game input.
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLButtonElement || e.target instanceof HTMLSelectElement) return;
      // Auto-repeat isn't a new press, e.g. Enter still held after it closed the menu.
      if (!e.repeat && !this.keys.has(e.code)) this.pressed.add(e.code);
      this.keys.add(e.code);
      if (e.code.startsWith('Arrow') || e.code === 'Space') e.preventDefault();
      if (e.code === 'Escape') this.drag = null;
    };
    const keyup = (e: KeyboardEvent) => this.keys.delete(e.code);
    // Keys released while the window is in the background never send keyup.
    const blur = () => this.keys.clear();
    const menu = (e: Event) => e.preventDefault();
    canvas.addEventListener('pointerdown', down);
    canvas.addEventListener('pointermove', move);
    canvas.addEventListener('pointerup', up);
    canvas.addEventListener('pointercancel', (e) => this.drag?.id === e.pointerId && (this.drag = null));
    canvas.addEventListener('contextmenu', menu);
    window.addEventListener('keydown', keydown);
    window.addEventListener('keyup', keyup);
    window.addEventListener('blur', blur);
    this.cleanup.push(() => {
      canvas.removeEventListener('pointerdown', down);
      canvas.removeEventListener('pointermove', move);
      canvas.removeEventListener('pointerup', up);
      canvas.removeEventListener('contextmenu', menu);
      window.removeEventListener('keydown', keydown);
      window.removeEventListener('keyup', keyup);
      window.removeEventListener('blur', blur);
    });
  }

  detach(): void {
    this.cleanup.forEach((f) => f());
    this.cleanup = [];
  }

  /** True once per key press. */
  tapped(code: string): boolean {
    return this.pressed.has(code);
  }

  /** True once per press of this button on any connected gamepad. */
  padTapped(button: number): boolean {
    return gamepads().some((pad, i) => pad && this.padEdge(i, pad, button));
  }

  /**
   * Applies this frame's input to `aim` for a local player whose turn it is.
   * Returns true when they let go of a throw.
   */
  update(dt: number, aim: Aim, pad: PadBinding): boolean {
    let fire = false;

    const fine = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight');

    if (this.drag) {
      const d = this.drag;
      d.base ??= { ...aim };
      const dx = d.cx - d.x;
      const dy = d.cy - d.y;
      if (Math.hypot(dx, dy) > CLICK_SLOP) d.moved = true;
      if (d.moved) {
        // The aim as a vector in drag space (x right, y up), plus the drag on top.
        const rad = (d.base.angle * Math.PI) / 180;
        const len = (d.base.power / MAX_POWER) * DRAG_FULL_POWER;
        const k = (this.dragMode === 'slingshot' ? -1 : 1) * (fine ? DRAG_FINE : 1);
        const vx = Math.cos(rad) * len + dx * k;
        const vy = Math.sin(rad) * len - dy * k;
        aim.angle = toAngle(vx, vy);
        aim.power = (Math.hypot(vx, vy) / DRAG_FULL_POWER) * MAX_POWER;
      }
      // Releasing throws, whether it was a drag or just a click (same shot again).
      if (this.released) {
        fire = true;
        this.drag = null;
      }
    }
    this.released = false;

    const angleRate = (fine ? 6 : 40) * dt;
    const powerRate = (fine ? 6 : 40) * dt;
    if (this.keys.has('ArrowLeft')) aim.angle += angleRate;
    if (this.keys.has('ArrowRight')) aim.angle -= angleRate;
    if (this.keys.has('ArrowUp')) aim.power += powerRate;
    if (this.keys.has('ArrowDown')) aim.power -= powerRate;
    if (this.tapped('Space') || this.tapped('Enter')) fire = true;

    const now = performance.now();
    gamepads().forEach((p, i) => {
      if (!p || (pad !== 'any' && pad !== i)) return;
      const [lx = 0, , , ry = 0] = p.axes;
      // Stick left turns the aim left (toward 180°); stick up adds power.
      aim.angle -= stickRate(lx) * STICK_ANGLE_RATE * dt;
      aim.power -= stickRate(ry) * STICK_POWER_RATE * dt;
      aim.angle += (this.dpadSteps(i, p, 14, now) - this.dpadSteps(i, p, 15, now)) * DPAD_ANGLE_STEP; // left, right
      aim.power += (this.dpadSteps(i, p, 12, now) - this.dpadSteps(i, p, 13, now)) * DPAD_POWER_STEP; // up, down
      if (this.padEdge(i, p, 0)) fire = true; // A / cross
    });

    aim.angle = clamp(aim.angle, 0, 180);
    aim.power = clamp(aim.power, 0, MAX_POWER);
    return fire;
  }

  /** Call once at the end of every frame. */
  endFrame(): void {
    this.pressed.clear();
    gamepads().forEach((p, i) => {
      if (p) this.padPrev[i] = p.buttons.map((b) => b.pressed);
    });
  }

  /** Forgets any drag or key press in progress, e.g. one made while it wasn't this player's turn. */
  cancel(): void {
    this.drag = null;
    this.released = false;
    this.held.clear(); // d-pad repeat starts fresh on the next turn
    this.repeats.clear();
    this.endFrame(); // clears key presses and samples pad buttons, so a held button isn't new
  }

  get dragging(): boolean {
    return this.drag !== null;
  }

  // Steps for a d-pad button this frame: one on the press, then a steady repeat while held.
  private dpadSteps(i: number, pad: Gamepad, button: number, now: number): number {
    const key = `${i}:${button}`;
    if (!(pad.buttons[button]?.pressed ?? false)) {
      this.held.delete(key);
      this.repeats.delete(key);
      return 0;
    }
    if (this.padEdge(i, pad, button) || !this.held.has(key)) {
      this.held.set(key, now);
      this.repeats.delete(key);
      return 1;
    }
    const since = now - this.held.get(key)! - REPEAT_DELAY_MS;
    if (since < 0) return 0;
    // Count repeat ticks crossed since the last frame.
    const ticks = Math.floor(since / REPEAT_EVERY_MS);
    const done = this.repeats.get(key) ?? -1;
    this.repeats.set(key, ticks);
    return Math.max(0, ticks - done);
  }

  private padEdge(i: number, pad: Gamepad, button: number): boolean {
    return (pad.buttons[button]?.pressed ?? false) && !(this.padPrev[i]?.[button] ?? false);
  }
}

/** Connected gamepads. Empty if the page isn't allowed gamepad access (Permissions-Policy), which makes getGamepads throw. */
function gamepads(): (Gamepad | null)[] {
  try {
    return navigator.getGamepads();
  } catch {
    return [];
  }
}

/** -1..1 stick axis to a rate. Past the dead zone it rises with the square, so small tilts are slow. */
function stickRate(axis: number): number {
  const over = (Math.abs(axis) - STICK_DEAD) / (1 - STICK_DEAD);
  return over <= 0 ? 0 : Math.sign(axis) * over * over;
}

// Direction to a throw angle. Pointing below the horizon snaps to flat.
function toAngle(dx: number, up: number): number {
  const deg = (Math.atan2(up, dx) * 180) / Math.PI;
  if (deg >= 0) return deg;
  return deg > -90 ? 0 : 180;
}
