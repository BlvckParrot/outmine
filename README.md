# outmine

[![licence: GPL-2.0](https://img.shields.io/badge/licence-GPL--2.0-2f6f4e)](LICENSE)
[![image](https://github.com/BlvckParrot/outmine/actions/workflows/image.yml/badge.svg)](https://github.com/BlvckParrot/outmine/actions/workflows/image.yml)
[![runtime: Bun](https://img.shields.io/badge/runtime-Bun%201.4-b8860b)](https://bun.sh)

A public leaderboard where rank is paid in CPU time instead of money. Same shape as
outbid.lol — one board, listings competing for the top slot — except the currency is
browser mining, and the proceeds go to whoever runs the site.

No accounts. A visitor picks a listing and mines for it, exactly as an outbid.lol
visitor pays for someone's position. That also kills sybil farming on its own:
fifty tabs means fifty times the real work.

![The outmine board: the price of first place, the claim form, trending and activity side by side, then the top three as cards and the rest as a table](docs/board.png)

**The product** — [Consent](#consent) · [How scoring cannot be cheated](#how-scoring-cannot-be-cheated) ·
[The PoW gate](#the-pow-gate) · [Two boards, one table](#two-boards-one-table) ·
[Sharing](#sharing) · [Owning a listing](#owning-a-listing) · [The look](#the-look)

**The machinery** — [Storage](#storage) · [Pool connections](#pool-connections) ·
[Capacity](#capacity) · [Abuse guard](#abuse-guard) · [What it earns](#what-it-earns) ·
[What it counts](#what-it-counts)

**Running it** — [Before deploying](#before-deploying) · [Configuration](#configuration) ·
[Layout](#layout) · [The API](#the-api) · [Running it](#running-it) · [Deploying](#deploying) ·
[Developing](#developing) · [Tests](#tests) · [Contributing](#contributing) · [Licence](#licence)

## Consent

Nothing hashes until a visitor says so, and the site is built so that this stays true
rather than being a promise in a README.

A banner is the first thing on the page, and it says what this is in one line: *this
site mines cryptocurrency with your CPU*, the proceeds go to the site owner, it will use
battery. Only after it is accepted does the page offer a listing to mine for.

Accepting it is not the same as starting. **A stored consent still does not start the
CPU on its own** — a returning visitor is not asked twice, but they still have to press
a button before a single hash is computed. That is deliberate and it is the one property
worth testing rather than trusting: `scripts/browser-check.ts` asserts exactly it — it
reloads with consent already stored, and fails if anything is mining afterwards
(`didNotAutostart`).

Consent is versioned (`CONSENT_VERSION` in `packages/web/src/storage.ts`). Bumping it
invalidates every stored answer, which is the only honest way to ask again after the
terms of what is mined, or how much, have changed.

While mining, the panel carries a thread count and a throttle, both movable mid-run, and
a stop button that ends it. Mining runs only while the tab is open; closing it is also
stopping.

`ALLOWED_ORIGINS` is the server-side half of this. Left empty, only same-origin requests
open a mining socket. Without such a policy any other website could point a
`new WebSocket("wss://your-host/ws")` at your deployment and mine on *its* visitors'
CPUs against your pool account, with no banner anywhere. See
[Before deploying](#before-deploying).

## How scoring cannot be cheated

The browser never reports its own score. It finds nonces; the server submits them to
zpool; a share counts only once **the pool accepts it**. A forged nonce is rejected
upstream, so there is nothing to fake and no heuristic to tune.

Verified end to end in `packages/server/src/hub.integration.test.ts`: five random nonces produce five
rejections and zero score.

## The PoW gate

Adding a listing is free, but it does not reach the board until enough shares have
been mined for it. That is the entire anti-spam mechanism: a spammer pays in the same
currency everyone else competes in.

Pending listings stay visible in a separate "waiting for hashes" section with a
progress bar. They have to be — a gate that hides listings from the very people who
would mine them onto the board is a wall, and a fresh install would have nothing to
mine for at all.

## Storage

SQLite in WAL mode with `synchronous = NORMAL`, the usual pairing. At the default
`FULL` every commit waits for an fsync, including the one behind every outbound click.
`NORMAL` cannot corrupt the database; a power cut can cost the last transactions, which
here is at most one flush interval of shares.

Two indexes carry the whole `ORDER BY` of the two lists the hub rebuilds on every
broadcast, tie-breaker included, so SQLite walks them in order instead of sorting into
a temporary B-tree. Checked with `EXPLAIN QUERY PLAN`, which is also the way to notice
when a query stops using them.

Schema changes travel in `db.ts` as an append-only list, with `PRAGMA user_version`
recording how far a database has got. SQLite has no `ADD COLUMN IF NOT EXISTS`, and the
`CREATE TABLE IF NOT EXISTS` in `schema.sql` is a no-op on a database that already
exists, so without this only fresh installs would ever see a new column.

## Two boards, one table

All-time score never decays, which is the right rule for a leaderboard and a bad one
for anybody arriving late: the launch week would own the top forever. The 24h tab
scores the same listings by what was mined for them today, and it is a `WHERE` clause
rather than a second table — the flush loop already writes hourly buckets to
`share_buckets`.

Search and paging live on `/api/board` too. The WebSocket only ever pushes the
unfiltered top of the board, so as soon as a filter is on, the client stops applying
those pushes and drives the list over HTTP instead. Otherwise the next broadcast
overwrites what the visitor asked for with the default list.

## Sharing

outbid.lol grew because every lost position was a reason to post, and every post had
somewhere to point. The equivalent here:

- `/l/:id` — a listing's own page, and the URL a share points at.
- `/og/:id.png` — the link preview card, drawn as SVG and rasterised with resvg.
  It has to be a raster: X, Slack and Facebook all refuse an SVG as `og:image`.
- `/badge/:id.svg` — a shields-style badge for a README, with the copyable snippet on
  the listing page.
- Per-listing `og:` tags are stitched into `index.html` by the server, because a
  crawler runs no JavaScript and the SPA would hand it the generic ones.

The bundled font is passed to resvg explicitly and system fonts are switched off. A
slim container has no fonts installed, so relying on fontconfig produces a card that
looks right in development and is blank in production.

`PUBLIC_ORIGIN` matters here and nowhere else: `og:image` must be absolute, and behind
Caddy the hop to the app is plain http, so a URL derived from the request would
advertise the card over http and the preview would be dropped.

## Owning a listing

Creating one returns an edit token, printed exactly once; only its SHA-256 is stored.
The browser that created the listing keeps it under `outmine:owned` and pins that
listing above every page - its queue progress, a button to mine for it, and an editor
for the name and tagline over `PATCH /api/listings/:id`. Before that panel existed the
token was a random string under a form and the route it unlocks had no caller.

A listing can also carry its own icon in place of the letter avatar, once it has mined
its way to `ICON_MIN_POINTS`. The gate is the point: a logo is the loudest thing on a
row, and an upload form on a listing anyone can create with one POST is an invitation.
The browser redraws whatever was picked onto a 128px canvas and `PUT`s the PNG, so the
server receives a known size whatever was chosen - but it re-checks the bytes anyway,
because the endpoint is reachable with curl. PNG only, judged by signature and IHDR
rather than by a Content-Type the uploader chose: a dimension cap is what stops a few
hundred bytes from decompressing into gigabytes, and SVG is refused outright because it
is a scriptable document that would be served from our own origin. The bytes live in
the row and are served from `/icon/:id.png`; no board query ever selects them, only a
`has_icon` flag, or fifty rows would be a megabyte of snapshot every two seconds.

## The look

The layout is outbid.lol's, deliberately: a status pill, a headline that names what
the top costs, one field to claim a spot, trending and activity side by side, then a
board whose first three places are cards and whose rest is a table. It is a shape
people have already learned, and the argument here is the same one - rank is for sale,
this is the price.

The palette is not theirs. One accent, gold, over warm neutrals, in a light theme and
a dark one that a button in the header switches between. Gold is a light colour, which
is the one place the token set differs in structure from the usual: `--primary-foreground`
is white on the light theme and near-black on the dark one, because dark text on gold
is what reads.

Every pair the design puts together is measured rather than eyeballed. The first light
gold picked, `#b07714`, gave 3.8:1 under a white button label and had to go darker.

The stored choice is applied by an inline script in `index.html` before the first
paint; a class set by React arrives one frame too late and the page flashes white.
That script sits after the `<!--og-->` marker, which has to stay the first thing in
`<head>`.

Two faces are served from `public/fonts`, DM Sans and JetBrains Mono, latin and
latin-ext apiece. Self-hosted rather than from Google's CDN: the container has no
outbound network, and who opened the page is not a third party's business. Numbers are
the mono - scores, hashrates, ranks - and everything else is the sans.

## Pool connections

Miners share pool sockets. Neither extreme works: one socket per miner means a few
hundred TCP connections from one IP and a ban, while a single shared socket runs into
zpool's vardiff, which targets 5-15 submits per minute *per connection*. That would cap
the whole site at 5-15 shares a minute however many people mine - scoring stays right on
average, but a newcomer can mine five minutes and see zero, which is the only feedback
the game has.

How many share one socket is not a constant, because vardiff decides it and vardiff is
not ours. Each socket reports what the pool actually credited in the last 30 seconds;
from that comes the wait one miner on it sees, and the socket's capacity moves four at a
time towards `POOL_TARGET_SHARE_SECONDS`. A socket is only grown while it is full - a
half-empty one looks fast *because* it is half empty - and never shrunk below four,
since past that point splitting miners across more sockets buys no shares and only
spends connections.

If the pool drops us or errors, no new socket is opened for `POOL_BACKOFF_MS` and every
capacity is halved. A controller that only ever opens connections is how one address
earns a ban, and a ban takes every listing's earnings with it. `MAX_POOL_CONNECTIONS` is
the hard stop behind that; a miner turned away is told to try again, and does, so the
crowd drains in as capacity grows rather than needing a reload.

Each miner on a socket gets its own extranonce2, so no two build the same header, and
submit replies are routed back by stratum request id. Without that routing the credit
lands on whoever happens to be next on the socket, and the totals still look plausible.

Connections reconnect on their own with exponential backoff. extranonce1 changes on
reconnect, so every header is rebuilt rather than reused.

## Capacity

Measured with `scripts/load-test.ts`, which opens real WebSockets that say `mine`,
report a hashrate and submit shares, against `scripts/stratum-stub.ts` - a pool that
accepts everything. Five thousand miners pointed at zpool would be the flood the
controller above exists to prevent, so the load test never touches it.

On this machine, 5000 concurrent sockets: **none refused, ~65 MB RSS, broadcast loop
late by 0-1 ms**, 20k shares through the hub in two minutes. Three thousand arriving in
a single tick behaves the same. `/health` reports `lagMs`, which is that number - one
thread runs the board, the sockets and the share cards, so it is the first thing to look
at when the site feels slow.

Two things make that possible and are easy to undo:

- The board snapshot goes out with `server.publish`, so Bun encodes and compresses it
  once for the whole topic rather than once per socket.
- A joining socket is handed the last broadcast rather than a fresh snapshot. Building
  one is three queries and a walk of every client; per connection, that made a restart
  quadratic in the number of visitors watching.

Past 5000 the next step is more processes (`reusePort`), which means deciding what
`online`, the feed and the pool sockets mean when there is more than one of them. Not
worth doing before the measurement above says one is full.

## Abuse guard

A client can spray random nonces instead of hashing. That is not a shortcut: at this
pool difficulty a random nonce is valid about 1 in 8,600 times, which is exactly the
work honest mining needs. It is still a nuisance, because a flood of invalid shares
gets the *server's* IP banned by the pool. Ten consecutive unaccepted submits ends
that connection.

Counting rejects alone is not enough — a pool that has had enough simply stops
replying, so silence counts against the client too.

New listings are rate limited per address (`RATE_MAX`, five a minute) by
`hono-rate-limiter`, keyed through `clientAddress` rather than the library's own
default: that default reads `X-Forwarded-For` from the left, which is the end a client
writes, so anyone could reset their own limit with one forged header. See
`TRUSTED_PROXIES` below.

## What it earns

**Algorithm choice moves revenue by orders of magnitude; nothing else comes close.**
Measured on an Apple M-series, one WASM thread, with `bun run bench`:

| | H/s | zpool rate | BTC/day/thread |
|---|---|---|---|
| minotaurx | 896 | 0.00013543 /MH/day | 1.2e-7 |
| **rinhash** | **14,025** | **0.00485204 /MH/day** | **6.8e-5** |

**The hashrate column is measured and certain; the rate column is not.** RinHash runs
**15.6x faster** in a browser because its Argon2d touches 64 KiB where yespower
touches 2 MiB — that much is ours to verify, and on its own it is reason enough to
prefer it. The rate is zpool's own advertisement, and it does not survive a sanity
check: 0.00485 BTC per MH/s per day is $372 a day for one megahash, which would have
every CPU on earth pointed at this coin by tomorrow. The pool has fifty miners on it.

So take the last column as an upper bound with a broken unit, not a forecast. What
*is* measured end to end, by watching the payout address across a mining run: at
MinotaurX, 3.1 kH/s for three minutes credited 9.5e-11 BTC, which is **1.3e-8
BTC/day/thread** — a tenth of what the same table predicts. Read that way, a thousand
tabs of four threads is about $120 a month at $76,700/BTC on MinotaurX, and RinHash is
worth somewhere between 15x and rather more than that.

`scripts/measure-yield.ts` is how that gets settled: it mines for a couple of hours
and divides the credited BTC by the hashes that earned it. Run it per algorithm before
believing any ratio, including this one.

Browser mining pays little either way; that is the honest baseline for 2026, and zpool
does not pay out below 0.00075 BTC. The leaderboard is what makes any of it worth
anything: a normal page gets a 30-second visit, a board people compete on gets a tab
left open for hours.

### Why not SIMD

yespower ships an SSE2 path and warns at compile time when it is not enabled, so
`-msimd128 -msse2` looks like free money. It is not: measured in Chromium and in Bun
on Apple Silicon, the SIMD build runs MinotaurX at **0.85x** the plain scalar one.
`-msse4.1`, `-mrelaxed-simd`, `-flto`, `emmalloc` and a fixed heap were measured too
and are noise. The SSE2 shuffles do not survive the trip through WASM to NEON. This
may well go the other way on an x86 browser, where wasm SIMD maps almost one to one —
untested here, and not worth shipping a build that is slower for every Mac visitor on
the chance that it is faster elsewhere.

## What it counts

Enough to know whether the thing works, and nothing that could say who a visitor was.

A page view is one `view` message on the WebSocket that is already open — no pixel, no
third-party script, no cookie, nothing an ad blocker has a rule for. A crawler never
opens a socket, so a crawler never counts as a visit. `first` is set once per page load
rather than once per socket, so a reconnect after a deploy does not invent a second
visitor.

What lands in SQLite is already aggregated: one row per day per thing counted, in a
`traffic` table with `(day, kind, key)` as its key. Days, not timestamps. No addresses,
no session ids, no per-request rows to join back together later. A year of this is a few
thousand rows.

Referrers are stored as **hosts**, not URLs. Knowing that people arrive from
`news.ycombinator.com` is the whole point of the number; the path they came from is
their business, and a full URL is the part that can carry a search query or a private
link.

One traffic number is public — `visitsToday` on `/api/stats`, because the board already
shows how busy it is and hiding the visit count would be a pretence. Everything else,
including which listings get looked at and who sends the traffic, sits behind
`/admin/traffic` and `ADMIN_TOKEN`. That page reads better in a browser than as JSON,
which is why the token travels in the query string — and the two ways a token in a URL
escapes are the `Referer` of the next click and a cache, so the response carries
`Referrer-Policy: no-referrer`, `Cache-Control: no-store` and
`X-Robots-Tag: noindex, nofollow`.

## Before deploying

Set `POOL_USER` to your payout address. The server refuses to start without it - mining
to an empty address credits nobody and nothing else would complain.

Back up the database on a schedule:

```
0 4 * * *  cd /srv/outmine && docker compose exec -T app bun scripts/backup.ts
```

`scripts/backup.ts` uses `VACUUM INTO`, which takes a consistent snapshot without
stopping writers - unlike copying the file, which can catch a torn page mid-checkpoint.
Snapshots land in `./backups`, a second bind mount, rather than beside the database in
`./data`: fifteen copies of a file in the same directory as the file survive a bad
`DELETE` and nothing else. Point that mount at another disk, or rsync it off the host.

Both mounts have to be writable by the image's `bun` user before the first start:

```
sudo chown -R 1000:1000 ./data ./backups
```

`ADMIN_TOKEN` enables `DELETE /api/listings/:id`, the only way to take a listing down
short of editing SQLite by hand.

`ALLOWED_ORIGINS` is a security control, not a convenience. The mining socket accepts
any browser that reaches it, so without an origin policy another site could run
`new WebSocket("wss://your-host/ws")` and mine on its own visitors' CPUs against your
pool account, skipping the consent banner entirely.

Same-origin is always allowed and the list only *adds* origins - the dev server, a
second domain. It is not the complete set, so naming a dev origin and forgetting your
own domain cannot take the site down. A missing `Origin` header is allowed through:
browsers always send one on a WebSocket handshake, so the guard still holds, and
non-browser clients have nobody else's CPU to spend.

`TRUSTED_PROXIES` decides where the client address comes from. `X-Forwarded-For` is
appended to by each hop, so with one proxy the real address is the *last* entry.
Reading the first entry - the obvious way - lets anyone forge an address and walk past
the rate limit with a single header, so at `0` the header is ignored entirely and the
socket address is used. The bundled compose file sets it to `1` for Caddy.

Every response carries a Content-Security-Policy. Two directives in it are not
boilerplate. `script-src` includes `'wasm-unsafe-eval'`, because the miner is a
WebAssembly module reached through `WebAssembly.instantiateStreaming`, and Chrome
refuses that without it — which would break the entire product silently. And the
inline theme script, which has to run before the first paint or a stored dark theme
flashes white, is vouched for by a per-request nonce: `index.html` carries a
placeholder that is filled in beside the crawler tags, so it cannot go stale the way a
hard-coded hash would. `scripts/browser-check.ts` is what proves the policy did not
break mining.

## Configuration

Every tunable lives in `packages/server/src/config.ts` and is validated at startup:
a mistyped number stops the server with the name of the offending variable instead of
quietly becoming `NaN`. `.env.example` lists all of them with their defaults.

Only `POOL_USER` is required. The rest have defaults that work, and the ones worth
knowing about are the algorithm (`POOL_ALGO`, `POOL_HOST`, `POOL_PORT` — see below),
the visibility threshold (`VISIBILITY_THRESHOLD`, 600 shares), the icon gate
(`ICON_MIN_POINTS`, 2000 points), the bounds the pool controller works inside
(`MINERS_PER_CONNECTION`, `MAX_POOL_CONNECTIONS`, `POOL_TARGET_SHARE_SECONDS`), how many
visitors are held at once (`MAX_CLIENTS`, `MAX_CLIENTS_PER_ADDRESS`) and the origin
policy below.

`TRUSTED_PROXIES` is not optional behind a proxy, and not only for the rate limiter:
the per-address socket ceiling is keyed the same way, so with it unset every visitor
arrives as the proxy's address and the site caps itself at `MAX_CLIENTS_PER_ADDRESS`
people. The bundled compose file sets it to 1.

`POOL_ALGO` decides which WASM module the browser downloads and how a nonce is
submitted, and it has to agree with the host and port. Mining one algorithm at
another's pool is not an error anywhere: the pool accepts the connection, hands out
work, and calls every share invalid. The server refuses to start when the host names
a different known algorithm, which catches the realistic version of that mistake.

`POOL_PASS` also carries zpool's static difficulty knob: `c=BTC,d=0.00005` pins the
share target instead of letting vardiff find it. Useful for tests — at the default
difficulty one browser thread needs 2.15M hashes, about two and a half minutes, to
find a single RinHash share, and a check that waits ninety seconds fails for no
reason. Leave it off in production; vardiff sizes itself to the whole shared
connection, which is the right unit.

## Layout

```
packages/protocol/   the WebSocket contract, imported by both server and browser
packages/wasm/       MinotaurX and RinHash hashers, compiled to WASM with emcc
packages/web/
  index.css          the two palettes, the four faces, the Tailwind theme
  App.tsx            layout: consent, the mining panel, the page the URL names
  miner-session.ts   useMiner: the socket, the worker pool, the counters
  theme.ts           light or dark; index.html applies it before the first paint
  router.ts          a dozen lines of pushState; six paths do not need a dependency
  api.ts             where the API is, and usePolled for the pages that read from it
  session.ts         what pages read from the live connection
  storage.ts         consent, last listing, theme - every read guarded
  pages/             home, listing, stats, about, rules, faq
  components/        header, hero, board rows, trending, activity, panels, ui
  public/fonts/      DM Sans and JetBrains Mono, latin and latin-ext
  miner.worker.ts    the hashing worker
packages/server/
  config.ts          every tunable, validated at startup
  security.ts        origin policy, client address, constant-time comparison
  routes.ts          the HTTP surface
  share.ts           /l/:id, the badge, the cards, the crawler tags
  server.ts          socket wiring, the upgrade gate, shutdown
  hub.ts             clients, pool connections, scoring, the board
  cards.ts           drawing the share card and the badge
  assets/            JetBrains Mono, shipped so the card renders in a slim container
  stratum.ts         one pool connection: framing, submits, reconnect
  blockheader.ts     stratum job -> the 80 bytes the miner hashes
  listings.ts        target normalisation and every SQL statement in the project
  db.ts              the connection, the pragmas, the migrations, the liveness probe
  log.ts             one JSON line per event, to stdout
scripts/             backup, browser check, load test, stratum stub, yield, test setup
.github/workflows/   image.yml: typecheck and test, then build and push to GHCR
```

Bun workspaces. Still one deployed process and one SQLite file; three runtime
dependencies on the server (`hono`, `@resvg/resvg-js` only to turn a share card into a
PNG, and `hono-rate-limiter`) and one in the browser (`lucide-react`, tree-shaken to
the eight icons used). Bodies, ETags, static files, the CSP and the request validators
are all hono's own middleware rather than further packages. The split is about keeping the boundaries honest — the browser cannot
reach into server code, and the shared contract is a package rather than a relative
path.

First load is 72 kB of JavaScript and 6 kB of CSS, both gzipped, plus 68 kB of fonts;
latin-ext adds 29 kB and only for a page that needs it. The WASM miner downloads when
somebody presses a button, not before, and only the module the server asked for:
RinHash is 14 kB gzipped against MinotaurX's 175 kB, because sixteen sphlib hash
functions do not come cheap.

Two rules hold this together. **Every SQL statement lives in `listings.ts`**, so the
ordering of the board, its tie-break and the rank a badge prints cannot drift apart -
they are one constant used three times. And **`useMiner` sits above the router**, so
navigating between pages cannot stop mining.

The WASM exports one function, `mine(header, target, nonceStart, nonceEnd)`. The nonce
loop lives in C because crossing the JS/WASM boundary per hash costs more than a hash.
Stratum, job handling and merkle math stay in TypeScript on the server, so the browser
only ever spins nonces.

## The API

Everything the browser does, and everything a script could do instead. No API key: the
board is public, the two writes that are not are gated by a token.

| | |
|---|---|
| `GET /health` | `lagMs` and `poolHealthy`, the two numbers that say whether this is fine |
| `GET /api/board` | `?window=all\|24h&q=&offset=`; the paged, searchable board |
| `GET /api/trending` | biggest movers of the last two hours |
| `GET /api/stats` | the totals behind `/stats` |
| `GET /api/listings/:id` | one listing, plus `rank` — which the client cannot work out from a single page |
| `POST /api/listings` | create; returns the edit token **once**. `RATE_MAX` per address per minute |
| `PATCH /api/listings/:id` | edit name and tagline. `X-Edit-Token` |
| `PUT /api/listings/:id/icon` | raw PNG body, ≤128px. `X-Edit-Token` and `ICON_MIN_POINTS` |
| `DELETE /api/listings/:id` | takedown. `X-Admin-Token` |
| `GET /icon/:id.png` | the uploaded icon |
| `GET /r/:id` | the outbound click, and the only `GET` that writes |
| `GET /l/:id` | the listing's page, with its `og:` tags stitched in for crawlers |
| `GET /og/:id.png`, `/og/home.png` | link preview cards, SVG rasterised by resvg |
| `GET /badge/:id.svg` | a shields-style rank badge for somebody else's README |
| `GET /admin/traffic` | the traffic report. `?token=` — see [What it counts](#what-it-counts) |
| `WS /ws` | the mining socket |

On the socket the browser sends `mine`, `stop`, `share`, `hashrate` and `view`; the
server sends `board`, `job`, `shareResult` and `error`. Both sides import those types
from `packages/protocol`, which exists because they were once written twice and drifted:
`pending` was added to the hub and neither the client nor `/api/board` heard about it.

Errors are `{ "error": "..." }` with a real status code. An `error` on the socket may
carry `retry: true`, which marks the ones that are about the moment rather than the
request — the pool is full or backing off — and the client asks again on its own.

## Running it

```bash
cp .env.example .env   # set POOL_USER to your BTC address
bun install
bun run build          # WASM then frontend, in dependency order
bun start
```

The WASM build needs emscripten (`brew install emscripten`) and clones cpuminer-multi
on first run.

## Deploying

One small VPS is the whole shape of it: one Bun process, one SQLite file, Caddy in front
for TLS. Measured, 5000 concurrent sockets cost about 65 MB — the cheapest plan anywhere
is several times more than this needs, and a bigger one buys nothing, because the process
is single-threaded by design and the next step past 5000 is `reusePort`, not more RAM.

What it does need is less common than what it does not: outbound raw TCP on the pool's
port (plain stratum, not HTTP), a persistent disk for SQLite and its WAL, exactly one
instance, and no scale-to-zero. That rules out every edge and function runtime, and
anything that autoscales — two replicas would open two sets of pool sockets from one
address, which is the flood the connection controller exists to prevent.

The image is built by `.github/workflows/image.yml` and pushed to GHCR; the host pulls
it. Building on the server would mean a ~2 GB emscripten pull and ~35 C files through
`emcc -O3` on one core, and it would quietly undo the pinning in the wasm stage — see
`.dockerignore`.

```bash
sudo chown -R 1000:1000 ./data ./backups   # once, before the first start
docker compose pull && docker compose up -d
```

Then check that the pool is actually reachable, which is the one thing a host can quietly
break:

```bash
curl -s https://your-domain/health    # poolHealthy:false means outbound 7444 is blocked
```

### A note on bandwidth

The board snapshot is ~23 kB of JSON, deflated to ~2.7 kB by `perMessageDeflate`, pushed
every `BOARD_BROADCAST_MS` and skipped entirely when nothing moved. So an idle board costs
nothing and a busy one costs about 3.5 GB per month per continuously-open tab: ~35 GB at
ten of them, ~175 GB at fifty. Well inside any VPS traffic allowance, and far outside the
1 GB/month egress that some "free tier" VMs come with. Doubling `BOARD_BROADCAST_MS` halves
it without touching code.

### A note on acceptable use

Most hosts ban cryptocurrency mining outright, and some word it broadly enough to cover
anything adjacent. This server does no hashing — the browsers do — and it holds one
outbound stratum connection and some WebSockets, at near-zero CPU. That is a real
distinction and it is worth putting in a pre-sales email rather than finding out
afterwards. It is not worth hiding: a host that finds out later takes the machine and the
data with it.

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
# POOL_ALGO must match the server under test - this is the only check that can tell
# a header or nonce laid out for the wrong algorithm from a bad network.
INTEGRATION=1 POOL_ALGO=rinhash bun test packages/server/src/hub.integration.test.ts

BASE=http://localhost:5173 bun scripts/browser-check.ts  # consent, mine, shares land

# How many visitors one process holds. The stub is a pool that accepts everything;
# five thousand miners pointed at a real one is a flood from a single address.
bun scripts/stratum-stub.ts &
POOL_HOST=127.0.0.1 POOL_PORT=3399 TRUSTED_PROXIES=1 MAX_CLIENTS=6000 \
  PORT=3400 DB_PATH=/tmp/load.sqlite bun packages/server/src/server.ts &
CLIENTS=5000 BASE=http://localhost:3400 bun scripts/load-test.ts
```

`routes.test.ts` drives the HTTP surface through `app.request()` — no socket, no
`Bun.serve` — covering the token gates, the body limits, the rate limit and the shape
of every error. It writes, so `scripts/test-setup.ts` is preloaded to point `DB_PATH`
at a scratch file: Bun shares one module registry across test files, so a test cannot
redirect the database for itself once another file has opened it.

`browser-check.ts` covers what no unit test can reach: that navigating to another page
does not stop mining, that a returning visitor is not asked to consent twice, and — the
one that matters — that a stored consent still does not start the CPU by itself.

Two tests carry most of the weight. The hash vector test pins the WASM build against
the native build of the same C: a mismatch raises no error, it just makes the pool
discard every share while everything looks healthy. The multiplex test checks that two
miners on one socket get different headers and that each accepted share lands on the
right listing - crossed credit is silent and the totals still look plausible.

CI runs `typecheck` and `bun test packages/{server,web,protocol}` on every push to
`main`, and the image is only pushed if both pass. `packages/wasm` is excluded there on
purpose: `mine.test.ts` imports the compiled emscripten glue at module scope, so it
needs a full WASM build to even load. Those vectors are what `bun test` covers locally
once `build.sh` has run.

## Contributing

Issues and pull requests are welcome. `bun run check` has to pass — that is the same
typecheck and test run CI gates the image on.

The two rules in [Layout](#layout) are the ones worth knowing before changing anything:
every SQL statement lives in `listings.ts`, and `useMiner` sits above the router.

For anything with a security dimension — the origin policy, the address the rate limiter
trusts, the token comparisons, the icon decoder — please use GitHub's private security
advisories rather than a public issue.

## Licence

**GPL-2.0.** The full text is in [LICENSE](LICENSE), and it covers the whole repository:
server, browser, protocol and the WASM miner.

That is not a preference, it is what gets compiled in. The miner is built from upstream
C, and the RinHash lineage states plain version 2 with no "or later" clause — so GPLv3
and AGPLv3 were never available to the combined work:

| Upstream | Used for | Terms |
|---|---|---|
| [cpuminer-multi](https://github.com/litecoincash-project/cpuminer-multi) | `minotaurhash`, sphlib | GPL-2.0-or-later |
| [cpuminer-opt-rin](https://github.com/Rin-coin/cpuminer-opt-rin) | RinHash, argon2d, BLAKE3, SHA-3 | **GPL-2.0** |
| [yespower](https://www.openwall.com/yespower/) | inside MinotaurX | BSD-2-Clause |
| [phc-winner-argon2](https://github.com/P-H-C/phc-winner-argon2) `ref.c`, [XKCP](https://github.com/XKCP/XKCP), [BLAKE3](https://github.com/BLAKE3-team/BLAKE3) | the portable paths | CC0 / Apache-2.0 |

Those sources are not vendored into this repository — `build.sh` fetches them, and the
`Dockerfile` pins all three by commit SHA plus one file by digest, which is where anyone
asking for the corresponding source of a shipped `mine-*.wasm` should look.

The two bundled typefaces, DM Sans and JetBrains Mono, are under the SIL Open Font
License; their `OFL.txt` ships beside them in `packages/web/public/fonts` and
`packages/server/assets`.
