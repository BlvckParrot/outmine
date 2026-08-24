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

## Storage

SQLite in WAL mode with `synchronous = NORMAL`, the usual pairing. At the default
`FULL` every commit waits for an fsync, including the one behind every outbound click.
`NORMAL` cannot corrupt the database; a power cut can cost the last transactions, which
here is at most one flush interval of shares.

Two indexes carry the whole `ORDER BY` of the two lists the hub rebuilds on every
broadcast, tie-breaker included, so SQLite walks them in order instead of sorting into
a temporary B-tree. Checked with `EXPLAIN QUERY PLAN`, which is also the way to notice
when a query stops using them.

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

## Configuration

Every tunable lives in `packages/server/src/config.ts` and is validated at startup:
a mistyped number stops the server with the name of the offending variable instead of
quietly becoming `NaN`. `.env.example` lists all of them with their defaults.

Only `POOL_USER` is required. The rest have defaults that work, and the ones worth
knowing about are the visibility threshold (`VISIBILITY_THRESHOLD`, 600 shares),
the icon gate (`ICON_MIN_POINTS`, 2000 points), the pool grouping
(`MINERS_PER_CONNECTION`, `MAX_POOL_CONNECTIONS`) and the origin policy below.

## Layout

```
packages/protocol/   the WebSocket contract, imported by both server and browser
packages/wasm/       MinotaurX hasher, compiled from cpuminer-multi with emcc
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
  db.ts              the connection, the pragmas, the liveness probe
scripts/             backup, browser check, algorithm ranking
```

Bun workspaces. Still one deployed process and one SQLite file; two runtime
dependencies on the server (`hono` and `@resvg/resvg-js`, the latter only to turn a
share card into a PNG) and one in the browser (`lucide-react`, tree-shaken to the eight
icons used). The split is about keeping the boundaries honest — the browser cannot
reach into server code, and the shared contract is a package rather than a relative
path.

First load is 72 kB of JavaScript and 6 kB of CSS, both gzipped, plus 68 kB of fonts;
latin-ext adds 29 kB and only for a page that needs it. The WASM miner is another
175 kB and downloads when somebody presses a button, not before.

Two rules hold this together. **Every SQL statement lives in `listings.ts`**, so the
ordering of the board, its tie-break and the rank a badge prints cannot drift apart -
they are one constant used three times. And **`useMiner` sits above the router**, so
navigating between pages cannot stop mining.

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

`browser-check.ts` covers what no unit test can reach: that navigating to another page
does not stop mining, that a returning visitor is not asked to consent twice, and — the
one that matters — that a stored consent still does not start the CPU by itself.

Two tests carry most of the weight. The hash vector test pins the WASM build against
the native build of the same C: a mismatch raises no error, it just makes the pool
discard every share while everything looks healthy. The multiplex test checks that two
miners on one socket get different headers and that each accepted share lands on the
right listing - crossed credit is silent and the totals still look plausible.

## Licence

The WASM hasher derives from cpuminer-multi, which is GPLv2, so the build output is
GPLv2 as well.
