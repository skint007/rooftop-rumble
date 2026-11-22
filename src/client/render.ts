/** Canvas drawing for the match: sky, skyline, raccoons, cans and effects. */
import { BODY_OFFSET, HAND_OFFSET, MAX_POWER, MAX_WIND, rng, teamLabel, WORLD_H, WORLD_W, type GameState, type Player } from '../shared/game.ts';

export interface Effect {
  kind: 'boom' | 'spark' | 'text';
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  born: number;
  life: number;
  color: string;
  text?: string;
}

/** Everything the renderer needs for one frame. play.ts owns and mutates it. */
export interface Scene {
  state: GameState;
  now: number; // ms
  feetY: number[]; // per player, differs from state while someone falls
  gone: boolean[]; // per player, true once their death has been shown
  aim: { id: number; angle: number; power: number } | null;
  can: { x: number; y: number; color: string } | null;
  trails: (number[] | undefined)[];
  effects: Effect[];
  banner: { text: string; sub?: string; color: string } | null;
  hint: string;
  shake: number; // remaining shake in px
}

const BUILDING_COLORS = ['#3d5a80', '#6d3b47', '#4f5d75', '#2a6f6a', '#5c4d7d', '#7a5c3a', '#40576b', '#694060'];
const WINDOW_ON = ['#ffd56b', '#ffe8a3', '#ffc94d'];
const WINDOW_OFF = 'rgba(10, 14, 30, 0.55)';

let cityCanvas: HTMLCanvasElement | null = null;
let cityKey = '';
let skyCanvas: HTMLCanvasElement | null = null;
let skySeed = -1;

function offscreen(): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = WORLD_W;
  c.height = WORLD_H;
  return [c, c.getContext('2d')!];
}

// The sky changes each round: a few colour schemes, seeded stars and moon position.
function drawSky(seed: number): HTMLCanvasElement {
  if (skyCanvas && skySeed === seed) return skyCanvas;
  const [c, g] = offscreen();
  const rand = rng(seed ^ 0xabcdef);
  const schemes = [
    ['#0b1026', '#1d2b5a', '#3b3f7a'],
    ['#140d2b', '#3a1f5d', '#a04a6b'],
    ['#061a2b', '#0f3a57', '#2f6f86'],
    ['#1a0f1f', '#4a1f3a', '#d0704a'],
  ];
  const s = schemes[Math.floor(rand() * schemes.length)]!;
  const grad = g.createLinearGradient(0, 0, 0, WORLD_H);
  grad.addColorStop(0, s[0]!);
  grad.addColorStop(0.6, s[1]!);
  grad.addColorStop(1, s[2]!);
  g.fillStyle = grad;
  g.fillRect(0, 0, WORLD_W, WORLD_H);
  for (let i = 0; i < 140; i++) {
    g.globalAlpha = 0.3 + rand() * 0.7;
    g.fillStyle = '#fff';
    const r = rand() < 0.1 ? 1.6 : 0.9;
    g.fillRect(rand() * WORLD_W, rand() * WORLD_H * 0.6, r, r);
  }
  g.globalAlpha = 1;
  // Moon with a bite taken out.
  const mx = 120 + rand() * (WORLD_W - 240);
  const my = 70 + rand() * 60;
  g.fillStyle = 'rgba(255, 244, 214, 0.12)';
  g.beginPath();
  g.arc(mx, my, 60, 0, Math.PI * 2);
  g.fill();
  // Cut the crescent on its own canvas so the bite doesn't punch through the sky.
  const moon = document.createElement('canvas');
  moon.width = moon.height = 64;
  const mg = moon.getContext('2d')!;
  mg.fillStyle = '#fff4d6';
  mg.beginPath();
  mg.arc(32, 32, 30, 0, Math.PI * 2);
  mg.fill();
  mg.globalCompositeOperation = 'destination-out';
  mg.beginPath();
  mg.arc(45, 24, 26, 0, Math.PI * 2);
  mg.fill();
  g.drawImage(moon, mx - 32, my - 32);
  // Hazy far skyline for depth.
  g.fillStyle = 'rgba(0, 0, 0, 0.25)';
  let x = 0;
  while (x < WORLD_W) {
    const w = 30 + rand() * 50;
    const h = 140 + rand() * 260;
    g.fillRect(x, WORLD_H - h, w + 1, h);
    x += w;
  }
  skyCanvas = c;
  skySeed = seed;
  return c;
}

