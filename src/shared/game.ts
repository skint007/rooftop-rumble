/**
 * Rooftop Rumble game rules.
 *
 * Pure functions over plain JSON-safe objects. The server runs them for online
 * matches and the browser runs them for local matches, so both behave the same.
 *
 * Coordinates are logical pixels in a WORLD_W x WORLD_H world with y pointing down.
 * Angles are degrees: 0 = right, 90 = straight up, 180 = left.
 */

export const WORLD_W = 1280;
export const WORLD_H = 720;
export const GRAVITY = 420; // px/s²
export const MAX_POWER = 100;
export const MAX_WIND = 90; // px/s² of sideways push
export const PATH_FPS = 60; // ThrowResult.path is sampled at this rate

export const BODY_OFFSET = 18; // body centre, measured up from the feet
export const BODY_RADIUS = 15;
export const HAND_OFFSET = 40; // the can leaves the paw this far above the feet

const SPEED_PER_POWER = 9.5;
const SIM_DT = 1 / 120;
const SWEEP_PX = 2; // collision checks are at most this far apart
const CPU_SWEEP_PX = 6; // coarser for the CPU's many trial throws
const MAX_FLIGHT_SECONDS = 14;
const BLAST_RADIUS = 34;
const DIRECT_HIT_BLAST = 52;
const DEADLY_FALL = 160;

export const MAX_PLAYERS = 4;
export const SEAT_COLORS = ['#ff8c42', '#4cc9f0', '#a7e05a', '#f15bb5'] as const;

export type Difficulty = 'easy' | 'normal' | 'hard';
export type Controller = 'human' | 'cpu';

/** Who is playing. Built by the lobby (online) or the setup screen (local). */
export interface PlayerSpec {
  seat: number;
  name: string;
  team: number;
  color: string;
  controller: Controller;
  difficulty: Difficulty;
}

export interface Player extends PlayerSpec {
  id: number;
  x: number;
  y: number; // feet
  alive: boolean;
  lastAngle: number;
  lastPower: number;
  shots: number; // throws this round, CPUs use it to "learn"
}

export interface Building {
  x: number;
  w: number;
  h: number;
  style: number; // picks colours and window pattern when drawing
  seed: number;
}

export interface Crater {
  x: number;
  y: number;
  r: number;
}

export interface MatchConfig {
  winsNeeded: number;
  friendlyFire: boolean;
  teams: boolean;
}

export type Phase = 'aiming' | 'roundOver' | 'matchOver';

export interface GameState {
  config: MatchConfig;
  players: Player[];
  scores: number[]; // round wins per team
  round: number;
  seed: number;
  buildings: Building[];
  craters: Crater[];
  wind: number;
  turnTeams: number[]; // teams in the order they take turns
  lastThrower: number[]; // per team, id of its most recent thrower
  current: number; // id of the player whose turn it is
  phase: Phase;
  turn: number; // changes every turn; throws must name it, so stale ones are ignored
  roundWinner: number | null; // team, or -1 for a draw
  matchWinner: number | null;
}

export interface Fall {
  id: number;
  toY: number;
  died: boolean;
}

/** Everything needed to animate a throw and then apply it with applyThrow. */
export interface ThrowResult {
  shooter: number;
  angle: number;
  power: number;
  path: number[]; // flat [x0, y0, x1, y1, ...] at PATH_FPS
  impact: Crater | null; // null when the can flew off the side
  hitPlayer: number | null;
  killed: number[];
  falls: Fall[];
}

export interface Shot {
  angle: number;
  power: number;
}

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const round1 = (v: number) => Math.round(v * 10) / 10;

export function teamName(team: number): string {
  return 'ABCD'[team] ?? '?';
}

/** Deterministic PRNG (mulberry32). Returns floats in [0, 1). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function randomSeed(): number {
  return Math.floor(Math.random() * 2 ** 31);
}

/** A fresh match. Call startRound before the first turn. */
export function createMatch(specs: PlayerSpec[], config: MatchConfig): GameState {
  return {
    config,
    players: specs.map((s, id) => ({ ...s, id, x: 0, y: 0, alive: true, lastAngle: 45, lastPower: 50, shots: 0 })),
    scores: [0, 0, 0, 0],
    round: 0,
    seed: 0,
    buildings: [],
    craters: [],
    wind: 0,
    turnTeams: [],
    lastThrower: [-1, -1, -1, -1],
    current: 0,
    phase: 'aiming',
    turn: randomSeed(), // random start, so a throw from an earlier match can't match
    roundWinner: null,
    matchWinner: null,
  };
}

