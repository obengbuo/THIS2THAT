/** Types shared by the game engine, the API and the web client. */

export type WordLength = 4 | 5;
export type Difficulty = 'easy' | 'medium' | 'hard';
export type GameMode = 'solo' | 'couples' | 'pass';
export type GameStatus = 'playing' | 'completed';
export type HintType = 'letter' | 'word' | 'next';

export const WORD_LENGTHS: readonly WordLength[] = [4, 5];
export const DIFFICULTIES: readonly Difficulty[] = ['easy', 'medium', 'hard'];
export const GAME_MODES: readonly GameMode[] = ['solo', 'couples', 'pass'];
export const REACTIONS = ['❤️', '😂', '🔥', '👏', '🤔', '😘'] as const;

/** Reasons a submitted word is rejected. */
export type RejectCode =
  | 'bad_length'
  | 'not_a_word'
  | 'already_used'
  | 'not_one_letter'
  | 'wrong_position'
  | 'slot_locked'
  | 'bad_slot';

export interface PlayerView {
  id: string;
  name: string;
  /** Has at least one live real-time connection. */
  connected: boolean;
}

export interface SlotView {
  /** The locked word, or null while the slot is still open. */
  word: string | null;
  lockedBy: string | null;
  /** Letters revealed by hints (null = not revealed). */
  revealed: (string | null)[];
}

export interface GameResult {
  score: number;
  elapsedMs: number;
  hintsUsed: number;
  wrongAttempts: number;
  correctSubmissions: number;
}

/** What clients see. Never contains the stored solution. */
export interface GameView {
  code: string;
  /** Increments each time New Game is pressed inside a room. */
  round: number;
  version: number;
  length: WordLength;
  difficulty: Difficulty;
  mode: GameMode;
  turnBased: boolean;
  start: string;
  target: string;
  /** Intermediate slots only (start and target are always locked). */
  slots: SlotView[];
  players: PlayerView[];
  /** Player id whose turn it is, when turnBased. */
  turn: string | null;
  status: GameStatus;
  startedAt: number | null;
  completedAt: number | null;
  serverNow: number;
  hintsUsed: number;
  wrongAttempts: number;
  correctSubmissions: number;
  result: GameResult | null;
}

export interface Session {
  code: string;
  playerId: string;
  token: string;
}

export interface CreateGameRequest {
  length: WordLength;
  difficulty: Difficulty;
  mode: GameMode;
  turnBased?: boolean;
  name: string;
  /** Second player's name (pass-the-phone only). */
  partnerName?: string;
  /** Anonymous, browser-generated id used for statistics and recent-puzzle history. */
  deviceId: string;
}
export interface JoinGameRequest {
  name: string;
  deviceId: string;
}
export interface SessionResponse {
  session: Session;
  game: GameView;
}

export interface SubmitRequest {
  slot: number;
  word: string;
}
export type SubmitResponse =
  | { accepted: true; game: GameView }
  | { accepted: false; code: RejectCode; message: string; game: GameView };

export interface HintRequest {
  type: HintType;
  slot?: number;
}
export type HintPayload =
  | { type: 'letter'; slot: number; index: number; letter: string }
  | { type: 'word'; slot: number; word: string }
  | { type: 'next'; slot: number; anchor: string; message: string };
export interface HintResponse {
  hint: HintPayload;
  game: GameView;
}

export interface NewRoundRequest {
  length?: WordLength;
  difficulty?: Difficulty;
}

export interface PlayerStats {
  gamesPlayed: number;
  gamesCompleted: number;
  correctSubmissions: number;
  incorrectSubmissions: number;
  hintsUsed: number;
  currentStreak: number;
  bestStreak: number;
  bestTimeMs: number | null;
  bestScore: number;
  totalScore: number;
}

export interface ApiErrorBody {
  error: { code: string; message: string };
}

/** Client -> server over the WebSocket. Ephemeral: never persisted. */
export type ClientSocketMessage =
  | { type: 'draft'; slot: number; text: string }
  | { type: 'focus'; slot: number | null }
  | { type: 'reaction'; emoji: string }
  | { type: 'ping' }
  /** First message after the socket opens: asks for the current state and announces presence. */
  | { type: 'hello' };

/** Server -> client over the WebSocket. */
export type ServerSocketMessage =
  | { type: 'state'; game: GameView; event?: GameEvent }
  | { type: 'draft'; playerId: string; slot: number; text: string }
  | { type: 'focus'; playerId: string; slot: number | null }
  | { type: 'reaction'; playerId: string; emoji: string }
  | { type: 'pong' };

/** Why a state broadcast happened, so clients can animate appropriately. */
export type GameEvent =
  | { kind: 'locked'; slot: number; playerId: string }
  | { kind: 'rejected'; slot: number; playerId: string }
  | { kind: 'hint'; playerId: string; hintType: HintType }
  | { kind: 'joined'; playerId: string }
  | { kind: 'presence' }
  | { kind: 'turn' }
  | { kind: 'new_round' }
  | { kind: 'completed' };
