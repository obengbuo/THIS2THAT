import { beforeEach, describe, expect, it } from 'vitest';
import { GameService, handleHttp, MemoryStore, type Broadcaster } from '@ftt/api';
import { candidatesFor, getGraph, isComplete, solve, type Chain } from '@ftt/game-engine';
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

const chainOf = (g: GameView): Chain => [g.start, ...g.slots.map((s) => s.word), g.target];
/** A full valid solution for the game's current locked state. */
const solutionFor = (g: GameView) => solve(getGraph(g.length), chainOf(g))!.slice(1, -1);

async function couple(opts: { turnBased?: boolean } = {}) {
  const a = await service.createGame({ length: 4, difficulty: 'medium', mode: 'couples', name: 'Ama', deviceId: DEVICE_A, ...opts });
  const b = await service.joinGame(a.session.code, { name: 'Kofi', deviceId: DEVICE_B });
  return { a: a.session, b: b.session, game: b.game };
}

describe('solo game flow', () => {
  it('creates a solvable game without exposing the solution', async () => {
    const { game, session } = await service.createGame({ length: 5, difficulty: 'easy', mode: 'solo', name: 'Ama', deviceId: DEVICE_A });
    expect(session.code).toMatch(/^[A-Z2-9]{6}$/);
    expect(game.length).toBe(5);
    expect(game.slots.every((s) => s.word === null)).toBe(true);
    expect(JSON.stringify(game)).not.toContain('solution');
    expect(solve(getGraph(5), chainOf(game))).not.toBeNull();
  });

  it('locks correct words, rejects wrong ones, and detects completion', async () => {
    const { game, session } = await service.createGame({ length: 4, difficulty: 'easy', mode: 'solo', name: 'Ama', deviceId: DEVICE_A });
    const words = solutionFor(game);

    const bad = await service.submitWord(session, { slot: 0, word: 'ZZZZ' });
    expect(bad).toMatchObject({ accepted: false, code: 'not_a_word', message: 'Not a valid English word.' });
    expect(bad.game.slots[0]!.word).toBeNull();
    expect(bad.game.wrongAttempts).toBe(1);

    clock += 20_000;
    let view = game;
    for (const [slot, word] of words.entries()) {
      const res = await service.submitWord(session, { slot, word: word.toLowerCase() });
      expect(res.accepted).toBe(true);
      view = res.game;
      expect(view.slots[slot]).toMatchObject({ word, lockedBy: session.playerId });
    }
    expect(view.status).toBe('completed');
    expect(isComplete(chainOf(view))).toBe(true);
    expect(view.result).toMatchObject({ elapsedMs: 20_000, wrongAttempts: 1, hintsUsed: 0, correctSubmissions: words.length });
    expect(view.result!.score).toBe(1000 - 10 - 25);

    const after = await service.submitWord(session, { slot: 0, word: words[0]! }).catch((e) => e);
    expect(after).toMatchObject({ code: 'completed' });
  });

  it('accepts any valid solution path, in any order', async () => {
    const { game, session } = await service.createGame({ length: 4, difficulty: 'hard', mode: 'solo', name: 'Ama', deviceId: DEVICE_A });
    const graph = getGraph(4);
    let view = game;
    // Fill from the bottom up, choosing the LAST legal candidate each time.
    for (let slot = view.slots.length - 1; slot >= 0; slot--) {
      const options = candidatesFor(graph, chainOf(view), slot + 1);
      const res = await service.submitWord(session, { slot, word: options.at(-1)! });
      expect(res.accepted).toBe(true);
      view = res.game;
    }
    expect(view.status).toBe('completed');
  });
});

