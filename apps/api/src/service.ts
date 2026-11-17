import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { buildResult, checkStep, generatePuzzle, getGraph, HintError, hintFor, pairKey, type Ladder, type Puzzle } from '@ftt/game-engine';
import {
  REACTIONS,
  type ClientSocketMessage, type CreateGameRequest, type GameEvent, type GameView, type HintPayload, type HintResponse,
  type JoinGameRequest, type NewRoundRequest, type PlayerStats, type ServerSocketMessage, type Session, type SessionResponse,
  type SubmitResponse,
} from '@ftt/shared-types';
import { ApiError, badRequest, conflict, notFound, unauthorized } from './errors';
import {
  CODE_ALPHABET, CODE_LENGTH, parseCode, parseDeviceId, parseDifficulty, parseHintType, parseLength, parseAfter, parseMode, parseName, parseWord,
} from './sanitize';
import { VersionConflict, type GameStore, type StoredGame, type StoredPlayer, type StoredProfile } from './store/types';

/** Delivers a payload to one WebSocket connection; resolves false if it is gone. */
export interface Broadcaster {
  send(connectionId: string, payload: string): Promise<boolean>;
}

export interface ServiceOptions {
  now?: () => number;
  /** Rooms expire this long after their last new round. */
  gameTtlSeconds?: number;
  logger?: (event: string, data: Record<string, unknown>) => void;
}

