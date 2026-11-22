/**
 * Turns mouse drags, keys and gamepads into an aim (angle + power) and a throw.
 *
 * Mouse: press anywhere, drag, release to throw. By default you pull back like a
 * slingshot; "point" mode aims where you drag instead.
 * Gamepad: left stick aims, right stick (up/down) sets power, d-pad fine-tunes, A throws.
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
const STICK_DEAD = 0.35;

export class AimInput {
  dragMode: DragMode = 'slingshot';
  private drag: { id: number; x: number; y: number; cx: number; cy: number } | null = null;
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
      this.drag = { id: e.pointerId, x: p.x, y: p.y, cx: p.x, cy: p.y };
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

    if (this.drag) {
      const sign = this.dragMode === 'slingshot' ? -1 : 1;
      const dx = (this.drag.cx - this.drag.x) * sign;
      const dy = (this.drag.cy - this.drag.y) * sign;
      const len = Math.hypot(dx, dy);
      if (len > 6) {
        aim.power = clamp((len / DRAG_FULL_POWER) * MAX_POWER, 0, MAX_POWER);
        aim.angle = toAngle(dx, -dy);
      }
      if (this.released) {
        fire = len > 12;
        this.drag = null;
      }
    }
    this.released = false;

    const fine = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight');
    const angleRate = (fine ? 6 : 40) * dt;
    const powerRate = (fine ? 6 : 40) * dt;
    if (this.keys.has('ArrowLeft')) aim.angle += angleRate;
    if (this.keys.has('ArrowRight')) aim.angle -= angleRate;
    if (this.keys.has('ArrowUp')) aim.power += powerRate;
    if (this.keys.has('ArrowDown')) aim.power -= powerRate;
    if (this.tapped('Space') || this.tapped('Enter')) fire = true;

    gamepads().forEach((p, i) => {
      if (!p || (pad !== 'any' && pad !== i)) return;
      const [lx = 0, ly = 0, , ry = 0] = p.axes;
      if (Math.hypot(lx, ly) > STICK_DEAD) {
        // Smooth toward the stick so the arrow doesn't jitter.
        const target = toAngle(lx, -ly);
        aim.angle += (target - aim.angle) * Math.min(1, dt * 14);
      }
      if (Math.abs(ry) > 0.15) aim.power -= ry * 55 * dt;
      const b = (n: number) => p.buttons[n]?.pressed ?? false;
      if (b(14)) aim.angle += 8 * dt; // d-pad left
      if (b(15)) aim.angle -= 8 * dt; // d-pad right
      if (b(12)) aim.power += 8 * dt; // d-pad up
      if (b(13)) aim.power -= 8 * dt; // d-pad down
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
    this.endFrame(); // clears key presses and samples pad buttons, so a held button isn't new
  }

  get dragging(): boolean {
    return this.drag !== null;
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

// Direction to a throw angle. Pointing below the horizon snaps to flat.
function toAngle(dx: number, up: number): number {
  const deg = (Math.atan2(up, dx) * 180) / Math.PI;
  if (deg >= 0) return deg;
  return deg > -90 ? 0 : 180;
}
