/**
 * Lets a gamepad drive the menus. While a menu screen is showing, the d-pad or left
 * stick moves focus to the nearest control in that direction, LB/RB step through every
 * control in order, A presses or toggles it, left/right change a dropdown, and B presses
 * the screen's back button (`data-back`).
 * It has its own frame loop and ignores the pads while no menu screen is showing.
 */
import { gamepads } from './input.ts';

type Dir = 'up' | 'down' | 'left' | 'right';

const STICK = 0.5;
const REPEAT_DELAY_MS = 350;
const REPEAT_EVERY_MS = 140;
const A = 0;
const B = 1;
const LB = 4;
const RB = 5;
const TAPPABLE = [A, B, LB, RB];
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

/**
 * Names a control by where it sits (section, seat row, type, and its place among controls
 * of that type in the row), so the same control can be found again after a redraw even
 * if controls were added or removed elsewhere on the screen.
 */
function describe(el: HTMLElement, screen: HTMLElement): string {
  const box = el.parentElement?.closest<HTMLElement>('[id]');
  const row = el.closest('.seat');
  const scope = row instanceof HTMLElement ? row : box && screen.contains(box) ? box : screen;
  const rowIndex = row?.parentElement ? [...row.parentElement.children].indexOf(row) : -1;
  const kindOf = (c: HTMLElement) => (c instanceof HTMLInputElement ? `input:${c.type}` : c.tagName);
  const same = controls(scope).filter((c) => kindOf(c) === kindOf(el));
  // Buttons also carry their label: a redraw can turn the same slot from Join into Kick.
  const label = el instanceof HTMLButtonElement ? `|${el.textContent}` : '';
  return `${box?.id ?? ''}|${rowIndex}|${kindOf(el)}|${same.indexOf(el)}${label}`;
}

function stepSelect(select: HTMLSelectElement, by: number): void {
  const i = Math.min(select.options.length - 1, Math.max(0, select.selectedIndex + by));
  if (i === select.selectedIndex) return;
  select.selectedIndex = i;
  select.dispatchEvent(new Event('change'));
}

/** Starts the menu navigation loop. Call once. */
export function startPadNav(): void {
  let prev: boolean[][] = []; // per pad, TAPPABLE buttons last frame
  // Where focus was on the current screen, so a redraw that drops it can put it back.
  let spot: { screen: HTMLElement; key: string } | null = null;

  // The remembered control after a redraw. If it's gone (e.g. Join became Kick), focus is
  // left alone rather than guessed, so the next A can't press something not chosen.
  const recall = (screen: HTMLElement, list: HTMLElement[]): HTMLElement | undefined =>
    spot ? list.find((c) => describe(c, screen) === spot!.key) : undefined;
  // Per pad and direction, so one pad holding a direction doesn't hide another's press.
  const heldSince = new Map<string, number>();
  const lastRepeat = new Map<string, number>();

  // The focus ring and focus restoring are for pad use only; mouse or keyboard input hands back.
  const handBack = () => document.body.classList.remove('pad-nav');
  document.addEventListener('pointerdown', handBack, true);
  document.addEventListener('keydown', handBack, true);

  const frame = (now: number) => {
    requestAnimationFrame(frame);
    // Any pad can drive the menus. Presses are tracked per pad, so one pad holding a
    // button doesn't hide another pad's press.
    const pads = gamepads();
    const pressedNow = pads.map((p) => (p ? TAPPABLE.map((b) => p.buttons[b]?.pressed ?? false) : []));
    const tap = (b: number) => pressedNow.some((btns, i) => btns[TAPPABLE.indexOf(b)] && !prev[i]?.[TAPPABLE.indexOf(b)]);
    const held = new Map<string, Dir>(); // "pad:dir" -> dir, for every direction held this frame
    pads.forEach((p, i) => {
      if (!p) return;
      const b = (n: number) => p.buttons[n]?.pressed ?? false;
      const [x = 0, y = 0] = p.axes;
      if (b(DPAD.up) || y < -STICK) held.set(`${i}:up`, 'up');
      if (b(DPAD.down) || y > STICK) held.set(`${i}:down`, 'down');
      if (b(DPAD.left) || x < -STICK) held.set(`${i}:left`, 'left');
      if (b(DPAD.right) || x > STICK) held.set(`${i}:right`, 'right');
    });
    const aTap = tap(A);
    const bTap = tap(B);
    const step = (tap(RB) ? 1 : 0) - (tap(LB) ? 1 : 0);
    prev = pressedNow;

    const screen = document.querySelector<HTMLElement>('.overlay:not([hidden])');
    if (!screen) {
      heldSince.clear();
      return;
    }
    // A redraw (lobby update, changed setting) dropped focus: put it back where it was.
    const focusGone = !(document.activeElement instanceof HTMLElement && screen.contains(document.activeElement));
    if (focusGone && spot?.screen === screen && document.body.classList.contains('pad-nav')) {
      recall(screen, controls(screen))?.focus();
    }

    // Directions fire on the press, then repeat while held.
    const moves: Dir[] = [];
    for (const key of heldSince.keys()) if (!held.has(key)) heldSince.delete(key);
    for (const [key, dir] of held) {
      const since = heldSince.get(key);
      if (since === undefined) {
        heldSince.set(key, now);
        lastRepeat.set(key, now);
        moves.push(dir);
      } else if (now - since > REPEAT_DELAY_MS && now - lastRepeat.get(key)! > REPEAT_EVERY_MS) {
        lastRepeat.set(key, now);
        moves.push(dir);
      }
    }
    if (!moves.length && !aTap && !bTap && !step) return;
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
    // Bumpers walk every control in page order, so none is out of reach whatever the layout.
    if (step) list[(list.indexOf(active) + step + list.length) % list.length]?.focus();
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
    if (el instanceof HTMLElement && index >= 0) spot = { screen, key: describe(el, screen) }; // keep the last good spot if focus is gone
  };
  requestAnimationFrame(frame);
}
