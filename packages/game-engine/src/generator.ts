import type { Difficulty, WordLength } from '@ftt/shared-types';
import { bfs, countShortestPaths, getGraph, type WordGraph } from './graph';
import { pick, secureRng, type Rng } from './random';
import fallbackData from './fallbacks.json';

export interface DifficultySpec {
  /** Inclusive range of intermediate words (slots). */
  minSlots: number;
  maxSlots: number;
  /** Which familiarity tier the start and target words are drawn from. */
  endpoints: 'basic' | 'common';
  /** Minimum number of distinct all-familiar solutions (more = more forgiving). */
  minFamiliarSolutions: number;
  /** Maximum number of distinct solutions over the whole dictionary (fewer = harder). */
  maxSolutions: number;
}

/**
 * Difficulty is more than chain length: Easy and Medium use everyday endpoint words and
 * puzzles with several familiar routes; Hard draws endpoints from the wider familiar
 * tier and uses longer chains with few routes.
 */
export const DIFFICULTY: Record<Difficulty, DifficultySpec> = {
  easy: { minSlots: 2, maxSlots: 3, endpoints: 'basic', minFamiliarSolutions: 3, maxSolutions: Infinity },
  medium: { minSlots: 4, maxSlots: 5, endpoints: 'basic', minFamiliarSolutions: 2, maxSolutions: Infinity },
  hard: { minSlots: 6, maxSlots: 8, endpoints: 'common', minFamiliarSolutions: 1, maxSolutions: 60 },
};

export interface Puzzle {
  length: WordLength;
  difficulty: Difficulty;
  start: string;
  target: string;
  /** Number of intermediate words the players must fill. */
  slots: number;
  /** One verified solution, start..target inclusive, made only of familiar words. */
  solution: string[];
  /** Distinct solutions over the whole dictionary (capped at 1,000,000). */
  solutionCount: number;
  attempts: number;
  fromFallback: boolean;
}

export interface GenerateOptions {
  length: WordLength;
  difficulty: Difficulty;
  /** Recently played pair keys (see pairKey) that must not be reused. */
  excludePairs?: Iterable<string>;
  /** Words to avoid as start/target where possible (e.g. the previous puzzle's ends). */
  avoidWords?: Iterable<string>;
  rng?: Rng;
  maxAttempts?: number;
}

export const pairKey = (start: string, target: string) => `${start}>${target}`;

/** A random shortest path source -> target through familiar words only. */
function samplePath(graph: WordGraph, distFromSource: Int16Array, target: number, rng: Rng): string[] {
  const path = [target];
  let node = target;
  while (distFromSource[node]! > 0) {
    const d = distFromSource[node]!;
    const prev = graph.neighbors[node]!.filter((n) => graph.common[n] && distFromSource[n] === d - 1);
    node = pick(prev, rng);
    path.push(node);
  }
  return path.reverse().map((id) => graph.words[id]!);
}

/**
 * Builds a puzzle from a concrete start word, or returns null when no target meets the
 * difficulty spec. A puzzle is only ever returned together with a verified solution.
 */
function fromStart(
  graph: WordGraph,
  start: number,
  opts: GenerateOptions,
  spec: DifficultySpec,
  rng: Rng,
  excluded: Set<string>,
  avoid: Set<string>,
): Omit<Puzzle, 'attempts' | 'fromFallback'> | null {
  const full = bfs(graph, start, { maxDepth: spec.maxSlots + 1 });
  const familiar = bfs(graph, start, { maxDepth: spec.maxSlots + 1, commonOnly: true });
  const tier = spec.endpoints === 'basic' ? graph.basic : graph.common;
  const startWord = graph.words[start]!;

  // Try the slot counts in random order so chain lengths vary within a difficulty.
  const sizes: number[] = [];
  for (let s = spec.minSlots; s <= spec.maxSlots; s++) sizes.push(s);
  for (let i = sizes.length - 1; i > 0; i--) {
    const j = rng(i + 1);
    [sizes[i], sizes[j]] = [sizes[j]!, sizes[i]!];
  }

  for (const slots of sizes) {
    const steps = slots + 1;
    const targets: number[] = [];
    for (let t = 0; t < graph.words.length; t++) {
      // The familiar-only distance must equal the true distance: this guarantees a
      // solution made of familiar words that uses exactly the slots shown.
      if (!tier[t] || full[t] !== steps || familiar[t] !== steps) continue;
      const word = graph.words[t]!;
      if (avoid.has(word)) continue;
      if (excluded.has(pairKey(startWord, word)) || excluded.has(pairKey(word, startWord))) continue;
      targets.push(t);
    }
    // A few random draws per size; each is checked against the solution-count rules.
    for (let tries = 0; tries < 6 && targets.length > 0; tries++) {
      const k = rng(targets.length);
      const target = targets[k]!;
      targets.splice(k, 1);
      const familiarCount = countShortestPaths(graph, familiar, target, { commonOnly: true });
      if (familiarCount < spec.minFamiliarSolutions) continue;
      const solutionCount = countShortestPaths(graph, full, target);
      if (solutionCount > spec.maxSolutions) continue;
      return {
        length: opts.length,
        difficulty: opts.difficulty,
        start: startWord,
        target: graph.words[target]!,
        slots,
        solution: samplePath(graph, familiar, target, rng),
        solutionCount,
      };
    }
  }
  return null;
}

