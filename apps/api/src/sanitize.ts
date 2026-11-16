import { DIFFICULTIES, GAME_MODES, WORD_LENGTHS, type Difficulty, type GameMode, type HintType, type WordLength } from '@ftt/shared-types';
import { badRequest } from './errors';

/** Room codes avoid look-alike characters (no 0/O, 1/I/L). */
export const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const CODE_LENGTH = 6;
const CODE_RE = new RegExp(`^[${CODE_ALPHABET}]{${CODE_LENGTH}}$`);

export function parseCode(input: unknown): string {
  const code = typeof input === 'string' ? input.trim().toUpperCase() : '';
  if (!CODE_RE.test(code)) throw badRequest('That room code is not valid.', 'bad_code');
  return code;
}

/** Display names: printable, no markup characters, at most 16 characters. */
export function parseName(input: unknown, fallback: string): string {
  if (typeof input !== 'string') return fallback;
  const clean = input
    .normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f<>&"'`\\]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 16);
  return clean || fallback;
}

export function parseDeviceId(input: unknown): string {
  if (typeof input !== 'string' || !/^[A-Za-z0-9_-]{16,64}$/.test(input)) throw badRequest('Missing or invalid deviceId.');
  return input;
}

const oneOf = <T>(allowed: readonly T[], label: string) => (input: unknown): T => {
  if (!allowed.includes(input as T)) throw badRequest(`Invalid ${label}.`);
  return input as T;
};
export const parseLength = oneOf<WordLength>(WORD_LENGTHS, 'word length');
export const parseDifficulty = oneOf<Difficulty>(DIFFICULTIES, 'difficulty');
export const parseMode = oneOf<GameMode>(GAME_MODES, 'game mode');
export const parseHintType = oneOf<HintType>(['letter', 'word', 'next'], 'hint type');

export function parseSlot(input: unknown, slotCount: number): number {
  if (typeof input !== 'number' || !Number.isInteger(input) || input < 0 || input >= slotCount)
    throw badRequest("That isn't a slot on this board.", 'bad_slot');
  return input;
}

/** Words are validated by the engine; this only bounds what reaches it. */
export function parseWord(input: unknown): string {
  if (typeof input !== 'string' || input.length > 16) throw badRequest('Invalid word.');
  return input.trim().toUpperCase();
}
