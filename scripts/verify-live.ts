// End-to-end check of a deployed stack, driven through real browsers.
//
//   npx tsx scripts/verify-live.ts https://main.<appId>.amplifyapp.com [ApiUrl]
//
// Plays a full two-player Couples game one letter at a time (create, join, presence, turns,
// a rejected word, live push, reload/resume, take back, win, new round), then starts Solo and
// Pass-the-Phone and opens Statistics. Also works against `npm run dev` (http://localhost:3000).
// Needs Playwright + Chromium available (`require('playwright')`).
//
// SERVE_LOCAL=1 serves apps/web/out under the site origin instead of fetching the site
// (for networks that cannot reach the site host). API and WebSocket traffic is always live.
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { changedIndex, getGraph, routeToTarget } from '../packages/game-engine/src';

const { chromium } = createRequire(import.meta.url)('playwright') as typeof import('playwright');

const SITE = (process.argv[2] ?? process.env.SITE_URL ?? '').replace(/\/+$/, '');
if (!/^https:\/\/|^http:\/\/localhost[:/]?/.test(SITE)) throw new Error('Usage: npx tsx scripts/verify-live.ts https://<site> [ApiUrl]');
const OUT = path.join(__dirname, '..', 'apps', 'web', 'out');
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.txt': 'text/plain', '.webmanifest': 'application/manifest+json',
};

const passed: string[] = [];
const ok = (what: string) => { passed.push(what); console.log(`  ✓ ${what}`); };
const T = { timeout: 20_000 };

