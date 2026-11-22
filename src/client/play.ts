/**
 * The match screen. Plays back MatchEvents from a session (local runner or the
 * online server) as animation, and turns local input into aim/throw actions.
 */
import { PATH_FPS, teamLabel, WORLD_H, type GameState, type ThrowResult } from '../shared/game.ts';
import { AIM_TWEEN_MS, type MatchEvent } from '../shared/match.ts';
import { sfx } from './audio.ts';
import { AimInput, type Aim, type PadBinding } from './input.ts';
import { draw, type Effect, type Scene } from './render.ts';

/** What the match screen needs from local or online play. */
export interface Session {
  /** The gamepad binding if this browser controls player `id`, otherwise null. */
  localPlayer(id: number): PadBinding | null;
  aim(id: number, angle: number, power: number): void;
  /** `turn` is the state's turn token, so the runner can ignore a throw that arrives late. */
  throw(id: number, angle: number, power: number, turn: number): void;
}

const AIM_SEND_MS = 60;
const FALL_MS = 750;
const STOPPED = Symbol('stopped');
const ease = (t: number) => t * t * (3 - 2 * t);

export class Play {
  readonly input = new AimInput();
  /** Called when the match ends, with the final state. */
  onMatchOver: (state: GameState) => void = () => {};
  /** Called when a gamepad's Start button is pressed. */
  onPause: () => void = () => {};
  /** While true (e.g. a menu is open), local input is ignored. */
  inputBlocked = false;
  private scene: Scene | null = null;
  private queue: MatchEvent[] = [];
  private pumping = false;
  private animating = false;
  private thrown = false; // a local throw is in flight to the session
  private myAim: Aim = { angle: 45, power: 50 };
  private lastAimSent = 0;
  private running = true;
  private g: CanvasRenderingContext2D;
  private canvas: HTMLCanvasElement;
  private session: Session;

  constructor(canvas: HTMLCanvasElement, session: Session) {
    this.canvas = canvas;
    this.session = session;
    this.g = canvas.getContext('2d')!;
    this.input.attach(canvas);
    requestAnimationFrame((t) => this.loop(t, t));
  }

  /** Ends this screen. Any animation in progress stops at its next step. */
  stop(): void {
    this.running = false;
    this.queue = [];
    this.input.detach();
  }

  // Animation steps. They reject once the screen is stopped, which unwinds playThrow.
  private frame(): Promise<number> {
    return this.step(new Promise((r) => requestAnimationFrame(r)));
  }

  private wait(ms: number): Promise<unknown> {
    return this.step(new Promise((r) => setTimeout(r, ms)));
  }

  private async step<T>(p: Promise<T>): Promise<T> {
    const v = await p;
    if (!this.running) throw STOPPED;
    return v;
  }

  receive(ev: MatchEvent): void {
    this.queue.push(ev);
    void this.pump();
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    while (this.queue.length && this.running) {
      const ev = this.queue.shift()!;
      if (ev.t === 'state') this.showState(ev.state);
      else if (ev.t === 'aim') this.showRemoteAim(ev.id, ev.angle, ev.power);
      else await this.playThrow(ev.result, ev.after).catch((e: unknown) => {
        if (e !== STOPPED) throw e;
      });
    }
    this.pumping = false;
  }

  private showState(state: GameState): void {
    const prevRound = this.scene?.state.round;
    const fresh = !this.scene || prevRound !== state.round;
    this.scene = {
      state: structuredClone(state),
      now: performance.now(),
      feetY: state.players.map((p) => p.y),
      gone: state.players.map((p) => !p.alive),
      aim: null,
      can: null,
      trails: fresh ? [] : this.scene!.trails,
      effects: fresh ? [] : this.scene!.effects,
      banner: null,
      hint: '',
      shake: 0,
    };
    this.thrown = false;
    if (fresh) {
      this.flash(`ROUND ${state.round}`, state.wind === 0 ? 'Calm night' : `Wind ${state.wind > 0 ? '→' : '←'} ${Math.abs(state.wind)}`);
    }
    if (state.phase === 'matchOver') return this.onMatchOver(state);
    if (state.phase !== 'aiming') return;

    const p = state.players[state.current]!;
    const mine = this.session.localPlayer(p.id) !== null;
    this.myAim = { angle: p.lastAngle, power: p.lastPower };
    this.scene.aim = { id: p.id, ...this.myAim };
    this.scene.hint = mine
      ? `${p.name.toUpperCase()}: DRAG TO AIM · ARROWS/STICKS · SPACE/A THROWS`
      : p.controller === 'cpu'
        ? `${p.name.toUpperCase()} IS THINKING…`
        : `${p.name.toUpperCase()} IS AIMING…`;
    if (mine) {
      sfx.turn();
      this.text(p.x, p.y - 110, 'YOUR TURN', p.color, 1400);
    }
  }

