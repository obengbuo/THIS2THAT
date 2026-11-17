import type { RejectCode } from '@ftt/shared-types';
import { differsByOne, type WordGraph } from './graph';

/**
 * The ladder so far: words[0] is the start word and every later word was written by a
 * player. The rules of a move are simple and local:
 *
 *   - it is a real word of the right length,
 *   - it differs from the word before it by exactly one letter, in place,
 *   - it has not been written on this board before.
 *
 * There is no hidden answer and no fixed number of moves: any route that reaches the
 * target wins. Because words cannot repeat a route can run into a dead end; taking the
 * last word back is always possible.
 */
export type Ladder = string[];

export type Placement =
  | { ok: true; word: string }
  | { ok: false; code: RejectCode; message: string };

const reject = (code: RejectCode, message: string): Placement => ({ ok: false, code, message });

export function normalizeWord(input: unknown): string {
  return typeof input === 'string' ? input.trim().toUpperCase() : '';
}

/** Checks one move: may `input` be written after the last word of `words`? */
export function checkStep(graph: WordGraph, words: Ladder, input: unknown): Placement {
  const word = normalizeWord(input);
  const previous = words.at(-1)!;
  if (word.length !== graph.length || !/^[A-Z]+$/.test(word))
    return reject('bad_length', `Words need exactly ${graph.length} letters.`);
  if (word === previous) return reject('not_one_letter', `Change one letter of ${previous} first.`);
  if (!differsByOne(previous, word)) return reject('not_one_letter', `Change exactly one letter of ${previous}.`);
  if (!graph.index.has(word)) return reject('not_a_word', `${word} is not a word we know.`);
  if (words.includes(word)) return reject('already_used', `${word} is already on the board.`);
  return { ok: true, word };
}

/** True when `words` is a legal ladder: real words, one letter apart, no repeats. */
export function isLadder(graph: WordGraph, words: Ladder): boolean {
  if (words.length === 0 || new Set(words).size !== words.length) return false;
  if (!words.every((w) => graph.index.has(w))) return false;
  for (let i = 0; i + 1 < words.length; i++) if (!differsByOne(words[i]!, words[i + 1]!)) return false;
  return true;
}

/**
 * The shortest way to finish the ladder from its last word without reusing a word:
 * returns the words still to write (ending with `target`), an empty list if the ladder
 * already ends on the target, or null if it has run into a dead end. Prefers familiar
 * words; `choose` picks among equally good next words (default: the first).
 */
export function routeToTarget(graph: WordGraph, words: Ladder, target: string, choose: (n: number) => number = () => 0): string[] | null {
  const from = graph.index.get(words.at(-1)!);
  const goal = graph.index.get(target);
  if (from === undefined || goal === undefined) return null;
  if (from === goal) return [];
  const blocked = new Set(words.slice(0, -1).map((w) => graph.index.get(w)));
  if (blocked.has(goal)) return null;

  // Distances to the target over words that are still available.
  const dist = new Int16Array(graph.words.length).fill(-1);
  dist[goal] = 0;
  const queue = [goal];
  for (let head = 0; head < queue.length && dist[from] === -1; head++) {
    const u = queue[head]!;
    for (const v of graph.neighbors[u]!) {
      if (dist[v] !== -1 || blocked.has(v)) continue;
      dist[v] = dist[u]! + 1;
      queue.push(v);
    }
  }
  if (dist[from] === -1) return null;

  const route: string[] = [];
  for (let node = from; node !== goal; ) {
    const closer = graph.neighbors[node]!.filter((v) => dist[v] === dist[node]! - 1);
    const familiar = closer.filter((v) => graph.common[v]);
    const pool = familiar.length ? familiar : closer;
    node = pool[choose(pool.length)]!;
    route.push(graph.words[node]!);
  }
  return route;
}

/** Zero-based position of the single letter that differs between two adjacent words. */
export function changedIndex(a: string, b: string): number {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return i;
  return -1;
}