type FallbackTable = Record<string, Record<string, [string, string][]>>;

/** Verified-at-use fallback: re-derives distance and solution from the live graph. */
function fromFallback(
  graph: WordGraph,
  opts: GenerateOptions,
  spec: DifficultySpec,
  rng: Rng,
  excluded: Set<string>,
): Omit<Puzzle, 'attempts' | 'fromFallback'> {
  const table = (fallbackData as unknown as FallbackTable)[String(opts.length)]?.[opts.difficulty] ?? [];
  const fresh = table.filter(([s, t]) => !excluded.has(pairKey(s, t)));
  const pool = [...(fresh.length ? fresh : table)];
  while (pool.length) {
    const k = rng(pool.length);
    const [s, t] = pool.splice(k, 1)[0]!;
    const si = graph.index.get(s);
    const ti = graph.index.get(t);
    if (si === undefined || ti === undefined) continue;
    const full = bfs(graph, si);
    const familiar = bfs(graph, si, { commonOnly: true });
    const steps = full[ti]!;
    if (steps < spec.minSlots + 1 || steps > spec.maxSlots + 1 || familiar[ti] !== steps) continue;
    return {
      length: opts.length,
      difficulty: opts.difficulty,
      start: s,
      target: t,
      slots: steps - 1,
      solution: samplePath(graph, familiar, ti, rng),
      solutionCount: countShortestPaths(graph, full, ti),
    };
  }
  throw new Error(`No puzzle available for ${opts.length}-letter ${opts.difficulty}`);
}

/**
 * Generates a fresh, verified-solvable puzzle.
 *
 *  1. Pick a random start word from the difficulty's familiarity tier.
 *  2. BFS from it twice: over the whole dictionary and over familiar words only.
 *  3. Keep targets at the wanted distance whose familiar distance equals the true
 *     distance, that are not recently played, and whose solution counts suit the level.
 *  4. Pick one at random and sample a random familiar solution path.
 *  5. Retry with a new start on failure; after maxAttempts use the fallback table.
 */
export function generatePuzzle(opts: GenerateOptions): Puzzle {
  const graph = getGraph(opts.length);
  const spec = DIFFICULTY[opts.difficulty];
  const rng = opts.rng ?? secureRng;
  const excluded = new Set(opts.excludePairs ?? []);
  const avoid = new Set(opts.avoidWords ?? []);
  const starts = spec.endpoints === 'basic' ? graph.basicIds : graph.commonIds;
  const maxAttempts = opts.maxAttempts ?? 60;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const start = pick(starts, rng);
    // "Where possible": stop honouring avoidWords in the final third of attempts.
    const strict = attempt <= (maxAttempts * 2) / 3;
    if (strict && avoid.has(graph.words[start]!)) continue;
    const puzzle = fromStart(graph, start, opts, spec, rng, excluded, strict ? avoid : new Set());
    if (puzzle) return { ...puzzle, attempts: attempt, fromFallback: false };
  }
  return { ...fromFallback(graph, opts, spec, rng, excluded), attempts: maxAttempts, fromFallback: true };
}
