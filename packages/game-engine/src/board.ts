/**
 * Client-side draft of the next move. Pure and dictionary-free so it can ship to the
 * browser.
 *
 * A move changes exactly one letter of the current word, so the draft is the current
 * word with at most one letter replaced: writing a letter in a second position puts the
 * first one back. The server checks every move again; this only shapes the typing.
 */
export interface Draft {
  /** The word being changed (the last word on the board). */
  base: string;
  /** `base` with at most one letter replaced. */
  text: string;
  /** Zero-based letter position the next keystroke writes to. */
  cursor: number;
}

export function newDraft(base: string, cursor = 0): Draft {
  return { base, text: base, cursor: Math.min(Math.max(0, cursor), Math.max(0, base.length - 1)) };
}

/** Position of the replaced letter, or null while the draft still equals the base. */
export function changedAt(draft: Draft): number | null {
  for (let i = 0; i < draft.base.length; i++) if (draft.text[i] !== draft.base[i]) return i;
  return null;
}

export function moveCursor(draft: Draft, to: number): Draft {
  const cursor = Math.min(Math.max(0, to), draft.base.length - 1);
  return cursor === draft.cursor ? draft : { ...draft, cursor };
}

/** Writes `letter` at the cursor, putting any other changed letter back. */
export function typeLetter(draft: Draft, letter: string): Draft {
  const ch = letter.toUpperCase();
  if (!/^[A-Z]$/.test(ch)) return draft;
  const text = draft.base.slice(0, draft.cursor) + ch + draft.base.slice(draft.cursor + 1);
  return text === draft.text ? draft : { ...draft, text };
}

/** Puts the original word back. */
export function clearDraft(draft: Draft): Draft {
  return draft.text === draft.base ? draft : { ...draft, text: draft.base };
}

/** Loads a whole word (e.g. a suggested one) if it is one letter away from the base. */
export function setWord(draft: Draft, word: string): Draft {
  const text = word.toUpperCase();
  if (text.length !== draft.base.length) return draft;
  const diff = [...text].map((ch, i) => (ch === draft.base[i] ? -1 : i)).filter((i) => i >= 0);
  if (diff.length !== 1) return draft;
  return { ...draft, text, cursor: diff[0]! };
}
