/**
 * Synthesized sound effects. Everything is generated with Web Audio, so there
 * are no sound files. Call unlockAudio() from a click or key press first.
 */

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let noiseBuf: AudioBuffer | null = null;
let muted = false;

export function unlockAudio(): void {
  if (!ctx) {
    ctx = new AudioContext();
    master = ctx.createGain();
    master.gain.value = muted ? 0 : 0.5;
    master.connect(ctx.destination);
    noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  if (ctx.state === 'suspended') void ctx.resume();
}

export function toggleMute(): boolean {
  muted = !muted;
  if (master) master.gain.value = muted ? 0 : 0.5;
  return muted;
}

// Runs fn with the audio graph if audio is unlocked.
function withAudio(fn: (ac: AudioContext, out: AudioNode, now: number) => void): void {
  if (ctx && master && !muted) fn(ctx, master, ctx.currentTime);
}

function envGain(ac: AudioContext, out: AudioNode, t: number, peak: number, attack: number, decay: number): GainNode {
  const g = ac.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(peak, t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
  g.connect(out);
  return g;
}

function tone(type: OscillatorType, from: number, to: number, start: number, dur: number, peak = 0.3): void {
  withAudio((ac, out, now) => {
    const t = now + start;
    const o = ac.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(from, t);
    o.frequency.exponentialRampToValueAtTime(to, t + dur);
    o.connect(envGain(ac, out, t, peak, 0.01, dur));
    o.start(t);
    o.stop(t + dur + 0.05);
  });
}

function noise(start: number, dur: number, filterFrom: number, filterTo: number, peak: number, type: BiquadFilterType = 'lowpass'): void {
  withAudio((ac, out, now) => {
    const t = now + start;
    const src = ac.createBufferSource();
    src.buffer = noiseBuf;
    const f = ac.createBiquadFilter();
    f.type = type;
    f.frequency.setValueAtTime(filterFrom, t);
    f.frequency.exponentialRampToValueAtTime(filterTo, t + dur);
    src.connect(f).connect(envGain(ac, out, t, peak, 0.005, dur));
    src.start(t, Math.random());
    src.stop(t + dur + 0.05);
  });
}

export const sfx = {
  click: () => tone('square', 660, 880, 0, 0.05, 0.08),
  turn: () => {
    tone('triangle', 523, 523, 0, 0.12, 0.2);
    tone('triangle', 784, 784, 0.1, 0.18, 0.2);
  },
  throw: (power: number) => {
    noise(0, 0.25, 600, 3000 + power * 30, 0.35, 'bandpass');
    tone('sine', 200, 500 + power * 4, 0, 0.18, 0.12);
  },
  explode: (big: boolean) => {
    noise(0, big ? 1.1 : 0.7, big ? 2600 : 1800, 60, big ? 0.9 : 0.7);
    tone('sine', big ? 120 : 160, 30, 0, big ? 0.7 : 0.45, 0.6);
  },
  hit: () => {
    tone('sawtooth', 440, 110, 0, 0.35, 0.25);
    tone('square', 330, 80, 0.08, 0.4, 0.18);
  },
  fall: () => tone('triangle', 700, 120, 0, 0.9, 0.2),
  splat: () => noise(0, 0.25, 900, 120, 0.6),
  offscreen: () => tone('sine', 900, 300, 0, 0.35, 0.1),
  win: () => [523, 659, 784, 1047].forEach((f, i) => tone('square', f, f, i * 0.12, i === 3 ? 0.5 : 0.14, 0.15)),
  matchWin: () =>
    [392, 523, 659, 784, 659, 784, 1047].forEach((f, i) => tone('square', f, f, i * 0.14, i === 6 ? 0.8 : 0.16, 0.15)),
  draw: () => [392, 370, 349, 330].forEach((f, i) => tone('triangle', f, f, i * 0.18, 0.2, 0.18)),
};
