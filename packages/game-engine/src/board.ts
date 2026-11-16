/**
 * Client-side whiteboard state: the editable drafts layered over the server's locked
 * words. Pure and dictionary-free so it can ship to the browser.
 *
 * Locking rules enforced here (and independently by the server, which has no
 * operation that unlocks a slot):
 *   - a locked slot can never be typed in, erased, undone or reset;
 *   - Undo and Reset only ever touch unlocked drafts.
 */
export interface BoardSlot {
  /** Locked word, or the draft currently written in the slot (may be partial). */
  text: string;
  locked: boolean;
}

export interface Board {
  length: number;
  slots: BoardSlot[];
  /** Draft snapshots for Undo (drafts only — never locked words). */
  history: string[][];
}

const HISTORY_LIMIT = 100;

export function createBoard(length: number, slotCount: number): Board {
  return {
    length,
    slots: Array.from({ length: slotCount }, () => ({ text: '', locked: false })),
    history: [],
  };
}

const drafts = (board: Board) => board.slots.map((s) => (s.locked ? '' : s.text));

function withDraft(board: Board, slot: number, text: string): Board {
  const current = board.slots[slot];
  if (!current || current.locked || current.text === text) return board;
  return {
    ...board,
    slots: board.slots.map((s, i) => (i === slot ? { ...s, text } : s)),
    history: [...board.history, drafts(board)].slice(-HISTORY_LIMIT),
  };
}

export function setDraft(board: Board, slot: number, text: string): Board {
  const clean = text.toUpperCase().replace(/[^A-Z]/g, '').slice(0, board.length);
  return withDraft(board, slot, clean);
}

export function typeLetter(board: Board, slot: number, letter: string): Board {
  const current = board.slots[slot];
  if (!current || current.locked || current.text.length >= board.length) return board;
  return setDraft(board, slot, current.text + letter);
}

export function backspace(board: Board, slot: number): Board {
  const current = board.slots[slot];
  if (!current || current.locked || current.text.length === 0) return board;
  return withDraft(board, slot, current.text.slice(0, -1));
}

/** Reverts the last draft edit. Locked words are untouched. */
export function undo(board: Board): Board {
  const previous = board.history.at(-1);
  if (!previous) return board;
  return {
    ...board,
    slots: board.slots.map((s, i) => (s.locked ? s : { ...s, text: previous[i] ?? '' })),
    history: board.history.slice(0, -1),
  };
}

/** Wipes every draft. Locked words are untouched. */
export function resetDrafts(board: Board): Board {
  if (board.slots.every((s) => s.locked || s.text === '')) return board;
  return {
    ...board,
    slots: board.slots.map((s) => (s.locked ? s : { ...s, text: '' })),
    history: [...board.history, drafts(board)].slice(-HISTORY_LIMIT),
  };
}

/**
 * Applies the server's authoritative locked words. Locks are one-way: a slot the
 * server reports as locked becomes locked here; a locally locked slot never reopens.
 */
export function applyLocks(board: Board, serverWords: (string | null)[]): Board {
  let changed = false;
  const slots = board.slots.map((s, i) => {
    const word = serverWords[i] ?? null;
    if (word === null || (s.locked && s.text === word)) return s;
    changed = true;
    return { text: word, locked: true };
  });
  return changed ? { ...board, slots } : board;
}

export function firstOpenSlot(board: Board, from = 0): number | null {
  const n = board.slots.length;
  for (let k = 0; k < n; k++) {
    const i = (from + k) % n;
    if (!board.slots[i]!.locked) return i;
  }
  return null;
}
