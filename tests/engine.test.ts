import { describe, expect, it } from 'vitest';
import {
  applyLocks, backspace, bfs, candidatesFor, checkPlacement, computeScore, countShortestPaths, createBoard, DIFFICULTY, differsByOne,
  distance, generatePuzzle, getGraph, isChainConsistent, isComplete, nextMove, pairKey, resetDrafts, revealLetter, seededRng, setDraft,
  solve, suggestWord, typeLetter, undo, type Chain,
} from '@ftt/game-engine';
import { getWordList } from '@ftt/dictionary';

const g4 = getGraph(4);
const g5 = getGraph(5);
const board = (start: string, slots: number, target: string): Chain => [start, ...Array<null>(slots).fill(null), target];

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

describe('word validation', () => {
  it('accepts a valid 4-letter ladder in order', () => {
    const chain = board('COLD', 3, 'WARM');
    for (const [i, w] of ['CORD', 'CARD', 'WARD'].entries()) {
      const r = checkPlacement(g4, chain, i + 1, w);
      expect(r).toEqual({ ok: true, word: w });
      chain[i + 1] = w;
    }
    expect(isComplete(chain)).toBe(true);
  });

  it('accepts a valid 5-letter ladder', () => {
    const p = generatePuzzle({ length: 5, difficulty: 'medium', rng: seededRng(7) });
    const chain = board(p.start, p.slots, p.target);
    p.solution.slice(1, -1).forEach((w, i) => {
      expect(checkPlacement(g5, chain, i + 1, w).ok).toBe(true);
      chain[i + 1] = w;
    });
    expect(isComplete(chain)).toBe(true);
  });

  it('normalises case and whitespace', () => {
    expect(checkPlacement(g4, board('COLD', 3, 'WARM'), 1, ' cord ')).toEqual({ ok: true, word: 'CORD' });
  });

  it('rejects words that are not in the dictionary', () => {
    expect(checkPlacement(g4, board('COLD', 3, 'WARM'), 1, 'COLX')).toMatchObject({ ok: false, code: 'not_a_word' });
  });

  it('rejects words of the wrong length', () => {
    const chain = board('COLD', 3, 'WARM');
    for (const w of ['COR', 'CORDS', '', 'C0RD', 42, null])
      expect(checkPlacement(g4, chain, 1, w)).toMatchObject({ ok: false, code: 'bad_length' });
  });

  it('rejects changes of more than one letter next to a fixed word', () => {
    const r = checkPlacement(g4, board('COLD', 3, 'WARM'), 1, 'CARD');
    expect(r).toMatchObject({ ok: false, code: 'not_one_letter' });
    expect(checkPlacement(g4, board('COLD', 3, 'WARM'), 3, 'CARD')).toMatchObject({ ok: false, code: 'not_one_letter' });
  });

  it('rejects repeated words', () => {
    const chain = board('COLD', 3, 'WARM');
    chain[1] = 'CORD';
    expect(checkPlacement(g4, chain, 2, 'CORD')).toMatchObject({ ok: false, code: 'already_used' });
    expect(checkPlacement(g4, chain, 2, 'COLD')).toMatchObject({ ok: false, code: 'already_used' });
  });

  it('rejects a real, adjacent word that cannot lead to the target (wrong position)', () => {
    // BOLD is one letter from COLD but no 3-step route continues from it to WARM.
    expect(checkPlacement(g4, board('COLD', 3, 'WARM'), 1, 'BOLD')).toMatchObject({ ok: false, code: 'wrong_position' });
    // CARD belongs in the middle slot, not the first or last.
    expect(checkPlacement(g4, board('COLD', 3, 'WARM'), 2, 'CARD').ok).toBe(true);
    // WARD is right for slot 3 but placed in slot 2 it cannot work.
    expect(checkPlacement(g4, board('COLD', 3, 'WARM'), 2, 'WARD')).toMatchObject({ ok: false, code: 'wrong_position' });
  });

  it('rejects slots outside the board and locked slots', () => {
    const chain = board('COLD', 3, 'WARM');
    for (const pos of [0, 4, -1, 9, 1.5]) expect(checkPlacement(g4, chain, pos, 'CORD')).toMatchObject({ ok: false, code: 'bad_slot' });
    chain[1] = 'CORD';
    expect(checkPlacement(g4, chain, 1, 'CORD')).toMatchObject({ ok: false, code: 'slot_locked' });
  });

  it('accepts alternative solution paths, not one hidden answer', () => {
    const chain = board('COLD', 3, 'WARM');
    const first = candidatesFor(g4, chain, 1);
    expect(first).toContain('CORD');
    expect(first.length).toBeGreaterThan(1); // e.g. CORD or WOLD
    for (const option of first) {
      const branch = [...chain];
      expect(checkPlacement(g4, branch, 1, option).ok).toBe(true);
      branch[1] = option;
      const solved = solve(g4, branch);
      expect(solved && isComplete(solved)).toBe(true);
    }
  });

  it('supports solving bottom-up and from the middle', () => {
    const chain = board('COLD', 3, 'WARM');
    expect(checkPlacement(g4, chain, 3, 'WARD').ok).toBe(true);
    chain[3] = 'WARD';
    expect(checkPlacement(g4, chain, 1, 'CORD').ok).toBe(true);
    chain[1] = 'CORD';
    expect(candidatesFor(g4, chain, 2)).toEqual(['CARD', 'WORD']); // two valid routes remain

    const middle = board('COLD', 3, 'WARM');
    expect(checkPlacement(g4, middle, 2, 'CARD').ok).toBe(true);
    middle[2] = 'CARD';
    expect(candidatesFor(g4, middle, 1)).toEqual(['CORD']);
    // WOLD starts a valid route (WOLD→WORD→WARD) but no longer fits once CARD is fixed.
    expect(checkPlacement(g4, middle, 1, 'WOLD')).toMatchObject({ ok: false });
  });

  it('every candidate keeps the puzzle solvable; every non-candidate is rejected', () => {
    const rng = seededRng(99);
    for (let n = 0; n < 40; n++) {
      const p = generatePuzzle({ length: n % 2 ? 4 : 5, difficulty: (['easy', 'medium', 'hard'] as const)[n % 3]!, rng });
      const graph = getGraph(p.length);
      const chain = board(p.start, p.slots, p.target);
      const pos = 1 + rng(p.slots);
      const ok = new Set(candidatesFor(graph, chain, pos));
      expect(ok.has(p.solution[pos]!)).toBe(true);
      for (const w of ok) {
        const next = [...chain];
        next[pos] = w;
        expect(isChainConsistent(graph, next)).toBe(true);
        expect(solve(graph, next)).not.toBeNull();
      }
      const stranger = graph.words.find((w) => !ok.has(w) && !chain.includes(w))!;
      expect(checkPlacement(graph, chain, pos, stranger).ok).toBe(false);
    }
  });

  it('detects completion only for a full, legal ladder', () => {
    expect(isComplete(['COLD', 'CORD', 'CARD', 'WARD', 'WARM'])).toBe(true);
    expect(isComplete(['COLD', 'CORD', null, 'WARD', 'WARM'])).toBe(false);
    expect(isComplete(['COLD', 'CORD', 'WORD', 'WARD', 'WARM'])).toBe(true); // alternative route
    expect(isComplete(['COLD', 'CORD', 'CORD', 'WARD', 'WARM'])).toBe(false);
    expect(isComplete(['COLD', 'BOLD', 'CARD', 'WARD', 'WARM'])).toBe(false);
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
          expect(isComplete(p.solution)).toBe(true);
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
        expect(isComplete(p.solution)).toBe(true);
        expect(distance(getGraph(length), p.start, p.target)).toBe(p.slots + 1);
      }
  });
});

