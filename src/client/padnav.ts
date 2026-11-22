/**
 * Lets a gamepad drive the menus with one simple scheme. While a menu screen is showing:
 * up/down (d-pad, left stick, or LB/RB) step through the controls in page order, left/right
 * change the focused dropdown (or move between buttons in the same row), A presses a button or
 * toggles a checkbox, and B presses the screen's back button (`data-back`). Text fields are
 * skipped, since a controller can't type. A hint bar shows the scheme while a pad is in use.
 * It has its own frame loop and ignores the pads while no menu screen is showing.
 */
import { gamepads } from './input.ts';

type Dir = 'up' | 'down' | 'left' | 'right';

const STICK = 0.5; // stick tilt that starts a direction
const STICK_RELEASE = 0.35; // ...and the tilt it has to drop below to end it
const SWITCH_MARGIN = 0.2; // the other stick axis must win by this much to change direction
const REPEAT_DELAY_MS = 350;
const REPEAT_EVERY_MS = 140;
const A = 0;
const B = 1;
const LB = 4;
const RB = 5;
const START = 9;
const TAPPABLE = [A, B, LB, RB, START];
const HELD_BEFORE = -1; // heldSince marker: held since before the menu appeared
const DPAD: Record<Dir, number> = { up: 12, down: 13, left: 14, right: 15 };

