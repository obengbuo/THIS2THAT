/**
 * Regenerates src/fallbacks.json: a diverse table of pre-verified puzzles used only if
 * live generation fails repeatedly. Run: npx tsx packages/game-engine/scripts/build-fallbacks.ts
 */
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { generatePuzzle, pairKey, seededRng } from '../src';

const PER_BUCKET = 60;
const rng = seededRng(20261116);
const table: Record<string, Record<string, [string, string][]>> = {};
for (const length of [4, 5] as const) {
  table[length] = {};
  for (const difficulty of ['easy', 'medium', 'hard'] as const) {
    const seen = new Set<string>();
    const usedWords = new Set<string>();
    const rows: [string, string][] = [];
    while (rows.length < PER_BUCKET) {
      const p = generatePuzzle({ length, difficulty, rng, excludePairs: seen, avoidWords: usedWords });
      if (p.fromFallback) continue;
      seen.add(pairKey(p.start, p.target));
      usedWords.add(p.start).add(p.target);
      rows.push([p.start, p.target]);
    }
    table[length]![difficulty] = rows;
  }
}
writeFileSync(path.join(__dirname, '..', 'src', 'fallbacks.json'), JSON.stringify(table) + '\n');
console.log('fallback puzzles:', Object.values(table).flatMap((d) => Object.values(d)).flat().length);