// Buildings with craters cut out. Rebuilt only when a crater is added.
function drawCity(state: GameState): HTMLCanvasElement {
  const key = `${state.seed}:${state.round}:${state.craters.length}`;
  if (cityCanvas && cityKey === key) return cityCanvas;
  const [c, g] = offscreen();
  for (const b of state.buildings) {
    const rand = rng(b.seed);
    const top = WORLD_H - b.h;
    g.fillStyle = BUILDING_COLORS[b.style % BUILDING_COLORS.length]!;
    g.fillRect(b.x, top, b.w, b.h);
    g.fillStyle = 'rgba(255,255,255,0.07)';
    g.fillRect(b.x, top, 3, b.h);
    g.fillStyle = 'rgba(0,0,0,0.25)';
    g.fillRect(b.x + b.w - 4, top, 4, b.h);
    g.fillStyle = 'rgba(0,0,0,0.3)';
    g.fillRect(b.x, top, b.w, 4);
    // Windows: columns and rows fitted to the building, some lit.
    const pattern = (b.style >> 3) % 3;
    const ww = pattern === 2 ? 6 : 8;
    const wh = pattern === 1 ? 6 : 11;
    const gapX = pattern === 2 ? 6 : 7;
    const gapY = pattern === 1 ? 8 : 9;
    const cols = Math.max(1, Math.floor((b.w - 12) / (ww + gapX)));
    const startX = b.x + (b.w - (cols * (ww + gapX) - gapX)) / 2;
    const litChance = 0.25 + rand() * 0.5;
    for (let y = top + 14; y + wh < WORLD_H - 8; y += wh + gapY) {
      for (let i = 0; i < cols; i++) {
        const lit = rand() < litChance;
        g.fillStyle = lit ? WINDOW_ON[Math.floor(rand() * WINDOW_ON.length)]! : WINDOW_OFF;
        g.fillRect(startX + i * (ww + gapX), y, ww, wh);
      }
    }
    // Rooftop clutter.
    const r = rand();
    g.fillStyle = 'rgba(0,0,0,0.35)';
    if (r < 0.25) g.fillRect(b.x + b.w * 0.2, top - 10, 12, 10); // vent
    else if (r < 0.4) {
      g.fillRect(b.x + b.w * 0.7, top - 26, 2, 26); // antenna
      g.fillStyle = '#ff5964';
      g.fillRect(b.x + b.w * 0.7 - 1, top - 28, 4, 4);
    }
  }
  // Scorched rims, then the holes themselves.
  g.globalCompositeOperation = 'source-atop';
  g.fillStyle = 'rgba(20, 10, 5, 0.6)';
  for (const cr of state.craters) {
    g.beginPath();
    g.arc(cr.x, cr.y, cr.r + 4, 0, Math.PI * 2);
    g.fill();
  }
  g.globalCompositeOperation = 'destination-out';
  for (const cr of state.craters) {
    g.beginPath();
    g.arc(cr.x, cr.y, cr.r, 0, Math.PI * 2);
    g.fill();
  }
  g.globalCompositeOperation = 'source-over';
  cityCanvas = c;
  cityKey = key;
  return c;
}

