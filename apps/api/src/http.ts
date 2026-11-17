import type { ApiErrorBody, Session } from '@ftt/shared-types';
import { ApiError, badRequest, unauthorized } from './errors';
import type { GameService } from './service';

export interface HttpRequest {
  method: string;
  path: string;
  headers: Record<string, string | undefined>;
  body: string | null;
}
export interface HttpResponse {
  status: number;
  body: unknown;
}

const MAX_BODY = 2048;

function json(body: string | null): Record<string, unknown> {
  if (!body) return {};
  if (body.length > MAX_BODY) throw new ApiError(413, 'too_large', 'Request body too large.');
  try {
    const parsed = JSON.parse(body);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch {
    /* fall through */
  }
  throw badRequest('Body must be a JSON object.');
}

/** Authorization: Bearer <playerId>.<token> */
function session(req: HttpRequest, code: string): Session {
  const header = req.headers.authorization ?? req.headers.Authorization ?? '';
  const match = /^Bearer ([A-Za-z0-9_-]{6,32})\.([A-Za-z0-9_-]{20,64})$/.exec(header);
  if (!match) throw unauthorized('Missing or malformed credentials.');
  return { code, playerId: match[1]!, token: match[2]! };
}

/** Transport-neutral HTTP router shared by the Lambda handler and the dev server. */
export async function handleHttp(service: GameService, req: HttpRequest): Promise<HttpResponse> {
  try {
    const parts = req.path.replace(/\/+$/, '').split('/').filter(Boolean);
    const [root, id, action] = parts;
    const route = `${req.method} ${root ?? ''}${id ? '/:id' : ''}${action ? `/${action}` : ''}`;
    switch (route) {
      case 'GET health':
        return { status: 200, body: { ok: true } };
      case 'POST games':
        return { status: 201, body: await service.createGame(json(req.body)) };
      case 'GET games/:id':
        return { status: 200, body: { game: await service.getGame(session(req, id!)) } };
      case 'POST games/:id/join':
        return { status: 200, body: await service.joinGame(id, json(req.body)) };
      case 'POST games/:id/submit':
        return { status: 200, body: await service.submitWord(session(req, id!), json(req.body)) };
      case 'POST games/:id/undo':
        return { status: 200, body: { game: await service.undoWord(session(req, id!)) } };
      case 'POST games/:id/hint':
        return { status: 200, body: await service.requestHint(session(req, id!), json(req.body)) };
      case 'POST games/:id/pass':
        return { status: 200, body: { game: await service.passTurn(session(req, id!)) } };
      case 'POST games/:id/new':
        return { status: 200, body: { game: await service.newRound(session(req, id!), json(req.body)) } };
      case 'GET stats/:id':
        return { status: 200, body: { stats: await service.getStats(id) } };
      default:
        throw new ApiError(404, 'no_route', 'Not found.');
    }
  } catch (err) {
    if (err instanceof ApiError)
      return { status: err.status, body: { error: { code: err.code, message: err.message } } satisfies ApiErrorBody };
    console.error('unhandled_error', err);
    return { status: 500, body: { error: { code: 'internal', message: 'Something went wrong.' } } satisfies ApiErrorBody };
  }
}
