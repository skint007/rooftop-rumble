/**
 * Lets a gamepad drive the menus. While a menu screen is showing, the d-pad or left
 * stick moves focus to the nearest control in that direction, A presses or toggles it,
 * left/right change a dropdown, and B presses the screen's back button (`data-back`).
 * It has its own frame loop and ignores the pads while no menu screen is showing.
 */
import { gamepads } from './input.ts';

type Dir = 'up' | 'down' | 'left' | 'right';

const STICK = 0.5;
const REPEAT_DELAY_MS = 350;
const REPEAT_EVERY_MS = 140;
const A = 0;
const B = 1;
const DPAD: Record<Dir, number> = { up: 12, down: 13, left: 14, right: 15 };

/** Controls on the visible menu screen, in page order. */
function controls(screen: HTMLElement): HTMLElement[] {
  return [...screen.querySelectorAll<HTMLElement>('button, select, input')].filter(
    (el) => !(el as HTMLButtonElement).disabled && el.getClientRects().length > 0,
  );
}

function centre(el: HTMLElement): { x: number; y: number } {
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

// The nearest control in a direction, favouring ones straight ahead over ones off to the side.
function nearest(from: HTMLElement, list: HTMLElement[], dir: Dir): HTMLElement | undefined {
  const c = centre(from);
  let best: HTMLElement | undefined;
  let bestScore = Infinity;
  for (const el of list) {
    if (el === from) continue;
    const p = centre(el);
    const ahead = dir === 'down' ? p.y - c.y : dir === 'up' ? c.y - p.y : dir === 'right' ? p.x - c.x : c.x - p.x;
    const side = dir === 'up' || dir === 'down' ? Math.abs(p.x - c.x) : Math.abs(p.y - c.y);
    if (ahead <= 4) continue;
    const score = ahead + side * 2;
    if (score < bestScore) {
      bestScore = score;
      best = el;
    }
  }
  return best;
}

function stepSelect(select: HTMLSelectElement, by: number): void {
  const i = Math.min(select.options.length - 1, Math.max(0, select.selectedIndex + by));
  if (i === select.selectedIndex) return;
  select.selectedIndex = i;
  select.dispatchEvent(new Event('change'));
}

/** Starts the menu navigation loop. Call once. */
export function startPadNav(): void {
  let prev: boolean[] = [];
  // Where focus was on the current screen, so a redraw that drops it can put it back.
  let spot: { screen: HTMLElement; index: number } | null = null;
  const heldSince = new Map<Dir, number>();
  const lastRepeat = new Map<Dir, number>();

  // Show the focus ring while the pad is in use; a mouse press hides it again.
  document.addEventListener('pointerdown', () => document.body.classList.remove('pad-nav'), true);

  const frame = (now: number) => {
    requestAnimationFrame(frame);
    // Combine all pads: any of them can drive the menus.
    const pads = gamepads().filter((p): p is Gamepad => p !== null);
    const down = (b: number) => pads.some((p) => p.buttons[b]?.pressed ?? false);
    const axis = (n: number) => pads.reduce((a, p) => (Math.abs(p.axes[n] ?? 0) > Math.abs(a) ? (p.axes[n] ?? 0) : a), 0);
    const buttons = [down(A), down(B)];
    const dirHeld: Record<Dir, boolean> = {
      up: down(DPAD.up) || axis(1) < -STICK,
      down: down(DPAD.down) || axis(1) > STICK,
      left: down(DPAD.left) || axis(0) < -STICK,
      right: down(DPAD.right) || axis(0) > STICK,
    };
    const aTap = buttons[0]! && !prev[0];
    const bTap = buttons[1]! && !prev[1];
    prev = buttons;

    const screen = document.querySelector<HTMLElement>('.overlay:not([hidden])');
    if (!screen) {
      heldSince.clear();
      return;
    }
    // A redraw (lobby update, changed setting) dropped focus: put it back where it was.
    const focusGone = !(document.activeElement instanceof HTMLElement && screen.contains(document.activeElement));
    if (focusGone && spot?.screen === screen && document.body.classList.contains('pad-nav')) {
      const list = controls(screen);
      list[Math.min(spot.index, list.length - 1)]?.focus();
    }

    // Directions fire on the press, then repeat while held.
    const moves: Dir[] = [];
    for (const dir of Object.keys(dirHeld) as Dir[]) {
      if (!dirHeld[dir]) {
        heldSince.delete(dir);
        continue;
      }
      const since = heldSince.get(dir);
      if (since === undefined) {
        heldSince.set(dir, now);
        lastRepeat.set(dir, now);
        moves.push(dir);
      } else if (now - since > REPEAT_DELAY_MS && now - lastRepeat.get(dir)! > REPEAT_EVERY_MS) {
        lastRepeat.set(dir, now);
        moves.push(dir);
      }
    }
    if (!moves.length && !aTap && !bTap) return;
    document.body.classList.add('pad-nav');

    const list = controls(screen);
    const active = document.activeElement instanceof HTMLElement && list.includes(document.activeElement) ? document.activeElement : null;

    if (bTap) {
      spot = null;
      screen.querySelector<HTMLElement>('[data-back]')?.click();
      return;
    }
    // The first pad input on a screen just puts focus on its first control.
    if (!active) {
      list[0]?.focus();
      remember(screen);
      return;
    }
    if (aTap) {
      remember(screen);
      if (active instanceof HTMLSelectElement) stepSelect(active, 1);
      else if (!(active instanceof HTMLInputElement && active.type !== 'checkbox')) active.click();
      return;
    }
    for (const dir of moves) {
      if (active instanceof HTMLSelectElement && (dir === 'left' || dir === 'right')) {
        stepSelect(active, dir === 'left' ? -1 : 1);
        continue;
      }
      nearest(active, list, dir)?.focus();
    }
    remember(screen);
  };

  const remember = (screen: HTMLElement) => {
    const el = document.activeElement;
    const index = el instanceof HTMLElement ? controls(screen).indexOf(el) : -1;
    if (index >= 0) spot = { screen, index }; // keep the last good spot if focus is gone
  };
  requestAnimationFrame(frame);
}
