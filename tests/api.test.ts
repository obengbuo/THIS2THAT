import { beforeEach, describe, expect, it } from 'vitest';
import { GameService, handleHttp, MemoryStore, type Broadcaster } from '@ftt/api';
import { differsByOne, getGraph, isLadder, routeToTarget } from '@ftt/game-engine';
import type { GameView, ServerSocketMessage, Session, SessionResponse } from '@ftt/shared-types';

const DEVICE_A = 'device-aaaaaaaaaaaaaaaa';
const DEVICE_B = 'device-bbbbbbbbbbbbbbbb';

class Inbox implements Broadcaster {
  messages = new Map<string, ServerSocketMessage[]>();
  dead = new Set<string>();
  async send(connectionId: string, payload: string) {
    if (this.dead.has(connectionId)) return false;
    const list = this.messages.get(connectionId) ?? [];
    list.push(JSON.parse(payload));
    this.messages.set(connectionId, list);
    return true;
  }
  last(connectionId: string) {
    return this.messages.get(connectionId)?.at(-1);
  }
  lastState(connectionId: string): GameView | undefined {
    const states = (this.messages.get(connectionId) ?? []).filter((m) => m.type === 'state');
    const m = states.at(-1);
    return m?.type === 'state' ? m.game : undefined;
  }
}

let store: MemoryStore;
let inbox: Inbox;
let service: GameService;
let clock: number;

beforeEach(() => {
  store = new MemoryStore();
  inbox = new Inbox();
  clock = Date.now();
  service = new GameService(store, inbox, { now: () => clock });
});

const wordsOf = (g: GameView) => [g.start, ...g.chain.map((s) => s.word)];
/** The words still to write to finish the game by a shortest route. */
const routeFor = (g: GameView) => routeToTarget(getGraph(g.length), wordsOf(g), g.target)!;
/** A string one letter away from the current word that is not a word. */
const nonWord = (g: GameView) => {
  const current = wordsOf(g).at(-1)!;
  for (const ch of 'QXZJVK') {
    const candidate = ch + current.slice(1);
    if (candidate !== current && !getGraph(g.length).index.has(candidate)) return candidate;
  }
  throw new Error('no non-word found');
};

async function couple() {
  const a = await service.createGame({ length: 4, difficulty: 'medium', mode: 'couples', name: 'Ama', deviceId: DEVICE_A });
  const b = await service.joinGame(a.session.code, { name: 'Kofi', deviceId: DEVICE_B });
  return { a: a.session, b: b.session, game: b.game };
}
const solo = (length: 4 | 5 = 4, difficulty: 'easy' | 'medium' | 'hard' = 'easy') =>
  service.createGame({ length, difficulty, mode: 'solo', name: 'Ama', deviceId: DEVICE_A });

/** Plays the rest of the game by a shortest route, alternating between `sessions`. */
async function finish(game: GameView, sessions: Session[]) {
  let view = game;
  for (const word of routeFor(game)) {
    const who = sessions.find((s) => s.playerId === view.turn) ?? sessions[0]!;
    const res = await service.submitWord(who, { word, after: view.chain.length });
    expect(res.accepted).toBe(true);
    view = res.game;
  }
  return view;
}

