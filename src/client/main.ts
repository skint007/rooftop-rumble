/** Screens and wiring: title, local setup, online lobby, pause menu and results. */
import { MAX_PLAYERS, SEAT_COLORS, teamName, type Difficulty, type GameState, type MatchConfig, type PlayerSpec } from '../shared/game.ts';
import { MatchRunner } from '../shared/match.ts';
import { NAME_MAX, type ClientMsg, type LobbySeat, type LobbyView, type ServerMsg } from '../shared/protocol.ts';
import { sfx, toggleMute, unlockAudio } from './audio.ts';
import type { DragMode, PadBinding } from './input.ts';
import { Play, type Session } from './play.ts';

// ---------- small DOM helpers ----------

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

type Props<K extends keyof HTMLElementTagNameMap> = Partial<Omit<HTMLElementTagNameMap[K], 'className'>> & { className?: string };

function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props<K> = {}, ...kids: (Node | string)[]): HTMLElementTagNameMap[K] {
  const el = Object.assign(document.createElement(tag), props);
  el.append(...kids);
  return el;
}

/** A <select> over typed values. */
function pick<T extends string | number>(options: readonly (readonly [T, string])[], value: T, onChange: (v: T) => void, disabled = false): HTMLSelectElement {
  const el = h('select', { disabled });
  options.forEach(([v, label], i) => el.append(h('option', { value: String(i), selected: v === value }, label)));
  el.onchange = () => {
    sfx.click();
    onChange(options[Number(el.value)]![0]);
  };
  return el;
}

function swatch(seat: number): HTMLDivElement {
  const el = h('div', { className: 'swatch' });
  el.style.background = SEAT_COLORS[seat]!;
  return el;
}

function check(label: string, value: boolean, onChange: (v: boolean) => void, disabled = false): HTMLLabelElement {
  const box = h('input', { type: 'checkbox', checked: value, disabled });
  box.onchange = () => onChange(box.checked);
  return h('label', { className: 'check' }, box, label);
}

function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? { ...fallback, ...JSON.parse(raw) } : fallback;
  } catch {
    return fallback;
  }
}

function save(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage blocked: settings just won't persist.
  }
}

const TEAMS = Array.from({ length: MAX_PLAYERS }, (_, i) => [i, `Team ${teamName(i)}`] as const);
const DIFFS = [['easy', 'CPU easy'], ['normal', 'CPU normal'], ['hard', 'CPU hard']] as const satisfies readonly (readonly [Difficulty, string])[];
const PADS: readonly (readonly [PadBinding, string])[] = [['any', 'Any pad'], [0, 'Pad 1'], [1, 'Pad 2'], [2, 'Pad 3'], [3, 'Pad 4']];
const WINS = [[1, 'First to 1'], [3, 'First to 3'], [5, 'First to 5'], [7, 'First to 7']] as const;

// ---------- screens ----------

const screens = ['title', 'local', 'online', 'lobby', 'menu', 'results'] as const;
type ScreenId = (typeof screens)[number];

function show(id: ScreenId | null): void {
  for (const s of screens) $(s).hidden = s !== id;
  $('menu-btn').hidden = !(play && id === null);
}

let play: Play | null = null;
let endMatch: (() => void) | null = null; // set while a match is running
let rematch: (() => void) | null = null;
const prefs = load('rr.prefs', { name: '', dragMode: 'slingshot' as DragMode, muted: false });

document.addEventListener('pointerdown', unlockAudio);
document.addEventListener('keydown', unlockAudio);
document.querySelectorAll<HTMLButtonElement>('[data-go]').forEach((b) => {
  b.onclick = () => {
    sfx.click();
    const go = b.dataset.go as ScreenId;
    if (go === 'local') renderLocal();
    if (go === 'online') disconnect();
    show(go);
  };
});

function startPlay(session: Session, onEnd: () => void): Play {
  play?.stop();
  play = new Play($<HTMLCanvasElement>('game'), session);
  play.input.dragMode = prefs.dragMode;
  play.onPause = () => toggleMenu();
  play.onMatchOver = () => setTimeout(() => play && show('results'), 1800);
  endMatch = onEnd;
  show(null);
  return play;
}

function stopPlay(): void {
  play?.stop();
  play = null;
  endMatch = null;
  rematch = null;
}

function quitToTitle(): void {
  stopLocal?.();
  stopPlay();
  disconnect();
  show('title');
}

// ---------- pause menu and results ----------

