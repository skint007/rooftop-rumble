/**
 * Runs a match: turn flow, CPU turns and round transitions.
 *
 * The server uses it for online rooms and the browser uses it for local games,
 * so both play out the same. It talks to the outside world only through `emit`.
 */
import {
  advanceTurn,
  applyThrow,
  computeThrow,
  cpuChooseShot,
  createMatch,
  PATH_FPS,
  randomSeed,
  startRound,
  type GameState,
  type MatchConfig,
  type PlayerSpec,
  type ThrowResult,
} from './game.ts';

export type MatchEvent =
  | { t: 'state'; state: GameState }
  | { t: 'throw'; result: ThrowResult; after: GameState }
  | { t: 'aim'; id: number; angle: number; power: number };

const CPU_THINK_MS = 1100;
const ROUND_PAUSE_MS = 3200;
export const AIM_TWEEN_MS = 450;

/** How long clients take to animate a throw. The runner waits this long before moving on. */
export function throwDurationMs(res: ThrowResult): number {
  const flight = (res.path.length / 2 / PATH_FPS) * 1000;
  const boom = res.impact ? 650 : 250;
  const fall = res.falls.length ? 900 : 0;
  return AIM_TWEEN_MS + flight + boom + fall + 250;
}

export class MatchRunner {
  readonly state: GameState;
  private busy = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private emit: (ev: MatchEvent) => void;

  constructor(specs: PlayerSpec[], config: MatchConfig, emit: (ev: MatchEvent) => void) {
    this.state = createMatch(specs, config);
    this.emit = emit;
  }

  start(): void {
    startRound(this.state, randomSeed());
    this.beginTurn();
  }

  stop(): void {
    clearTimeout(this.timer);
  }

  /** Swaps a player between human and CPU control, e.g. when someone disconnects. */
  setCpu(id: number): void {
    const p = this.state.players[id];
    if (!p || p.controller === 'cpu') return;
    p.controller = 'cpu';
    p.difficulty = 'normal';
    if (this.state.current === id && !this.busy && this.state.phase === 'aiming') this.beginTurn();
  }

  /** Live aim from the current player, relayed so everyone sees the arrow move. */
  aim(id: number, angle: number, power: number): void {
    if (this.canAct(id)) this.emit({ t: 'aim', id, angle, power });
  }

  /** A human throws. Ignored if it isn't their turn. */
  /** A human throws. Ignored unless it's their turn and `turn` matches the current one. */
  throw(id: number, angle: number, power: number, turn: number): boolean {
    if (!this.canAct(id) || turn !== this.state.turn || this.state.players[id]!.controller !== 'human') return false;
    this.doThrow(id, angle, power);
    return true;
  }

  private canAct(id: number): boolean {
    return !this.busy && this.state.phase === 'aiming' && this.state.current === id;
  }

  private beginTurn(): void {
    this.state.turn = (this.state.turn + 1) % 2 ** 31;
    this.emit({ t: 'state', state: structuredClone(this.state) });
    const p = this.state.players[this.state.current]!;
    if (p.controller !== 'cpu') return;
    this.later(CPU_THINK_MS, () => {
      const shot = cpuChooseShot(this.state, p.id, randomSeed());
      this.doThrow(p.id, shot.angle, shot.power);
    });
  }

  private doThrow(id: number, angle: number, power: number): void {
    this.busy = true;
    const result = computeThrow(this.state, id, angle, power);
    applyThrow(this.state, result);
    this.emit({ t: 'throw', result, after: structuredClone(this.state) });
    this.later(throwDurationMs(result), () => {
      this.busy = false;
      if (this.state.phase === 'aiming') {
        advanceTurn(this.state);
        this.beginTurn();
      } else if (this.state.phase === 'roundOver') {
        this.busy = true;
        this.later(ROUND_PAUSE_MS, () => {
          this.busy = false;
          startRound(this.state, randomSeed());
          this.beginTurn();
        });
      }
      // matchOver: nothing left to run.
    });
  }

  private later(ms: number, fn: () => void): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(fn, ms);
  }
}