describe('solo game flow', () => {
  it('starts with only the start word on the board and never exposes the solution', async () => {
    const { game, session } = await solo(5);
    expect(session.code).toMatch(/^[A-Z2-9]{6}$/);
    expect(game.length).toBe(5);
    expect(game.chain).toEqual([]);
    expect(game.turnBased).toBe(false);
    expect(JSON.stringify(game)).not.toContain('solution');
    expect(routeFor(game)).toHaveLength(game.optimalMoves);
  });

  it('adds one word per move, rejects bad moves, and completes on the target', async () => {
    const { game, session } = await solo();
    const route = routeFor(game);

    const bad = await service.submitWord(session, { word: nonWord(game) });
    expect(bad).toMatchObject({ accepted: false, code: 'not_a_word' });
    expect(bad.game.chain).toEqual([]);
    expect(bad.game.wrongAttempts).toBe(1);

    clock += 20_000;
    let view = game;
    for (const [i, word] of route.entries()) {
      const res = await service.submitWord(session, { word: word.toLowerCase() });
      expect(res.accepted).toBe(true);
      view = res.game;
      expect(view.chain).toHaveLength(i + 1);
      expect(view.chain[i]).toEqual({ word, by: session.playerId });
    }
    expect(view.status).toBe('completed');
    expect(view.chain.at(-1)!.word).toBe(game.target);
    expect(isLadder(getGraph(4), wordsOf(view))).toBe(true);
    expect(view.result).toMatchObject({
      elapsedMs: 20_000, wrongAttempts: 1, hintsUsed: 0, correctSubmissions: route.length, moves: route.length, optimalMoves: game.optimalMoves,
    });
    expect(view.result!.score).toBe(1000 - 10 - 25);

    await expect(service.submitWord(session, { word: route[0]! })).rejects.toMatchObject({ code: 'completed' });
  });

  it('enforces the one-letter rule against the last word on the board', async () => {
    const { game, session } = await solo(4, 'medium');
    const route = routeFor(game);
    // A real word, but two letters away from the start word.
    expect(await service.submitWord(session, { word: route[1]! })).toMatchObject({ accepted: false, code: 'not_one_letter' });
    expect(await service.submitWord(session, { word: game.start })).toMatchObject({ accepted: false, code: 'not_one_letter' });
    expect(await service.submitWord(session, { word: 'ABC' })).toMatchObject({ accepted: false, code: 'bad_length' });
    const first = await service.submitWord(session, { word: route[0]! });
    expect(first.accepted).toBe(true);
    // Going back to a word already on the board is not allowed.
    expect(await service.submitWord(session, { word: game.start })).toMatchObject({ accepted: false, code: 'already_used' });
    expect((await service.getGame(session)).chain.map((s) => s.word)).toEqual([route[0]]);
  });

  it('accepts any route, however long, and charges for the extra moves', async () => {
    const { game, session } = await solo(4, 'easy');
    const graph = getGraph(4);
    // Wander: step to a neighbour that is not on a shortest route, then finish from there.
    const direct = routeFor(game);
    const detour = graph.neighbors[graph.index.get(game.start)!]!
      .map((i) => graph.words[i]!)
      .find((w) => w !== direct[0] && w !== game.target && (routeToTarget(graph, [game.start, w], game.target)?.length ?? 0) >= direct.length);
    if (!detour) return; // no detour from this start word; other runs cover it
    const res = await service.submitWord(session, { word: detour });
    expect(res.accepted).toBe(true);
    const view = await finish(res.game, [session]);
    expect(view.status).toBe('completed');
    expect(view.result!.moves).toBeGreaterThan(game.optimalMoves);
    expect(view.result!.score).toBe(1000 - 30 * (view.result!.moves - game.optimalMoves));
  });

  it('makes a retried move harmless', async () => {
    const { game, session } = await solo();
    const word = routeFor(game)[0]!;
    const [r1, r2] = await Promise.all([service.submitWord(session, { word, after: 0 }), service.submitWord(session, { word, after: 0 })]);
    expect(r1.accepted && r2.accepted).toBe(true);
    const view = await service.getGame(session);
    expect(view.chain.map((s) => s.word)).toEqual([word]);
    expect(view).toMatchObject({ correctSubmissions: 1, wrongAttempts: 0 });
  });
});

