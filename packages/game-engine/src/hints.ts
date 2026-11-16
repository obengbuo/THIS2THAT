import type { HintPayload } from '@ftt/shared-types';
import type { WordGraph } from './graph';
import { secureRng, type Rng } from './random';
import { anchorsAround, candidatesFor, type Chain } from './validate';

/** Letters already revealed per chain position (same indexing as the chain). */
export type Revealed = ((string | null)[] | undefined)[];

export class HintError extends Error {}

const familiarFirst = (graph: WordGraph, words: string[]) => {
  const familiar = words.filter((w) => graph.common[graph.index.get(w)!]);
  return familiar.length ? familiar : words;
};

const openPositions = (chain: Chain) =>
  chain.map((w, i) => (w === null ? i : -1)).filter((i) => i > 0);

/**
 * Hint 3 — the open slot that is easiest to reason about right now: one that touches a
 * fixed word, preferring the slot with the fewest legal words.
 */
export function nextMove(graph: WordGraph, chain: Chain): Extract<HintPayload, { type: 'next' }> {
  let best: { position: number; anchor: string; count: number; above: boolean } | null = null;
  for (const position of openPositions(chain)) {
    const above = chain[position - 1] ?? null;
    const below = chain[position + 1] ?? null;
    if (above === null && below === null) continue;
    const count = candidatesFor(graph, chain, position).length;
    if (count > 0 && (!best || count < best.count))
      best = { position, anchor: (above ?? below)!, count, above: above !== null };
  }
  if (!best) throw new HintError('The board is already complete.');
  return {
    type: 'next',
    slot: best.position - 1,
    anchor: best.anchor,
    message: best.above
      ? `Try this one: change one letter of ${best.anchor}.`
      : `Try this one: it is one letter away from ${best.anchor}.`,
  };
}

/** Hint 2 — a word that fits `position` and keeps the puzzle solvable. Not locked. */
export function suggestWord(
  graph: WordGraph,
  chain: Chain,
  position: number | undefined,
  revealed: Revealed = [],
  rng: Rng = secureRng,
): Extract<HintPayload, { type: 'word' }> {
  const target = position ?? nextMove(graph, chain).slot + 1;
  let options = candidatesFor(graph, chain, target);
  if (options.length === 0) throw new HintError('That slot is already locked.');
  // Stay consistent with letters this slot has already had revealed.
  const shown = revealed[target];
  if (shown) {
    const matching = options.filter((w) => shown.every((ch, i) => ch === null || w[i] === ch));
    if (matching.length) options = matching;
  }
  const pool = familiarFirst(graph, options);
  return { type: 'word', slot: target - 1, word: pool[rng(pool.length)]! };
}

/** Hint 1 — reveal one more letter of a word that fits `position`. */
export function revealLetter(
  graph: WordGraph,
  chain: Chain,
  position: number | undefined,
  revealed: Revealed = [],
  rng: Rng = secureRng,
): Extract<HintPayload, { type: 'letter' }> {
  const target = position ?? nextMove(graph, chain).slot + 1;
  const shown = revealed[target] ?? Array<string | null>(graph.length).fill(null);
  const hidden = shown.map((ch, i) => (ch === null ? i : -1)).filter((i) => i >= 0);
  if (chain[target] !== null && chain[target] !== undefined) throw new HintError('That slot is already locked.');
  if (hidden.length === 0) throw new HintError('Every letter of that word is already revealed.');
  const { word } = suggestWord(graph, chain, target, revealed, rng);

  // Prefer the most informative letter: one that differs from the nearest fixed word.
  const { p, q } = anchorsAround(chain, target);
  const near = target - p <= q - target ? chain[p]! : chain[q]!;
  const informative = hidden.filter((i) => word[i] !== near[i]);
  const from = informative.length ? informative : hidden;
  const index = from[rng(from.length)]!;
  return { type: 'letter', slot: target - 1, index, letter: word[index]! };
}