describe('permanent locking (server)', () => {
  it('never lets a locked word be changed, by anyone', async () => {
    const { a, b, game } = await couple();
    const graph = getGraph(4);
    const options = candidatesFor(graph, chainOf(game), 1);
    const first = await service.submitWord(a, { slot: 0, word: options[0]! });
    expect(first.accepted).toBe(true);

    // A different real word for the same slot — even another valid candidate — is refused.
    const other = options[1] ?? 'WORD';
    for (const who of [a, b]) {
      const res = await service.submitWord(who, { slot: 0, word: other });
      expect(res).toMatchObject({ accepted: false, code: 'slot_locked' });
      expect(res.game.slots[0]).toMatchObject({ word: options[0], lockedBy: a.playerId });
      expect(res.game.wrongAttempts).toBe(0); // not counted as a mistake
    }
    // Re-submitting the identical word is an idempotent success, not a second lock.
    const again = await service.submitWord(b, { slot: 0, word: options[0]! });
    expect(again.accepted).toBe(true);
    expect(again.game.correctSubmissions).toBe(1);
    expect(again.game.slots[0]!.lockedBy).toBe(a.playerId);
  });

  it('exposes no HTTP route that edits, clears, undoes or resets a slot', async () => {
    const { session, game } = await service.createGame({ length: 4, difficulty: 'easy', mode: 'solo', name: 'Ama', deviceId: DEVICE_A });
    const word = solutionFor(game)[0]!;
    await service.submitWord(session, { slot: 0, word });
    const headers = { authorization: `Bearer ${session.playerId}.${session.token}` };
    for (const [method, action] of [['POST', 'reset'], ['POST', 'undo'], ['DELETE', 'submit'], ['PUT', 'submit'], ['POST', 'unlock'], ['PATCH', '']] as const) {
      const res = await handleHttp(service, { method, path: `/games/${session.code}/${action}`, headers, body: JSON.stringify({ slot: 0 }) });
      expect(res.status).toBe(404);
    }
    expect((await service.getGame(session)).slots[0]!.word).toBe(word);
  });

  it('only a new game clears the board', async () => {
    const { session, game } = await service.createGame({ length: 4, difficulty: 'easy', mode: 'solo', name: 'Ama', deviceId: DEVICE_A });
    await service.submitWord(session, { slot: 0, word: solutionFor(game)[0]! });
    const next = await service.newRound(session, {});
    expect(next.round).toBe(2);
    expect(next.slots.every((s) => s.word === null)).toBe(true);
    expect([next.start, next.target]).not.toContain(game.start);
    expect([next.start, next.target]).not.toContain(game.target);
  });
});