describe('taking a word back', () => {
  it('removes only the last word, returns the turn to its writer, and counts as a miss', async () => {
    const { a, b, game } = await couple();
    const route = routeFor(game);
    await service.submitWord(a, { word: route[0]! });
    const second = await service.submitWord(b, { word: route[1]! });
    expect(second.game.turn).toBe(a.playerId);

    const undone = await service.undoWord(a); // either player may take the last word back
    expect(undone.chain.map((s) => s.word)).toEqual([route[0]]);
    expect(undone.turn).toBe(b.playerId);
    expect(undone.wrongAttempts).toBe(1);
    // The word that was taken back can be written again.
    expect((await service.submitWord(b, { word: route[1]! })).accepted).toBe(true);
  });

  it('refuses when there is nothing to take back or the game is over', async () => {
    const { game, session } = await solo();
    await expect(service.undoWord(session)).rejects.toMatchObject({ code: 'nothing_to_undo' });
    await finish(game, [session]);
    await expect(service.undoWord(session)).rejects.toMatchObject({ code: 'completed' });
  });

  it('only a new game wipes the whole board', async () => {
    const { session, game } = await solo();
    await service.submitWord(session, { word: routeFor(game)[0]! });
    const next = await service.newRound(session, {});
    expect(next.round).toBe(2);
    expect(next.chain).toEqual([]);
    expect([next.start, next.target]).not.toContain(game.start);
    expect([next.start, next.target]).not.toContain(game.target);
  });

  it('exposes no HTTP route that edits or clears earlier words', async () => {
    const { session, game } = await solo();
    const word = routeFor(game)[0]!;
    await service.submitWord(session, { word });
    const headers = { authorization: `Bearer ${session.playerId}.${session.token}` };
    for (const [method, action] of [['POST', 'reset'], ['DELETE', 'submit'], ['PUT', 'submit'], ['POST', 'unlock'], ['PATCH', '']] as const) {
      const res = await handleHttp(service, { method, path: `/games/${session.code}/${action}`, headers, body: JSON.stringify({ word: 'CORD' }) });
      expect(res.status).toBe(404);
    }
    expect((await service.getGame(session)).chain.map((s) => s.word)).toEqual([word]);
  });
});