/** Controls a pad can use on the visible menu screen, in page order. Text fields are left out. */
function controls(screen: HTMLElement): HTMLElement[] {
  return [...screen.querySelectorAll<HTMLElement>('button, select, input[type=checkbox]')].filter(
    (el) => !(el as HTMLButtonElement).disabled && el.getClientRects().length > 0,
  );
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
  const stickAxis = new Map<number, 'x' | 'y' | null>(); // per pad, the axis the stick is counting
  const stickLocked = new Set<number>(); // pads whose stick is ignored until it returns to centre
  // Only a stick that's tilted right now needs to wait; a centred one is free to use at once.
  const lockTiltedSticks = () =>
    gamepads().forEach((p, i) => {
      if (p && (Math.abs(p.axes[0] ?? 0) >= STICK_RELEASE || Math.abs(p.axes[1] ?? 0) >= STICK_RELEASE)) stickLocked.add(i);
    });
  const lastRepeat = new Map<string, number>();

  // Directions held right now are ignored until released (used when the screen or the
  // input device changes, so a held stick doesn't keep moving focus somewhere new).
  const ignoreHeld = () => {
    for (const key of heldSince.keys()) heldSince.set(key, HELD_BEFORE);
    lockTiltedSticks();
  };
  let lastScreen: HTMLElement | null = null;
  const hint = document.querySelector<HTMLElement>('.pad-hint');
  let lastHintSpace = '';

  // The focus ring and focus restoring are for pad use only; mouse or keyboard input hands back.
  const handBack = () => {
    document.body.classList.remove('pad-nav');
    ignoreHeld();
  };
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
      // The stick gives one direction at a time. It starts past STICK and holds until it
      // drops below STICK_RELEASE, and keeps its axis until the other clearly wins, so
      // wobble near a threshold or a diagonal doesn't flip it.
      const [ax = 0, ay = 0] = p.axes;
      const [mx, my] = [Math.abs(ax), Math.abs(ay)];
      const centred = mx < STICK_RELEASE && my < STICK_RELEASE;
      // After a screen change or keyboard/mouse use, the stick waits until it's let go.
      if (centred) stickLocked.delete(i);
      const was = stickAxis.get(i);
      const axis = stickLocked.has(i)
        ? null
        : was === 'x' && mx >= STICK_RELEASE && my < mx + SWITCH_MARGIN
          ? 'x'
          : was === 'y' && my >= STICK_RELEASE && mx < my + SWITCH_MARGIN
            ? 'y'
            : mx > STICK || my > STICK
              ? mx >= my ? 'x' : 'y'
              : null;
      stickAxis.set(i, axis);
      if (b(DPAD.up) || (axis === 'y' && ay < 0)) held.set(`${i}:up`, 'up');
      if (b(DPAD.down) || (axis === 'y' && ay > 0)) held.set(`${i}:down`, 'down');
      if (b(DPAD.left) || (axis === 'x' && ax < 0)) held.set(`${i}:left`, 'left');
      if (b(DPAD.right) || (axis === 'x' && ax > 0)) held.set(`${i}:right`, 'right');
    });
    const aTap = tap(A);
    const bTap = tap(B);
    const step = (tap(RB) ? 1 : 0) - (tap(LB) ? 1 : 0);
    // Start opens the in-game menu (play.ts handles that); here it just counts as pad use,
    // so the hint shows even if the keyboard was used last.
    if (tap(START)) document.body.classList.add('pad-nav');
    prev = pressedNow;

    const screen = document.querySelector<HTMLElement>('.overlay:not([hidden])');
    document.body.classList.toggle('menu-open', screen !== null); // shows the pad hint bar
    document.body.classList.toggle('menu-has-back', screen?.querySelector('[data-back]') != null); // "B back" in the hint
    // Reserve the hint bar's real height (it wraps on narrow screens) below every menu.
    const hintSpace = `${(hint?.offsetHeight ?? 0) + 24}px`;
    if (hintSpace !== lastHintSpace) {
      document.documentElement.style.setProperty('--hint-space', hintSpace);
      lastHintSpace = hintSpace;
    }
    if (!screen) {
      // Directions held while no menu is showing (e.g. setting power in a match) are
      // ignored until released, so opening the menu doesn't send focus running.
      heldSince.clear();
      for (const key of held.keys()) heldSince.set(key, HELD_BEFORE);
      lockTiltedSticks();
      lastScreen = null;
      return;
    }
    if (screen !== lastScreen) {
      // A screen (re)appearing starts fresh: restoring is only for redraws within one showing,
      // so reopening the menu never lands on End match by itself.
      for (const key of held.keys()) heldSince.set(key, HELD_BEFORE);
      lockTiltedSticks();
      spot = null;
      lastScreen = screen;
    }
    // A redraw (lobby update, changed setting) dropped focus: put it back where it was.
    const focusGone = !(document.activeElement instanceof HTMLElement && screen.contains(document.activeElement));
    if (focusGone && spot?.screen === screen && document.body.classList.contains('pad-nav')) {
      const again = recall(screen, controls(screen));
      // Gone means gone: a later redraw (e.g. someone new in that seat) mustn't bring it back.
      if (again) again.focus();
      else spot = null;
    }

    // Directions fire on the press, then repeat while held.
    const moves: Dir[] = [];
    for (const key of heldSince.keys()) if (!held.has(key)) heldSince.delete(key);
    for (const [key, dir] of held) {
      const since = heldSince.get(key);
      if (since === HELD_BEFORE) continue;
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
      // A presses buttons and toggles checkboxes. Dropdowns only change with left/right,
      // so A can't change a setting by accident.
      remember(screen);
      if (!(active instanceof HTMLSelectElement)) active.click();
      return;
    }
    // Moves go to the previous/next control in page order (stopping at the ends).
    const go = (by: number) => {
      const i = Math.min(list.length - 1, Math.max(0, list.indexOf(active) + by));
      list[i]?.focus();
    };
    if (step) go(step);
    // One move per frame, so two directions at once (e.g. d-pad diagonals) can't both act
    // and the second can't land on a control the first one just left.
    for (const dir of moves.slice(0, step ? 0 : 1)) {
      if (dir === 'up' || dir === 'down') {
        go(dir === 'down' ? 1 : -1);
      } else if (active instanceof HTMLSelectElement) {
        remember(screen); // before the change, which may redraw and drop focus
        stepSelect(active, dir === 'left' ? -1 : 1);
      } else if (active instanceof HTMLButtonElement) {
        // Only along this row of buttons (same parent, same line); never off its end onto a setting.
        const top = active.getBoundingClientRect().top;
        const row = list.filter(
          (c) => c instanceof HTMLButtonElement && c.parentElement === active.parentElement && Math.abs(c.getBoundingClientRect().top - top) < 8,
        );
        row[row.indexOf(active) + (dir === 'right' ? 1 : -1)]?.focus();
      }
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
