/**
 * Random-generation stress test: generates 10,000 puzzles (more with STRESS=1) and
 * reports uniqueness, solvability, speed and distribution. Every puzzle must be solvable.
 */
import { expect, it } from 'vitest';
import { checkPlacement, DIFFICULTY, distance, generatePuzzle, getGraph, isComplete, pairKey, type Chain } from '@ftt/game-engine';

const TOTAL = process.env.STRESS ? 60_000 : 10_000;

it(`generates ${TOTAL.toLocaleString()} puzzles: all solvable, well distributed, fast`, () => {
  getGraph(4);
  getGraph(5); // build graphs up front so timings measure generation only
  const lengths = [4, 5] as const;
  const difficulties = ['easy', 'medium', 'hard'] as const;
  const counts: Record<string, number> = {};
  const slotCounts: Record<string, Record<number, number>> = {};
  const unique = new Set<string>();
  let solvable = 0;
  let fallbacks = 0;
  let attempts = 0;
  let generationMs = 0;

  for (let i = 0; i < TOTAL; i++) {
    const length = lengths[i % 2]!;
    const difficulty = difficulties[Math.floor(i / 2) % 3]!;
    const t0 = performance.now();
    const p = generatePuzzle({ length, difficulty });
    generationMs += performance.now() - t0;

    const bucket = `${length}-letter ${difficulty}`;
    counts[bucket] = (counts[bucket] ?? 0) + 1;
    (slotCounts[bucket] ??= {})[p.slots] = (slotCounts[bucket]![p.slots] ?? 0) + 1;
    unique.add(`${length}:${pairKey(p.start, p.target)}`);
    fallbacks += Number(p.fromFallback);
    attempts += p.attempts;

    // Independently verify solvability by replaying the solution through the validator.
    const graph = getGraph(length);
    const chain: Chain = [p.start, ...Array<null>(p.slots).fill(null), p.target];
    let ok = p.start.length === length && p.target.length === length && distance(graph, p.start, p.target) === p.slots + 1;
    for (let pos = 1; ok && pos <= p.slots; pos++) {
      ok = checkPlacement(graph, chain, pos, p.solution[pos]).ok;
      chain[pos] = p.solution[pos]!;
    }
    ok &&= isComplete(chain);
    ok &&= p.slots >= DIFFICULTY[difficulty].minSlots && p.slots <= DIFFICULTY[difficulty].maxSlots;
    if (ok) solvable++;
  }

  const duplicatePct = ((TOTAL - unique.size) / TOTAL) * 100;
  const report = [
    '',
    '── Puzzle generation stress report ──',
    `puzzles generated      ${TOTAL}`,
    `unique puzzles         ${unique.size}`,
    `duplicate percentage   ${duplicatePct.toFixed(2)}%`,
    `solvability            ${((solvable / TOTAL) * 100).toFixed(2)}%`,
    `avg generation time    ${(generationMs / TOTAL).toFixed(3)} ms`,
    `avg attempts           ${(attempts / TOTAL).toFixed(2)}`,
    `fallback puzzles used  ${fallbacks}`,
    'distribution (count | slots → count):',
    ...Object.keys(counts).sort().map((k) => `  ${k.padEnd(16)} ${String(counts[k]).padStart(6)} | ${JSON.stringify(slotCounts[k])}`),
    `by length              4-letter ${lengths.map((l) => Object.entries(counts).filter(([k]) => k.startsWith(String(l))).reduce((n, [, c]) => n + c, 0)).join(' / 5-letter ')}`,
    '',
  ].join('\n');
  console.log(report);

  expect(solvable).toBe(TOTAL);
  expect(fallbacks).toBe(0);
  expect(duplicatePct).toBeLessThan(15);
  expect(generationMs / TOTAL).toBeLessThan(10);
});