async function main() {
  const proxy = process.env.HTTPS_PROXY && SITE.startsWith('https://') ? { server: process.env.HTTPS_PROXY } : undefined;
  const browser = await chromium.launch({ proxy });
  const problems: string[] = [];

  const newPlayer = async (tag: string) => {
    const context = await browser.newContext({ viewport: { width: 390, height: 780 }, hasTouch: true });
    if (process.env.SERVE_LOCAL) {
      await context.route(`${SITE}/**`, (route) => {
        const rel = decodeURIComponent(new URL(route.request().url()).pathname).replace(/^\/+/, '') || 'index.html';
        const file = [path.join(OUT, rel), path.join(OUT, rel, 'index.html'), path.join(OUT, 'index.html')].find((f) => existsSync(f) && !f.endsWith(path.sep) && path.extname(f))!;
        return route.fulfill({ status: 200, contentType: TYPES[path.extname(file)] ?? 'application/octet-stream', body: readFileSync(file) });
      });
    }
    const page = await context.newPage();
    const frames = { received: 0, sockets: 0 };
    page.on('websocket', (ws) => { frames.sockets++; ws.on('framereceived', () => frames.received++); });
    page.on('pageerror', (e) => problems.push(`${tag} pageerror: ${e.message}`));
    page.on('response', (r) => { if (r.status() >= 500) problems.push(`${tag} HTTP ${r.status()} ${r.url()}`); });
    return { page, frames, tag };
  };
  type Player = Awaited<ReturnType<typeof newPlayer>>;

  const session = (p: Player) => p.page.evaluate(() => JSON.parse(localStorage.getItem('ftt.session') ?? 'null'));
  /** Fetches the authoritative game from the live API, from inside the page (real Origin). */
  const fetchGame = (p: Player) => p.page.evaluate(async () => {
    const s = JSON.parse(localStorage.getItem('ftt.session')!);
    const api = (performance.getEntriesByType('resource') as PerformanceResourceTiming[]).map((e) => e.name).find((n) => /\/games(\/|$)/.test(n))!;
    const res = await fetch(`${new URL(api).origin}/games/${s.code}`, { headers: { authorization: `Bearer ${s.playerId}.${s.token}` } });
    return (await res.json()).game;
  });
  type View = { start: string; target: string; length: 4 | 5; round: number; turn: string | null; status: string; wrongAttempts: number; chain: { word: string; by: string }[] };
  const current = (g: View) => g.chain.at(-1)?.word ?? g.start;
  const routeFor = (g: View) => routeToTarget(getGraph(g.length), [g.start, ...g.chain.map((c) => c.word)], g.target)!;
  /** Changes one letter of the last word on the board and presses Check. */
  const play = async (p: Player, from: string, to: string) => {
    const i = changedIndex(from, to);
    await p.page.locator(`button[aria-label^="Letter ${i + 1}:"]`).click();
    await p.page.locator(`.touch-keyboard button:text-is("${to[i]}")`).click();
    await p.page.locator('[aria-label="Check word"]').click();
  };
  const sees = (p: Player, n: number, word: string) => p.page.locator(`[aria-label^="Word ${n}: ${word}"]`).waitFor(T);
  const gone = (p: Player, n: number) => p.page.locator(`[aria-label^="Word ${n}:"]`).waitFor({ ...T, state: 'detached' });
  const canType = (p: Player) => p.page.locator('.touch-keyboard button:text-is("A")').isEnabled();
  const pick = (p: Player, label: string) => p.page.getByRole('button', { name: label }).first().click();
  const closeDialogs = async (p: Player) => {
    for (const b of await p.page.locator('[role="dialog"] [aria-label="Close"]').all()) await b.click().catch(() => {});
  };

  // ── Couples ────────────────────────────────────────────────────────────────
  console.log('Couples');
  const a = await newPlayer('A');
  const b = await newPlayer('B');
  await a.page.goto(SITE);

  // Playwright answers CORS preflights itself whenever it intercepts requests (SERVE_LOCAL),
  // so check the real one explicitly: a browser needs a 2xx with the site's origin allowed.
  await a.page.waitForLoadState('networkidle');
  const apiBase = (process.argv[3] ?? process.env.API_URL)?.replace(/\/+$/, '') ?? await a.page.evaluate(async () => {
    for (const src of Array.from(document.scripts, (s) => s.src).filter(Boolean)) {
      const m = /https:\/\/[a-z0-9]+\.execute-api\.[a-z0-9-]+\.amazonaws\.com|http:\/\/localhost:4000/.exec(await (await fetch(src)).text());
      if (m) return m[0];
    }
    return null;
  });
  if (!apiBase) throw new Error('could not find the API URL in the site bundle');
  for (const [reqMethod, reqPath, reqHeaders] of [['POST', '/games', 'content-type'], ['GET', '/games/ABCDEF', 'authorization']] as const) {
    const pre = await a.page.context().request.fetch(`${apiBase}${reqPath}`, {
      method: 'OPTIONS', headers: { origin: SITE, 'access-control-request-method': reqMethod, 'access-control-request-headers': reqHeaders },
    });
    const h = pre.headers();
    if (!pre.ok() || h['access-control-allow-origin'] !== SITE || !h['access-control-allow-methods']?.includes(reqMethod) || !h['access-control-allow-headers']?.includes(reqHeaders))
      throw new Error(`CORS preflight for ${reqMethod} ${reqPath} failed: HTTP ${pre.status()} ${JSON.stringify(h)}`);
  }
  const foreign = await a.page.context().request.fetch(`${apiBase}/games`, {
    method: 'OPTIONS', headers: { origin: 'https://not-the-site.example', 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' },
  });
  if (['https://not-the-site.example', '*'].includes(foreign.headers()['access-control-allow-origin'] ?? '')) throw new Error('API allows a foreign origin');
  ok('CORS preflight succeeds for the site origin and not for another origin');
  await pick(a, 'Couples'); await pick(a, '4 Letters'); await pick(a, 'Medium');
  await a.page.getByLabel('Your name').fill('Ama');
  await a.page.getByRole('button', { name: 'START GAME' }).click();
  await a.page.locator('[aria-label="Whiteboard"]').waitFor(T);
  const { code } = await session(a);
  ok(`A created room ${code} (POST /games → DynamoDB)`);

  await b.page.goto(`${SITE}/?room=${code}`);
  await b.page.locator('[role="dialog"]').getByLabel('Your name').fill('Kofi');
  await b.page.getByRole('button', { name: 'Join the board' }).click();
  await b.page.locator('[aria-label="Whiteboard"]').waitFor(T);
  ok('B joined through the invite link');

  await a.page.getByText('● here').waitFor(T);
  ok('A sees B as "● here" (presence pushed over WebSocket)');
  await closeDialogs(a);

  let game: View = await fetchGame(a);
  console.log(`  ${game.start} → ${game.target}, can be done in ${routeFor(game).length} moves`);
  const ids = { a: (await session(a)).playerId as string, b: (await session(b)).playerId as string };
  const mover = (g: View) => (g.turn === ids.a ? a : b);

  if ((await a.page.locator('.word-row').count()) !== 1 || !(await a.page.locator(`[aria-label^="Start word ${game.start}"]`).count()))
    throw new Error('the board should start with only the start word written on it');
  if (!(await a.page.locator(`[aria-label="Goal: get from ${game.start} to ${game.target}"]`).count())) throw new Error('goal line missing');
  ok(`The board shows only ${game.start}; the goal line names ${game.target}`);

  if (!(await canType(a)) || (await canType(b))) throw new Error('A should move first and B should have to wait');
  ok('A moves first; B has to wait for their turn');

  const junk = ['Q', 'X', 'Z', 'J'].map((ch) => ch + game.start.slice(1)).find((w) => !getGraph(game.length).index.has(w))!;
  await play(a, game.start, junk);
  await a.page.waitForFunction(() => document.querySelector('[role="status"]')?.textContent, undefined, T);
  game = await fetchGame(a);
  if (game.chain.length || game.wrongAttempts < 1 || game.turn !== ids.a) throw new Error(`wrong word was not handled: ${JSON.stringify(game)}`);
  ok(`A's non-word ${junk} was rejected, counted, and did not pass the turn`);

  const before = b.frames.received;
  const first = routeFor(game)[0]!;
  await play(a, game.start, first);
  await sees(a, 1, first);
  await sees(b, 1, first);
  if (b.frames.received <= before) throw new Error('B saw the word but received no WebSocket frame');
  await b.page.waitForFunction(() => !(document.querySelector('.touch-keyboard button') as HTMLButtonElement).disabled, undefined, T);
  if (await canType(a)) throw new Error('A can still type after moving');
  ok(`A changed one letter (${game.start} → ${first}); B saw it via WebSocket push and now has the turn`);

  game = await fetchGame(b);
  const second = routeFor(game)[0]!;
  await play(b, first, second);
  await sees(b, 2, second);
  await sees(a, 2, second);
  ok(`B changed one letter (${first} → ${second}); A saw it`);

  await b.page.reload();
  await sees(b, 1, first);
  await sees(b, 2, second);
  ok('B reloaded and resumed the same board');

  await a.page.getByRole('button', { name: 'Take Back' }).click();
  await gone(a, 2);
  await gone(b, 2);
  game = await fetchGame(b);
  if (game.chain.length !== 1 || game.turn !== ids.b) throw new Error(`take back went wrong: ${JSON.stringify(game)}`);
  ok('Take Back removed the last word for both and returned the turn to B');

  for (let n = 0; game.status === 'playing'; n++) {
    if (n > 20) throw new Error('game did not finish');
    const next = routeFor(game)[0]!;
    await play(mover(game), current(game), next);
    await sees(a, game.chain.length + 1, next);
    await sees(b, game.chain.length + 1, next);
    game = await fetchGame(a);
  }
  if (current(game) !== game.target) throw new Error('game completed without reaching the target');
  if (game.chain.some((c, i) => i > 0 && c.by === game.chain[i - 1]!.by)) throw new Error('players did not alternate');
  for (const p of [a, b]) await p.page.getByRole('dialog', { name: 'YOU GOT FROM THIS TO THAT!' }).waitFor(T);
  ok(`They alternated to ${game.target}; both see "YOU GOT FROM THIS TO THAT!"`);

  await a.page.getByRole('dialog', { name: 'YOU GOT FROM THIS TO THAT!' }).getByRole('button', { name: 'New Game' }).click();
  for (const p of [a, b]) {
    await p.page.waitForFunction(() => document.querySelectorAll('.word-row').length === 1 && !!document.querySelector('[aria-label^="Start word"]'), undefined, T);
    const g: View = await fetchGame(p);
    if (g.round !== game.round + 1 || g.status !== 'playing' || g.chain.length) throw new Error(`${p.tag} round ${g.round}, status ${g.status}`);
  }
  ok('New Game dealt a new round to both players');
  if (a.frames.sockets < 1 || b.frames.sockets < 1) throw new Error('a player never opened a WebSocket');

  // ── Solo, Pass-the-Phone, Statistics ───────────────────────────────────────
  console.log('Other modes');
  const solo = await newPlayer('solo');
  await solo.page.goto(SITE);
  await pick(solo, 'Solo');
  await solo.page.getByRole('button', { name: 'START GAME' }).click();
  await solo.page.locator('[aria-label^="Start word"]').waitFor(T);
  ok('Solo game starts');

  const pass = await newPlayer('pass');
  await pass.page.goto(SITE);
  await pick(pass, 'Pass-the-Phone');
  await pass.page.getByLabel('Player 1').fill('Ama');
  await pass.page.getByLabel('Player 2').fill('Kofi');
  await pass.page.getByRole('button', { name: 'START GAME' }).click();
  await pass.page.locator('[aria-label^="Start word"]').waitFor(T);
  ok('Pass-the-Phone game starts');

  await a.page.locator('[aria-label="Leave game"]').click();
  const stats = a.page.waitForResponse((r) => r.url().includes('/stats/'), T);
  await a.page.getByRole('button', { name: 'Statistics' }).click();
  const res = await stats;
  const body = await res.json();
  if (res.status() !== 200 || !body.stats) throw new Error(`stats: HTTP ${res.status()} ${JSON.stringify(body)}`);
  await a.page.locator('[role="dialog"]').waitFor(T);
  console.log(`  stats: ${JSON.stringify(body.stats)}`);
  ok('Statistics dialog loads from the live API');

  await browser.close();
  if (problems.length) throw new Error(`Problems seen during the run:\n${problems.join('\n')}`);
  console.log(`\nAll ${passed.length} live checks passed against ${SITE}`);
}

main().catch((err) => { console.error(`\nFAILED after ${passed.length} checks:`, err); process.exit(1); });
