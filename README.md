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

## Layout

```
wasm/          MinotaurX hasher, compiled from cpuminer-multi with emcc
src/           Bun server: Hono API, stratum client, mining hub, SQLite
web/           Vite + React frontend and the mining web worker
scripts/       spikes and the algorithm ranking helper
```

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
bun test                                  # hash vectors, header assembly, normalizer
POOL_USER=<addr> bun test src/hub.integration.test.ts   # real shares against zpool
```

The hash vector test is the important one: it pins the WASM build against the native
build of the same C. A mismatch there does not raise an error, it just makes the pool
discard every share while everything looks healthy.

## Licence

The WASM hasher derives from cpuminer-multi, which is GPLv2, so the build output is
GPLv2 as well.
