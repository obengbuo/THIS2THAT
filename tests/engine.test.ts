import { describe, expect, it } from 'vitest';
import {
  bfs, changedAt, changedIndex, checkStep, clearDraft, computeScore, countShortestPaths, DIFFICULTY, differsByOne, distance, generatePuzzle,
  getGraph, hintFor, HintError, isLadder, moveCursor, newDraft, pairKey, routeToTarget, seededRng, setWord, typeLetter,
} from '@ftt/game-engine';
import { getWordList } from '@ftt/dictionary';

const g4 = getGraph(4);
const g5 = getGraph(5);

describe('dictionary and graph', () => {
  it('keeps 4- and 5-letter words strictly separate', () => {
    for (const length of [4, 5] as const) {
      const list = getWordList(length);
      expect(list.all.length).toBeGreaterThan(2000);
      expect(list.all.every((w) => w.length === length && /^[A-Z]+$/.test(w))).toBe(true);
      expect(list.common.every((w) => list.all.includes(w))).toBe(true);
      expect(list.basic.every((w) => list.common.includes(w))).toBe(true);
    }
  });

  it('connects exactly the words that differ by one letter in place', () => {
    expect(differsByOne('COLD', 'CORD')).toBe(true);
    expect(differsByOne('COLD', 'COLD')).toBe(false);
    expect(differsByOne('COLD', 'CARD')).toBe(false);
    expect(differsByOne('COLD', 'CLOD')).toBe(false); // rearranging is not allowed
    const cold = g4.index.get('COLD')!;
    for (const n of g4.neighbors[cold]!) expect(differsByOne('COLD', g4.words[n]!)).toBe(true);
    expect(g4.neighbors[cold]!.map((n) => g4.words[n])).toContain('CORD');
  });

  it('finds the classic ladders', () => {
    expect(distance(g4, 'COLD', 'WARM')).toBe(4);
    expect(distance(g4, 'TICK', 'PULL')).toBeGreaterThan(0);
    expect(distance(g5, 'STONE', 'STORE')).toBe(1);
  });
});

describe('move validation', () => {
  it('accepts a valid 4-letter ladder one move at a time', () => {
    const ladder = ['COLD'];
    for (const word of ['CORD', 'CARD', 'WARD', 'WARM']) {
      expect(checkStep(g4, ladder, word)).toEqual({ ok: true, word });
      ladder.push(word);
    }
    expect(isLadder(g4, ladder)).toBe(true);
  });

  it('accepts a valid 5-letter ladder', () => {
    const ladder = ['STONE'];
    for (const word of ['STORE', 'SCORE', 'SCARE']) {
      expect(checkStep(g5, ladder, word).ok).toBe(true);
      ladder.push(word);
    }
  });

  it('normalises case and whitespace', () => {
    expect(checkStep(g4, ['COLD'], '  cord ')).toEqual({ ok: true, word: 'CORD' });
  });

  it('rejects strings that are not words', () => {
    expect(checkStep(g4, ['COLD'], 'COLZ')).toMatchObject({ ok: false, code: 'not_a_word' });
  });

  it('rejects words of the wrong length', () => {
    expect(checkStep(g4, ['COLD'], 'COLDS')).toMatchObject({ ok: false, code: 'bad_length' });
    expect(checkStep(g4, ['COLD'], 'COD')).toMatchObject({ ok: false, code: 'bad_length' });
    expect(checkStep(g4, ['COLD'], 'C0RD')).toMatchObject({ ok: false, code: 'bad_length' });
    expect(checkStep(g4, ['COLD'], 42)).toMatchObject({ ok: false, code: 'bad_length' });
  });

  it('rejects changing no letter, more than one letter, or moving letters around', () => {
    expect(checkStep(g4, ['COLD'], 'COLD')).toMatchObject({ ok: false, code: 'not_one_letter' });
    expect(checkStep(g4, ['COLD'], 'CARD')).toMatchObject({ ok: false, code: 'not_one_letter' });
    expect(checkStep(g4, ['COLD'], 'CLOD')).toMatchObject({ ok: false, code: 'not_one_letter' });
  });

  it('only ever compares with the last word on the board', () => {
    // CORD is one letter from COLD (the start) but two from CARE (the last word).
    expect(checkStep(g4, ['COLD', 'CORD', 'CARD', 'CARE'], 'CORE').ok).toBe(true);
    expect(checkStep(g4, ['COLD', 'COLT', 'CULT'], 'CORD')).toMatchObject({ ok: false, code: 'not_one_letter' });
  });

  it('rejects words already on the board', () => {
    expect(checkStep(g4, ['COLD', 'CORD'], 'COLD')).toMatchObject({ ok: false, code: 'already_used' });
    expect(checkStep(g4, ['COLD', 'CORD', 'CARD'], 'CORD')).toMatchObject({ ok: false, code: 'already_used' });
  });

  it('has no hidden answer: every neighbour of the last word is playable', () => {
    const id = g4.index.get('COLD')!;
    for (const n of g4.neighbors[id]!) expect(checkStep(g4, ['COLD'], g4.words[n]!).ok).toBe(true);
  });

  it('recognises legal ladders', () => {
    expect(isLadder(g4, ['COLD', 'CORD', 'CARD', 'WARD', 'WARM'])).toBe(true);
    expect(isLadder(g4, ['COLD', 'CARD'])).toBe(false);
    expect(isLadder(g4, ['COLD', 'CORD', 'COLD'])).toBe(false);
    expect(isLadder(g4, ['COLD', 'COLZ'])).toBe(false);
    expect(changedIndex('COLD', 'CORD')).toBe(2);
  });
});

