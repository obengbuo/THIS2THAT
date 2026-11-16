# FROM THIS TO THAT

The viral whiteboard word game couples play — rebuilt so two people can play it **on the same
board from anywhere**. Change one letter at a time to get from one word to another; every
correct word gets a marker underline and is locked for good.

- **Couples mode (long-distance):** one player starts a room and sends a link. Both write on the
  same whiteboard in real time, see each other's handwriting appear letter by letter, see who is
  on which line, and can send reactions (❤️ 😂 🔥 …).
- **Pass-the-Phone** and **Solo** modes, 4- and 5-letter words, Easy / Medium / Hard.
- No accounts. Fresh, verified-solvable puzzle every game.

```
COLD          start word (locked)
CORD   ←  one letter changed, real word, still leads to WARM → green underline, locked
CARD
WARD
WARM          target word (locked)
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

- Every word has exactly 4 (or 5) letters.
- Each word differs from the one above it by **exactly one letter, in place** — no rearranging,
  adding or removing.
- Every word must be in the game's dictionary and can be used only once per ladder.
- The board shows exactly as many empty lines as the **shortest** route needs, so there is no
  slack: a word is accepted only if a complete ladder is still possible with it in that line.
- Lines can be solved in any order — top-down, bottom-up, or from the middle — and **any** valid
  route is accepted, not one hidden answer.
- A correct word is underlined in green and **permanently locked**. Undo and Reset only affect
  unlocked drafts. Only **New Game** clears the board.

| Difficulty | Empty lines | Start/target vocabulary | Routes |
|-----------|-------------|-------------------------|--------|
| Easy      | 2–3         | everyday words          | at least 3 familiar routes |
| Medium    | 4–5         | everyday words          | at least 2 familiar routes |
| Hard      | 6–8         | familiar words          | at most 60 routes in total |

**Scoring:** `(1000 − 1 pt per 2 s (max 500) − 100 × hints − 25 × misses) × multiplier`, never
below 0. Multipliers: Easy 1.0, Medium 1.5, Hard 2.0.

**Hints** (each costs 100 points): *Show next move* highlights a line you can solve from the
words already on the board; *Reveal a letter* shows one letter of a word that fits the selected
line; *Suggest a word* writes a fitting word for you to check (it is not locked automatically).
Hints are computed from the current board, so they never lead to a dead end.

**Turns:** Pass-the-Phone always alternates. Couples can optionally "take turns". A turn passes
after every checked word (right or wrong) or when you press *pass*.

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

**Validating a word.** Because the number of lines equals the shortest distance, every full
solution is a shortest path, so each stretch between two fixed words must itself be a shortest
path. A word `W` fits line `i` exactly when

```
dist(nearest fixed word above, W) == lines between them
dist(W, nearest fixed word below) == lines between them
```

Two bounded BFS runs answer that exactly: any valid route is accepted, and a word that would
make the puzzle unfinishable is rejected. Rejections carry a reason: *Not a valid English word*,
*Change exactly one letter…*, *This word doesn't fit the selected position*, *That word is
already used*.

**Locking.** The game record carries a `version`; every write is a conditional write on it. If
two players submit at once, one write wins, the other is re-validated against the new state and
either locks its own line or is told the line was just taken. No operation exists that edits or
clears a locked line except starting a new round.

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

59 tests cover: valid 4- and 5-letter ladders, non-words, wrong lengths, multi-letter changes,
repeats, wrong-position words, alternative routes, any-order solving, locked words surviving
edit / undo / reset, generation at every difficulty, randomisation, recent-history exclusion,
fallbacks, hints, scoring, concurrent submissions to the same and to different lines, turn
order, reconnecting players, completion, statistics, and input rejection over HTTP.

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
| POST | `/games` | – | `{ length: 4\|5, difficulty, mode: solo\|couples\|pass, turnBased?, name, partnerName?, deviceId }` | `{ session: { code, playerId, token }, game }` |
| POST | `/games/{code}/join` | – | `{ name, deviceId }` | `{ session, game }` |
| GET  | `/games/{code}` | ✓ | – | `{ game }` |
| POST | `/games/{code}/submit` | ✓ | `{ slot, word }` | `{ accepted: true, game }` or `{ accepted: false, code, message, game }` |
| POST | `/games/{code}/hint` | ✓ | `{ type: next\|letter\|word, slot? }` | `{ hint, game }` |
| POST | `/games/{code}/pass` | ✓ | `{}` | `{ game }` |
| POST | `/games/{code}/new` | ✓ | `{ length?, difficulty? }` | `{ game }` (new round, same room) |
| GET  | `/stats/{deviceId}` | – | – | `{ stats }` |

`slot` is the zero-based index of the empty line. Rejection codes: `bad_length`, `not_a_word`,
`already_used`, `not_one_letter`, `wrong_position`, `slot_locked`. Types live in
`packages/shared-types`.

## 7. Real-time design

Connect to the WebSocket URL with `?code=…&playerId=…&token=…`; the connection is refused unless
the credentials match a player in that room.

| Direction | Message | Meaning |
|-----------|---------|---------|
| client → server | `{ type: "hello" }` | first message after open: re-sync state, announce presence |
| client → server | `{ type: "draft", slot, text }` | what I am writing right now (not saved) |
| client → server | `{ type: "focus", slot }` | which line my cursor is on |
| client → server | `{ type: "reaction", emoji }` | one of a fixed set of emoji |
| client → server | `{ type: "ping" }` | keep-alive (every 25 s) |
| server → client | `{ type: "state", game, event? }` | authoritative board after any change |
| server → client | `draft` / `focus` / `reaction` with `playerId` | partner signals, relayed only to the other player |

Clients ignore any state older than the one they hold (`round`, then `version`). Reconnection
uses exponential backoff; on every open the client sends `hello` and receives the full state.
Connections that have gone away are pruned the next time a broadcast fails.

## 8. DynamoDB schema

One on-demand table, keys `pk` (string) / `sk` (string), TTL attribute `expiresAt`.

| Item | pk | sk | Contents | TTL |
|------|----|----|----------|-----|
| Game session | `GAME#<code>` | `STATE` | settings, start/target, stored solution, lines with locked word + who locked it + revealed letters, players (hashed tokens), turn, timers, counters, result, recent pairs, `version` | 24 h after the last new round |
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
- **Input bounds:** room codes, device ids, slots, hint types and modes are checked against
  strict patterns; names are stripped of control and markup characters and cut to 16
  characters; request bodies are capped at 2 KB; WebSocket frames at 512 bytes with a fixed
  message vocabulary.