function toggleMenu(): void {
  if (!play) return;
  if ($('menu').hidden) {
    $('menu-note').textContent = online ? 'The match keeps running while this is open.' : '';
    $('menu-end').hidden = online !== null && lobby?.hostId !== lobby?.you;
    show('menu');
  } else {
    show(null);
  }
}

function refreshMenuLabels(): void {
  $('menu-mute').textContent = `Sound: ${prefs.muted ? 'off' : 'on'}`;
  $('menu-drag').textContent = `Drag: ${prefs.dragMode}`;
}

if (prefs.muted) toggleMute();
refreshMenuLabels();
$('menu-btn').onclick = toggleMenu;
$('menu-resume').onclick = toggleMenu;
$('menu-mute').onclick = () => {
  prefs.muted = toggleMute();
  save('rr.prefs', prefs);
  refreshMenuLabels();
};
$('menu-drag').onclick = () => {
  prefs.dragMode = prefs.dragMode === 'slingshot' ? 'point' : 'slingshot';
  if (play) play.input.dragMode = prefs.dragMode;
  save('rr.prefs', prefs);
  refreshMenuLabels();
};
$('menu-end').onclick = () => endMatch?.();
$('menu-quit').onclick = quitToTitle;
$('results-quit').onclick = quitToTitle;
$('results-again').onclick = () => {
  sfx.click();
  rematch?.();
};
window.addEventListener('keydown', (e) => {
  if (e.code === 'Escape' && play && !play.input.dragging && $('results').hidden) toggleMenu();
});

// ---------- local play ----------

interface LocalSeat {
  kind: 'off' | 'human' | 'cpu';
  name: string;
  team: number;
  pad: PadBinding;
  difficulty: Difficulty;
}

const localSetup = load('rr.local', {
  seats: [
    { kind: 'human', name: 'Player 1', team: 0, pad: 'any', difficulty: 'normal' },
    { kind: 'cpu', name: 'CPU 2', team: 1, pad: 'any', difficulty: 'normal' },
    { kind: 'off', name: 'Player 3', team: 2, pad: 'any', difficulty: 'normal' },
    { kind: 'off', name: 'Player 4', team: 3, pad: 'any', difficulty: 'normal' },
  ] as LocalSeat[],
  config: { winsNeeded: 3, friendlyFire: false, teams: false } as MatchConfig,
});
let stopLocal: (() => void) | null = null;

function renderLocal(): void {
  const { seats, config } = localSetup;
  const rerender = () => {
    save('rr.local', localSetup);
    renderLocal();
  };
  $('local-seats').replaceChildren(
    ...seats.map((s, i) => {
      const name = h('input', { value: s.name, maxLength: NAME_MAX, disabled: s.kind === 'off' });
      name.oninput = () => {
        s.name = name.value;
        save('rr.local', localSetup);
      };
      const kind = pick([['off', 'Off'], ['human', 'Human'], ['cpu', 'CPU']], s.kind, (v) => {
        s.kind = v;
        rerender();
      });
      const extra =
        s.kind === 'human'
          ? [pick(PADS, s.pad, (v) => ((s.pad = v), rerender()))]
          : s.kind === 'cpu'
            ? [pick(DIFFS, s.difficulty, (v) => ((s.difficulty = v), rerender()))]
            : [];
      const team = config.teams && s.kind !== 'off' ? [pick(TEAMS, s.team, (v) => ((s.team = v), rerender()))] : [];
      return h(
        'div',
        { className: `seat ${s.kind === 'off' ? 'open' : ''}` },
        swatch(i),
        h('div', { className: 'fields' }, kind, name, ...extra, ...team),
      );
    }),
  );
  $('local-options').replaceChildren(...configControls(config, rerender, false));
}

/** Win target, teams and friendly fire. Shared by local setup and the online lobby. */
function configControls(config: MatchConfig, changed: () => void, disabled: boolean): HTMLElement[] {
  return [
    pick(WINS, config.winsNeeded as (typeof WINS)[number][0], (v) => ((config.winsNeeded = v), changed()), disabled),
    check('Teams', config.teams, (v) => ((config.teams = v), changed()), disabled),
    check('Friendly fire', config.friendlyFire, (v) => ((config.friendlyFire = v), changed()), disabled || !config.teams),
  ];
}

