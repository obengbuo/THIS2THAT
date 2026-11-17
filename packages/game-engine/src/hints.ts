import type { HintPayload, HintType } from '@ftt/shared-types';
import type { WordGraph } from './graph';
import { secureRng, type Rng } from './random';
import { changedIndex, routeToTarget, type Ladder } from './validate';

export class HintError extends Error {}

const ORDINAL = ['1st', '2nd', '3rd', '4th', '5th'];

/**
 * A hint for the next move, always along a shortest remaining route to the target:
 *
 *   next    which letter of the current word to change
 *   letter  that position and the letter to put there
 *   word    the whole next word
 *
 * `revealed` holds letters already given out for this move, so that repeated hints
 * keep pointing at the same word instead of contradicting each other.
 */
export function hintFor(
  graph: WordGraph,
  words: Ladder,
  target: string,
  type: HintType,
  revealed: (string | null)[] = [],
  rng: Rng = secureRng,
): HintPayload {
  const current = words.at(-1)!;
  if (current === target) throw new HintError('The board is already complete.');
  const shownAt = revealed.findIndex((ch) => ch !== null);
  let route = routeToTarget(graph, words, target, rng);
  if (shownAt >= 0) {
    // Stay with the word an earlier letter hint pointed at, if it is still playable.
    const promised = current.slice(0, shownAt) + revealed[shownAt] + current.slice(shownAt + 1);
    const viaPromised = graph.index.has(promised) && !words.includes(promised) ? routeToTarget(graph, [...words, promised], target, rng) : null;
    if (viaPromised) route = [promised, ...viaPromised];
  }
  if (!route) throw new HintError('There is no way forward from here. Take back the last word and try another.');
  const word = route[0]!;
  const index = changedIndex(current, word);
  if (type === 'next') return { type, index, message: `Change the ${ORDINAL[index] ?? `${index + 1}th`} letter of ${current}.` };
  if (type === 'letter') return { type, index, letter: word[index]! };
  return { type, index, word };
}