describe('routes to the target', () => {
  it('finds a shortest way to finish from wherever the ladder is', () => {
    const route = routeToTarget(g4, ['COLD'], 'WARM')!;
    expect(route).toHaveLength(distance(g4, 'COLD', 'WARM'));
    expect(route.at(-1)).toBe('WARM');
    expect(isLadder(g4, ['COLD', ...route])).toBe(true);
    expect(routeToTarget(g4, ['COLD', 'CORD', 'CARD', 'WARD', 'WARM'], 'WARM')).toEqual([]);
  });

  it('never reuses a word already on the board', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const p = generatePuzzle({ length: 4, difficulty: 'medium', rng: seededRng(seed) });
      // Walk two random legal moves, then ask for the way home.
      const rng = seededRng(seed * 31);
      const ladder = [p.start];
      for (let k = 0; k < 2; k++) {
        const options = g4.neighbors[g4.index.get(ladder.at(-1)!)!]!.map((i) => g4.words[i]!).filter((w) => !ladder.includes(w) && w !== p.target);
        if (!options.length) break;
        ladder.push(options[rng(options.length)]!);
      }
      const route = routeToTarget(g4, ladder, p.target);
      if (!route) continue;
      expect(isLadder(g4, [...ladder, ...route])).toBe(true);
      expect(route.at(-1)).toBe(p.target);
    }
  });

  it('reports a dead end when every way forward is used up', () => {
    // A word whose only neighbours are already on the board cannot move on.
    const lonely = g4.words.find((w, i) => g4.neighbors[i]!.length === 1 && w !== 'WARM')!;
    const only = g4.words[g4.neighbors[g4.index.get(lonely)!]![0]!]!;
    expect(routeToTarget(g4, [only, lonely], 'WARM')).toBeNull();
  });
});