function specsFrom(seats: { kind: string; name: string; team: number; difficulty: Difficulty }[], teams: boolean): PlayerSpec[] {
  return seats.flatMap((s, i) =>
    s.kind === 'off' || s.kind === 'open'
      ? []
      : [{ seat: i, name: s.name.trim() || `Player ${i + 1}`, team: teams ? s.team : i, color: SEAT_COLORS[i]!, controller: s.kind === 'cpu' ? 'cpu' : 'human', difficulty: s.difficulty }],
  );
}

function startLocal(): void {
  const specs = specsFrom(localSetup.seats, localSetup.config.teams);
  if (specs.length < 2 || new Set(specs.map((s) => s.team)).size < 2) {
    $('local-error').textContent = 'Need at least two sides. Turn on another seat or change teams.';
    return;
  }
  $('local-error').textContent = '';
  stopLocal?.();
  let runner: MatchRunner | null = null;
  const session: Session = {
    localPlayer: (id) => {
      const p = runner?.state.players[id];
      return p?.controller === 'human' ? localSetup.seats[p.seat]!.pad : null;
    },
    aim: (id, a, p) => runner?.aim(id, a, p),
    throw: (id, a, p) => void runner?.throw(id, a, p),
  };
  const view = startPlay(session, () => {
    stopLocal?.();
    stopPlay();
    renderLocal();
    show('local');
  });
  runner = new MatchRunner(specs, structuredClone(localSetup.config), (ev) => view.receive(ev));
  stopLocal = () => {
    runner?.stop();
    stopLocal = null;
  };
  rematch = startLocal;
  $('results-again').textContent = 'Rematch';
  $('results-again').hidden = false;
  $('results-note').textContent = '';
  runner.start();
}

$('local-start').onclick = () => {
  sfx.click();
  startLocal();
};

// ---------- online play ----------

let net: WebSocket | null = null;
let online: { pads: Map<number, PadBinding> } | null = null;
let lobby: LobbyView | null = null;
let lastState: GameState | null = null;

function send(msg: ClientMsg): void {
  if (net?.readyState === WebSocket.OPEN) net.send(JSON.stringify(msg));
}

/** Leaves the room on purpose, without the "disconnected" error. */
function disconnect(): void {
  const ws = net;
  net = null;
  online = null;
  lobby = null;
  ws?.close();
  if (location.search) history.replaceState(null, '', location.pathname);
}

function connect(first: ClientMsg): void {
  disconnect();
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  net = ws;
  online = { pads: new Map() };
  ws.onopen = () => ws.send(JSON.stringify(first));
  ws.onmessage = (e) => onServer(JSON.parse(String(e.data)) as ServerMsg);
  ws.onclose = () => {
    if (net !== ws) return;
    const wasIn = lobby !== null;
    net = null;
    online = null;
    lobby = null;
    stopPlay();
    show('online');
    $('online-error').textContent = wasIn ? 'Disconnected from the server.' : 'Could not reach the server.';
  };
}

function onServer(msg: ServerMsg): void {
  switch (msg.t) {
    case 'error':
      $(lobby ? 'lobby-error' : 'online-error').textContent = msg.message;
      return;
    case 'lobby':
      return onLobby(msg.lobby);
    case 'state':
      lastState = msg.state;
      play?.receive(msg);
      return;
    case 'throw':
      lastState = msg.after;
      play?.receive(msg);
      return;
    case 'aim':
      play?.receive(msg);
  }
}

function onLobby(next: LobbyView): void {
  const first = lobby === null;
  lobby = next;
  history.replaceState(null, '', `?room=${next.code}`);
  if (next.inGame && !play) {
    startOnlinePlay();
  } else if (!next.inGame && play) {
    stopPlay();
    show('lobby');
  } else if (first) {
    show('lobby');
  }
  if (play) updateResultsButtons();
  renderLobby();
}

function startOnlinePlay(): void {
  const session: Session = {
    localPlayer: (id) => {
      const seat = lastState?.players[id]?.seat ?? -1;
      return lobby?.seats[seat]?.owner === lobby?.you ? (online?.pads.get(seat) ?? 'any') : null;
    },
    aim: (id, angle, power) => send({ t: 'aim', id, angle, power }),
    throw: (id, angle, power) => send({ t: 'throw', id, angle, power }),
  };
  startPlay(session, () => send({ t: 'lobby' }));
  rematch = () => send({ t: 'lobby' });
  updateResultsButtons();
}

function updateResultsButtons(): void {
  const host = lobby?.hostId === lobby?.you;
  $('results-again').textContent = 'Back to lobby';
  $('results-again').hidden = !host;
  $('results-note').textContent = host ? '' : 'Waiting for the host to head back to the lobby…';
}