describe('couples multiplayer', () => {
  it('requires a valid session for every action', async () => {
    const { a, game } = await couple();
    const word = solutionFor(game)[0]!;
    const forged: Session = { ...a, token: 'x'.repeat(43) };
    await expect(service.submitWord(forged, { slot: 0, word })).rejects.toMatchObject({ status: 401 });
    await expect(service.getGame({ ...a, playerId: 'nobody' })).rejects.toMatchObject({ status: 401 });
    await expect(service.connect('c1', { code: a.code, playerId: a.playerId, token: 'nope' })).rejects.toMatchObject({ status: 401 });
    await expect(service.joinGame(a.code, { name: 'Third', deviceId: 'device-cccccccccccccccc' })).rejects.toMatchObject({ code: 'room_full' });
    await expect(service.joinGame('ZZZZZZ', { name: 'x', deviceId: DEVICE_B })).rejects.toMatchObject({ status: 404 });
    expect((await service.getGame(a)).slots[0]!.word).toBeNull();
  });

  it('pushes locked words to the other player in real time', async () => {
    const { a, b, game } = await couple();
    await service.connect('conn-a', a);
    await service.connect('conn-b', b);
    await service.message('conn-b', JSON.stringify({ type: 'hello' }));
    expect(inbox.lastState('conn-a')!.players.map((p) => p.connected)).toEqual([true, true]);

    const word = solutionFor(game)[0]!;
    await service.submitWord(a, { slot: 0, word });
    const pushed = inbox.last('conn-b');
    expect(pushed).toMatchObject({ type: 'state', event: { kind: 'locked', slot: 0, playerId: a.playerId } });
    expect(inbox.lastState('conn-b')!.slots[0]).toMatchObject({ word, lockedBy: a.playerId });
  });

  it('relays live drafts and reactions to the partner only, and drops junk', async () => {
    const { a, b } = await couple();
    await service.connect('conn-a', a);
    await service.connect('conn-b', b);
    await service.message('conn-a', JSON.stringify({ type: 'draft', slot: 1, text: 'cor' }));
    expect(inbox.last('conn-b')).toEqual({ type: 'draft', playerId: a.playerId, slot: 1, text: 'COR' });
    expect(inbox.messages.get('conn-a')).toBeUndefined();
    await service.message('conn-a', JSON.stringify({ type: 'reaction', emoji: '❤️' }));
    expect(inbox.last('conn-b')).toEqual({ type: 'reaction', playerId: a.playerId, emoji: '❤️' });
    const count = inbox.messages.get('conn-b')!.length;
    for (const junk of ['not json', '{"type":"draft","slot":1,"text":"<script>"}', '{"type":"reaction","emoji":"<b>"}', '{"type":"state"}', 'x'.repeat(2000)])
      await service.message('conn-a', junk);
    expect(inbox.messages.get('conn-b')!.length).toBe(count);
  });

  it('resolves two players racing for the same slot: exactly one lock wins', async () => {
    for (let run = 0; run < 25; run++) {
      const { a, b, game } = await couple();
      const options = candidatesFor(getGraph(4), chainOf(game), 1);
      const [wa, wb] = [options[0]!, options[1] ?? options[0]!];
      const [ra, rb] = await Promise.all([service.submitWord(a, { slot: 0, word: wa }), service.submitWord(b, { slot: 0, word: wb })]);
      const final = await service.getGame(a);
      const locked = final.slots[0]!;
      expect([wa, wb]).toContain(locked.word);
      if (wa !== wb) {
        expect([ra.accepted, rb.accepted].filter(Boolean)).toHaveLength(1);
        const winner = ra.accepted ? a : b;
        expect(locked.lockedBy).toBe(winner.playerId);
        expect(locked.word).toBe(ra.accepted ? wa : wb);
        const loser = ra.accepted ? rb : ra;
        expect(loser).toMatchObject({ accepted: false, code: 'slot_locked' });
      }
      expect(final.correctSubmissions).toBe(1);
      expect(final.wrongAttempts).toBe(0);
    }
  });

  it('keeps every update when both players lock different slots at once', async () => {
    for (let run = 0; run < 25; run++) {
      const { a, b, game } = await couple();
      const words = solutionFor(game);
      const lastSlot = words.length - 1;
      const [ra, rb] = await Promise.all([
        service.submitWord(a, { slot: 0, word: words[0]! }),
        service.submitWord(b, { slot: lastSlot, word: words[lastSlot]! }),
      ]);
      expect(ra.accepted && rb.accepted).toBe(true);
      const final = await service.getGame(b);
      expect(final.slots[0]).toMatchObject({ word: words[0], lockedBy: a.playerId });
      expect(final.slots[lastSlot]).toMatchObject({ word: words[lastSlot], lockedBy: b.playerId });
      expect(final.correctSubmissions).toBe(2);
    }
  });

  it('a concurrent lock that would make the other word impossible is re-validated', async () => {
    // Both race with words for ADJACENT slots taken from different routes where possible;
    // whatever happens, the final board must remain solvable.
    for (let run = 0; run < 25; run++) {
      const { a, b, game } = await couple();
      const graph = getGraph(4);
      const c1 = candidatesFor(graph, chainOf(game), 1);
      const c2 = candidatesFor(graph, chainOf(game), 2);
      await Promise.all([
        service.submitWord(a, { slot: 0, word: c1[run % c1.length]! }),
        service.submitWord(b, { slot: 1, word: c2[(run * 7) % c2.length]! }),
      ]);
      const final = await service.getGame(a);
      expect(solve(graph, chainOf(final))).not.toBeNull();
    }
  });

  it('lets a disconnected player reconnect and resume the same board', async () => {
    const { a, b, game } = await couple();
    await service.connect('conn-a', a);
    await service.connect('conn-b1', b);
    const words = solutionFor(game);
    await service.submitWord(b, { slot: 0, word: words[0]! });

    await service.disconnect('conn-b1');
    expect(inbox.lastState('conn-a')!.players.find((p) => p.id === b.playerId)!.connected).toBe(false);
    await service.submitWord(a, { slot: 1, word: words[1]! }); // partner keeps playing meanwhile

    await service.connect('conn-b2', b);
    await service.message('conn-b2', JSON.stringify({ type: 'hello' }));
    const resumed = inbox.lastState('conn-b2')!;
    expect(resumed.slots.slice(0, 2).map((s) => s.word)).toEqual(words.slice(0, 2));
    expect(resumed.players.every((p) => p.connected)).toBe(true);
    expect((await service.getGame(b)).slots[0]!.lockedBy).toBe(b.playerId);
  });

  it('cleans up connections that have gone away', async () => {
    const { a, b, game } = await couple();
    await service.connect('conn-a', a);
    await service.connect('conn-b', b);
    inbox.dead.add('conn-b');
    await service.submitWord(a, { slot: 0, word: solutionFor(game)[0]! });
    expect((await store.listConnections(a.code)).map((c) => c.connectionId)).toEqual(['conn-a']);
  });

  it('enforces turns in turn-based mode', async () => {
    const { a, b, game } = await couple({ turnBased: true });
    expect(game.turn).toBe(a.playerId);
    const words = solutionFor(game);
    await expect(service.submitWord(b, { slot: 0, word: words[0]! })).rejects.toMatchObject({ code: 'not_your_turn' });
    const r1 = await service.submitWord(a, { slot: 0, word: words[0]! });
    expect(r1.game.turn).toBe(b.playerId);
    await expect(service.passTurn(a)).rejects.toMatchObject({ code: 'not_your_turn' });
    expect((await service.passTurn(b)).turn).toBe(a.playerId);
  });

  it('both partners pressing New Game at once produces one new round', async () => {
    const { a, b } = await couple();
    const [ga, gb] = await Promise.all([service.newRound(a, {}), service.newRound(b, {})]);
    const final = await service.getGame(a);
    expect(final.round).toBe(2);
    expect(new Set([ga.round, gb.round, final.round])).toEqual(new Set([2]));
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
    const words = solutionFor(game);
    const r1 = await service.submitWord(session, { slot: 0, word: words[0]! });
    expect(r1.game.slots[0]!.lockedBy).toBe(p1);
    expect(r1.game.turn).toBe(p2);
    const r2 = await service.submitWord(session, { slot: 1, word: 'ZZZZ' }); // a miss also passes the phone
    expect(r2.game.turn).toBe(p1);
    expect((await service.passTurn(session)).turn).toBe(p2);
    await expect(service.joinGame(session.code, { name: 'x', deviceId: DEVICE_B })).rejects.toMatchObject({ code: 'not_joinable' });
  });
});

