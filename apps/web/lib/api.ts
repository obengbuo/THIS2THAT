import type {
  ApiErrorBody, CreateGameRequest, Difficulty, GameView, HintResponse, HintType, PlayerStats, Session, SessionResponse, SubmitResponse, WordLength,
} from '@ftt/shared-types';

/** Falls back to the dev API on the same host, so phones on the LAN work in development. */
export function apiBase(): string {
  return process.env.NEXT_PUBLIC_API_URL || `${window.location.protocol}//${window.location.hostname}:4000`;
}
export function wsBase(): string {
  return process.env.NEXT_PUBLIC_WS_URL || `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.hostname}:4000`;
}

export class ApiClientError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

async function request<T>(method: 'GET' | 'POST', path: string, body?: unknown, session?: Session): Promise<T> {
  let res: Response;
  try {
    res = await fetch(apiBase().replace(/\/+$/, '') + path, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(session ? { authorization: `Bearer ${session.playerId}.${session.token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiClientError(0, 'network', "Can't reach the game server. Check your connection.");
  }
  const data = (await res.json().catch(() => null)) as (T & Partial<ApiErrorBody>) | null;
  if (!res.ok || !data) {
    const err = data?.error;
    throw new ApiClientError(res.status, err?.code ?? 'error', err?.message ?? (res.status === 429 ? 'Slow down a little.' : 'Something went wrong.'));
  }
  return data;
}

export const api = {
  create: (body: CreateGameRequest) => request<SessionResponse>('POST', '/games', body),
  join: (code: string, name: string, deviceId: string) => request<SessionResponse>('POST', `/games/${encodeURIComponent(code)}/join`, { name, deviceId }),
  get: (s: Session) => request<{ game: GameView }>('GET', `/games/${s.code}`, undefined, s).then((r) => r.game),
  submit: (s: Session, slot: number, word: string) => request<SubmitResponse>('POST', `/games/${s.code}/submit`, { slot, word }, s),
  hint: (s: Session, type: HintType, slot?: number) => request<HintResponse>('POST', `/games/${s.code}/hint`, { type, slot }, s),
  pass: (s: Session) => request<{ game: GameView }>('POST', `/games/${s.code}/pass`, {}, s).then((r) => r.game),
  newRound: (s: Session, settings: { length?: WordLength; difficulty?: Difficulty }) =>
    request<{ game: GameView }>('POST', `/games/${s.code}/new`, settings, s).then((r) => r.game),
  stats: (deviceId: string) => request<{ stats: PlayerStats }>('GET', `/stats/${deviceId}`).then((r) => r.stats),
};