/** Draws a raccoon standing at (x, feetY). `throwing` raises the arm toward `angle`. */
function drawRaccoon(g: CanvasRenderingContext2D, p: Player, feetY: number, now: number, throwing: boolean, angle: number): void {
  const x = p.x;
  const face = p.x < WORLD_W / 2 ? 1 : -1;
  const bob = Math.sin(now / 400 + p.id) * 0.8;
  g.save();
  g.translate(x, feetY);
  // Tail, striped.
  g.save();
  g.translate(-face * 10, -12);
  g.rotate(-face * (0.9 + Math.sin(now / 300 + p.id) * 0.12));
  for (let i = 0; i < 4; i++) {
    g.fillStyle = i % 2 ? '#2b2b2b' : '#8f8f98';
    g.beginPath();
    g.ellipse(0, -i * 6, 5.5 - i * 0.4, 4, 0, 0, Math.PI * 2);
    g.fill();
  }
  g.restore();
  // Legs and body.
  g.fillStyle = '#3a3a42';
  g.fillRect(-8, -7, 6, 7);
  g.fillRect(2, -7, 6, 7);
  g.fillStyle = '#8f8f98';
  g.beginPath();
  g.ellipse(0, -BODY_OFFSET + bob, 12, 13, 0, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = '#c9c9cf';
  g.beginPath();
  g.ellipse(0, -BODY_OFFSET + 3 + bob, 7, 8, 0, 0, Math.PI * 2);
  g.fill();
  // Arms. The throwing arm points along the aim.
  g.strokeStyle = '#6f6f78';
  g.lineWidth = 5;
  g.lineCap = 'round';
  g.beginPath();
  g.moveTo(-face * 9, -BODY_OFFSET - 2 + bob);
  g.lineTo(-face * 13, -BODY_OFFSET + 8 + bob);
  g.stroke();
  const armA = throwing ? (angle * Math.PI) / 180 : face > 0 ? 1.9 : 1.25;
  g.beginPath();
  g.moveTo(face * 8, -BODY_OFFSET - 4 + bob);
  g.lineTo(face * 8 + Math.cos(armA) * 13, -BODY_OFFSET - 4 + bob - Math.sin(armA) * 13);
  g.stroke();
  // Head.
  const hy = -BODY_OFFSET - 18 + bob;
  g.fillStyle = '#8f8f98';
  for (const s of [-1, 1]) {
    g.beginPath();
    g.moveTo(s * 5, hy - 6);
    g.lineTo(s * 10, hy - 14);
    g.lineTo(s * 11, hy - 3);
    g.fill();
  }
  g.beginPath();
  g.ellipse(0, hy, 11, 9, 0, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = '#e8e8ec';
  g.beginPath();
  g.ellipse(face * 4, hy + 3, 6, 4, 0, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = '#1f1f24'; // the mask
  g.beginPath();
  g.ellipse(-4 + face * 2, hy - 1, 4.5, 3.2, 0, 0, Math.PI * 2);
  g.ellipse(4 + face * 2, hy - 1, 4.5, 3.2, 0, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = '#fff';
  g.fillRect(-4 + face * 3, hy - 2, 2, 2);
  g.fillRect(4 + face * 3, hy - 2, 2, 2);
  g.fillStyle = '#111';
  g.beginPath();
  g.arc(face * 9, hy + 2, 1.8, 0, Math.PI * 2);
  g.fill();
  // Bandana in the player's colour.
  g.fillStyle = p.color;
  g.fillRect(-10, -BODY_OFFSET - 9 + bob, 20, 4);
  g.beginPath();
  g.moveTo(-face * 8, -BODY_OFFSET - 8 + bob);
  g.lineTo(-face * 16, -BODY_OFFSET - 3 + bob + Math.sin(now / 150) * 1.5);
  g.lineTo(-face * 13, -BODY_OFFSET - 10 + bob);
  g.fill();
  g.restore();
}

function drawCan(g: CanvasRenderingContext2D, x: number, y: number, now: number, color: string): void {
  g.save();
  g.translate(x, y);
  g.rotate(now / 60);
  g.fillStyle = color;
  g.fillRect(-4, -6, 8, 12);
  g.fillStyle = '#e6e6e6';
  g.fillRect(-4, -7, 8, 2);
  g.fillRect(-4, 5, 8, 2);
  g.fillStyle = 'rgba(255,255,255,0.6)';
  g.fillRect(-2, -4, 2, 8);
  g.restore();
}

function drawAim(g: CanvasRenderingContext2D, p: Player, feetY: number, angle: number, power: number, now: number): void {
  const rad = (angle * Math.PI) / 180;
  const sx = p.x;
  const sy = feetY - HAND_OFFSET;
  const len = 28 + (power / MAX_POWER) * 130;
  g.save();
  g.strokeStyle = p.color;
  g.lineWidth = 3;
  g.setLineDash([7, 7]);
  g.lineDashOffset = -now / 30;
  g.beginPath();
  g.moveTo(sx, sy);
  const ex = sx + Math.cos(rad) * len;
  const ey = sy - Math.sin(rad) * len;
  g.lineTo(ex, ey);
  g.stroke();
  g.setLineDash([]);
  g.fillStyle = p.color;
  g.translate(ex, ey);
  g.rotate(-rad);
  g.beginPath();
  g.moveTo(10, 0);
  g.lineTo(-4, -7);
  g.lineTo(-4, 7);
  g.fill();
  g.restore();
  // Readout above their head.
  const label = `${angle.toFixed(1)}°  ${power.toFixed(0)}%`;
  g.font = 'bold 15px "Press Start 2P", monospace';
  g.textAlign = 'center';
  const ty = feetY - 92;
  const w = g.measureText(label).width + 16;
  const lx = Math.min(Math.max(sx, w / 2 + 4), WORLD_W - w / 2 - 4); // keep it on screen
  g.fillStyle = 'rgba(0,0,0,0.65)';
  g.fillRect(lx - w / 2, ty - 16, w, 24);
  g.fillStyle = '#fff';
  g.fillText(label, lx, ty + 2);
  // Power bar.
  g.fillStyle = 'rgba(0,0,0,0.65)';
  g.fillRect(lx - 40, ty + 12, 80, 8);
  g.fillStyle = power > 85 ? '#ff5964' : power > 55 ? '#ffd56b' : '#a7e05a';
  g.fillRect(lx - 39, ty + 13, (78 * power) / MAX_POWER, 6);
}

function drawWind(g: CanvasRenderingContext2D, wind: number): void {
  const cx = WORLD_W / 2;
  const y = 26;
  g.font = '12px "Press Start 2P", monospace';
  g.textAlign = 'center';
  g.fillStyle = 'rgba(255,255,255,0.8)';
  g.fillText(wind === 0 ? 'NO WIND' : 'WIND', cx, y - 4);
  if (wind === 0) return;
  const len = (Math.abs(wind) / MAX_WIND) * 110 + 10;
  const dir = Math.sign(wind);
  g.strokeStyle = '#9fe7ff';
  g.fillStyle = '#9fe7ff';
  g.lineWidth = 4;
  g.beginPath();
  g.moveTo(cx - (dir * len) / 2, y + 10);
  g.lineTo(cx + (dir * len) / 2, y + 10);
  g.stroke();
  g.beginPath();
  g.moveTo(cx + (dir * len) / 2 + dir * 8, y + 10);
  g.lineTo(cx + (dir * len) / 2 - dir * 2, y + 3);
  g.lineTo(cx + (dir * len) / 2 - dir * 2, y + 17);
  g.fill();
}

function drawHud(g: CanvasRenderingContext2D, scene: Scene): void {
  const { state } = scene;
  const teams = [...new Set(state.players.map((p) => p.team))].sort((a, b) => a - b);
  g.font = '13px "Press Start 2P", monospace';
  g.textAlign = 'left';
  teams.forEach((team, i) => {
    const members = state.players.filter((p) => p.team === team);
    const text = `${teamLabel(state, team)}  ${state.scores[team]}`;
    const y = 24 + i * 22;
    g.fillStyle = 'rgba(0,0,0,0.5)';
    g.fillRect(10, y - 15, g.measureText(text).width + 34, 20);
    members.forEach((m, k) => {
      g.fillStyle = m.color;
      g.fillRect(16 + k * 5, y - 10, 4, 10);
    });
    g.fillStyle = '#fff';
    g.fillText(text, 22 + members.length * 5, y);
  });
  g.textAlign = 'right';
  g.fillStyle = 'rgba(255,255,255,0.75)';
  g.fillText(`ROUND ${state.round}  ·  FIRST TO ${state.config.winsNeeded}`, WORLD_W - 70, 24);
  if (scene.hint) {
    g.textAlign = 'center';
    g.font = '11px "Press Start 2P", monospace';
    g.fillStyle = 'rgba(255,255,255,0.7)';
    g.fillText(scene.hint, WORLD_W / 2, WORLD_H - 14);
  }
}

function drawNameTag(g: CanvasRenderingContext2D, p: Player, feetY: number, active: boolean): void {
  g.font = '10px "Press Start 2P", monospace';
  g.textAlign = 'center';
  const y = feetY - 58;
  const w = g.measureText(p.name).width + 10;
  g.fillStyle = active ? p.color : 'rgba(0,0,0,0.55)';
  g.fillRect(p.x - w / 2, y - 11, w, 15);
  g.fillStyle = active ? '#111' : p.color;
  g.fillText(p.name, p.x, y);
}

function drawEffects(g: CanvasRenderingContext2D, scene: Scene): void {
  const now = scene.now;
  scene.effects = scene.effects.filter((e) => now - e.born < e.life);
  for (const e of scene.effects) {
    const t = (now - e.born) / e.life;
    if (e.kind === 'boom') {
      g.globalAlpha = 1 - t;
      g.fillStyle = t < 0.25 ? '#fff6c2' : e.color;
      g.beginPath();
      g.arc(e.x, e.y, e.r * (0.4 + t * 0.9), 0, Math.PI * 2);
      g.fill();
      g.strokeStyle = '#ffb347';
      g.lineWidth = 4 * (1 - t);
      g.beginPath();
      g.arc(e.x, e.y, e.r * (0.6 + t * 1.4), 0, Math.PI * 2);
      g.stroke();
    } else if (e.kind === 'spark') {
      const s = (now - e.born) / 1000;
      g.globalAlpha = 1 - t;
      g.fillStyle = e.color;
      g.fillRect(e.x + e.vx * s, e.y + e.vy * s + 200 * s * s, e.r, e.r);
    } else if (e.text) {
      g.globalAlpha = 1 - t * t;
      g.font = '14px "Press Start 2P", monospace';
      g.textAlign = 'center';
      g.fillStyle = e.color;
      g.fillText(e.text, e.x, e.y - t * 40);
    }
  }
  g.globalAlpha = 1;
}

function drawBanner(g: CanvasRenderingContext2D, banner: NonNullable<Scene['banner']>): void {
  g.fillStyle = 'rgba(0,0,0,0.55)';
  g.fillRect(0, WORLD_H / 2 - 70, WORLD_W, banner.sub ? 130 : 90);
  g.textAlign = 'center';
  g.font = '34px "Press Start 2P", monospace';
  g.fillStyle = banner.color;
  g.fillText(banner.text, WORLD_W / 2, WORLD_H / 2 - 8);
  if (banner.sub) {
    g.font = '14px "Press Start 2P", monospace';
    g.fillStyle = '#fff';
    g.fillText(banner.sub, WORLD_W / 2, WORLD_H / 2 + 34);
  }
}

export function draw(g: CanvasRenderingContext2D, scene: Scene): void {
  const { state, now } = scene;
  g.save();
  if (scene.shake > 0.5) g.translate((Math.random() - 0.5) * scene.shake, (Math.random() - 0.5) * scene.shake);
  scene.shake *= 0.9;
  g.drawImage(drawSky(state.seed), 0, 0);
  g.drawImage(drawCity(state), 0, 0);

  // Faint trail of each player's last throw, to help adjust the next one.
  g.lineWidth = 1.5;
  state.players.forEach((p, i) => {
    const t = scene.trails[i];
    if (!t || !p.alive || scene.gone[i]) return;
    g.strokeStyle = p.color;
    g.globalAlpha = 0.28;
    g.setLineDash([2, 6]);
    g.beginPath();
    for (let k = 0; k < t.length; k += 2) g.lineTo(t[k]!, t[k + 1]!);
    g.stroke();
  });
  g.setLineDash([]);
  g.globalAlpha = 1;

  for (const p of state.players) {
    if (scene.gone[p.id]) continue;
    const aiming = scene.aim?.id === p.id;
    drawRaccoon(g, p, scene.feetY[p.id]!, now, aiming, scene.aim?.angle ?? 0);
    drawNameTag(g, p, scene.feetY[p.id]!, state.phase === 'aiming' && state.current === p.id);
  }
  if (scene.aim) {
    const p = state.players[scene.aim.id]!;
    drawAim(g, p, scene.feetY[p.id]!, scene.aim.angle, scene.aim.power, now);
  }
  if (scene.can) drawCan(g, scene.can.x, scene.can.y, now, scene.can.color);
  drawEffects(g, scene);
  g.restore();
  drawWind(g, state.wind);
  drawHud(g, scene);
  if (scene.banner) drawBanner(g, scene.banner);
}
