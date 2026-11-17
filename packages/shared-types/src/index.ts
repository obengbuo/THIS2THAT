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
  /** The board moved on (the partner wrote a word) before this submission arrived. */
  | 'stale';

export interface PlayerView {
  id: string;
  name: string;
  /** Has at least one live real-time connection. */
  connected: boolean;
}

/** One word written on the board after the start word. */
export interface StepView {
  word: string;
  /** Player id who wrote it. */
  by: string;
}

export interface GameResult {
  score: number;
  elapsedMs: number;
  hintsUsed: number;
  wrongAttempts: number;
  correctSubmissions: number;
  /** Words written to get from start to target (the target counts). */
  moves: number;
  /** Fewest moves that could have done it. */
  optimalMoves: number;
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
  /** True when two players alternate (couples and pass-the-phone). */
  turnBased: boolean;
  start: string;
  target: string;
  /**
   * Every word written so far, in order. Each differs from the one before it (the first
   * from `start`) by exactly one letter. The game is complete when the last is `target`.
   */
  chain: StepView[];
  /** Letters of the next word revealed by hints (null = not revealed). */
  revealed: (string | null)[];
  /** Fewest moves from start to target. */
  optimalMoves: number;
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
  word: string;
  /** How many words were on the board when this was written (makes retries harmless). */
  after?: number;
}
export type SubmitResponse =
  | { accepted: true; game: GameView }
  | { accepted: false; code: RejectCode; message: string; game: GameView };

export interface HintRequest {
  type: HintType;
}
/** `index` is the zero-based letter position to change in the current word. */
export type HintPayload =
  | { type: 'next'; index: number; message: string }
  | { type: 'letter'; index: number; letter: string }
  | { type: 'word'; index: number; word: string };
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
  /** The word I am writing; `after` is how many words were on the board when I wrote it. */
  | { type: 'draft'; after: number; text: string; cursor: number }
  | { type: 'reaction'; emoji: string }
  | { type: 'ping' }
  /** First message after the socket opens: asks for the current state and announces presence. */
  | { type: 'hello' };

/** Server -> client over the WebSocket. */
export type ServerSocketMessage =
  | { type: 'state'; game: GameView; event?: GameEvent }
  | { type: 'draft'; playerId: string; after: number; text: string; cursor: number }
  | { type: 'reaction'; playerId: string; emoji: string }
  | { type: 'pong' };

/** Why a state broadcast happened, so clients can animate appropriately. */
export type GameEvent =
  | { kind: 'locked'; playerId: string }
  | { kind: 'rejected'; playerId: string }
  | { kind: 'undone'; playerId: string }
  | { kind: 'hint'; playerId: string; hintType: HintType }
  | { kind: 'joined'; playerId: string }
  | { kind: 'presence' }
  | { kind: 'turn' }
  | { kind: 'new_round' }
  | { kind: 'completed' };
