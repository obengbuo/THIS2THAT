import type { RejectCode } from '@ftt/shared-types';
import { bfs, differsByOne, type WordGraph } from './graph';

/**
 * A chain is the full ladder including both ends:
 *   chain[0] = start, chain[chain.length-1] = target, everything between is a slot
 *   holding either a LOCKED word or null.
 *
 * Invariant used throughout: the number of steps (chain.length - 1) equals the
 * shortest-path distance between start and target. Therefore every complete solution
 * is a shortest path, every segment between two fixed words must itself be a shortest
 * path, and a word W fits position i exactly when
 *
 *     dist(previous fixed word, W) == i - p   and   dist(W, next fixed word) == q - i
 *
 * This accepts ANY valid solution (not one hidden answer) and never lets a player lock
 * a word that would make the puzzle impossible to finish.
 */
export type Chain = (string | null)[];

export type Placement =
  | { ok: true; word: string }
  | { ok: false; code: RejectCode; message: string };

const reject = (code: RejectCode, message: string): Placement => ({ ok: false, code, message });

export function normalizeWord(input: unknown): string {
  return typeof input === 'string' ? input.trim().toUpperCase() : '';
}

/** Nearest fixed positions on either side of `position`. */
export function anchorsAround(chain: Chain, position: number): { p: number; q: number } {
  let p = position - 1;
  while (p > 0 && chain[p] === null) p--;
  let q = position + 1;
  while (q < chain.length - 1 && chain[q] === null) q++;
  return { p, q };
}

export function checkPlacement(graph: WordGraph, chain: Chain, position: number, input: unknown): Placement {
  const word = normalizeWord(input);
  if (!Number.isInteger(position) || position <= 0 || position >= chain.length - 1)
    return reject('bad_slot', "That isn't a slot on this board.");
  if (chain[position] !== null) return reject('slot_locked', 'That word is already locked in.');
  if (word.length !== graph.length || !/^[A-Z]+$/.test(word))
    return reject('bad_length', `Words need exactly ${graph.length} letters.`);
  const id = graph.index.get(word);
  if (id === undefined) return reject('not_a_word', 'Not a valid English word.');
  if (chain.includes(word)) return reject('already_used', 'That word is already used.');

  const { p, q } = anchorsAround(chain, position);
  const before = chain[p]!;
  const after = chain[q]!;
  if (p === position - 1 && !differsByOne(before, word))
    return reject('not_one_letter', `Change exactly one letter from ${before}.`);
  if (q === position + 1 && !differsByOne(word, after))
    return reject('not_one_letter', `Change exactly one letter to reach ${after}.`);

  const up = position - p;
  const down = q - position;
  const dist = bfs(graph, id, { maxDepth: Math.max(up, down) });
  if (dist[graph.index.get(before)!] !== up || dist[graph.index.get(after)!] !== down)
    return reject('wrong_position', "This word doesn't fit the selected position.");
  return { ok: true, word };
}

/** Every word that may legally be locked into `position` right now. */
export function candidatesFor(graph: WordGraph, chain: Chain, position: number): string[] {
  if (position <= 0 || position >= chain.length - 1 || chain[position] !== null) return [];
  const { p, q } = anchorsAround(chain, position);
  const up = position - p;
  const down = q - position;
  const fromBefore = bfs(graph, graph.index.get(chain[p]!)!, { maxDepth: up });
  const fromAfter = bfs(graph, graph.index.get(chain[q]!)!, { maxDepth: down });
  const out: string[] = [];
  for (let i = 0; i < graph.words.length; i++)
    if (fromBefore[i] === up && fromAfter[i] === down) out.push(graph.words[i]!);
  return out;
}

/** True when the chain is a legal ladder state (all fixed words consistent). */
export function isChainConsistent(graph: WordGraph, chain: Chain): boolean {
  const fixed = chain.map((w, i) => ({ w, i })).filter((x): x is { w: string; i: number } => x.w !== null);
  if (fixed[0]?.i !== 0 || fixed.at(-1)?.i !== chain.length - 1) return false;
  if (new Set(fixed.map((f) => f.w)).size !== fixed.length) return false;
  for (let k = 0; k + 1 < fixed.length; k++) {
    const a = graph.index.get(fixed[k]!.w);
    const b = graph.index.get(fixed[k + 1]!.w);
    if (a === undefined || b === undefined) return false;
    const gap = fixed[k + 1]!.i - fixed[k]!.i;
    if (bfs(graph, a, { maxDepth: gap })[b] !== gap) return false;
  }
  return true;
}

/** Every slot filled and each adjacent pair differs by exactly one letter. */
export function isComplete(chain: Chain): chain is string[] {
  if (chain.some((w) => w === null)) return false;
  for (let i = 0; i + 1 < chain.length; i++) if (!differsByOne(chain[i]!, chain[i + 1]!)) return false;
  return new Set(chain).size === chain.length;
}

/**
 * Completes the chain with one valid solution (preferring familiar words), or returns
 * null if the chain cannot be completed.
 */
export function solve(graph: WordGraph, chain: Chain, choose: (n: number) => number = () => 0): string[] | null {
  if (!isChainConsistent(graph, chain)) return null;
  const out = [...chain];
  for (let i = 1; i < out.length - 1; i++) {
    if (out[i] !== null) continue;
    const options = candidatesFor(graph, out, i);
    if (options.length === 0) return null;
    const familiar = options.filter((w) => graph.common[graph.index.get(w)!]);
    const pool = familiar.length ? familiar : options;
    out[i] = pool[choose(pool.length)]!;
  }
  return out as string[];
}
