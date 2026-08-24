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

## Layout

```
wasm/          MinotaurX hasher, compiled from cpuminer-multi with emcc
src/           Bun server: Hono API, stratum client, mining hub, SQLite
src/protocol.ts  the WebSocket contract, imported by both server and browser
web/           Vite + React frontend and the mining web worker
scripts/       backup, browser check, algorithm ranking
```

One process, one SQLite file, one runtime dependency (`hono`). No workspaces: there is
nothing here that is versioned or deployed separately, so there are no boundaries for a
monorepo to manage.

The WASM exports one function, `mine(header, target, nonceStart, nonceEnd)`. The nonce
loop lives in C because crossing the JS/WASM boundary per hash costs more than a hash.
Stratum, job handling and merkle math stay in TypeScript on the server, so the browser
only ever spins nonces.

## Running it

```bash
cp .env.example .env      # set POOL_USER to your BTC address
./wasm/build.sh           # needs emscripten; clones cpuminer-multi on first run
bun install
bun run build:web
bun run start
```

Deploy with `docker compose up -d` — Caddy handles TLS, the app is one Bun process,
SQLite lives in a bind mount.

## Tests

```bash
bun run check             # typecheck, then hash vectors, framing, header assembly, normalizer
POOL_USER=<addr> bun test src/hub.integration.test.ts   # real shares against zpool
BASE=http://localhost:3000 bun scripts/browser-check.ts # consent, mine, shares land
```

Two tests carry most of the weight. The hash vector test pins the WASM build against
the native build of the same C: a mismatch raises no error, it just makes the pool
discard every share while everything looks healthy. The multiplex test checks that two
miners on one socket get different headers and that each accepted share lands on the
right listing - crossed credit is silent and the totals still look plausible.

## Licence

The WASM hasher derives from cpuminer-multi, which is GPLv2, so the build output is
GPLv2 as well.