const GAME_TTL = 24 * 60 * 60;
const CONNECTION_TTL = 3 * 60 * 60;
const PROFILE_TTL = 180 * 24 * 60 * 60;
const RECENT_PAIRS = 60;
const MAX_RETRIES = 8;
/** Longest ladder a board will hold; beyond this players must take a word back. */
export const MAX_MOVES = 40;

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const newToken = () => randomBytes(32).toString('base64url');
const newId = () => randomBytes(9).toString('base64url');
const newCode = () => Array.from({ length: CODE_LENGTH }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('');

const emptyStats = (): PlayerStats => ({
  gamesPlayed: 0, gamesCompleted: 0, correctSubmissions: 0, incorrectSubmissions: 0, hintsUsed: 0,
  currentStreak: 0, bestStreak: 0, bestTimeMs: null, bestScore: 0, totalScore: 0,
});

/** The ladder so far, start word first. */
const wordsOf = (game: StoredGame): Ladder => [game.start, ...game.chain.map((s) => s.word)];
const blank = (length: number) => Array<string | null>(length).fill(null);

/**
 * The authoritative game service. Transport-agnostic: the Lambda handlers and the local
 * dev server both call into this class, so behaviour is identical in both.
 */
export class GameService {
  private now: () => number;
  private ttl: number;
  private log: NonNullable<ServiceOptions['logger']>;

  constructor(private store: GameStore, private broadcaster: Broadcaster, opts: ServiceOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.ttl = opts.gameTtlSeconds ?? GAME_TTL;
    this.log = opts.logger ?? (() => {});
  }

  // ───────────────────────────── views & auth ─────────────────────────────

  private async view(game: StoredGame): Promise<GameView> {
    const online = new Set((await this.store.listConnections(game.code)).map((c) => c.playerId));
    return this.toView(game, online);
  }

  private toView(game: StoredGame, online: Set<string>): GameView {
    return {
      code: game.code,
      round: game.round,
      version: game.version,
      length: game.length,
      difficulty: game.difficulty,
      mode: game.mode,
      turnBased: game.turnBased,
      start: game.start,
      target: game.target,
      chain: game.chain.map((s) => ({ word: s.word, by: s.by })),
      revealed: game.revealed,
      optimalMoves: game.optimalMoves,
      players: game.players.map((p) => ({ id: p.id, name: p.name, connected: online.has(p.id) })),
      turn: game.turnBased ? game.players[game.turn]?.id ?? null : null,
      status: game.completedAt ? 'completed' : 'playing',
      startedAt: game.startedAt,
      completedAt: game.completedAt,
      serverNow: this.now(),
      hintsUsed: game.hintsUsed,
      wrongAttempts: game.wrongAttempts,
      correctSubmissions: game.correctSubmissions,
      result: game.result,
    };
  }

  private authorize(game: StoredGame, session: Pick<Session, 'playerId' | 'token'>): StoredPlayer {
    const supplied = Buffer.from(sha256(String(session.token ?? '')));
    // Pass-the-phone: both seats share the device's token.
    const player = game.players.find((p) => p.id === session.playerId);
    if (!player) throw unauthorized();
    const expected = Buffer.from(player.tokenHash);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw unauthorized();
    return player;
  }

  private async load(codeInput: unknown): Promise<StoredGame> {
    const game = await this.store.getGame(parseCode(codeInput));
    // Rooms saved by an older version of the game (a different board shape) are gone.
    if (!game || !Array.isArray(game.chain)) throw notFound();
    return game;
  }

  /**
   * Read-modify-write with optimistic concurrency. `mutate` re-runs against fresh
   * state whenever another request won the race, so a stale update can never
   * overwrite a locked word.
   */
  private async transact<T>(code: unknown, mutate: (game: StoredGame) => T | Promise<T>): Promise<{ game: StoredGame; value: T; changed: boolean }> {
    for (let attempt = 0; ; attempt++) {
      const game = await this.load(code);
      const before = game.version;
      const snapshot = JSON.stringify(game);
      const value = await mutate(game);
      if (JSON.stringify(game) === snapshot) return { game, value, changed: false };
      game.version = before + 1;
      try {
        await this.store.saveGame(game, before);
        return { game, value, changed: true };
      } catch (err) {
        if (!(err instanceof VersionConflict) || attempt >= MAX_RETRIES) throw err instanceof VersionConflict ? conflict('The board is busy, try again.') : err;
      }
    }
  }

  private async broadcast(game: StoredGame, event?: GameEvent): Promise<GameView> {
    const connections = await this.store.listConnections(game.code);
    const view = this.toView(game, new Set(connections.map((c) => c.playerId)));
    const payload = JSON.stringify({ type: 'state', game: view, event } satisfies ServerSocketMessage);
    await this.fanOut(game.code, connections.map((c) => c.connectionId), payload);
    return view;
  }

  private async fanOut(code: string, connectionIds: string[], payload: string) {
    await Promise.all(
      connectionIds.map(async (id) => {
        const alive = await this.broadcaster.send(id, payload).catch(() => true);
        if (!alive) await this.store.deleteConnection(id, code).catch(() => {});
      }),
    );
  }

  // ───────────────────────────── profiles ─────────────────────────────

  private async updateProfile(deviceId: string, mutate: (p: StoredProfile) => void): Promise<StoredProfile> {
    for (let attempt = 0; ; attempt++) {
      const existing = await this.store.getProfile(deviceId);
      const profile: StoredProfile = existing ?? { deviceId, version: 0, recentPairs: [], openGame: null, expiresAt: 0, ...emptyStats() };
      const before = profile.version;
      mutate(profile);
      profile.version = before + 1;
      profile.expiresAt = Math.floor(this.now() / 1000) + PROFILE_TTL;
      try {
        await this.store.saveProfile(profile, before);
        return profile;
      } catch (err) {
        if (!(err instanceof VersionConflict) || attempt >= MAX_RETRIES) throw err;
      }
    }
  }

  /** Records that these devices were dealt a puzzle (history + streak bookkeeping). */
  private async recordDeal(game: StoredGame) {
    const key = pairKey(game.start, game.target);
    const open = `${game.code}:${game.round}`;
    await Promise.all(
      [...new Set(game.players.map((p) => p.deviceId))].map((deviceId) =>
        this.updateProfile(deviceId, (p) => {
          p.gamesPlayed += 1;
          if (p.openGame && p.openGame !== open) p.currentStreak = 0; // abandoned the previous game
          p.openGame = open;
          p.recentPairs = [...p.recentPairs.filter((k) => k !== key), key].slice(-RECENT_PAIRS);
        }).catch((err) => this.log('profile_error', { deviceId, error: String(err) })),
      ),
    );
  }

  private async recordCompletion(game: StoredGame) {
    const result = game.result!;
    await Promise.all(
      [...new Set(game.players.map((p) => p.deviceId))].map((deviceId) =>
        this.updateProfile(deviceId, (p) => {
          p.gamesCompleted += 1;
          p.correctSubmissions += result.correctSubmissions;
          p.incorrectSubmissions += result.wrongAttempts;
          p.hintsUsed += result.hintsUsed;
          p.currentStreak += 1;
          p.bestStreak = Math.max(p.bestStreak, p.currentStreak);
          p.bestTimeMs = p.bestTimeMs === null ? result.elapsedMs : Math.min(p.bestTimeMs, result.elapsedMs);
          p.bestScore = Math.max(p.bestScore, result.score);
          p.totalScore += result.score;
          p.openGame = null;
        }).catch((err) => this.log('profile_error', { deviceId, error: String(err) })),
      ),
    );
  }

  async getStats(deviceIdInput: unknown): Promise<PlayerStats> {
    const profile = await this.store.getProfile(parseDeviceId(deviceIdInput));
    const { gamesPlayed, gamesCompleted, correctSubmissions, incorrectSubmissions, hintsUsed, currentStreak, bestStreak, bestTimeMs, bestScore, totalScore } =
      profile ?? emptyStats();
    return { gamesPlayed, gamesCompleted, correctSubmissions, incorrectSubmissions, hintsUsed, currentStreak, bestStreak, bestTimeMs, bestScore, totalScore };
  }

  // ───────────────────────────── puzzles ─────────────────────────────

  private async deal(game: Pick<StoredGame, 'length' | 'difficulty' | 'recentPairs' | 'players'> & Partial<Pick<StoredGame, 'start' | 'target'>>): Promise<Puzzle> {
    const profiles = await Promise.all([...new Set(game.players.map((p) => p.deviceId))].map((d) => this.store.getProfile(d)));
    const exclude = new Set([...game.recentPairs, ...profiles.flatMap((p) => p?.recentPairs ?? [])]);
    // Avoid immediately repeating a start or target word.
    const avoid = new Set<string>([game.start, game.target].filter((w): w is string => !!w));
    for (const key of [...exclude].slice(-6)) key.split('>').forEach((w) => avoid.add(w));
    const puzzle = generatePuzzle({ length: game.length, difficulty: game.difficulty, excludePairs: exclude, avoidWords: avoid });
    this.log('puzzle_generated', { length: puzzle.length, difficulty: puzzle.difficulty, slots: puzzle.slots, attempts: puzzle.attempts, fallback: puzzle.fromFallback });
    return puzzle;
  }

  private applyPuzzle(game: StoredGame, puzzle: Puzzle) {
    const now = this.now();
    game.start = puzzle.start;
    game.target = puzzle.target;
    game.solution = puzzle.solution;
    game.optimalMoves = puzzle.slots + 1;
    game.chain = [];
    game.revealed = blank(puzzle.length);
    game.recentPairs = [...game.recentPairs, pairKey(puzzle.start, puzzle.target)].slice(-RECENT_PAIRS);
    // Couples rooms start the clock when the partner arrives (or on the first move).
    game.startedAt = game.mode === 'couples' && game.players.length < 2 ? null : now;
    game.completedAt = null;
    game.result = null;
    game.hintsUsed = 0;
    game.wrongAttempts = 0;
    game.correctSubmissions = 0;
    game.expiresAt = Math.floor(now / 1000) + this.ttl;
  }

  // ───────────────────────────── commands ─────────────────────────────

  async createGame(body: Partial<CreateGameRequest>): Promise<SessionResponse> {
    const mode = parseMode(body.mode);
    const deviceId = parseDeviceId(body.deviceId);
    const token = newToken();
    const tokenHash = sha256(token);
    const players: StoredPlayer[] = [{ id: newId(), name: parseName(body.name, 'Player 1'), tokenHash, deviceId }];
    if (mode === 'pass') players.push({ id: newId(), name: parseName(body.partnerName, 'Player 2'), tokenHash, deviceId });

    const game: StoredGame = {
      code: '', version: 1, round: 1, createdAt: this.now(), expiresAt: 0,
      length: parseLength(body.length), difficulty: parseDifficulty(body.difficulty), mode,
      turnBased: mode !== 'solo', // two players always take turns: one letter each
      start: '', target: '', solution: [], optimalMoves: 0, chain: [], revealed: [], players, turn: 0,
      startedAt: null, completedAt: null, hintsUsed: 0, wrongAttempts: 0, correctSubmissions: 0, result: null, recentPairs: [],
    };
    this.applyPuzzle(game, await this.deal(game));

    for (let attempt = 0; ; attempt++) {
      game.code = newCode();
      try {
        await this.store.createGame(game);
        break;
      } catch (err) {
        if (!(err instanceof VersionConflict) || attempt >= MAX_RETRIES) throw err;
      }
    }
    await this.recordDeal(game);
    this.log('game_created', { code: game.code, mode, length: game.length, difficulty: game.difficulty });
    return { session: { code: game.code, playerId: players[0]!.id, token }, game: await this.view(game) };
  }

  async joinGame(code: unknown, body: Partial<JoinGameRequest>): Promise<SessionResponse> {
    const deviceId = parseDeviceId(body.deviceId);
    const token = newToken();
    const player: StoredPlayer = { id: newId(), name: parseName(body.name, 'Player 2'), tokenHash: sha256(token), deviceId };
    const { game } = await this.transact(code, (g) => {
      if (g.mode !== 'couples') throw conflict("This game isn't open for joining.", 'not_joinable');
      if (g.players.length >= 2) throw conflict('This room already has two players.', 'room_full');
      g.players.push(player);
      if (!g.completedAt && g.startedAt === null) g.startedAt = this.now();
    });
    await this.recordDeal(game);
    await this.broadcast(game, { kind: 'joined', playerId: player.id });
    return { session: { code: game.code, playerId: player.id, token }, game: await this.view(game) };
  }

  async getGame(session: Session): Promise<GameView> {
    const game = await this.load(session.code);
    this.authorize(game, session);
    return this.view(game);
  }

  /**
   * Plays one move: checks the word against the last word on the board and, if it is a
   * real word exactly one letter away that has not been used, writes it underneath and
   * hands the turn to the other player. Writing the target word completes the game.
   */
  async submitWord(session: Session, body: { word?: unknown; after?: unknown }): Promise<SubmitResponse> {
    const word = parseWord(body.word);
    const after = parseAfter(body.after);
    let completedNow = false;
    let actor = '';

    const { game, value, changed } = await this.transact(session.code, (g) => {
      completedNow = false;
      const player = this.authorize(g, session);
      const active = g.turnBased ? g.players[g.turn] ?? player : player;
      actor = active.id;
      // A retry or double tap of a move that already landed: harmless.
      if (after !== undefined && g.chain[after]?.word === word) return { ok: true as const, word };
      if (g.completedAt) throw conflict('This puzzle is already complete.', 'completed');
      if (g.mode === 'couples' && g.players.length < 2) throw conflict('Waiting for your partner to join.', 'waiting');
      if (g.mode === 'couples' && active.id !== player.id) throw conflict(`It's ${active.name}'s turn.`, 'not_your_turn');
      // The board moved on since this was written (not counted as a mistake).
      if (after !== undefined && after !== g.chain.length)
        return { ok: false as const, code: 'stale' as const, message: 'The board changed. Try again from the new word.' };
      if (g.chain.length >= MAX_MOVES) throw conflict('The board is full. Take back a word or start a new game.', 'board_full');

      const placement = checkStep(getGraph(g.length), wordsOf(g), word);
      const now = this.now();
      if (g.startedAt === null) g.startedAt = now;
      if (!placement.ok) {
        g.wrongAttempts += 1; // a wrong word does not pass the turn
        return placement;
      }
      g.chain.push({ word: placement.word, by: active.id, at: now });
      g.revealed = blank(g.length);
      g.correctSubmissions += 1;
      if (placement.word === g.target) {
        g.completedAt = now;
        g.result = buildResult({
          difficulty: g.difficulty, elapsedMs: now - g.startedAt, hintsUsed: g.hintsUsed, wrongAttempts: g.wrongAttempts,
          correctSubmissions: g.correctSubmissions, moves: g.chain.length, optimalMoves: g.optimalMoves,
        });
        completedNow = true;
      } else if (g.players.length > 1) g.turn = (g.turn + 1) % g.players.length;
      return placement;
    });

    if (changed && completedNow) await this.recordCompletion(game);
    const event: GameEvent | undefined = !changed
      ? undefined
      : completedNow ? { kind: 'completed' } : value.ok ? { kind: 'locked', playerId: actor } : { kind: 'rejected', playerId: actor };
    const view = changed ? await this.broadcast(game, event) : await this.view(game);
    return value.ok ? { accepted: true, game: view } : { accepted: false, code: value.code, message: value.message, game: view };
  }

  /**
   * Takes the last word back off the board (the way out of a dead end). Either player
   * may do it; the turn returns to whoever wrote that word. Counts as a miss.
   */
  async undoWord(session: Session): Promise<GameView> {
    let actor = '';
    const { game } = await this.transact(session.code, (g) => {
      actor = this.authorize(g, session).id;
      if (g.completedAt) throw conflict('This puzzle is already complete.', 'completed');
      const last = g.chain.pop();
      if (!last) throw conflict('There is nothing to take back.', 'nothing_to_undo');
      const writer = g.players.findIndex((p) => p.id === last.by);
      if (g.players.length > 1 && writer >= 0) g.turn = writer;
      g.revealed = blank(g.length);
      g.wrongAttempts += 1;
    });
    return this.broadcast(game, { kind: 'undone', playerId: actor });
  }

  async requestHint(session: Session, body: { type?: unknown }): Promise<HintResponse> {
    const type = parseHintType(body.type);
    let actor = '';
    const { game, value } = await this.transact(session.code, (g) => {
      actor = this.authorize(g, session).id;
      if (g.completedAt) throw conflict('This puzzle is already complete.', 'completed');
      let hint: HintPayload;
      try {
        hint = hintFor(getGraph(g.length), wordsOf(g), g.target, type, g.revealed);
      } catch (err) {
        if (err instanceof HintError) throw conflict(err.message, 'no_hint');
        throw err;
      }
      if (hint.type === 'letter') {
        g.revealed = blank(g.length);
        g.revealed[hint.index] = hint.letter;
      }
      if (g.startedAt === null) g.startedAt = this.now();
      g.hintsUsed += 1;
      return hint;
    });
    return { hint: value, game: await this.broadcast(game, { kind: 'hint', playerId: actor, hintType: type }) };
  }

  async passTurn(session: Session): Promise<GameView> {
    const { game, changed } = await this.transact(session.code, (g) => {
      const player = this.authorize(g, session);
      if (!g.turnBased || g.players.length < 2 || g.completedAt) throw conflict('There is no turn to pass.', 'no_turn');
      if (g.mode === 'couples' && g.players[g.turn]!.id !== player.id) throw conflict("It isn't your turn.", 'not_your_turn');
      g.turn = (g.turn + 1) % g.players.length;
    });
    return changed ? this.broadcast(game, { kind: 'turn' }) : this.view(game);
  }

  /** New Game inside a room: wipes the board and deals a fresh pair of words. */
  async newRound(session: Session, body: Partial<NewRoundRequest>): Promise<GameView> {
    const current = await this.load(session.code);
    this.authorize(current, session);
    const settings = {
      length: body.length === undefined ? current.length : parseLength(body.length),
      difficulty: body.difficulty === undefined ? current.difficulty : parseDifficulty(body.difficulty),
    };
    const puzzle = await this.deal({ ...current, ...settings });
    const { game, changed } = await this.transact(session.code, (g) => {
      this.authorize(g, session);
      // Both partners pressed New Game at once: the first one wins, the second is a no-op.
      if (g.round !== current.round) return;
      g.round += 1;
      g.length = settings.length;
      g.difficulty = settings.difficulty;
      g.turn = (g.round - 1) % Math.max(1, g.players.length); // alternate who goes first
      this.applyPuzzle(g, puzzle);
    });
    if (!changed) return this.view(game);
    await this.recordDeal(game);
    return this.broadcast(game, { kind: 'new_round' });
  }

  // ───────────────────────────── real-time ─────────────────────────────

  /** $connect: authenticates the socket against the room before accepting it. */
  async connect(connectionId: string, query: { code?: unknown; playerId?: unknown; token?: unknown }): Promise<void> {
    const game = await this.load(query.code);
    const player = this.authorize(game, { playerId: String(query.playerId ?? ''), token: String(query.token ?? '') });
    await this.store.putConnection({
      connectionId, code: game.code, playerId: player.id, expiresAt: Math.floor(this.now() / 1000) + CONNECTION_TTL,
    });
  }

  /** Called once the socket is usable (API Gateway cannot send during $connect). */
  async announce(connectionId: string): Promise<void> {
    const conn = await this.store.getConnection(connectionId);
    if (!conn) return;
    const game = await this.store.getGame(conn.code);
    if (game) await this.broadcast(game, { kind: 'presence' });
  }

  async disconnect(connectionId: string): Promise<void> {
    const conn = await this.store.getConnection(connectionId);
    if (!conn) return;
    await this.store.deleteConnection(connectionId, conn.code);
    const game = await this.store.getGame(conn.code);
    if (game) await this.broadcast(game, { kind: 'presence' });
  }

  /** Ephemeral partner signals: live handwriting preview, focus and reactions. */
  async message(connectionId: string, raw: string): Promise<void> {
    if (raw.length > 512) return;
    let msg: ClientSocketMessage;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'hello') return this.announce(connectionId);
    if (msg.type === 'ping') {
      await this.broadcaster.send(connectionId, JSON.stringify({ type: 'pong' } satisfies ServerSocketMessage));
      return;
    }
    const conn = await this.store.getConnection(connectionId);
    if (!conn) return;
    let out: ServerSocketMessage;
    const small = (n: unknown, max: number): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= max;
    if (msg.type === 'draft' && small(msg.after, MAX_MOVES) && small(msg.cursor, 4) && typeof msg.text === 'string' && /^[A-Za-z]{4,5}$/.test(msg.text))
      out = { type: 'draft', playerId: conn.playerId, after: msg.after, text: msg.text.toUpperCase(), cursor: msg.cursor };
    else if (msg.type === 'reaction' && (REACTIONS as readonly string[]).includes(msg.emoji))
      out = { type: 'reaction', playerId: conn.playerId, emoji: msg.emoji };
    else return;
    const peers = (await this.store.listConnections(conn.code)).filter((c) => c.connectionId !== connectionId);
    await this.fanOut(conn.code, peers.map((c) => c.connectionId), JSON.stringify(out));
  }
}

export { ApiError };