/** A skyline that fills the screen. The overall shape varies per seed. */
export function generateCity(seed: number): Building[] {
  const rand = rng(seed);
  const shape = Math.floor(rand() * 5);
  const out: Building[] = [];
  let x = 0;
  while (x < WORLD_W) {
    let w = 54 + Math.floor(rand() * 58);
    if (WORLD_W - x - w < 54) w = WORLD_W - x;
    const t = (x + w / 2) / WORLD_W;
    const trend = [
      0.5, // jumbled
      0.25 + 0.5 * t, // rising
      0.75 - 0.5 * t, // falling
      0.28 + 0.9 * Math.abs(t - 0.5), // valley
      0.73 - 0.9 * Math.abs(t - 0.5), // peak
    ][shape]!;
    const h = clamp(trend * 400 + 60 + (rand() - 0.5) * 150, 80, 470);
    out.push({ x, w, h: Math.round(h), style: Math.floor(rand() * 64), seed: Math.floor(rand() * 2 ** 31) });
    x += w;
  }
  return out;
}

/** New city, new wind, everyone alive again. */
export function startRound(state: GameState, seed: number): void {
  const rand = rng(seed ^ 0x5bd1e995);
  state.round += 1;
  state.seed = seed;
  state.buildings = generateCity(seed);
  state.craters = [];
  state.wind = rand() < 0.15 ? 0 : Math.round((rand() * 2 - 1) * MAX_WIND);
  state.phase = 'aiming';
  state.roundWinner = null;
  placePlayers(state);
  for (const p of state.players) {
    p.alive = true;
    p.shots = 0;
    p.lastAngle = p.x < WORLD_W / 2 ? 45 : 135;
    p.lastPower = 50;
  }
  // Teams take turns in rotation, and a different team leads off each round.
  const teams = [...new Set(state.players.map((p) => p.team))].sort((a, b) => a - b);
  const lead = (state.round - 1) % teams.length;
  state.turnTeams = [...teams.slice(lead), ...teams.slice(0, lead)];
  // Each team's opener rotates through its members from round to round.
  for (const team of teams) {
    const members = state.players.filter((p) => p.team === team);
    state.lastThrower[team] = members[(((state.round - 2) % members.length) + members.length) % members.length]!.id;
  }
  state.current = nextMember(state, state.turnTeams[0]!)!;
}

// Teammates stand next to each other, spread evenly across the city.
function placePlayers(state: GameState): void {
  const { buildings, players } = state;
  const n = players.length;
  const order = [...players].sort((a, b) => a.team - b.team || a.id - b.id);
  const used = new Set<number>();
  order.forEach((p, k) => {
    const fx = n === 1 ? 0.5 : 0.08 + (0.84 * k) / (n - 1);
    let idx = buildings.findIndex((b) => fx * WORLD_W < b.x + b.w);
    const step = fx < 0.5 ? 1 : -1;
    while (used.has(idx)) idx = clamp(idx + step, 0, buildings.length - 1);
    used.add(idx);
    const b = buildings[idx]!;
    p.x = b.x + b.w / 2;
    p.y = WORLD_H - b.h;
  });
}

const columnCache = new WeakMap<Building[], Int16Array>();

// Maps every x column to its building index, for fast hit tests.
function columns(buildings: Building[]): Int16Array {
  let cols = columnCache.get(buildings);
  if (!cols) {
    cols = new Int16Array(WORLD_W).fill(-1);
    buildings.forEach((b, i) => cols!.fill(i, Math.max(0, b.x), Math.min(WORLD_W, b.x + b.w)));
    columnCache.set(buildings, cols);
  }
  return cols;
}

/** True if (x, y) is brick: inside a building and not blown away. The street is always solid. */
export function isSolid(buildings: Building[], craters: Crater[], x: number, y: number): boolean {
  if (y >= WORLD_H) return true;
  if (x < 0 || x >= WORLD_W || y < 0) return false;
  const b = buildings[columns(buildings)[Math.floor(x)]!];
  if (!b || y < WORLD_H - b.h) return false;
  for (const c of craters) {
    const dx = x - c.x;
    const dy = y - c.y;
    if (dx * dx + dy * dy < c.r * c.r) return false;
  }
  return true;
}

interface TraceHit {
  x: number;
  y: number;
  player: number | null;
  out: boolean;
}