describe('puzzle generation', () => {
  for (const length of [4, 5] as const)
    for (const difficulty of ['easy', 'medium', 'hard'] as const)
      it(`generates solvable ${length}-letter ${difficulty} puzzles within spec`, () => {
        const graph = getGraph(length);
        const spec = DIFFICULTY[difficulty];
        const rng = seededRng(length * 100 + difficulty.length);
        for (let i = 0; i < 150; i++) {
          const p = generatePuzzle({ length, difficulty, rng });
          expect(p.fromFallback).toBe(false);
          expect(p.slots).toBeGreaterThanOrEqual(spec.minSlots);
          expect(p.slots).toBeLessThanOrEqual(spec.maxSlots);
          expect(p.start.length).toBe(length);
          expect(p.target.length).toBe(length);
          expect(p.solution).toHaveLength(p.slots + 2);
          expect(p.solution[0]).toBe(p.start);
          expect(p.solution.at(-1)).toBe(p.target);
          expect(isLadder(getGraph(p.length), p.solution)).toBe(true);
          expect(p.solution.every((w) => graph.common[graph.index.get(w)!] === 1)).toBe(true);
          // Slots shown == true shortest distance - 1, so no shorter route exists.
          expect(distance(graph, p.start, p.target)).toBe(p.slots + 1);
          const tier = spec.endpoints === 'basic' ? graph.basic : graph.common;
          expect(tier[graph.index.get(p.start)!] && tier[graph.index.get(p.target)!]).toBe(1);
          expect(p.solutionCount).toBeLessThanOrEqual(spec.maxSolutions);
          const from = bfs(graph, graph.index.get(p.start)!);
          expect(countShortestPaths(graph, from, graph.index.get(p.target)!)).toBe(p.solutionCount);
        }
      });

  it('randomises across repeated games', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 300; i++) {
      const p = generatePuzzle({ length: 4, difficulty: 'medium' });
      seen.add(pairKey(p.start, p.target));
    }
    expect(seen.size).toBeGreaterThan(280);
  });

  it('never repeats recently played pairs and avoids the previous endpoints', () => {
    const recent: string[] = [];
    let last: string[] = [];
    for (let i = 0; i < 200; i++) {
      const p = generatePuzzle({ length: 4, difficulty: 'easy', excludePairs: recent, avoidWords: last });
      expect(recent).not.toContain(pairKey(p.start, p.target));
      expect(recent).not.toContain(pairKey(p.target, p.start));
      expect(last).not.toContain(p.start);
      expect(last).not.toContain(p.target);
      recent.push(pairKey(p.start, p.target));
      last = [p.start, p.target];
    }
  });

  it('falls back to a verified puzzle when generation cannot succeed', () => {
    for (const length of [4, 5] as const)
      for (const difficulty of ['easy', 'medium', 'hard'] as const) {
        const p = generatePuzzle({ length, difficulty, maxAttempts: 0 });
        expect(p.fromFallback).toBe(true);
        expect(isLadder(getGraph(p.length), p.solution)).toBe(true);
        expect(distance(getGraph(length), p.start, p.target)).toBe(p.slots + 1);
      }
  });
});

describe('hints', () => {
  it('each hint type describes the same shortest next move', () => {
    for (let seed = 1; seed <= 30; seed++) {
      const p = generatePuzzle({ length: 4, difficulty: 'medium', rng: seededRng(seed) });
      const next = hintFor(g4, [p.start], p.target, 'next', [], seededRng(seed));
      const letter = hintFor(g4, [p.start], p.target, 'letter', [], seededRng(seed));
      const word = hintFor(g4, [p.start], p.target, 'word', [], seededRng(seed));
      if (next.type !== 'next' || letter.type !== 'letter' || word.type !== 'word') throw new Error('wrong hint types');
      expect(next.index).toBe(word.index);
      expect(letter.index).toBe(word.index);
      expect(word.word[word.index]).toBe(letter.letter);
      expect(checkStep(g4, [p.start], word.word).ok).toBe(true);
      expect(distance(g4, word.word, p.target)).toBe(p.slots); // one move closer
    }
  });

  it('a word hint stays consistent with a letter already revealed', () => {
    for (let seed = 1; seed <= 30; seed++) {
      const p = generatePuzzle({ length: 5, difficulty: 'easy', rng: seededRng(seed) });
      const letter = hintFor(g5, [p.start], p.target, 'letter', [], seededRng(seed));
      if (letter.type !== 'letter') throw new Error('expected letter');
      const revealed = Array<string | null>(5).fill(null);
      revealed[letter.index] = letter.letter;
      const word = hintFor(g5, [p.start], p.target, 'word', revealed, seededRng(seed + 99));
      if (word.type !== 'word') throw new Error('expected word');
      expect(word.word[letter.index]).toBe(letter.letter);
      expect(word.index).toBe(letter.index);
    }
  });

  it('refuses hints on a finished board and explains a dead end', () => {
    expect(() => hintFor(g4, ['COLD', 'CORD'], 'CORD', 'word')).toThrow(HintError);
    const lonely = g4.words.find((w, i) => g4.neighbors[i]!.length === 1 && w !== 'WARM')!;
    const only = g4.words[g4.neighbors[g4.index.get(lonely)!]![0]!]!;
    expect(() => hintFor(g4, [only, lonely], 'WARM', 'next')).toThrow(/Take back/);
  });
});