describe('couples multiplayer', () => {
  it('requires a valid session for every action', async () => {
    const { a, game } = await couple();
    const word = routeFor(game)[0]!;
    const forged: Session = { ...a, token: 'x'.repeat(43) };
    await expect(service.submitWord(forged, { word })).rejects.toMatchObject({ status: 401 });
    await expect(service.undoWord(forged)).rejects.toMatchObject({ status: 401 });
    await expect(service.getGame({ ...a, playerId: 'nobody' })).rejects.toMatchObject({ status: 401 });
    await expect(service.connect('c1', { code: a.code, playerId: a.playerId, token: 'nope' })).rejects.toMatchObject({ status: 401 });
    await expect(service.joinGame(a.code, { name: 'Third', deviceId: 'device-cccccccccccccccc' })).rejects.toMatchObject({ code: 'room_full' });
    await expect(service.joinGame('ZZZZZZ', { name: 'x', deviceId: DEVICE_B })).rejects.toMatchObject({ status: 404 });
    expect((await service.getGame(a)).chain).toEqual([]);
  });

  it('waits for the partner before the first move', async () => {
    const a = await service.createGame({ length: 4, difficulty: 'easy', mode: 'couples', name: 'Ama', deviceId: DEVICE_A });
    expect(a.game.turnBased).toBe(true);
    await expect(service.submitWord(a.session, { word: routeFor(a.game)[0]! })).rejects.toMatchObject({ code: 'waiting' });
  });

  it('alternates strictly: one letter each until the target', async () => {
    const { a, b, game } = await couple();
    expect(game.turn).toBe(a.playerId);
    const route = routeFor(game);
    await expect(service.submitWord(b, { word: route[0]! })).rejects.toMatchObject({ code: 'not_your_turn' });
    const r1 = await service.submitWord(a, { word: route[0]! });
    expect(r1.game.turn).toBe(b.playerId);
    await expect(service.submitWord(a, { word: route[1]! })).rejects.toMatchObject({ code: 'not_your_turn' });

    // A wrong word does not pass the turn.
    const miss = await service.submitWord(b, { word: nonWord(r1.game) });
    expect(miss).toMatchObject({ accepted: false, game: { turn: b.playerId } });

    const final = await finish(r1.game, [a, b]);
    expect(final.status).toBe('completed');
    expect(final.chain.map((s) => s.by)).toEqual(route.map((_, i) => (i % 2 ? b.playerId : a.playerId)));

    await expect(service.passTurn(a)).rejects.toMatchObject({ code: 'no_turn' });
  });

  it('lets a player pass their turn', async () => {
    const { a, b } = await couple();
    await expect(service.passTurn(b)).rejects.toMatchObject({ code: 'not_your_turn' });
    expect((await service.passTurn(a)).turn).toBe(b.playerId);
  });

  it('pushes each new word to the other player in real time', async () => {
    const { a, b, game } = await couple();
    await service.connect('conn-a', a);
    await service.connect('conn-b', b);
    await service.message('conn-b', JSON.stringify({ type: 'hello' }));
    expect(inbox.lastState('conn-a')!.players.map((p) => p.connected)).toEqual([true, true]);

    const word = routeFor(game)[0]!;
    await service.submitWord(a, { word });
    expect(inbox.last('conn-b')).toMatchObject({ type: 'state', event: { kind: 'locked', playerId: a.playerId } });
    expect(inbox.lastState('conn-b')!.chain).toEqual([{ word, by: a.playerId }]);
    expect(inbox.lastState('conn-b')!.turn).toBe(b.playerId);

    await service.undoWord(b);
    expect(inbox.last('conn-a')).toMatchObject({ type: 'state', event: { kind: 'undone', playerId: b.playerId }, game: { chain: [] } });
  });

  it('relays live drafts and reactions to the partner only, and drops junk', async () => {
    const { a, b } = await couple();
    await service.connect('conn-a', a);
    await service.connect('conn-b', b);
    await service.message('conn-a', JSON.stringify({ type: 'draft', after: 1, text: 'cord', cursor: 2 }));
    expect(inbox.last('conn-b')).toEqual({ type: 'draft', playerId: a.playerId, after: 1, text: 'CORD', cursor: 2 });
    expect(inbox.messages.get('conn-a')).toBeUndefined();
    await service.message('conn-a', JSON.stringify({ type: 'reaction', emoji: '❤️' }));
    expect(inbox.last('conn-b')).toEqual({ type: 'reaction', playerId: a.playerId, emoji: '❤️' });
    const count = inbox.messages.get('conn-b')!.length;
    for (const junk of [
      'not json', '{"type":"draft","after":1,"text":"<script>","cursor":0}', '{"type":"draft","after":1,"text":"CORD","cursor":9}',
      '{"type":"draft","after":-1,"text":"CORD","cursor":0}', '{"type":"reaction","emoji":"<b>"}', '{"type":"state"}', 'x'.repeat(2000),
    ])
      await service.message('conn-a', junk);
    expect(inbox.messages.get('conn-b')!.length).toBe(count);
  });

  it('never writes two words for one move when submissions race', async () => {
    for (let run = 0; run < 25; run++) {
      const { a, game } = await couple();
      const graph = getGraph(4);
      const options = graph.neighbors[graph.index.get(game.start)!]!.map((i) => graph.words[i]!).slice(0, 2);
      const results = await Promise.all(options.map((word) => service.submitWord(a, { word, after: 0 }).catch((e) => e)));
      const final = await service.getGame(a);
      expect(final.chain).toHaveLength(1);
      expect(options).toContain(final.chain[0]!.word);
      expect(final.correctSubmissions).toBe(1);
      expect(final.wrongAttempts).toBe(0); // the loser is told the board changed, not charged a miss
      expect(results.filter((r) => r.accepted === true)).toHaveLength(1);
    }
  });

  it('lets a disconnected player reconnect and resume the same board', async () => {
    const { a, b, game } = await couple();
    await service.connect('conn-a', a);
    await service.connect('conn-b1', b);
    const route = routeFor(game);
    await service.submitWord(a, { word: route[0]! });
    await service.submitWord(b, { word: route[1]! });

    await service.disconnect('conn-b1');
    expect(inbox.lastState('conn-a')!.players.find((p) => p.id === b.playerId)!.connected).toBe(false);
    await service.submitWord(a, { word: route[2]! }); // partner keeps playing meanwhile

    await service.connect('conn-b2', b);
    await service.message('conn-b2', JSON.stringify({ type: 'hello' }));
    const resumed = inbox.lastState('conn-b2')!;
    expect(resumed.chain.map((s) => s.word)).toEqual(route.slice(0, 3));
    expect(resumed.players.every((p) => p.connected)).toBe(true);
    expect(resumed.turn).toBe(b.playerId);
  });

  it('cleans up connections that have gone away', async () => {
    const { a, b, game } = await couple();
    await service.connect('conn-a', a);
    await service.connect('conn-b', b);
    inbox.dead.add('conn-b');
    await service.submitWord(a, { word: routeFor(game)[0]! });
    expect((await store.listConnections(a.code)).map((c) => c.connectionId)).toEqual(['conn-a']);
  });

  it('both partners pressing New Game at once produces one new round', async () => {
    const { a, b } = await couple();
    const [ga, gb] = await Promise.all([service.newRound(a, {}), service.newRound(b, {})]);
    const final = await service.getGame(a);
    expect(final.round).toBe(2);
    expect(new Set([ga.round, gb.round, final.round])).toEqual(new Set([2]));
    expect(final.turn).toBe(b.playerId); // the other player starts the next round
  });
});