// Flies a can until it hits something. When `record` is given, appends path points to it.
function trace(state: GameState, shooter: number, shot: Shot, dt: number, sweepPx: number, record?: number[]): TraceHit {
  const me = state.players[shooter]!;
  const rad = (shot.angle * Math.PI) / 180;
  const speed = shot.power * SPEED_PER_POWER;
  let x = me.x;
  let y = me.y - HAND_OFFSET;
  let vx = Math.cos(rad) * speed;
  let vy = -Math.sin(rad) * speed;
  let clearOfShooter = false;
  const every = Math.max(1, Math.round(1 / (dt * PATH_FPS)));
  const finish = (hit: TraceHit) => {
    record?.push(round1(hit.x), round1(hit.y));
    return hit;
  };
  record?.push(round1(x), round1(y));

  const steps = MAX_FLIGHT_SECONDS / dt;
  for (let i = 1; i <= steps; i++) {
    vx += state.wind * dt;
    vy += GRAVITY * dt;
    const px = x;
    const py = y;
    x += vx * dt;
    y += vy * dt;
    if (x < -80 || x > WORLD_W + 80) return finish({ x, y, player: null, out: true });

    // Check points along the step, not just its end, so the can can't skip a corner.
    const sub = Math.max(1, Math.ceil(Math.hypot(x - px, y - py) / sweepPx));
    for (let k = 1; k <= sub; k++) {
      const sx = px + ((x - px) * k) / sub;
      const sy = py + ((y - py) * k) / sub;
      for (const p of state.players) {
        if (!p.alive) continue;
        const d = Math.hypot(sx - p.x, sy - (p.y - BODY_OFFSET));
        // The can starts inside the thrower's reach, so ignore them until it gets clear.
        if (p.id === shooter && !clearOfShooter) {
          if (d > BODY_RADIUS + 12) clearOfShooter = true;
          continue;
        }
        if (d < BODY_RADIUS + 3) return finish({ x: sx, y: sy, player: p.id, out: false });
      }
      if (isSolid(state.buildings, state.craters, sx, sy)) return finish({ x: sx, y: sy, player: null, out: false });
    }
    if (record && i % every === 0) record.push(round1(x), round1(y));
  }
  return finish({ x, y, player: null, out: true });
}

// Where someone standing at (x, y) ends up once the ground under them is gone.
function landingY(buildings: Building[], craters: Crater[], x: number, y: number): number {
  for (let yy = Math.floor(y); yy < WORLD_H; yy++) {
    if ([-6, 0, 6].some((dx) => isSolid(buildings, craters, x + dx, yy))) return yy === Math.floor(y) ? y : yy;
  }
  return WORLD_H;
}

/** Simulates a throw without changing state. Animate it, then call applyThrow. */
export function computeThrow(state: GameState, shooter: number, angle: number, power: number): ThrowResult {
  const shot = { angle: clamp(round1(angle), 0, 180), power: clamp(round1(power), 0, MAX_POWER) };
  const path: number[] = [];
  const hit = trace(state, shooter, shot, SIM_DT, SWEEP_PX, path);
  const result: ThrowResult = { shooter, ...shot, path, impact: null, hitPlayer: hit.player, killed: [], falls: [] };
  if (hit.out) return result;

  const impact = { x: round1(hit.x), y: round1(hit.y), r: hit.player === null ? BLAST_RADIUS : DIRECT_HIT_BLAST };
  result.impact = impact;
  const me = state.players[shooter]!;
  // Friendly fire off protects teammates, but you can still blow yourself up.
  const canHarm = (p: Player) => state.config.friendlyFire || p.id === shooter || p.team !== me.team;

  for (const p of state.players) {
    if (!p.alive || !canHarm(p)) continue;
    const d = Math.hypot(p.x - impact.x, p.y - BODY_OFFSET - impact.y);
    if (p.id === hit.player || d < impact.r * 0.75 + BODY_RADIUS) result.killed.push(p.id);
  }

  const craters = [...state.craters, impact];
  for (const p of state.players) {
    if (!p.alive || result.killed.includes(p.id)) continue;
    const toY = landingY(state.buildings, craters, p.x, p.y);
    if (toY !== p.y) result.falls.push({ id: p.id, toY, died: toY >= WORLD_H || toY - p.y > DEADLY_FALL });
  }
  return result;
}

/** Applies a computed throw and decides whether the round or match is over. */
export function applyThrow(state: GameState, res: ThrowResult): void {
  const me = state.players[res.shooter]!;
  me.lastAngle = res.angle;
  me.lastPower = res.power;
  me.shots += 1;
  state.lastThrower[me.team] = me.id;
  if (res.impact) state.craters.push(res.impact);
  for (const id of res.killed) state.players[id]!.alive = false;
  for (const f of res.falls) {
    const p = state.players[f.id]!;
    p.y = f.toY;
    if (f.died) p.alive = false;
  }

  const teamsAlive = new Set(state.players.filter((p) => p.alive).map((p) => p.team));
  if (teamsAlive.size > 1) return;
  const winner = teamsAlive.size === 1 ? [...teamsAlive][0]! : -1;
  state.roundWinner = winner;
  if (winner >= 0) state.scores[winner]! += 1;
  if (winner >= 0 && state.scores[winner]! >= state.config.winsNeeded) {
    state.phase = 'matchOver';
    state.matchWinner = winner;
  } else {
    state.phase = 'roundOver';
  }
}

