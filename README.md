# FROM THIS TO THAT

The viral whiteboard word game couples play — rebuilt so two people can play it **on the same
board from anywhere**. The board starts with one word. Change one letter, pass it to your
partner, and keep going, one letter each, until you reach the last word.

- **Couples mode (long-distance):** one player starts a room and sends a link. You take turns on
  the same whiteboard in real time, watch your partner's letter change as they write it, and can
  send reactions (❤️ 😂 🔥 …).
- **Pass-the-Phone** and **Solo** modes, 4- and 5-letter words, Easy / Medium / Hard.
- No accounts. Fresh, verified-solvable puzzle every game.

```
get from COLD to WARM        ← the goal line
COLD          the only word on the board at the start
CORD   ←  Ama changed one letter
CARD   ←  Kofi changed one letter
WARD   ←  Ama
WARM   ←  Kofi wrote the last word: done
```

## Contents

1. [Game mechanics](#1-game-mechanics)
2. [Architecture](#2-architecture)
3. [Puzzle generation and validation](#3-puzzle-generation-and-validation)
4. [Run it locally](#4-run-it-locally)
5. [Tests](#5-tests)
6. [API reference](#6-api-reference)
7. [Real-time design](#7-real-time-design)
8. [DynamoDB schema](#8-dynamodb-schema)
9. [Deploy to AWS](#9-deploy-to-aws)
10. [Monitoring and logging](#10-monitoring-and-logging)
11. [Security](#11-security)
12. [Estimated AWS cost](#12-estimated-aws-cost)
13. [Project structure](#13-project-structure)
14. [Known limits](#14-known-limits)

---

## 1. Game mechanics

- The board starts with **only the start word**. A goal line above it names the word to reach.
- A move changes **exactly one letter, in place**, of the last word on the board — no
  rearranging, adding or removing. Tap a letter, type its replacement, press **Check**.
- The new word must be in the game's dictionary and must not already be on the board. If it
  passes, it is written underneath and becomes the word the next move changes.
- **Two players take turns**, one letter each (Couples and Pass-the-Phone). A rejected word does
  not pass the turn; *pass* does. In Couples the first move waits for the partner to join, and
  the other player starts the next round. Solo makes every move alone.
- There is **no fixed number of moves and no hidden answer**: any route that reaches the target
  wins, and writing the target ends the game. Fewer moves scores more.
- Because words cannot repeat, a route can run into a dead end. **Take Back** removes the last
  word for both players, returns the turn to whoever wrote it, and counts as a miss.
  **New Game** wipes the board. A board holds at most 40 words.

| Difficulty | Fewest moves possible | Start/target vocabulary | Shortest routes |
|-----------|-----------------------|-------------------------|-----------------|
| Easy      | 3–4                   | everyday words          | at least 3 familiar ones |
| Medium    | 5–6                   | everyday words          | at least 2 familiar ones |
| Hard      | 7–9                   | familiar words          | at most 60 in total |

**Scoring:** `(1000 − 1 pt per 2 s (max 500) − 100 × hints − 25 × misses − 30 × moves beyond the
fewest possible) × multiplier`, never below 0. Multipliers: Easy 1.0, Medium 1.5, Hard 2.0.

**Hints** (each costs 100 points): *Which letter?* points at the letter of the current word to
change; *Show me the move* writes the next word for you to check (it is not played
automatically). Hints follow a shortest remaining route from the current word that avoids words
already on the board, and say so when the board is in a dead end.

## 2. Architecture

```
                         ┌──────────────────────────── AWS ────────────────────────────┐
 Browser (Next.js,       │                                                             │
 static export on  ──HTTPS──▶ API Gateway HTTP API ──▶ Lambda "http" ─┐                │
 Amplify Hosting)        │                                            ├─▶ DynamoDB     │
        ▲          ──WSS───▶ API Gateway WebSocket ──▶ Lambda "ws" ───┘   (one table)  │
        │                │            ▲                     │                          │
        └── state pushes ─────────────┴── PostToConnection ◀┘                          │
                         └─────────────────────────────────────────────────────────────┘
```

- **`packages/game-engine`** — pure TypeScript, no I/O: word graph, BFS, generator, placement
  validation, hints, scoring, and the client-side draft board. Independently tested.
- **`packages/dictionary`** — curated word lists (built from SCOWL) bundled into the backend.
- **`apps/api`** — `GameService` holds all rules and is transport-agnostic. It is wrapped by two
  Lambda handlers for AWS and by a small Node HTTP + WebSocket server for local development, so
  both run identical logic. Storage sits behind a `GameStore` interface (`DynamoStore` /
  `MemoryStore`).
- **`apps/web`** — Next.js + React + Tailwind + Motion. A fully static client; every rule is
  enforced by the server.
- **Commands go over HTTP, pushes go over WebSocket.** Submitting a word is a normal request
  with a normal response; the socket only carries state broadcasts and ephemeral partner
  signals (live drafts, cursor, reactions). If the socket drops, the client polls until it
  reconnects, so the board always converges.

The server is authoritative in every mode, including Solo. The stored solution never leaves the
server.

## 3. Puzzle generation and validation

**Word graph.** For each length, every dictionary word is a node; two words are joined when they
differ in exactly one position. The graph is built once per process using wildcard buckets
(`C*LD` → COLD, CHLD…) in about 10 ms and kept in memory.

**Dictionary tiers** (4-letter / 5-letter counts):

| Tier | Source | Words | Used for |
|------|--------|-------|----------|
| basic  | SCOWL size ≤ 20 | 923 / 1,371 | Easy and Medium start/target words |
| common | SCOWL size ≤ 35 | 1,863 / 3,468 | Hard start/target words; the guaranteed solution |
| all    | SCOWL size ≤ 60 | 2,528 / 5,036 | everything a player may enter |

Proper nouns and abbreviations are not in SCOWL's base lists; a blocklist removes offensive
words. Rebuild with `npm run build:dictionary`.

**Generating a puzzle** (`generatePuzzle`):

1. Pick a random start word (cryptographically secure RNG) from the difficulty's tier.
2. BFS from it twice: over the whole dictionary, and over familiar words only.
3. Candidate targets are words at the wanted distance whose familiar-only distance **equals**
   the true distance — which guarantees a solution made only of familiar words that fits the
   lines shown — and that are not in the recent-history exclusion set.
4. Pick a candidate at random, check the route counts for the difficulty, and sample a random
   familiar route as the stored solution.
5. On failure retry with a new start word (up to 60 attempts), then fall back to a table of 360
   pre-generated puzzles that is re-verified against the live graph before use.

**Recent history.** The last 60 start/target pairs per device (and per room) are excluded, in
both directions, and the generator avoids reusing the previous few start/target words.

**Validating a move.** A move is checked only against the last word on the board: the right
length, exactly one letter different in place, in the dictionary, and not already on the board.
Rejections carry a reason: *Words need exactly 4 letters*, *Change exactly one letter of COLD*,
*COLZ is not a word we know*, *CORD is already on the board*. The generator still guarantees a
shortest route of the advertised length exists; players are free to take a longer one.

**Hints and dead ends.** A breadth-first search from the target over the words not yet used
gives the shortest remaining route from the current word. Hints follow it; if there is none,
the hint says to take the last word back.

**Concurrency.** The game record carries a `version`; every write is a conditional write on it.
A move carries the number of words its author saw on the board, so a retry or double tap of a
move that already landed is a harmless success, and a move written against an older board is
turned away as stale without counting as a miss. Earlier words are never edited: the only
operations that remove words are Take Back (the last word) and New Game (the whole board).

## 4. Run it locally

Requires Node.js 20 or newer.

```bash
npm install
npm run dev          # API on http://localhost:4000, website on http://localhost:3000
```

Open http://localhost:3000. For Couples mode, start a game and open the invite link in a second
browser window (or on a phone on the same Wi-Fi using your computer's LAN address — in that case
start the API with `ALLOWED_ORIGINS='*' npm run dev`).

The local API keeps games in memory; restarting it clears them.

Environment variables:

| Variable | Where | Default | Purpose |
|----------|-------|---------|---------|
| `NEXT_PUBLIC_API_URL` | web (build time) | `http://<host>:4000` | HTTP API base URL |
| `NEXT_PUBLIC_WS_URL` | web (build time) | `ws://<host>:4000` | WebSocket URL |
| `PORT` | dev API | `4000` | dev server port |
| `ALLOWED_ORIGINS` | dev API, Lambdas | `http://localhost:3000` (dev) | comma-separated allowed site origins, or `*` |
| `TABLE_NAME` | Lambdas | set by CDK | DynamoDB table |
| `WS_CALLBACK_URL` | Lambdas | set by CDK | WebSocket management endpoint |

See `apps/web/.env.example`.

## 5. Tests

```bash
npm test             # engine + API + 10,000-puzzle stress test
npm run test:stress  # 60,000 puzzles
npm run typecheck
```

64 tests cover: valid 4- and 5-letter ladders, non-words, wrong lengths, multi-letter changes,
repeats, moves checked against the last word only, routes of any length and their score,
shortest remaining routes and dead ends, generation at every difficulty, randomisation,
recent-history exclusion, fallbacks, hints, scoring, the one-letter draft, strict turn order,
waiting for a partner, take-back, retried and racing submissions, reconnecting players,
completion, statistics, old-format rooms, and input rejection over HTTP.

Stress report from the last run (10,000 puzzles):

```
unique puzzles         9568        duplicate percentage   4.32%
solvability            100.00%     avg generation time    0.331 ms
fallback puzzles used  0           4-letter 5000 / 5-letter 5000
4-letter easy    1667 | slots {2: 487, 3: 1180}     5-letter easy    1667 | {2: 552, 3: 1115}
4-letter medium  1667 | slots {4: 809, 5: 858}      5-letter medium  1667 | {4: 784, 5: 883}
4-letter hard    1666 | slots {6: 608, 7: 605, 8: 453}   5-letter hard  1666 | {6: 559, 7: 553, 8: 554}
```

Puzzles are not globally unique — with pure random draws about 4% of 10,000 repeat an earlier
pair. Within a player's own history the exclusion window prevents repeats.

Not covered by automated tests: the React UI (verified by driving the built site in a real
browser with two players), and `DynamoStore` / the Lambda handlers against real AWS — see
[Known limits](#14-known-limits).

## 6. API reference

JSON over HTTPS. Authenticated routes need `Authorization: Bearer <playerId>.<token>` (returned
when you create or join a game). Errors are `{ "error": { "code", "message" } }`.

| Method | Path | Auth | Body | Returns |
|--------|------|------|------|---------|
| GET  | `/health` | – | – | `{ ok }` |
| POST | `/games` | – | `{ length: 4\|5, difficulty, mode: solo\|couples\|pass, name, partnerName?, deviceId }` | `{ session: { code, playerId, token }, game }` |
| POST | `/games/{code}/join` | – | `{ name, deviceId }` | `{ session, game }` |
| GET  | `/games/{code}` | ✓ | – | `{ game }` |
| POST | `/games/{code}/submit` | ✓ | `{ word, after? }` | `{ accepted: true, game }` or `{ accepted: false, code, message, game }` |
| POST | `/games/{code}/undo` | ✓ | `{}` | `{ game }` (takes back the last word) |
| POST | `/games/{code}/hint` | ✓ | `{ type: next\|letter\|word }` | `{ hint, game }` |
| POST | `/games/{code}/pass` | ✓ | `{}` | `{ game }` |
| POST | `/games/{code}/new` | ✓ | `{ length?, difficulty? }` | `{ game }` (new round, same room) |
| GET  | `/stats/{deviceId}` | – | – | `{ stats }` |

`game.chain` lists the words written after `game.start`, each with who wrote it. `after` is how
many words were on the board when the move was written. Rejection codes: `bad_length`,
`not_a_word`, `already_used`, `not_one_letter`, `stale`. Refusals such as `not_your_turn`,
`waiting`, `completed`, `board_full` and `nothing_to_undo` are HTTP 409 errors. Types live in
`packages/shared-types`.

## 7. Real-time design

Connect to the WebSocket URL with `?code=…&playerId=…&token=…`; the connection is refused unless
the credentials match a player in that room.

| Direction | Message | Meaning |
|-----------|---------|---------|
| client → server | `{ type: "hello" }` | first message after open: re-sync state, announce presence |
| client → server | `{ type: "draft", after, text, cursor }` | the letter I am changing right now (not saved) |
| client → server | `{ type: "reaction", emoji }` | one of a fixed set of emoji |
| client → server | `{ type: "ping" }` | keep-alive (every 25 s) |
| server → client | `{ type: "state", game, event? }` | authoritative board after any change |
| server → client | `draft` / `reaction` with `playerId` | partner signals, relayed only to the other player |

Clients ignore any state older than the one they hold (`round`, then `version`). Reconnection
uses exponential backoff; on every open the client sends `hello` and receives the full state.
Connections that have gone away are pruned the next time a broadcast fails.

## 8. DynamoDB schema

One on-demand table, keys `pk` (string) / `sk` (string), TTL attribute `expiresAt`.

| Item | pk | sk | Contents | TTL |
|------|----|----|----------|-----|
| Game session | `GAME#<code>` | `STATE` | settings, start/target, stored solution, the words written so far + who wrote each, hint letters for the next move, players (hashed tokens), turn, timers, counters, result, recent pairs, `version` | 24 h after the last new round |
| Connection | `GAME#<code>` | `CONN#<connectionId>` | player id | 3 h |
| Connection lookup | `CONN#<connectionId>` | `META` | room code (for `$disconnect`) | 3 h |
| Player profile | `PLAYER#<deviceId>` | `PROFILE` | statistics, recent puzzle history, `version` | 180 days idle |

Access patterns: get/put a game by code; query a room's connections (`pk = GAME#… AND
begins_with(sk, "CONN#")`); get a connection by id; get/put a profile by device id. No scans, no
secondary indexes.

## 9. Deploy to AWS

Prerequisites: an AWS account, credentials configured in your shell (`aws configure` or SSO),
and Node.js 20+. Nothing in this repository contains credentials.

### Backend

```bash
npm install
cd infrastructure/aws-cdk
npx cdk bootstrap                                   # once per account/region
npx cdk deploy -c allowedOrigins=https://YOUR_SITE_ORIGIN -c alarmEmail=you@example.com
```

The stack outputs `ApiUrl` and `WebSocketUrl`. Use `-c stage=dev` for a second, disposable
environment (its table is deleted with the stack; the `prod` table is retained).

For the very first deploy you may not know the site origin yet: deploy with the default
`allowedOrigins=*`, then redeploy with the real origin once the site is up.

### Website (Amplify Hosting)

The site is a static Next.js export, built with the two URLs above.

*Option A — let CDK create the Amplify app.* Store a GitHub personal access token (repo scope)
in AWS Secrets Manager, then:

```bash
npx cdk deploy \
  -c githubRepo=OWNER/REPO -c githubBranch=main \
  -c githubTokenSecretName=NAME_OF_THE_SECRET \
  -c domainName=example.com          # optional
```

Amplify builds from `amplify.yml` on every push. With `domainName`, Amplify issues and renews
the TLS certificate (AWS Certificate Manager) and, when the domain's hosted zone is in Route 53
in the same account, creates the DNS records.

*Option B — console.* In Amplify Hosting choose "Host web app", connect the repository, set the
monorepo root to `apps/web`, and add the environment variables `NEXT_PUBLIC_API_URL` and
`NEXT_PUBLIC_WS_URL`.

*Option C — any static host.*

```bash
NEXT_PUBLIC_API_URL=<ApiUrl> NEXT_PUBLIC_WS_URL=<WebSocketUrl> npm run build
# upload apps/web/out/
```

*Option D — manual Amplify deploy (no GitHub token).*

```bash
node scripts/deploy-web.mjs <ApiUrl> <WebSocketUrl>
```

Builds the site, creates (or reuses) an Amplify app named `from-this-to-that` with a `main`
branch, uploads `apps/web/out` as a zip and prints `https://main.<appId>.amplifyapp.com`.
Re-run it to publish a new version, then redeploy the backend with
`-c allowedOrigins=https://main.<appId>.amplifyapp.com`.

To check a deployment end to end (needs Playwright and Chromium):

```bash
npx tsx scripts/verify-live.ts https://main.<appId>.amplifyapp.com
```

### Useful commands

```bash
npm run synth     # render the CloudFormation template
npx cdk diff      # (in infrastructure/aws-cdk) preview changes
npx cdk destroy   # remove the stack
```

## 10. Monitoring and logging

- Both Lambdas write structured JSON logs to CloudWatch Logs (14-day retention):
  `game_created`, `puzzle_generated` (with attempts and whether the fallback was used),
  `profile_error`, `broadcast_error`.
- CloudWatch alarms, sent to an SNS topic (subscribe with `-c alarmEmail=…`): Lambda errors
  (HTTP and WebSocket), HTTP Lambda p95 latency over 3 s, HTTP API 5xx, DynamoDB throttling.
- API Gateway and Lambda publish their standard metrics (requests, latency, concurrency,
  connection counts) with no extra configuration.

## 11. Security

- **Server-side validation of everything.** The client is never trusted; the stored solution is
  never sent to it.
- **Input bounds:** room codes, device ids, move markers, hint types and modes are checked against
  strict patterns; names are stripped of control and markup characters and cut to 16
  characters; request bodies are capped at 2 KB; WebSocket frames at 512 bytes with a fixed
  message vocabulary.
- **Room codes:** 6 characters from a 31-symbol alphabet without look-alikes (~887 million
  combinations), generated with a CSPRNG. Knowing a code lets you *join* a room that still has a
  free seat; rooms hold two players.
- **Sessions:** each player gets a 256-bit random token; only its SHA-256 hash is stored, and it
  is compared in constant time. Every game action and the WebSocket handshake require it.
- **Expiry:** rooms expire after 24 hours, connections after 3 hours.
- **Atomic moves / duplicate submissions:** conditional writes on a version number;
  re-submitting the same word is idempotent.
- **Throttling:** API Gateway stage throttles (HTTP 50 req/s, burst 100; WebSocket 100/200); the
  dev server has a per-address token bucket.
- **CORS / origin:** the HTTP API only allows the configured origins; the WebSocket `$connect`
  handler checks the `Origin` header against the same list.
- **Transport:** API Gateway endpoints are HTTPS/WSS only.
- **IAM:** each Lambda may only Get/Put/Delete/Query items in this one table and post to
  connections of this one WebSocket stage.

## 12. Estimated AWS cost

Rough monthly estimates for us-east-1 on-demand list prices, excluding the free tier and data
transfer; a game is assumed to be ~40 HTTP requests, ~300 WebSocket messages (live drafts are
the bulk) and ~20 minutes of connection time for two players. Check the AWS Pricing Calculator
before relying on these.

| | Low | Moderate | High |
|---|---|---|---|
| Games per month | 3,000 | 100,000 | 3,000,000 |
| API Gateway HTTP ($1.00/M) | $0.12 | $4 | $120 |
| API Gateway WebSocket ($1.00/M msgs + $0.25/M connection-minutes) | $1 | $35 | $1,050 |
| Lambda (512 MB ARM, ~30 ms avg) | $0.10 | $3 | $90 |
| DynamoDB on-demand | $0.20 | $7 | $200 |
| CloudWatch logs + alarms | $0.50 | $3 | $40 |
| Amplify Hosting (static) | $0–1 | $3 | $50 |
| **Total (approx.)** | **under $5** | **about $55** | **about $1,550** |

Most of the low tier falls inside the AWS free tier. There are no always-on resources. The
largest lever at scale is WebSocket message volume: sending live drafts less often (for example
once per 300 ms instead of per keystroke) cuts it substantially.

## 13. Project structure

```
├── apps/
│   ├── web/                  Next.js client (whiteboard UI)
│   │   ├── app/              layout, page, global styles
│   │   ├── components/       Whiteboard, Keyboard, Game, Home, dialogs
│   │   └── lib/              API client, socket, state hook, sounds, storage
│   └── api/
│       └── src/
│           ├── service.ts    all game rules + rooms + hints + stats
│           ├── http.ts       HTTP router (shared by Lambda and dev server)
│           ├── dev-server.ts local HTTP + WebSocket server
│           ├── lambda/       API Gateway handlers
│           └── store/        GameStore: memory.ts, dynamo.ts
├── packages/
│   ├── game-engine/          graph, generator, validation, hints, scoring, board
│   ├── dictionary/           word lists + build script
│   └── shared-types/         API and socket types
├── infrastructure/aws-cdk/   CDK stack
├── tests/                    engine, API and stress tests
└── amplify.yml               Amplify Hosting build settings
```

UI components live in `apps/web/components` rather than a separate `packages/ui`, since only one
app uses them.

## 14. Known limits

- **Verified once on AWS, by hand-run script.** The stack was deployed to `us-east-1` and
  `scripts/verify-live.ts` played a full two-player Couples game through real browsers against
  the live API Gateway, Lambdas and DynamoDB table: create, join by invite link, presence,
  turn order, a rejected word, moves pushed over the WebSocket, reload and resume, take back,
  the win dialog, a new
  round, Solo and Pass-the-Phone starts, and Statistics. The CloudWatch logs showed no errors.
  The first run missed a real bug — CORS preflights were routed to the Lambda and got a 404,
  so real browsers could not start a game — because Playwright answers preflights itself when
  it serves files locally. The API now routes only GET and POST, the Lambda answers a stray
  OPTIONS with 204, and the script checks the preflight explicitly.
  That run served the built site files under the site origin (`SERVE_LOCAL=1`) because the test
  network could not reach `amplifyapp.com`; the Amplify deploy job succeeded, but the page as
  served by Amplify was not fetched by the test. `DynamoStore` still has no automated unit
  test, and nothing has been load-tested on AWS.
- **Statistics are per browser.** They are keyed by an anonymous id in local storage, so they do
  not follow a player across devices. Cognito sign-in is the natural next step and is not
  implemented.
- **The dictionary is SCOWL-based**, so a few accepted or generated words will feel unusual, and
  some words players expect may be missing. Edit the size thresholds or blocklist in
  `packages/dictionary/scripts/build.mjs` and rebuild.
- **Pass-the-Phone is honour-based** — both players share one device and one session.
