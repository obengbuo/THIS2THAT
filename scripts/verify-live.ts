// End-to-end check of a deployed stack, driven through real browsers.
//
//   npx tsx scripts/verify-live.ts https://main.<appId>.amplifyapp.com
//
// Plays a full two-player Couples game (create, join, presence, reject, lock, live push,
// reload/resume, win, new round), then starts Solo and Pass-the-Phone and opens Statistics.
// Needs Playwright + Chromium available (`require('playwright')`).
//
// SERVE_LOCAL=1 serves apps/web/out under the site origin instead of fetching the site
// (for networks that cannot reach the site host). API and WebSocket traffic is always live.
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { getGraph, solve } from '../packages/game-engine/src';

const { chromium } = createRequire(import.meta.url)('playwright') as typeof import('playwright');

const SITE = (process.argv[2] ?? process.env.SITE_URL ?? '').replace(/\/+$/, '');
if (!SITE.startsWith('https://')) throw new Error('Usage: npx tsx scripts/verify-live.ts https://<site>');
const OUT = path.join(__dirname, '..', 'apps', 'web', 'out');
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.txt': 'text/plain', '.webmanifest': 'application/manifest+json',
};

const passed: string[] = [];
const ok = (what: string) => { passed.push(what); console.log(`  ✓ ${what}`); };
const T = { timeout: 20_000 };

async function main() {
  const proxy = process.env.HTTPS_PROXY ? { server: process.env.HTTPS_PROXY } : undefined;
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
  const write = async (p: Player, slot: number, word: string) => {
    await p.page.locator(`[aria-label^="Word ${slot + 1}:"]`).click();
    for (let i = 0; i < 6; i++) await p.page.locator('[aria-label="Erase letter"]').click();
    for (const ch of word) await p.page.locator(`.touch-keyboard button:text-is("${ch}")`).click();
    await p.page.locator('[aria-label="Check word"]').click();
  };
  const locked = (p: Player, slot: number, word: string) => p.page.locator(`[aria-label="Word ${slot + 1}: ${word}, locked"]`).waitFor(T);
  const pick = (p: Player, label: string) => p.page.getByRole('button', { name: label }).first().click();
  const closeDialogs = async (p: Player) => {
    for (const b of await p.page.locator('[role="dialog"] [aria-label="Close"]').all()) await b.click().catch(() => {});
  };

  // ── Couples ────────────────────────────────────────────────────────────────
  console.log('Couples');
  const a = await newPlayer('A');
  const b = await newPlayer('B');
  await a.page.goto(SITE);
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

  let game = await fetchGame(a);
  const solution = solve(getGraph(game.length), [game.start, ...game.slots.map(() => null), game.target])!;
  const last = game.slots.length - 1;
  console.log(`  ${game.start} → ${game.target}, ${game.slots.length} slots`);

  await write(a, 0, 'ZZZZ'.slice(0, game.length));
  await a.page.waitForFunction(() => document.querySelector('[role="status"]')?.textContent, undefined, T);
  game = await fetchGame(a);
  if (game.slots[0].word || game.wrongAttempts < 1) throw new Error(`wrong word was not rejected: ${JSON.stringify(game.slots[0])}`);
  ok('A\'s wrong word was rejected and counted');

  const before = b.frames.received;
  await write(a, 0, solution[1]!);
  await locked(a, 0, solution[1]!);
  await locked(b, 0, solution[1]!);
  if (b.frames.received <= before) throw new Error('B saw the lock but received no WebSocket frame');
  ok(`A locked ${solution[1]}; B saw it lock via WebSocket push`);

  await write(b, last, solution[last + 1]!);
  await locked(b, last, solution[last + 1]!);
  await locked(a, last, solution[last + 1]!);
  ok(`B locked the last line (${solution[last + 1]}); A saw it`);

  await b.page.reload();
  await locked(b, 0, solution[1]!);
  await locked(b, last, solution[last + 1]!);
  ok('B reloaded and resumed the same board');

  for (let i = 1; i < last; i++) {
    const p = i % 2 ? b : a;
    await write(p, i, solution[i + 1]!);
    await locked(a, i, solution[i + 1]!);
    await locked(b, i, solution[i + 1]!);
  }
  for (const p of [a, b]) await p.page.getByRole('dialog', { name: 'YOU GOT FROM THIS TO THAT!' }).waitFor(T);
  ok('Ladder finished; both see "YOU GOT FROM THIS TO THAT!"');

  await a.page.getByRole('dialog', { name: 'YOU GOT FROM THIS TO THAT!' }).getByRole('button', { name: 'New Game' }).click();
  for (const p of [a, b]) {
    await p.page.waitForFunction((round) => !document.querySelector('[aria-label$=", locked"]') && !!document.querySelector('[aria-label="Word 1: empty"]') && round, game.round, T);
    const g = await fetchGame(p);
    if (g.round !== game.round + 1 || g.status !== 'playing') throw new Error(`${p.tag} round ${g.round}, status ${g.status}`);
  }
  ok('New Game dealt a new round to both players');
  if (a.frames.sockets < 1 || b.frames.sockets < 1) throw new Error('a player never opened a WebSocket');

  // ── Solo, Pass-the-Phone, Statistics ───────────────────────────────────────
  console.log('Other modes');
  const solo = await newPlayer('solo');
  await solo.page.goto(SITE);
  await pick(solo, 'Solo');
  await solo.page.getByRole('button', { name: 'START GAME' }).click();
  await solo.page.locator('[aria-label="Word 1: empty"]').waitFor(T);
  ok('Solo game starts');

  const pass = await newPlayer('pass');
  await pass.page.goto(SITE);
  await pick(pass, 'Pass-the-Phone');
  await pass.page.getByLabel('Player 1').fill('Ama');
  await pass.page.getByLabel('Player 2').fill('Kofi');
  await pass.page.getByRole('button', { name: 'START GAME' }).click();
  await pass.page.locator('[aria-label="Word 1: empty"]').waitFor(T);
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
