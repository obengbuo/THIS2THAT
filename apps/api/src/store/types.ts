import type { Difficulty, GameMode, GameResult, PlayerStats, WordLength } from '@ftt/shared-types';

export interface StoredPlayer {
  id: string;
  name: string;
  /** SHA-256 of the player's secret token. The token itself is never stored. */
  tokenHash: string;
  deviceId: string;
}

export interface StoredSlot {
  word: string | null;
  lockedBy: string | null;
  lockedAt: number | null;
  revealed: (string | null)[];
}

export interface StoredGame {
  code: string;
  /** Optimistic-concurrency version; every write is conditional on it. */
  version: number;
  round: number;
  createdAt: number;
  /** Epoch seconds; DynamoDB TTL attribute. */
  expiresAt: number;
  length: WordLength;
  difficulty: Difficulty;
  mode: GameMode;
  turnBased: boolean;
  start: string;
  target: string;
  /** One verified solution. Server-side only. */
  solution: string[];
  slots: StoredSlot[];
  players: StoredPlayer[];
  /** Index into players of whose turn it is. */
  turn: number;
  startedAt: number | null;
  completedAt: number | null;
  hintsUsed: number;
  wrongAttempts: number;
  correctSubmissions: number;
  result: GameResult | null;
  /** Pair keys already played in this room. */
  recentPairs: string[];
}

export interface StoredConnection {
  connectionId: string;
  code: string;
  playerId: string;
  expiresAt: number;
}

export interface StoredProfile extends PlayerStats {
  deviceId: string;
  version: number;
  /** Pair keys recently served to this device (newest last). */
  recentPairs: string[];
  /** "code:round" of a game that was started but not finished, used for streaks. */
  openGame: string | null;
  expiresAt: number;
}

export class VersionConflict extends Error {
  constructor() {
    super('version conflict');
  }
}

/**
 * Persistence boundary. Implemented by MemoryStore (local dev, tests) and DynamoStore
 * (production). All writes are conditional so concurrent requests cannot overwrite
 * each other: the loser gets VersionConflict and re-validates against fresh state.
 */
export interface GameStore {
  /** Fails with VersionConflict if the code is already taken. */
  createGame(game: StoredGame): Promise<void>;
  getGame(code: string): Promise<StoredGame | null>;
  /** Writes `game` only if the stored version equals `expectedVersion`. */
  saveGame(game: StoredGame, expectedVersion: number): Promise<void>;

  putConnection(conn: StoredConnection): Promise<void>;
  getConnection(connectionId: string): Promise<StoredConnection | null>;
  deleteConnection(connectionId: string, code: string): Promise<void>;
  listConnections(code: string): Promise<StoredConnection[]>;

  getProfile(deviceId: string): Promise<StoredProfile | null>;
  /** Conditional on version; `expectedVersion` 0 means "must not exist yet". */
  saveProfile(profile: StoredProfile, expectedVersion: number): Promise<void>;
}