describe('hints (server)', () => {
  it('serves all three hint types and counts them', async () => {
    const { session, game } = await service.createGame({ length: 5, difficulty: 'medium', mode: 'solo', name: 'Ama', deviceId: DEVICE_A });
    const graph = getGraph(5);
    const next = await service.requestHint(session, { type: 'next' });
    expect(next.hint.type).toBe('next');

    const letter = await service.requestHint(session, { type: 'letter', slot: 1 });
    if (letter.hint.type !== 'letter') throw new Error('expected letter');
    expect(letter.game.slots[1]!.revealed[letter.hint.index]).toBe(letter.hint.letter);

    const word = await service.requestHint(session, { type: 'word', slot: 1 });
    if (word.hint.type !== 'word') throw new Error('expected word');
    expect(word.hint.word[letter.hint.index]).toBe(letter.hint.letter); // consistent with the revealed letter
    expect(word.game.slots[1]!.word).toBeNull(); // suggested, not locked
    expect(candidatesFor(graph, chainOf(game), 2)).toContain(word.hint.word);
    expect(word.game.hintsUsed).toBe(3);

    const res = await service.submitWord(session, { slot: 1, word: word.hint.word });
    expect(res.accepted).toBe(true);
    await expect(service.requestHint(session, { type: 'word', slot: 1 })).rejects.toMatchObject({ code: 'no_hint' });
  });
});

describe('statistics and recent history', () => {
  it('tracks games, streaks, best time and totals per device', async () => {
    const play = async (finish: boolean) => {
      const { session, game } = await service.createGame({ length: 4, difficulty: 'easy', mode: 'solo', name: 'Ama', deviceId: DEVICE_A });
      if (!finish) return;
      clock += 30_000;
      for (const [slot, word] of solutionFor(game).entries()) await service.submitWord(session, { slot, word });
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
    const first = await service.createGame({ length: 4, difficulty: 'easy', mode: 'solo', name: 'Ama', deviceId: DEVICE_A });
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

  it('plays a whole game over HTTP', async () => {
    const created = await call('POST', '/games', { length: 4, difficulty: 'easy', mode: 'solo', name: 'Ama', deviceId: DEVICE_A });
    expect(created.status).toBe(201);
    const { session, game } = created.body as SessionResponse;
    for (const [slot, word] of solutionFor(game).entries()) {
      const res = await call('POST', `/games/${session.code}/submit`, { slot, word }, session);
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
    expect((await call('POST', `/games/${session.code}/submit`, { slot: 99, word: 'CORD' }, session)).status).toBe(400);
    expect((await call('POST', `/games/${session.code}/submit`, { slot: 0, word: { $ne: 1 } }, session)).status).toBe(400);
    expect((await call('POST', `/games/${session.code}/hint`, { type: 'solution' }, session)).status).toBe(400);
    expect((await call('GET', '/health')).status).toBe(200);
  });
});