describe('hints', () => {
  const rng = seededRng(5);
  it('next move points at a slot touching a fixed word', () => {
    const hint = nextMove(g4, board('COLD', 3, 'WARM'));
    expect([0, 2]).toContain(hint.slot);
    expect(['COLD', 'WARM']).toContain(hint.anchor);
  });

  it('word suggestions are always lockable and keep the puzzle solvable', () => {
    for (let n = 0; n < 60; n++) {
      const p = generatePuzzle({ length: n % 2 ? 4 : 5, difficulty: 'hard', rng });
      const graph = getGraph(p.length);
      const chain = board(p.start, p.slots, p.target);
      // Lock a couple of words from the middle first so hints must respect them.
      const mid = 1 + rng(p.slots);
      chain[mid] = p.solution[mid]!;
      while (chain.includes(null)) {
        const hint = suggestWord(graph, chain, undefined, [], rng);
        expect(checkPlacement(graph, chain, hint.slot + 1, hint.word).ok).toBe(true);
        chain[hint.slot + 1] = hint.word;
        expect(solve(graph, chain)).not.toBeNull();
      }
      expect(isComplete(chain)).toBe(true);
    }
  });

  it('letter reveals stay consistent with each other and with a valid word', () => {
    const chain = board('COLD', 3, 'WARM');
    const revealed: (string | null)[][] = chain.map(() => [null, null, null, null]);
    for (let i = 0; i < 4; i++) {
      const hint = revealLetter(g4, chain, 2, revealed, rng);
      expect(hint.slot).toBe(1);
      expect(revealed[2]![hint.index]).toBeNull();
      revealed[2]![hint.index] = hint.letter;
    }
    const word = revealed[2]!.join('');
    expect(checkPlacement(g4, chain, 2, word).ok).toBe(true);
    expect(() => revealLetter(g4, chain, 2, revealed, rng)).toThrow();
  });

  it('refuses hints for locked slots', () => {
    const chain = board('COLD', 3, 'WARM');
    chain[1] = 'CORD';
    expect(() => suggestWord(g4, chain, 1)).toThrow();
    expect(() => revealLetter(g4, chain, 1)).toThrow();
    expect(() => nextMove(g4, ['COLD', 'CORD', 'CARD', 'WARD', 'WARM'])).toThrow();
  });
});