- **Room codes:** 6 characters from a 31-symbol alphabet without look-alikes (~887 million
  combinations), generated with a CSPRNG. Knowing a code lets you *join* a room that still has a
  free seat; rooms hold two players.
- **Sessions:** each player gets a 256-bit random token; only its SHA-256 hash is stored, and it
  is compared in constant time. Every game action and the WebSocket handshake require it.
- **Expiry:** rooms expire after 24 hours, connections after 3 hours.
- **Atomic locking / duplicate submissions:** conditional writes on a version number;
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

- **Not yet run against real AWS.** The CDK stack synthesizes and the bundled Lambda starts and
  serves `/health`, but nothing has been deployed from this repository, and `DynamoStore` has
  no automated test (it mirrors `MemoryStore`, which is tested). Do a `-c stage=dev` deploy and
  play a two-device game before pointing a domain at it.
- **Statistics are per browser.** They are keyed by an anonymous id in local storage, so they do
  not follow a player across devices. Cognito sign-in is the natural next step and is not
  implemented.
- **The dictionary is SCOWL-based**, so a few accepted or generated words will feel unusual, and
  some words players expect may be missing. Edit the size thresholds or blocklist in
  `packages/dictionary/scripts/build.mjs` and rebuild.
- **Pass-the-Phone is honour-based** — both players share one device and one session.
