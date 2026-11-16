import data from './words.json';

export type WordLength = 4 | 5;

export interface WordList {
  /** Every word a player may enter (common + extra), uppercase, sorted. */
  all: string[];
  /** Familiar words; puzzle endpoints and the guaranteed solution come from here. */
  common: string[];
  /** Everyday subset of `common`; used for Easy puzzle endpoints. */
  basic: string[];
}

function unpack(packed: string, length: number): string[] {
  const out: string[] = [];
  for (let i = 0; i + length <= packed.length; i += length) out.push(packed.slice(i, i + length));
  return out;
}

const cache = new Map<WordLength, WordList>();

/** Curated dictionary for one word length. Lists never mix lengths. */
export function getWordList(length: WordLength): WordList {
  let list = cache.get(length);
  if (!list) {
    const common = unpack(length === 4 ? data.common4 : data.common5, length);
    const extra = unpack(length === 4 ? data.extra4 : data.extra5, length);
    const basic = unpack(length === 4 ? data.basic4 : data.basic5, length);
    list = { basic, common, all: [...common, ...extra].sort() };
    cache.set(length, list);
  }
  return list;
}

export const DICTIONARY_VERSION: string = data.version;
