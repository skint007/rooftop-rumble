/** One online room: its lobby, the clients in it and the match it runs. */
import { clamp, MAX_PLAYERS, SEAT_COLORS, type Difficulty, type MatchConfig, type PlayerSpec } from '../shared/game.ts';
import { MatchRunner } from '../shared/match.ts';
import { NAME_MAX, type ClientMsg, type LobbySeat, type LobbyView, type ServerMsg } from '../shared/protocol.ts';

type Send = (msg: ServerMsg) => void;
type Msg<T extends ClientMsg['t']> = Extract<ClientMsg, { t: T }>;

const AIM_MIN_MS = 40; // clients send aim about every 60 ms
const DIFFICULTIES: readonly Difficulty[] = ['easy', 'normal', 'hard'];
const openSeat = (i: number): LobbySeat => ({ kind: 'open', owner: null, name: '', team: i, difficulty: 'normal' });
const cleanName = (s: unknown) => (typeof s === 'string' ? s.replace(/\s+/g, ' ').trim().slice(0, NAME_MAX) : '');

export class Room {
  readonly code: string;
  private clients = new Map<string, { name: string; send: Send }>();
  private hostId = '';
  private seats = Array.from({ length: MAX_PLAYERS }, (_, i) => openSeat(i));
  private config: MatchConfig = { winsNeeded: 3, friendlyFire: false, teams: false };
  private match: MatchRunner | null = null;
  private playerSeat: number[] = []; // match player id -> lobby seat
  private dropped = new Set<number>();
  private lastAim = new Map<string, number>(); // client id -> ms of their last relayed aim // seats a CPU took over when their human left mid-match

  constructor(code: string) {
    this.code = code;
  }

  get empty(): boolean {
    return this.clients.size === 0;
  }

  /** Adds a client. Returns an error message if they can't join. */
  join(id: string, rawName: string, send: Send): string | null {
    if (this.clients.size >= 8) return 'That room is full.';
    const name = cleanName(rawName) || 'Player';
    this.clients.set(id, { name, send });
    if (!this.hostId) this.hostId = id;
    if (!this.match) {
      const free = this.seats.find((s) => s.kind === 'open');
      if (free) Object.assign(free, { kind: 'human', owner: id, name });
    }
    this.broadcastLobby();
    if (this.match) send({ t: 'state', state: this.match.state });
    return null;
  }

  leave(id: string): void {
    this.clients.delete(id);
    this.lastAim.delete(id);
    if (this.hostId === id) this.hostId = this.clients.keys().next().value ?? '';
    this.seats.forEach((s, i) => {
      if (s.owner !== id) return;
      // Mid-match, a CPU takes over so the game can carry on.
      if (this.match) {
        Object.assign(s, { kind: 'cpu', owner: null, name: `${s.name} (CPU)` });
        this.dropped.add(i);
        this.match.setCpu(this.playerSeat.indexOf(i));
      } else {
        this.seats[i] = openSeat(i);
      }
    });
    this.broadcastLobby();
  }

  dispose(): void {
    this.match?.stop();
  }

  handle(from: string, msg: ClientMsg): void {
    const isHost = from === this.hostId;
    switch (msg.t) {
      case 'aim':
      case 'throw':
        return this.playerMove(from, msg);
      case 'lobby':
        if (isHost) this.endMatch();
        return;
    }
    if (this.match) return;
    switch (msg.t) {
      case 'claim': {
        const s = this.seats[msg.seat];
        if (s?.kind === 'open') Object.assign(s, { kind: 'human', owner: from, name: this.clients.get(from)!.name });
        break;
      }
      case 'release': {
        const s = this.seats[msg.seat];
        if (s && (s.owner === from || (isHost && s.kind !== 'open'))) this.seats[msg.seat] = openSeat(msg.seat);
        break;
      }
      case 'seat': {
        const s = this.seats[msg.seat];
        if (!s || !(s.owner === from || (isHost && s.kind === 'cpu'))) return;
        if (msg.name !== undefined) s.name = cleanName(msg.name) || s.name;
        if (msg.team !== undefined) s.team = clamp(Math.floor(msg.team), 0, MAX_PLAYERS - 1);
        if (msg.difficulty !== undefined) s.difficulty = msg.difficulty;
        break;
      }
      case 'cpu': {
        const s = this.seats[msg.seat];
        if (!isHost || !s) return;
        if (msg.on && s.kind === 'open') Object.assign(s, { kind: 'cpu', name: `CPU ${msg.seat + 1}` });
        if (!msg.on && s.kind === 'cpu') this.seats[msg.seat] = openSeat(msg.seat);
        break;
      }
      case 'config':
        if (isHost) this.config = msg.config;
        break;
      case 'start':
        if (isHost) return this.startMatch(from);
        return;
    }
    this.broadcastLobby();
  }

