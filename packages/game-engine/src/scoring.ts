import type { Difficulty, GameResult } from '@ftt/shared-types';

export const SCORE = {
  base: 1000,
  /** One point per two seconds, capped so a slow game still scores. */
  timePenaltyPerSecond: 0.5,
  maxTimePenalty: 500,
  hintPenalty: 100,
  wrongPenalty: 25,
  multiplier: { easy: 1, medium: 1.5, hard: 2 } satisfies Record<Difficulty, number>,
} as const;

export function computeScore(input: {
  difficulty: Difficulty;
  elapsedMs: number;
  hintsUsed: number;
  wrongAttempts: number;
}): number {
  const seconds = Math.max(0, input.elapsedMs) / 1000;
  const time = Math.min(SCORE.maxTimePenalty, Math.floor(seconds * SCORE.timePenaltyPerSecond));
  const raw = SCORE.base - time - SCORE.hintPenalty * input.hintsUsed - SCORE.wrongPenalty * input.wrongAttempts;
  return Math.max(0, Math.round(raw * SCORE.multiplier[input.difficulty]));
}

export function buildResult(input: {
  difficulty: Difficulty;
  elapsedMs: number;
  hintsUsed: number;
  wrongAttempts: number;
  correctSubmissions: number;
}): GameResult {
  return {
    score: computeScore(input),
    elapsedMs: input.elapsedMs,
    hintsUsed: input.hintsUsed,
    wrongAttempts: input.wrongAttempts,
    correctSubmissions: input.correctSubmissions,
  };
}