function renderLobby(): void {
  if (!lobby) return;
  const L = lobby;
  const host = L.hostId === L.you;
  const nameOf = (id: string | null) => L.clients.find((c) => c.id === id)?.name ?? '?';
  $('lobby-code').textContent = L.code;
  $('lobby-seats').replaceChildren(
    ...L.seats.map((s: LobbySeat, i) => {
      const mine = s.owner === L.you;
      const fields: (HTMLElement | string)[] = [];
      if (s.kind === 'open') {
        fields.push(h('span', { className: 'who' }, 'Open seat'));
        fields.push(button('Join', () => send({ t: 'claim', seat: i })));
        if (host) fields.push(button('Add CPU', () => send({ t: 'cpu', seat: i, on: true }), true));
      } else if (mine) {
        const name = h('input', { value: s.name, maxLength: NAME_MAX });
        name.onchange = () => send({ t: 'seat', seat: i, name: name.value });
        fields.push(name);
        fields.push(pick(PADS, online?.pads.get(i) ?? 'any', (v) => (online?.pads.set(i, v), renderLobby())));
        if (L.config.teams) fields.push(pick(TEAMS, s.team, (v) => send({ t: 'seat', seat: i, team: v })));
        fields.push(button('Leave', () => send({ t: 'release', seat: i }), true));
      } else if (s.kind === 'cpu') {
        fields.push(h('span', { className: 'who' }, s.name, h('em', {}, 'Computer')));
        fields.push(pick(DIFFS, s.difficulty, (v) => send({ t: 'seat', seat: i, difficulty: v }), !host));
        if (L.config.teams) fields.push(pick(TEAMS, s.team, (v) => send({ t: 'seat', seat: i, team: v }), !host));
        if (host) fields.push(button('Remove', () => send({ t: 'release', seat: i }), true));
      } else {
        fields.push(h('span', { className: 'who' }, s.name, h('em', {}, `${nameOf(s.owner)}${s.owner === L.hostId ? ' · host' : ''}`)));
        if (L.config.teams) fields.push(h('span', {}, `Team ${teamName(s.team)}`));
        if (host) fields.push(button('Kick', () => send({ t: 'release', seat: i }), true));
      }
      return h(
        'div',
        { className: `seat ${s.kind === 'open' ? 'open' : ''}` },
        swatch(i),
        h('div', { className: 'fields' }, ...fields),
      );
    }),
  );
  const config = structuredClone(L.config);
  $('lobby-options').replaceChildren(
    ...configControls(config, () => send({ t: 'config', config }), !host),
    h('span', { className: 'small' }, `${L.clients.length} connected${host ? ' · you are host' : ''}`),
  );
  $<HTMLButtonElement>('lobby-start').hidden = !host;
}

function button(label: string, onClick: () => void, ghost = false): HTMLButtonElement {
  const b = h('button', { className: `small-btn ${ghost ? 'ghost' : ''}` }, label);
  b.onclick = () => {
    sfx.click();
    onClick();
  };
  return b;
}

const nameInput = $<HTMLInputElement>('online-name');
nameInput.value = prefs.name;
const playerName = () => {
  prefs.name = nameInput.value.trim();
  save('rr.prefs', prefs);
  return prefs.name || 'Player';
};
$('online-create').onclick = () => {
  sfx.click();
  $('online-error').textContent = '';
  connect({ t: 'create', name: playerName() });
};
$('online-join').onclick = () => {
  sfx.click();
  const code = $<HTMLInputElement>('online-code').value.trim().toUpperCase();
  if (!code) return void ($('online-error').textContent = 'Enter a room code.');
  $('online-error').textContent = '';
  connect({ t: 'join', code, name: playerName() });
};
$('lobby-start').onclick = () => {
  sfx.click();
  $('lobby-error').textContent = '';
  send({ t: 'start' });
};
$('lobby-leave').onclick = () => {
  sfx.click();
  disconnect();
  show('online');
};
$('lobby-copy').onclick = () => {
  void navigator.clipboard?.writeText(location.href);
  $('lobby-copy').textContent = 'Copied!';
  setTimeout(() => ($('lobby-copy').textContent = 'Copy link'), 1200);
};

// A ?room=CODE link drops you on the join screen with the code filled in.
const roomParam = new URLSearchParams(location.search).get('room');
if (roomParam) {
  $<HTMLInputElement>('online-code').value = roomParam.slice(0, 4).toUpperCase();
  show('online');
} else {
  show('title');
}
