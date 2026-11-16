import { getWordList, type WordLength } from '@ftt/dictionary';

/**
 * Word graph: nodes are dictionary words of one length, edges join words that differ
 * by exactly one letter in the same position. Built once per length and kept in memory.
 */
export interface WordGraph {
  length: WordLength;
  words: string[];
  index: Map<string, number>;
  neighbors: number[][];
  /** 1 when the word is in the familiar tier. */
  common: Uint8Array;
  /** 1 when the word is in the everyday tier. */
  basic: Uint8Array;
  commonIds: number[];
  basicIds: number[];
}

export function differsByOne(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i] && ++diff > 1) return false;
  return diff === 1;
}

export function buildGraph(length: WordLength, list = getWordList(length)): WordGraph {
  const words = list.all;
  const index = new Map(words.map((w, i) => [w, i]));
  const neighbors: number[][] = words.map(() => []);

  // Bucket words by wildcard pattern ("C*LD"): every pair in a bucket is adjacent.
  const buckets = new Map<string, number[]>();
  words.forEach((w, id) => {
    for (let p = 0; p < length; p++) {
      const key = w.slice(0, p) + '*' + w.slice(p + 1);
      const bucket = buckets.get(key);
      if (bucket) bucket.push(id);
      else buckets.set(key, [id]);
    }
  });
  for (const bucket of buckets.values())
    for (let i = 0; i < bucket.length; i++)
      for (let j = i + 1; j < bucket.length; j++) {
        neighbors[bucket[i]!]!.push(bucket[j]!);
        neighbors[bucket[j]!]!.push(bucket[i]!);
      }

  const flag = (subset: string[]) => {
    const out = new Uint8Array(words.length);
    for (const w of subset) out[index.get(w)!] = 1;
    return out;
  };
  const common = flag(list.common);
  const basic = flag(list.basic);
  const ids = (flags: Uint8Array) => words.map((_, i) => i).filter((i) => flags[i] === 1);
  return { length, words, index, neighbors, common, basic, commonIds: ids(common), basicIds: ids(basic) };
}

const graphs = new Map<WordLength, WordGraph>();
export function getGraph(length: WordLength): WordGraph {
  let g = graphs.get(length);
  if (!g) graphs.set(length, (g = buildGraph(length)));
  return g;
}

export interface BfsOptions {
  /** Restrict traversal to the familiar tier. */
  commonOnly?: boolean;
  /** Stop expanding beyond this distance. */
  maxDepth?: number;
}

/** Breadth-first distances from `source`; -1 where unreachable (or beyond maxDepth). */
export function bfs(graph: WordGraph, source: number, opts: BfsOptions = {}): Int16Array {
  const dist = new Int16Array(graph.words.length).fill(-1);
  const maxDepth = opts.maxDepth ?? Infinity;
  dist[source] = 0;
  const queue = [source];
  for (let head = 0; head < queue.length; head++) {
    const u = queue[head]!;
    const d = dist[u]!;
    if (d >= maxDepth) continue;
    for (const v of graph.neighbors[u]!) {
      if (dist[v] !== -1) continue;
      if (opts.commonOnly && !graph.common[v]) continue;
      dist[v] = d + 1;
      queue.push(v);
    }
  }
  return dist;
}

/** Shortest distance between two words, or -1. */
export function distance(graph: WordGraph, a: string, b: string, opts: BfsOptions = {}): number {
  const ia = graph.index.get(a);
  const ib = graph.index.get(b);
  if (ia === undefined || ib === undefined) return -1;
  return bfs(graph, ia, opts)[ib]!;
}

/**
 * Number of distinct shortest paths from `source` to `target` (capped), given the
 * BFS distances from `source`.
 */
export function countShortestPaths(
  graph: WordGraph,
  distFromSource: Int16Array,
  target: number,
  opts: { commonOnly?: boolean; cap?: number } = {},
): number {
  const cap = opts.cap ?? 1_000_000;
  const memo = new Map<number, number>();
  const walk = (node: number): number => {
    const d = distFromSource[node]!;
    if (d === 0) return 1;
    const known = memo.get(node);
    if (known !== undefined) return known;
    let total = 0;
    for (const prev of graph.neighbors[node]!) {
      if (distFromSource[prev] !== d - 1) continue;
      if (opts.commonOnly && !graph.common[prev]) continue;
      total += walk(prev);
      if (total >= cap) { total = cap; break; }
    }
    memo.set(node, total);
    return total;
  };
  return distFromSource[target]! < 0 ? 0 : walk(target);
}
