import type { Difficulty, GameMode, Session, WordLength } from '@ftt/shared-types';

export interface Prefs {
  name: string;
  partnerName: string;
  length: WordLength;
  difficulty: Difficulty;
  mode: GameMode;
  sound: boolean;
}

export const DEFAULT_PREFS: Prefs = {
  name: '', partnerName: '', length: 4, difficulty: 'easy', mode: 'couples', sound: true,
};

function read<T>(key: string): T | null {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}
function write(key: string, value: unknown) {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* private mode: the game still works, it just won't remember */
  }
}

/** Anonymous id for statistics and recent-puzzle history. No account needed. */
export function deviceId(): string {
  let id = read<string>('ftt.device');
  if (!id || !/^[A-Za-z0-9_-]{16,64}$/.test(id)) {
    const bytes = crypto.getRandomValues(new Uint8Array(18));
    id = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    write('ftt.device', id);
  }
  return id;
}

export const loadPrefs = (): Prefs => ({ ...DEFAULT_PREFS, ...(read<Partial<Prefs>>('ftt.prefs') ?? {}) });
export const savePrefs = (prefs: Prefs) => write('ftt.prefs', prefs);
export const loadSession = () => read<Session>('ftt.session');
export const saveSession = (session: Session | null) => write('ftt.session', session);
