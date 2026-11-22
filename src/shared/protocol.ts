/** Messages between the browser and the online server. */
import type { Difficulty, MatchConfig } from './game.ts';
import type { MatchEvent } from './match.ts';

export type SeatKind = 'open' | 'human' | 'cpu';

export interface LobbySeat {
  kind: SeatKind;
  owner: string | null; // client id, for human seats
  name: string;
  team: number;
  difficulty: Difficulty;
}

export interface LobbyView {
  code: string;
  you: string;
  hostId: string;
  clients: { id: string; name: string }[];
  seats: LobbySeat[];
  config: MatchConfig;
  inGame: boolean;
}

export type ClientMsg =
  | { t: 'create'; name: string }
  | { t: 'join'; code: string; name: string }
  | { t: 'claim'; seat: number }
  | { t: 'release'; seat: number }
  | { t: 'seat'; seat: number; name?: string; team?: number; difficulty?: Difficulty }
  | { t: 'cpu'; seat: number; on: boolean }
  | { t: 'config'; config: MatchConfig }
  | { t: 'start' }
  | { t: 'lobby' } // host: end the match and return everyone to the lobby
  | { t: 'aim'; id: number; angle: number; power: number }
  | { t: 'throw'; id: number; angle: number; power: number };

export type ServerMsg = { t: 'error'; message: string } | { t: 'lobby'; lobby: LobbyView } | MatchEvent;

export const ROOM_CODE_LENGTH = 4;
export const NAME_MAX = 14;