/**
 * Passes the turn to the next team that still has someone standing, so teams
 * alternate even when they're uneven. Within a team, members take turns in order.
 */
export function advanceTurn(state: GameState): void {
  const curTeam = state.players[state.current]!.team;
  const teams = state.turnTeams;
  const start = teams.indexOf(curTeam);
  for (let k = 1; k <= teams.length; k++) {
    const next = nextMember(state, teams[(start + k) % teams.length]!);
    if (next !== null) {
      state.current = next;
      return;
    }
  }
}

// The living teammate after the team's last thrower, or null if the whole team is down.
function nextMember(state: GameState, team: number): number | null {
  const members = state.players.filter((p) => p.team === team && p.alive);
  const last = state.lastThrower[team]!;
  return (members.find((p) => p.id > last) ?? members[0])?.id ?? null;
}

/** Names of the players on a team, for banners. */
export function teamLabel(state: GameState, team: number): string {
  const names = state.players.filter((p) => p.team === team).map((p) => p.name);
  return state.config.teams ? `Team ${teamName(team)}` : (names[0] ?? '?');
}

const CPU_NOISE: Record<Difficulty, { angle: number; power: number; floor: number }> = {
  easy: { angle: 8, power: 11, floor: 0.5 },
  normal: { angle: 3.5, power: 5, floor: 0.35 },
  hard: { angle: 1.2, power: 1.8, floor: 0.5 },
};

function gauss(rand: () => number): number {
  return Math.sqrt(-2 * Math.log(rand() || 1e-9)) * Math.cos(2 * Math.PI * rand());
}

/**
 * Picks a throw for a CPU player: finds the best shot at an enemy, then adds
 * aiming error. The error shrinks with each throw, like a person zeroing in.
 */
export function cpuChooseShot(state: GameState, id: number, seed: number): Shot {
  const me = state.players[id]!;
  const rand = rng(seed);
  const enemies = state.players
    .filter((p) => p.alive && p.team !== me.team)
    .sort((a, b) => Math.abs(a.x - me.x) - Math.abs(b.x - me.x));
  if (enemies.length === 0) return { angle: me.lastAngle, power: me.lastPower };
  const target = rand() < 0.75 ? enemies[0]! : enemies[Math.floor(rand() * enemies.length)]!;
  const friends = state.players.filter((p) => p.alive && p.team === me.team);
  const dir = target.x >= me.x ? 1 : -1;

  let best = { a: 45, power: 60, score: Infinity };
  // Tries a grid of throws (angle measured from the horizontal toward the target) and keeps the best.
  const search = (a0: number, a1: number, aStep: number, p0: number, p1: number, pStep: number) => {
    for (let a = a0; a <= a1; a += aStep) {
      for (let power = p0; power <= p1; power += pStep) {
        const hit = trace(state, id, { angle: dir > 0 ? a : 180 - a, power }, 1 / 60, CPU_SWEEP_PX);
        if (hit.out) continue;
        let score = Math.hypot(hit.x - target.x, hit.y - (target.y - BODY_OFFSET)) + power * 0.05;
        for (const f of friends) if (Math.hypot(hit.x - f.x, hit.y - (f.y - BODY_OFFSET)) < 75) score += 1000;
        if (score < best.score) best = { a, power, score };
      }
    }
  };
  // Coarse pass, then a finer one around the best. Bounded cost, since the server runs this inline.
  search(15, 85, 5, 20, MAX_POWER, 2.5);
  const { a, power } = best;
  search(Math.max(10, a - 4), Math.min(88, a + 4), 1, Math.max(5, power - 3), Math.min(MAX_POWER, power + 3), 0.5);
  const bestAngle = dir > 0 ? best.a : 180 - best.a;

  const noise = CPU_NOISE[me.difficulty];
  const learn = Math.max(noise.floor, 0.7 ** me.shots);
  return {
    angle: round1(clamp(bestAngle + gauss(rand) * noise.angle * learn, 0, 180)),
    power: round1(clamp(best.power + gauss(rand) * noise.power * learn, 5, MAX_POWER)),
  };
}