  private showRemoteAim(id: number, angle: number, power: number): void {
    if (!this.scene || this.session.localPlayer(id) !== null) return;
    this.scene.aim = { id, angle, power };
  }

  private async playThrow(res: ThrowResult, after: GameState): Promise<void> {
    const scene = this.scene;
    if (!scene) return;
    this.animating = true;
    const shooter = scene.state.players[res.shooter]!;
    scene.hint = '';

    // Swing the arrow to the final aim so everyone sees what was thrown.
    const from = scene.aim?.id === res.shooter ? { ...scene.aim } : { angle: shooter.lastAngle, power: shooter.lastPower };
    const start = performance.now();
    for (let t = 0; t < 1; t = (performance.now() - start) / AIM_TWEEN_MS) {
      const k = ease(t);
      scene.aim = { id: res.shooter, angle: from.angle + (res.angle - from.angle) * k, power: from.power + (res.power - from.power) * k };
      await this.frame();
    }
    scene.aim = { id: res.shooter, angle: res.angle, power: res.power };
    await this.wait(80);
    scene.aim = null;

    // Flight.
    sfx.throw(res.power);
    const flightStart = performance.now();
    const n = res.path.length / 2;
    for (;;) {
      const f = ((performance.now() - flightStart) / 1000) * PATH_FPS;
      const i = Math.floor(f);
      if (i >= n - 1) break;
      const k = f - i;
      const p = res.path;
      scene.can = {
        x: p[i * 2]! + (p[i * 2 + 2]! - p[i * 2]!) * k,
        y: p[i * 2 + 1]! + (p[i * 2 + 3]! - p[i * 2 + 1]!) * k,
        color: shooter.color,
      };
      await this.frame();
    }
    scene.can = null;
    scene.trails[res.shooter] = res.path;

    // Impact.
    if (res.impact) {
      const big = res.hitPlayer !== null;
      scene.state.craters.push(res.impact);
      this.boom(res.impact.x, res.impact.y, res.impact.r, big);
      sfx.explode(big);
      for (const id of res.killed) {
        const v = scene.state.players[id]!;
        scene.gone[id] = true;
        this.text(v.x, v.y - 60, id === res.shooter ? 'OOPS!' : 'BONK!', v.color, 1500);
      }
      if (res.killed.length) setTimeout(() => sfx.hit(), 120);
      await this.wait(600);
    } else {
      sfx.offscreen();
      this.text(Math.min(Math.max(res.path.at(-2)!, 60), 1220), 120, 'MISS', '#ccc', 1000);
      await this.wait(250);
    }

    // Anyone standing on blown-away floor drops.
    if (res.falls.length) {
      sfx.fall();
      const fromY = res.falls.map((f) => scene.feetY[f.id]!);
      const fallStart = performance.now();
      for (let t = 0; t < 1; t = (performance.now() - fallStart) / FALL_MS) {
        res.falls.forEach((f, k) => (scene.feetY[f.id] = fromY[k]! + (f.toY - fromY[k]!) * t * t));
        await this.frame();
      }
      for (const f of res.falls) {
        scene.feetY[f.id] = f.toY;
        if (!f.died) continue;
        scene.gone[f.id] = true;
        const v = scene.state.players[f.id]!;
        this.sparks(v.x, Math.min(f.toY, WORLD_H) - 10, v.color, 18);
        this.text(v.x, Math.min(f.toY, WORLD_H - 20) - 30, 'SPLAT', v.color, 1400);
      }
      if (res.falls.some((f) => f.died)) sfx.splat();
      await this.wait(150);
    }

    scene.state = structuredClone(after);
    this.animating = false;
    if (after.phase === 'roundOver' || after.phase === 'matchOver') this.announce(after);
  }