describe('scoring', () => {
  it('applies penalties and difficulty multipliers', () => {
    expect(computeScore({ difficulty: 'easy', elapsedMs: 0, hintsUsed: 0, wrongAttempts: 0 })).toBe(1000);
    expect(computeScore({ difficulty: 'medium', elapsedMs: 60_000, hintsUsed: 1, wrongAttempts: 2 })).toBe(Math.round((1000 - 30 - 100 - 50) * 1.5));
    expect(computeScore({ difficulty: 'hard', elapsedMs: 0, hintsUsed: 0, wrongAttempts: 0 })).toBe(2000);
  });
  it('never goes negative', () => {
    expect(computeScore({ difficulty: 'hard', elapsedMs: 9e9, hintsUsed: 50, wrongAttempts: 500 })).toBe(0);
  });
});

describe('whiteboard drafts and permanent locks', () => {
  const start = () => applyLocks(createBoard(4, 3), ['CORD', null, null]);

  it('locked words cannot be typed over, erased, or replaced', () => {
    let b = start();
    expect(b.slots[0]).toEqual({ text: 'CORD', locked: true });
    b = typeLetter(b, 0, 'X');
    b = backspace(b, 0);
    b = setDraft(b, 0, 'WORD');
    b = setDraft(b, 0, '');
    expect(b.slots[0]).toEqual({ text: 'CORD', locked: true });
  });

  it('reset clears drafts only', () => {
    let b = setDraft(start(), 1, 'CARD');
    b = setDraft(b, 2, 'WA');
    b = resetDrafts(b);
    expect(b.slots.map((s) => s.text)).toEqual(['CORD', '', '']);
    expect(b.slots[0]!.locked).toBe(true);
  });

  it('undo reverts drafts but never removes a locked word', () => {
    let b = createBoard(4, 3);
    b = setDraft(b, 0, 'CORD');
    b = typeLetter(b, 1, 'C');
    b = applyLocks(b, ['CORD', null, null]); // the server accepted CORD
    for (let i = 0; i < 10; i++) b = undo(b);
    expect(b.slots[0]).toEqual({ text: 'CORD', locked: true });
    expect(b.slots[1]!.text).toBe('');
  });

  it('locks are one-way even if a stale server state arrives', () => {
    const b = applyLocks(start(), [null, null, null]);
    expect(b.slots[0]).toEqual({ text: 'CORD', locked: true });
  });

  it('drafts are sanitised to letters of the right length', () => {
    const b = setDraft(createBoard(4, 1), 0, 'c0r<d>s!x');
    expect(b.slots[0]!.text).toBe('CRDS');
  });
});