describe('scoring', () => {
  it('applies penalties and difficulty multipliers', () => {
    expect(computeScore({ difficulty: 'easy', elapsedMs: 0, hintsUsed: 0, wrongAttempts: 0 })).toBe(1000);
    expect(computeScore({ difficulty: 'medium', elapsedMs: 60_000, hintsUsed: 1, wrongAttempts: 2 })).toBe(Math.round((1000 - 30 - 100 - 50) * 1.5));
    expect(computeScore({ difficulty: 'hard', elapsedMs: 0, hintsUsed: 0, wrongAttempts: 0 })).toBe(2000);
  });
  it('charges for moves beyond the fewest possible', () => {
    expect(computeScore({ difficulty: 'easy', elapsedMs: 0, hintsUsed: 0, wrongAttempts: 0, extraMoves: 3 })).toBe(1000 - 90);
    expect(computeScore({ difficulty: 'easy', elapsedMs: 0, hintsUsed: 0, wrongAttempts: 0, extraMoves: -1 })).toBe(1000);
  });
  it('never goes negative', () => {
    expect(computeScore({ difficulty: 'hard', elapsedMs: 9e9, hintsUsed: 50, wrongAttempts: 500 })).toBe(0);
  });
});

describe('drafting a move', () => {
  it('starts as the current word with nothing changed', () => {
    const d = newDraft('SACK');
    expect(d).toEqual({ base: 'SACK', text: 'SACK', cursor: 0 });
    expect(changedAt(d)).toBeNull();
  });

  it('replaces the letter under the cursor', () => {
    const d = typeLetter(moveCursor(newDraft('SACK'), 1), 'o');
    expect(d.text).toBe('SOCK');
    expect(changedAt(d)).toBe(1);
  });

  it('only ever changes one letter: a second change puts the first back', () => {
    let d = typeLetter(moveCursor(newDraft('SACK'), 1), 'O');
    d = typeLetter(moveCursor(d, 0), 'B');
    expect(d.text).toBe('BACK');
    expect(changedAt(d)).toBe(0);
    d = typeLetter(d, 'S'); // typing the original letter back is no change at all
    expect(d.text).toBe('SACK');
    expect(changedAt(d)).toBeNull();
  });

  it('keeps the cursor on the word and ignores non-letters', () => {
    expect(moveCursor(newDraft('SACK'), 9).cursor).toBe(3);
    expect(moveCursor(newDraft('SACK'), -2).cursor).toBe(0);
    expect(typeLetter(newDraft('SACK'), '1').text).toBe('SACK');
    expect(typeLetter(newDraft('SACK'), '<b>').text).toBe('SACK');
  });

  it('clears back to the current word and loads a suggested word', () => {
    const d = typeLetter(newDraft('SACK'), 'B');
    expect(clearDraft(d).text).toBe('SACK');
    expect(setWord(newDraft('SACK'), 'sick')).toMatchObject({ text: 'SICK', cursor: 1 });
    expect(setWord(newDraft('SACK'), 'BOYS').text).toBe('SACK'); // not one letter away: ignored
    expect(setWord(newDraft('SACK'), 'SACKS').text).toBe('SACK');
  });
});
