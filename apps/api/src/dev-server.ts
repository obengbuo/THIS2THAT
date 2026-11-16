/**
 * Local development server: the same GameService the Lambdas run, backed by an
 * in-memory store, served over plain HTTP + WebSocket on one port.
 *
 *   npm run dev:api          →  http://localhost:4000  /  ws://localhost:4000
 */
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { WebSocketServer, type WebSocket } from 'ws';
import { handleHttp } from './http';
import { GameService, type Broadcaster } from './service';
import { MemoryStore } from './store/memory';

const PORT = Number(process.env.PORT ?? 4000);
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ?? 'http://localhost:3000').split(',').map((o) => o.trim());

const sockets = new Map<string, WebSocket>();
const broadcaster: Broadcaster = {
  async send(connectionId, payload) {
    const socket = sockets.get(connectionId);
    if (!socket || socket.readyState !== socket.OPEN) return false;
    socket.send(payload);
    return true;
  },
};
const service = new GameService(new MemoryStore(), broadcaster, {
  logger: (event, data) => console.log(`[api] ${event}`, JSON.stringify(data)),
});

// Basic abuse prevention: token bucket per client address (API Gateway does this in AWS).
const buckets = new Map<string, { tokens: number; at: number }>();
const RATE = 10; // requests per second
const BURST = 30;
function allow(ip: string): boolean {
  const now = Date.now();
  const bucket = buckets.get(ip) ?? { tokens: BURST, at: now };
  bucket.tokens = Math.min(BURST, bucket.tokens + ((now - bucket.at) / 1000) * RATE);
  bucket.at = now;
  buckets.set(ip, bucket);
  if (bucket.tokens < 1) return false;
  bucket.tokens -= 1;
  return true;
}
setInterval(() => buckets.clear(), 10 * 60_000).unref();

const server = createServer(async (req, res) => {
  const origin = req.headers.origin ?? '';
  const allowOrigin = ALLOWED_ORIGINS.includes('*') ? '*' : ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0]!;
  const cors = {
    'access-control-allow-origin': allowOrigin,
    'access-control-allow-headers': 'content-type,authorization',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-max-age': '600',
    vary: 'origin',
  };
  if (req.method === 'OPTIONS') return void res.writeHead(204, cors).end();
  if (!allow(req.socket.remoteAddress ?? 'unknown'))
    return void res.writeHead(429, { ...cors, 'content-type': 'application/json' }).end(JSON.stringify({ error: { code: 'throttled', message: 'Slow down a little.' } }));

  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 4096) return void res.writeHead(413, cors).end();
  }
  const url = new URL(req.url ?? '/', 'http://localhost');
  const out = await handleHttp(service, {
    method: req.method ?? 'GET',
    path: url.pathname,
    headers: req.headers as Record<string, string | undefined>,
    body: body || null,
  });
  res.writeHead(out.status, { ...cors, 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(out.body));
});

const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 });
server.on('upgrade', async (req, socket, head) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const connectionId = randomUUID();
  try {
    await service.connect(connectionId, Object.fromEntries(url.searchParams));
  } catch {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    return void socket.destroy();
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    sockets.set(connectionId, ws);
    ws.on('message', (data) => void service.message(connectionId, data.toString()).catch((e) => console.error('[api] ws message', e)));
    ws.on('close', () => {
      sockets.delete(connectionId);
      void service.disconnect(connectionId).catch((e) => console.error('[api] ws close', e));
    });
  });
});

server.listen(PORT, () => console.log(`[api] FROM THIS TO THAT dev API on http://localhost:${PORT}`));