  private announce(s: GameState): void {
    if (!this.scene) return;
    const w = s.roundWinner ?? -1;
    if (w < 0) {
      sfx.draw();
      this.scene.banner = { text: 'DRAW!', sub: 'Nobody left standing', color: '#ffd56b' };
      return;
    }
    const color = s.players.find((p) => p.team === w)!.color;
    const name = teamLabel(s, w).toUpperCase();
    const score = [...new Set(s.players.map((p) => p.team))].map((t) => s.scores[t]).join(' - ');
    if (s.phase === 'matchOver') {
      sfx.matchWin();
      this.scene.banner = { text: `${name} WINS!`, sub: `Final score ${score}`, color };
      this.onMatchOver(s);
    } else {
      sfx.win();
      this.scene.banner = { text: `${name} TAKES ROUND ${s.round}`, sub: `Score ${score}`, color };
    }
  }

  private flash(text: string, sub: string): void {
    if (!this.scene) return;
    const scene = this.scene;
    scene.banner = { text, sub, color: '#ffd56b' };
    setTimeout(() => {
      if (scene.banner?.text === text) scene.banner = null;
    }, 1500);
  }

  private effect(e: Partial<Effect> & Pick<Effect, 'kind' | 'x' | 'y' | 'life' | 'color'>): void {
    this.scene?.effects.push({ vx: 0, vy: 0, r: 0, born: performance.now(), ...e });
  }

  private text(x: number, y: number, text: string, color: string, life: number): void {
    this.effect({ kind: 'text', x, y, text, color, life });
  }

  private sparks(x: number, y: number, color: string, count: number): void {
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2;
      const s = 80 + Math.random() * 260;
      this.effect({ kind: 'spark', x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s - 120, r: 2 + Math.random() * 3, color, life: 700 + Math.random() * 500 });
    }
  }

  private boom(x: number, y: number, r: number, big: boolean): void {
    this.effect({ kind: 'boom', x, y, r, color: '#ff7b39', life: big ? 750 : 550 });
    this.sparks(x, y, '#ffcf70', big ? 34 : 20);
    this.sparks(x, y, '#5a4a40', 10);
    if (this.scene) this.scene.shake = big ? 18 : 10;
  }

  private loop(now: number, last: number): void {
    if (!this.running) return;
    const dt = Math.min(0.05, (now - last) / 1000);
    const scene = this.scene;
    if (scene) {
      scene.now = now;
      this.handleInput(scene, dt, now);
      draw(this.g, scene);
    } else {
      this.g.fillStyle = '#0b1026';
      this.g.fillRect(0, 0, this.canvas.width, this.canvas.height);
    }
    if (this.input.padTapped(9)) this.onPause();
    this.input.endFrame();
    requestAnimationFrame((t) => this.loop(t, now));
  }

  private handleInput(scene: Scene, dt: number, now: number): void {
    const s = scene.state;
    const id = s.current;
    const pad = this.session.localPlayer(id);
    if (this.inputBlocked || this.animating || this.thrown || s.phase !== 'aiming' || pad === null) {
      // Drop drags and presses made while it isn't your turn, so they can't fire later.
      this.input.cancel();
      return;
    }
    const before = { ...this.myAim };
    const fire = this.input.update(dt, this.myAim, pad);
    scene.aim = { id, ...this.myAim };
    if (fire && this.myAim.power >= 1) {
      this.thrown = true;
      this.session.throw(id, this.myAim.angle, this.myAim.power, s.turn);
      return;
    }
    const changed = before.angle !== this.myAim.angle || before.power !== this.myAim.power;
    if (changed && now - this.lastAimSent > AIM_SEND_MS) {
      this.lastAimSent = now;
      this.session.aim(id, this.myAim.angle, this.myAim.power);
    }
  }
}