describe('pass-the-phone', () => {
  it('alternates turns on one device and credits the right player', async () => {
    const { session, game } = await service.createGame({
      length: 4, difficulty: 'easy', mode: 'pass', name: 'Ama', partnerName: 'Kofi', deviceId: DEVICE_A,
    });
    expect(game.players.map((p) => p.name)).toEqual(['Ama', 'Kofi']);
    expect(game.turnBased).toBe(true);
    const [p1, p2] = game.players.map((p) => p.id);
    const route = routeFor(game);
    const r1 = await service.submitWord(session, { word: route[0]! });
    expect(r1.game.chain[0]!.by).toBe(p1);
    expect(r1.game.turn).toBe(p2);
    const r2 = await service.submitWord(session, { word: nonWord(r1.game) }); // a miss keeps the phone
    expect(r2.game.turn).toBe(p2);
    expect((await service.passTurn(session)).turn).toBe(p1);
    await expect(service.joinGame(session.code, { name: 'x', deviceId: DEVICE_B })).rejects.toMatchObject({ code: 'not_joinable' });
  });
});

describe('hints (server)', () => {
  it('serves all three hint types for the next move and counts them', async () => {
    const { session, game } = await solo(5, 'medium');
    const next = await service.requestHint(session, { type: 'next' });
    if (next.hint.type !== 'next') throw new Error('expected next');
    expect(next.hint.message).toContain(game.start);

    const letter = await service.requestHint(session, { type: 'letter' });
    if (letter.hint.type !== 'letter') throw new Error('expected letter');
    expect(letter.game.revealed[letter.hint.index]).toBe(letter.hint.letter);
    expect(letter.hint.letter).not.toBe(game.start[letter.hint.index]);

    const word = await service.requestHint(session, { type: 'word' });
    if (word.hint.type !== 'word') throw new Error('expected word');
    expect(word.hint.word[letter.hint.index]).toBe(letter.hint.letter); // consistent with the revealed letter
    expect(differsByOne(game.start, word.hint.word)).toBe(true);
    expect(word.game.chain).toEqual([]); // suggested, not written
    expect(word.game.hintsUsed).toBe(3);

    const res = await service.submitWord(session, { word: word.hint.word });
    expect(res.accepted).toBe(true);
    expect(res.game.revealed.every((ch) => ch === null)).toBe(true); // hints are per move
    // Following the hints keeps you on a shortest route.
    expect(routeFor(res.game)).toHaveLength(game.optimalMoves - 1);
    const final = await finish(res.game, [session]);
    await expect(service.requestHint(session, { type: 'word' })).rejects.toMatchObject({ code: 'completed' });
    expect(final.result!.hintsUsed).toBe(3);
  });
});

describe('statistics and recent history', () => {
  it('tracks games, streaks, best time and totals per device', async () => {
    const play = async (complete: boolean) => {
      const { session, game } = await solo();
      if (!complete) return;
      clock += 30_000;
      await finish(game, [session]);
    };
    await play(true);
    await play(true);
    let stats = await service.getStats(DEVICE_A);
    expect(stats).toMatchObject({ gamesPlayed: 2, gamesCompleted: 2, currentStreak: 2, bestStreak: 2, bestTimeMs: 30_000, incorrectSubmissions: 0 });
    expect(stats.totalScore).toBe(stats.bestScore * 2);
    await play(false); // abandoned…
    await play(true); // …so the streak restarts
    stats = await service.getStats(DEVICE_A);
    expect(stats).toMatchObject({ gamesPlayed: 4, gamesCompleted: 3, currentStreak: 1, bestStreak: 2 });
    expect(await service.getStats(DEVICE_B)).toMatchObject({ gamesPlayed: 0, bestTimeMs: null });
  });

  it('does not repeat a puzzle for the same device across 150 new games', async () => {
    const seen = new Set<string>();
    let previous: string[] = [];
    const first = await solo();
    let view = first.game;
    for (let i = 0; i < 150; i++) {
      const key = `${view.start}>${view.target}`;
      if (i < 60) expect(seen.has(key)).toBe(false); // inside the recent-history window
      expect(previous).not.toContain(view.start);
      expect(previous).not.toContain(view.target);
      seen.add(key);
      previous = [view.start, view.target];
      view = await service.newRound(first.session, {});
    }
    expect(seen.size).toBeGreaterThan(140);
  });
});