  private playerMove(from: string, msg: Msg<'aim'> | Msg<'throw'>): void {
    if (!this.match || this.seats[this.playerSeat[msg.id] ?? -1]?.owner !== from) return;
    if (msg.t === 'throw') return void this.match.throw(msg.id, msg.angle, msg.power);
    // Aim is relayed to everyone, so cap how often one client can trigger it.
    const now = Date.now();
    if (now - (this.lastAim.get(from) ?? 0) < AIM_MIN_MS) return;
    this.lastAim.set(from, now);
    this.match.aim(msg.id, msg.angle, msg.power);
  }

  private startMatch(from: string): void {
    const filled = this.seats.map((s, i) => ({ s, i })).filter(({ s }) => s.kind !== 'open');
    const teams = new Set(filled.map(({ s, i }) => (this.config.teams ? s.team : i)));
    if (filled.length < 2 || teams.size < 2) {
      this.clients.get(from)?.send({ t: 'error', message: 'Need at least two sides to start.' });
      return;
    }
    this.playerSeat = filled.map(({ i }) => i);
    const specs: PlayerSpec[] = filled.map(({ s, i }) => ({
      seat: i,
      name: s.name,
      team: this.config.teams ? s.team : i,
      color: SEAT_COLORS[i]!,
      controller: s.kind === 'cpu' ? 'cpu' : 'human',
      difficulty: s.difficulty,
    }));
    this.match = new MatchRunner(specs, this.config, (ev) => this.broadcast(ev));
    this.broadcastLobby();
    this.match.start();
  }

  private endMatch(): void {
    this.match?.stop();
    this.match = null;
    for (const i of this.dropped) this.seats[i] = openSeat(i);
    this.dropped.clear();
    this.broadcastLobby();
  }

  private broadcast(msg: ServerMsg): void {
    for (const c of this.clients.values()) c.send(msg);
  }

  private broadcastLobby(): void {
    for (const [id, c] of this.clients) {
      const lobby: LobbyView = {
        code: this.code,
        you: id,
        hostId: this.hostId,
        clients: [...this.clients].map(([cid, x]) => ({ id: cid, name: x.name })),
        seats: this.seats,
        config: this.config,
        inGame: this.match !== null,
      };
      c.send({ t: 'lobby', lobby });
    }
  }
}

const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const seatOk = (v: unknown): v is number => num(v) && Number.isInteger(v) && v >= 0 && v < MAX_PLAYERS;

/** Parses and validates a message from a client. Returns null for anything malformed. */
export function parseClientMsg(raw: string): ClientMsg | null {
  let m: Record<string, unknown>;
  try {
    m = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof m !== 'object' || m === null) return null;
  switch (m.t) {
    case 'create':
      return { t: 'create', name: cleanName(m.name) };
    case 'join':
      return typeof m.code === 'string' ? { t: 'join', code: m.code.slice(0, 8), name: cleanName(m.name) } : null;
    case 'claim':
    case 'release':
      return seatOk(m.seat) ? { t: m.t, seat: m.seat } : null;
    case 'seat': {
      if (!seatOk(m.seat)) return null;
      const difficulty = DIFFICULTIES.find((d) => d === m.difficulty);
      return {
        t: 'seat',
        seat: m.seat,
        name: typeof m.name === 'string' ? m.name : undefined,
        team: num(m.team) ? m.team : undefined,
        difficulty,
      };
    }
    case 'cpu':
      return seatOk(m.seat) ? { t: 'cpu', seat: m.seat, on: m.on === true } : null;
    case 'config': {
      const c = m.config as Record<string, unknown> | null;
      if (typeof c !== 'object' || c === null || !num(c.winsNeeded)) return null;
      const config = { winsNeeded: clamp(Math.round(c.winsNeeded), 1, 9), friendlyFire: c.friendlyFire === true, teams: c.teams === true };
      return { t: 'config', config };
    }
    case 'start':
    case 'lobby':
      return { t: m.t };
    case 'aim':
    case 'throw':
      return seatOk(m.id) && num(m.angle) && num(m.power) ? { t: m.t, id: m.id, angle: m.angle, power: m.power } : null;
  }
  return null;
}
