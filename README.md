# outmine

A public leaderboard where rank is paid in CPU time instead of money. Same shape as
outbid.lol — one board, listings competing for the top slot — except the currency is
browser mining, and the proceeds go to whoever runs the site.

No accounts. A visitor picks a listing and mines for it, exactly as an outbid.lol
visitor pays for someone's position. That also kills sybil farming on its own:
fifty tabs means fifty times the real work.

## How scoring cannot be cheated

The browser never reports its own score. It finds nonces; the server submits them to
zpool; a share counts only once **the pool accepts it**. A forged nonce is rejected
upstream, so there is nothing to fake and no heuristic to tune.

Verified end to end in `src/hub.integration.test.ts`: five random nonces produce five
rejections and zero score.

## The PoW gate

Adding a listing is free, but it does not reach the board until enough shares have
been mined for it. That is the entire anti-spam mechanism: a spammer pays in the same
currency everyone else competes in.

Pending listings stay visible in a separate "waiting for hashes" section with a
progress bar. They have to be — a gate that hides listings from the very people who
would mine them onto the board is a wall, and a fresh install would have nothing to
mine for at all.

## Pool connections

Miners share pool sockets, 16 to a socket. Neither extreme works: one socket per miner
means a few hundred TCP connections from one IP and a ban, while a single shared socket
runs into zpool's vardiff, which targets 5-15 submits per minute *per connection*. That
would cap the whole site at 5-15 shares a minute however many people mine - scoring
stays right on average, but a newcomer can mine five minutes and see zero, which is the
only feedback the game has.

Each miner on a socket gets its own extranonce2, so no two build the same header, and
submit replies are routed back by stratum request id. Without that routing the credit
lands on whoever happens to be next on the socket, and the totals still look plausible.

Connections reconnect on their own with exponential backoff. extranonce1 changes on
reconnect, so every header is rebuilt rather than reused.

## Abuse guard

A client can spray random nonces instead of hashing. That is not a shortcut: at this
pool difficulty a random nonce is valid about 1 in 8,600 times, which is exactly the
work honest mining needs. It is still a nuisance, because a flood of invalid shares
gets the *server's* IP banned by the pool. Ten consecutive unaccepted submits ends
that connection.

Counting rejects alone is not enough — a pool that has had enough simply stops
replying, so silence counts against the client too.

## What it earns

Measured, not estimated. Single WASM thread on an Apple M-series: **877 H/s**
(`bun run bench`).

```
0.000877 MH/s x 0.000122 BTC/MH/day x $76,700  =  $0.0000082 / thread-day
```

| Concurrently mining tabs (4 threads each) | Monthly |
|---|---|
| 100 | ~$10 |
| 1,000 | ~$100 |
| 10,000 | ~$1,000 |

Browser mining pays little; that is the honest baseline for 2026. The leaderboard is
what makes it worth anything: a normal page gets a 30-second visit, a board people
compete on gets a tab left open for hours.

**Algorithm choice is the only number that really moves revenue.** minotaurx pays
230x what yespower does per hash. yescrypt was measured too: one bare yespower round
costs the same as a whole minotaurx hash, so both algorithms run at the same speed in
a browser and minotaurx simply pays 1.4x more. Re-check with `bun scripts/rank-algos.ts`.

## Before deploying

Set `POOL_USER` to your payout address. The server refuses to start without it - mining
to an empty address credits nobody and nothing else would complain.

Back up the database on a schedule:

```
0 4 * * *  cd /srv/outmine && docker compose exec -T app bun scripts/backup.ts
```

`ADMIN_TOKEN` enables `DELETE /api/listings/:id`, the only way to take a listing down
short of editing SQLite by hand.

`ALLOWED_ORIGINS` is a security control, not a convenience. The mining socket accepts
any browser that reaches it, so without an origin policy another site could run
`new WebSocket("wss://your-host/ws")` and mine on its own visitors' CPUs against your
pool account, skipping the consent banner entirely. Left empty, only same-origin
requests are accepted, so an unconfigured deployment is closed rather than open. A
missing `Origin` header is allowed through: browsers always send one on a WebSocket
handshake, so the guard still holds, and non-browser clients have nobody else's CPU to
spend.

## Layout

```
packages/protocol/   the WebSocket contract, imported by both server and browser
packages/wasm/       MinotaurX hasher, compiled from cpuminer-multi with emcc
packages/server/     Bun server: Hono API, stratum client, mining hub, SQLite
packages/web/        Vite + React frontend and the mining web worker
scripts/             backup, browser check, algorithm ranking
```

Bun workspaces. Still one deployed process, one SQLite file and one runtime dependency
(`hono`); the split is about keeping the boundaries honest — the browser cannot reach
into server code, and the shared contract is a package rather than a relative path.

The WASM exports one function, `mine(header, target, nonceStart, nonceEnd)`. The nonce
loop lives in C because crossing the JS/WASM boundary per hash costs more than a hash.
Stratum, job handling and merkle math stay in TypeScript on the server, so the browser
only ever spins nonces.

## Running it

```bash
cp .env.example .env   # set POOL_USER to your BTC address
bun install
bun run build          # WASM then frontend, in dependency order
bun start
```

The WASM build needs emscripten (`brew install emscripten`) and clones cpuminer-multi
on first run.

Deploy with `docker compose up -d` — Caddy handles TLS, the app is one Bun process,
SQLite lives in a bind mount.

## Developing

```bash
bun run dev            # API and Vite together; Ctrl+C stops both
```

Open http://localhost:5173. The browser talks to the API on :3000 **directly** rather
than through a Vite proxy, because proxying a long-lived WebSocket to a server that
`bun --watch` restarts on every save floods the terminal with EPIPE. `VITE_API_ORIGIN`
in `packages/web/.env.development` points the client at it; production leaves the
variable unset and everything is same-origin again.

Cross-origin in development means `ALLOWED_ORIGINS=http://localhost:5173` has to be in
your `.env`.

Restarting the server mid-session is fine: the client reconnects and resumes mining for
the same listing on its own.

## Tests

```bash
bun run check     # typecheck, then hash vectors, framing, header assembly, normalizer

# Real shares against zpool; needs a server running and an explicit opt-in, because
# Bun auto-loads .env and POOL_USER alone would make `check` demand a live pool.
INTEGRATION=1 bun test packages/server/src/hub.integration.test.ts

BASE=http://localhost:5173 bun scripts/browser-check.ts  # consent, mine, shares land
```

Two tests carry most of the weight. The hash vector test pins the WASM build against
the native build of the same C: a mismatch raises no error, it just makes the pool
discard every share while everything looks healthy. The multiplex test checks that two
miners on one socket get different headers and that each accepted share lands on the
right listing - crossed credit is silent and the totals still look plausible.

## Licence

The WASM hasher derives from cpuminer-multi, which is GPLv2, so the build output is
GPLv2 as well.