describe('HTTP layer', () => {
  const call = (method: string, path: string, body?: unknown, session?: Session) =>
    handleHttp(service, {
      method, path, body: body === undefined ? null : typeof body === 'string' ? body : JSON.stringify(body),
      headers: session ? { authorization: `Bearer ${session.playerId}.${session.token}` } : {},
    });

  it('plays a whole game over HTTP, including a take-back', async () => {
    const created = await call('POST', '/games', { length: 4, difficulty: 'easy', mode: 'solo', name: 'Ama', deviceId: DEVICE_A });
    expect(created.status).toBe(201);
    const { session, game } = created.body as SessionResponse;
    const route = routeFor(game);
    expect(await call('POST', `/games/${session.code}/submit`, { word: route[0], after: 0 }, session)).toMatchObject({ status: 200, body: { accepted: true } });
    expect(await call('POST', `/games/${session.code}/undo`, {}, session)).toMatchObject({ status: 200, body: { game: { chain: [] } } });
    for (const [after, word] of route.entries()) {
      const res = await call('POST', `/games/${session.code}/submit`, { word, after }, session);
      expect(res).toMatchObject({ status: 200, body: { accepted: true } });
    }
    const final = await call('GET', `/games/${session.code}`, undefined, session);
    expect((final.body as { game: GameView }).game.status).toBe('completed');
    expect(await call('GET', `/stats/${DEVICE_A}`)).toMatchObject({ status: 200, body: { stats: { gamesCompleted: 1 } } });
  });

  it('rejects malformed input cleanly', async () => {
    const { session } = (await call('POST', '/games', { length: 4, difficulty: 'easy', mode: 'solo', name: '<b>Ama</b>', deviceId: DEVICE_A })).body as SessionResponse;
    expect((await service.getGame(session)).players[0]!.name).toBe('bAma/b');
    expect((await call('POST', '/games', { length: 6, difficulty: 'easy', mode: 'solo', deviceId: DEVICE_A })).status).toBe(400);
    expect((await call('POST', '/games', { length: 4, difficulty: 'easy', mode: 'solo' })).status).toBe(400);
    expect((await call('POST', '/games', '{not json')).status).toBe(400);
    expect((await call('POST', '/games', 'x'.repeat(5000))).status).toBe(413);
    expect((await call('GET', `/games/${session.code}`)).status).toBe(401);
    expect((await call('GET', '/games/nope!!', undefined, session)).status).toBe(400);
    expect((await call('POST', `/games/${session.code}/submit`, { after: -3, word: 'CORD' }, session)).status).toBe(400);
    expect((await call('POST', `/games/${session.code}/submit`, { word: { $ne: 1 } }, session)).status).toBe(400);
    expect((await call('POST', `/games/${session.code}/hint`, { type: 'solution' }, session)).status).toBe(400);
    expect((await call('GET', '/health')).status).toBe(200);
  });

  it('treats a room saved by the old board format as gone', async () => {
    const { session } = await solo();
    const stored = (await store.getGame(session.code))!;
    const legacy = { ...stored, slots: [] } as Record<string, unknown>;
    delete legacy.chain;
    await store.saveGame({ ...(legacy as never as typeof stored), version: stored.version + 1 }, stored.version);
    expect((await call('GET', `/games/${session.code}`, undefined, session)).status).toBe(404);
  });
});

describe('Lambda HTTP handler', () => {
  it('answers a CORS preflight with a 2xx instead of routing it to a 404', async () => {
    const { handler } = await import('../apps/api/src/lambda/http');
    const res = await handler({ rawPath: '/games', headers: {}, requestContext: { http: { method: 'OPTIONS' } } } as never);
    expect(res.statusCode).toBe(204);
  });
});
