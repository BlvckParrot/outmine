// Every tunable in one place, validated at startup.
//
// These used to be `process.env.X ?? default` scattered across six files, which meant
// there was no way to see what was configurable, a typo in a number silently became
// NaN, and a missing payout address was only noticed on the pool dashboard.

import { MINER_ALGOS, type MinerAlgo } from "@outmine/protocol";

const problems: string[] = [];

function str(name: string, fallback?: string): string {
  const raw = process.env[name]?.trim();
  if (raw) return raw;
  if (fallback !== undefined) return fallback;
  problems.push(`${name} is required`);
  return "";
}

function int(name: string, fallback: number, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  // Number("") is 0 and Number("abc") is NaN; both would sail through a bare cast and
  // turn a mistyped interval into an infinite loop or a disabled limit.
  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    problems.push(`${name} must be a whole number, got ${JSON.stringify(raw)}`);
    return fallback;
  }
  if (value < min || value > max) {
    problems.push(`${name} must be between ${min} and ${max}, got ${value}`);
    return fallback;
  }
  return value;
}

function oneOf<T extends string>(name: string, allowed: readonly T[], fallback: T): T {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  if (!allowed.includes(raw as T)) {
    problems.push(`${name} must be one of ${allowed.join(", ")}, got ${JSON.stringify(raw)}`);
    return fallback;
  }
  return raw as T;
}

/** Unset takes the fallback; set-but-empty means an empty list.
 *
 *  Exported for its own test. The distinction is the whole point: treating an empty
 *  value as "no value" left a defaulted list with no off switch at all, since every
 *  other value is just a different list. */
export function list(name: string, fallback: readonly string[] = []): string[] {
  const raw = process.env[name];
  if (raw === undefined) return [...fallback];
  return raw.split(",").map((v) => v.trim()).filter(Boolean);
}

/** An optional value that has to fit a shape or is not a value at all.
 *
 *  Unset is the ordinary case, so a missing one is silent. A set one that does not fit
 *  is a problem rather than a fallback: the values this guards are spliced into a
 *  <script> tag and into a header, and "operator-set" is not the same as "safe".
 *
 *  Exported for its own test, like list() below. What it refuses is the point of it,
 *  and that is not reachable through the config singleton - which is read once per
 *  process, from whatever environment the first import happened to see. */
export function pattern(name: string, re: RegExp): string {
  const raw = process.env[name]?.trim();
  if (!raw) return "";
  if (!re.test(raw)) {
    problems.push(`${name} must match ${re}, got ${JSON.stringify(raw)}`);
    return "";
  }
  return raw;
}

/** A Bitcoin mainnet address: base58 for the two legacy forms, bech32 for segwit and
 *  taproot. Exported so config.test.ts checks this expression rather than a copy of it
 *  - the two regular expressions the test writes out itself are there to exercise
 *  pattern(), but this one *is* the thing being tested, and a stale copy would stay
 *  green against a broken account number.
 *
 *  ponytail: shape only, no checksum. This catches a truncated or mangled address and
 *  not a typo that happens to stay well-formed. The real check is that the operator
 *  reads the address back off their own /support page, which they will do once; a
 *  bech32 polymod would be thirty lines guarding a case a pair of eyes already sees.
 *  Add it if this ever gets set by anything other than a person pasting once. */
export const BTC_ADDRESS =
  /^(bc1[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{38,68}|[13][a-km-zA-HJ-NP-Z1-9]{25,34})$/;

/** The category /rules names first. A setting rather than a list baked into the source:
 *  what belongs on a public board is the operator's policy and moves without a deploy,
 *  and BLOCKED_WORDS replaces this entirely rather than adding to it. */
const DEFAULT_BLOCKED_WORDS = [
  "porn", "porno", "pornhub", "xxx", "nsfw", "hentai", "camgirl", "escort", "onlyfans",
] as const;

/** The repo root, derived from this file rather than the working directory: `bun
 *  --filter` runs the server from packages/server, and a relative path would otherwise
 *  mean a different file depending on how the process was started. */
const REPO_ROOT = new URL("../../../", import.meta.url).pathname;

const rootRelative = (value: string) => (value.startsWith("/") ? value : `${REPO_ROOT}${value}`);

export const config = {
  port: int("PORT", 3000, { min: 1, max: 65535 }),

  /** SQLite file. A relative value is resolved from the repo root, not the working
   *  directory, so it names one database however the server was launched. */
  dbPath: rootRelative(str("DB_PATH", "data/outmine.sqlite")),

  /** When the nightly snapshot runs, as a cron expression in the machine's local time -
   *  UTC in the image. Empty disables the backup entirely.
   *
   *  The server runs it itself rather than the host's crontab: the crontab line existed
   *  only in the README, the README lost it, and a backup nobody is running is worse
   *  than one that was never written. Minute resolution is all Bun.cron offers and all
   *  this needs; the loops in hub.ts stay on setInterval because they are seconds. */
  backupCron: process.env.BACKUP_CRON?.trim() ?? "0 4 * * *",

  /** Where snapshots land. Root-relative for the same reason as dbPath, and a separate
   *  directory from it on purpose - the image and compose file mount the two apart so a
   *  backup can live on another disk. */
  backupDir: rootRelative("backups"),

  /** Absolute origin this site is reached at, e.g. https://outmine.example.
   *
   *  Only needed for the tags a crawler reads: og:image and og:url have to be
   *  absolute, and a share card is fetched by a machine that never saw the request
   *  that produced the page. Empty falls back to the requesting Host header, which is
   *  right in development and behind a well-behaved proxy, and wrong the moment
   *  anything forwards a Host we do not control. */
  publicOrigin: (process.env.PUBLIC_ORIGIN?.trim() ?? "").replace(/\/$/, ""),

  /** Self-hosted analytics, or nothing at all.
   *
   *  Both or neither. The tag needs an origin to load from and a site to attribute to,
   *  and half the pair is a script that 404s on every page. Unset is the default and
   *  the feature is then wholly off: no tag in the document and no extra origin in the
   *  Content-Security-Policy.
   *
   *  Configuration rather than a line in index.html because one image serves every
   *  deployment. Baked in at build time it would either be wrong or would need a second
   *  image, and a dev tree would be reporting into production's dashboard. */
  analytics: {
    origin: pattern("ANALYTICS_ORIGIN", /^https?:\/\/[a-z0-9.-]+(:\d+)?$/i),
    siteId: pattern("ANALYTICS_SITE_ID", /^[A-Za-z0-9_-]{1,64}$/),
  },

  /** Where errors from a visitor's browser go, or nothing at all.
   *
   *  All three or none. The SDK needs an origin to post to, an organisation to post
   *  into and a token to post with, and two out of three is a page that loads a
   *  reporter which cannot report.
   *
   *  The token is NOT a secret and must not be handled as one. It is written into every
   *  page, so every visitor has it. It is ingest-only: the worst it buys is somebody
   *  writing junk into a log stream, which is why it is named PUBLIC and why the
   *  root credentials are not used here. Rotate it in the OpenObserve UI if it is
   *  abused. */
  observe: {
    origin: pattern("OBSERVE_ORIGIN", /^https?:\/\/[a-z0-9.-]+(:\d+)?$/i),
    org: pattern("OBSERVE_ORG", /^[A-Za-z0-9_-]{1,64}$/),
    publicToken: pattern("OBSERVE_PUBLIC_TOKEN", /^[A-Za-z0-9_.=+/-]{1,256}$/),
  },

  /** Where /support asks people to send money, or nothing at all - empty means the page
   *  says donations are not being taken rather than 404ing.
   *
   *  Bitcoin and nothing else, deliberately. Stripe lists "cryptocurrency mining and
   *  staking" among businesses it does not serve, and every card-based donation
   *  platform - GitHub Sponsors, Ko-fi, Liberapay, Open Collective - settles through
   *  Stripe or PayPal. This software mines cryptocurrency. An address cannot be
   *  reviewed, frozen or reconsidered, which on this particular site is the point.
   *
   *  Configuration and not a constant for the same reason DEPLOY_HOST is a secret and
   *  SITE_URL is a variable: this repository is public and names no single deployment.
   *  A fork that begged for money into this address would be a bug, and one nobody
   *  running it would notice.
   *
   *  No default from pool.user, even though this deployment sets both to the same
   *  address. Publishing the address an operator set up to be *paid* is a surprising
   *  thing to do on their behalf - and the two are free to differ, so a deployment that
   *  wants them equal says so twice rather than being unable to separate them. */
  donate: {
    btc: pattern("DONATE_BTC", BTC_ADDRESS),
  },

  /** Where the frontend build lives. Resolved from this file so any working directory
   *  works; the image overrides it when the layout differs. */
  webDist: process.env.WEB_DIST?.trim() || new URL("../../web/dist", import.meta.url).pathname,

  pool: {
    host: str("POOL_HOST", "rinhash.mine.zpool.ca"),

    /** The proof-of-work this pool wants. Decides which WASM module the browser
     *  loads, how the header is laid out, and how a nonce is submitted. */
    algo: oneOf<MinerAlgo>("POOL_ALGO", MINER_ALGOS, "rinhash"),

    port: int("POOL_PORT", 7444, { min: 1, max: 65535 }),
    /** Payout address. Required: mining to an empty user credits nobody and nothing
     *  else in the system complains. */
    user: str("POOL_USER"),
    password: str("POOL_PASS", "c=BTC"),

    /** Most miners one pool socket may hold.
     *
     *  An upper bound now, not the working number: how many actually share a socket is
     *  decided at runtime from what the pool credits (see tuneConnections in hub.ts).
     *
     *  Not one socket per miner: a few hundred visitors would be a few hundred TCP
     *  connections from one IP and the pool would ban us. Not one socket for everyone
     *  either: zpool's vardiff targets 5-15 submits per minute *per connection*, so a
     *  single shared socket would cap the whole site at 5-15 shares a minute no matter
     *  how many people mine. Scoring would stay right on average, but a newcomer could
     *  mine five minutes and see zero, which kills the only feedback the game has. */
    minersPerConnection: int("MINERS_PER_CONNECTION", 64, { min: 1, max: 256 }),

    /** Hard ceiling on sockets held against the pool. Past this, mining is refused
     *  rather than risking a ban that would take the whole site's earnings with it.
     *  The controller keeps the count far below this in normal weather; it is the
     *  brake, not the setting. */
    maxConnections: int("MAX_POOL_CONNECTIONS", 128, { min: 1, max: 4096 }),

    /** How often a browser should see an accepted share. The controller moves miners
     *  per socket towards this: vardiff holds a socket to a few submits a minute
     *  whatever its hashrate, so the wait a miner sees is set by how many share that
     *  socket. Lower means more sockets, and more sockets is what gets an address
     *  banned. */
    targetShareSeconds: int("POOL_TARGET_SHARE_SECONDS", 90, { min: 5, max: 3600 }),

    /** How long the site stops taking on new miners after the pool drops us or errors.
     *  A controller that opens connections has to have a way to stop. */
    backoffMs: int("POOL_BACKOFF_MS", 60_000, { min: 0, max: 3_600_000 }),

    /** Jobs kept per connection so a share that raced a job switch is dropped locally
     *  rather than sent and rejected. */
    jobHistory: int("JOB_HISTORY", 3, { min: 1, max: 32 }),

    /** Consecutive unaccepted submits tolerated per miner before cutting them off.
     *  Counting rejects alone is not enough: a pool that has had enough of bad shares
     *  simply stops replying, so silence counts against the miner too. */
    maxBadSubmits: int("MAX_BAD_SUBMITS", 10, { min: 1, max: 1000 }),

    /** How long an empty pool socket is held before it is closed.
     *
     *  Not zero, which is what closing on the last miner leaving amounts to: a visitor
     *  switching listings leaves and rejoins in the same tick, and that would be a
     *  fresh TCP connect, subscribe and authorize against the pool every time. Repeated
     *  fast enough it is a connection flood from our address, and the ban takes the
     *  whole site's earnings with it. */
    idleConnectionMs: int("POOL_IDLE_MS", 30_000, { min: 0, max: 600_000 }),

    /** Shortest gap between two `mine` messages from one socket. The grace period above
     *  already keeps the churn off the pool; this keeps it off the database, since every
     *  `mine` costs a listing lookup. */
    mineCooldownMs: int("MINE_COOLDOWN_MS", 2_000, { min: 0, max: 60_000 }),
  },

  limits: {
    /** Total simultaneous visitors holding a socket, mining or just watching.
     *
     *  Five thousand is measured rather than guessed: that many real sockets cost this
     *  server about 65 MB and left the broadcast loop running on time
     *  (scripts/load-test.ts). The default used to be 2000 while .env.example and its
     *  comment said 5000, so anyone who trusted the documentation and omitted the
     *  variable got 40% of the capacity it promised. */
    maxClients: int("MAX_CLIENTS", 5000, { min: 1, max: 100_000 }),
    /** Sockets one address may hold. Without it the ceiling above is a single global
     *  counter, so one host can take every slot and every later visitor is turned away
     *  at the door - and each accepted socket also costs a board snapshot.
     *
     *  One address is not one visitor: a university, an office or a phone network is a
     *  single address to us, which is why this is not the handful of tabs one person
     *  opens. It is only meaningful at all when the address is the visitor's - see the
     *  proxy note on clientAddress in security.ts. */
    maxClientsPerAddress: int("MAX_CLIENTS_PER_ADDRESS", 25, { min: 1, max: 10_000 }),
    /** Largest WebSocket frame accepted. Our biggest message is a board snapshot going
     *  the other way; anything large arriving is either a bug or an attack. */
    maxWsPayloadBytes: int("MAX_WS_PAYLOAD_BYTES", 16 * 1024, { min: 512, max: 1 << 20 }),
    /** Largest accepted request body. */
    maxBodyBytes: int("MAX_BODY_BYTES", 16 * 1024, { min: 512, max: 1 << 20 }),
    /** Client messages per second before a socket is dropped. Generous next to a
     *  miner's real rate, which is a share every few seconds plus a heartbeat. */
    maxMessagesPerSecond: int("MAX_MESSAGES_PER_SECOND", 20, { min: 1, max: 1000 }),
    /** Ceiling on a self-reported hashrate. The number cannot be verified, so it is
     *  capped to keep one client from claiming the whole board. */
    maxReportedHashrate: int("MAX_REPORTED_HASHRATE", 5_000_000, { min: 1 }),
    newListingsPerMinute: int("RATE_MAX", 5, { min: 1, max: 10_000 }),
    /** Requests per address per minute for the reads that cost real work: rasterising a
     *  share card, and the outbound hop, which writes a row. Generous next to a person
     *  clicking, and a ceiling for anything looping. */
    expensiveReadsPerMinute: int("READ_RATE_MAX", 60, { min: 1, max: 100_000 }),
    /** Largest uploaded icon. The browser re-draws every pick onto a 128px canvas
     *  before sending, and the worst case that survives that is a noisy photo at
     *  roughly 55 kB, so this is headroom over our own encoder rather than a budget
     *  for whatever someone chooses to send. */
    maxIconBytes: int("MAX_ICON_BYTES", 64 * 1024, { min: 1024, max: 1 << 20 }),
  },

  board: {
    /** Shares a listing needs before it appears on the board. This is the whole
     *  anti-spam mechanism: listing costs the currency the game runs on.
     *
     *  Priced in time, not in taste. `bun run bench` measures rinhash at ~13.6 kH/s per
     *  thread and the miner runs `hardwareConcurrency - 1` of them, so a laptop is
     *  around 95 kH/s. What a share costs in hashes is the pool's to decide and it
     *  moves it - see POINT_SCALE - so ten shares is a range rather than a number:
     *  roughly two to four minutes on eight cores at the difficulties seen so far, two
     *  and a half times that on four. Enough that creating listings in bulk is not
     *  free, short enough that a person finishes it in one sitting.
     *
     *  A gate in shares rather than in points on purpose, unlike iconMinPoints below.
     *  This is a spam filter, not a ranking - it does not have to be fair to the hash,
     *  and "7 of 10 shares" is something a progress bar can say. */
    visibilityThreshold: int("VISIBILITY_THRESHOLD", 10, { min: 1 }),
    entries: int("BOARD_ENTRIES", 50, { min: 1, max: 500 }),
    /** Points a listing needs before its owner may replace the letter avatar with an
     *  uploaded icon. A logo is the loudest thing on a row, so it is earned in the
     *  currency the board runs on rather than handed to every new listing - and it
     *  keeps an upload form off a listing anyone can create in one POST.
     *
     *  In points and not in shares because points are difficulty-weighted, so this asks
     *  for an amount of work rather than a number of pool round trips - the pool varies
     *  difficulty (see POINT_SCALE) and a share count would quietly get cheaper every
     *  time it did. How many shares that turns out to be therefore drifts: somewhere
     *  around 40 to 85 at what has been observed, a quarter of an hour of mining either
     *  way. Sized as a multiple of the board gate - an icon is the step after being on
     *  the board, not a second copy of getting there.
     *
     *  It was 2000, which the POINT_SCALE comment made look like a thousand shares and
     *  which was really four. The icon unlocked before the listing was even visible. */
    iconMinPoints: int("ICON_MIN_POINTS", 20_000, { min: 0 }),
    pendingEntries: int("BOARD_PENDING_ENTRIES", 20, { min: 1, max: 500 }),
    trendingEntries: int("BOARD_TRENDING_ENTRIES", 10, { min: 1, max: 500 }),
    feedEntries: int("BOARD_FEED_ENTRIES", 15, { min: 1, max: 200 }),
    /** How often a changed board is pushed to everyone. */
    broadcastMs: int("BOARD_BROADCAST_MS", 2_000, { min: 100, max: 60_000 }),
    /** How often in-memory counters are written to SQLite. */
    flushMs: int("FLUSH_MS", 30_000, { min: 500, max: 600_000 }),
    /** Longest accepted board search. Longer than any name it could match, and short
     *  enough that the scan it forces is bounded. */
    maxQueryLength: int("MAX_QUERY_LENGTH", 64, { min: 1, max: 500 }),
    maxNameLength: int("MAX_NAME_LENGTH", 60, { min: 1, max: 500 }),
    maxTaglineLength: int("MAX_TAGLINE_LENGTH", 200, { min: 1, max: 2000 }),
  },

  security: {
    /** Origins allowed to call the API and open a mining socket.
     *
     *  A security control, not a development convenience: without it any site could run
     *  `new WebSocket("wss://…/ws")` and mine on its own visitors' CPUs against this
     *  pool account, skipping the consent banner - the one thing separating this
     *  project from cryptojacking. Empty means same-origin only, so an unconfigured
     *  deployment is closed rather than open. */
    allowedOrigins: list("ALLOWED_ORIGINS"),

    /** Enables DELETE /api/listings/:id. Empty disables takedowns entirely. */
    adminToken: process.env.ADMIN_TOKEN?.trim() ?? "",

    /** Words refused in a listing's name or tagline, comma separated. Set it to replace
     *  the default list; leave it unset for that list, and set it empty to turn the
     *  check off. Which of those a board wants is the operator's policy, so it is a
     *  setting rather than a deploy - but an unconfigured deployment gets the list.
     *
     *  A name reaches the public board, the share card a crawler renders, and the
     *  <title> of a page people post to X. The admin takedown route is the real remedy
     *  and this is not a substitute for it - see blockedWord in security.ts for what
     *  the match does and does not catch. */
    blockedWords: list("BLOCKED_WORDS", DEFAULT_BLOCKED_WORDS),

    /** Proxies in front of this server, counted from the outside in. X-Forwarded-For
     *  is appended to by each hop, so with one proxy the client address is the last
     *  entry. Trusting the first entry instead would let anyone forge their address
     *  and walk past the rate limit with a single header. */
    trustedProxies: int("TRUSTED_PROXIES", 0, { min: 0, max: 10 }),
  },
} as const;

// A typo here is silent for as long as it takes to need a backup, so it is a startup
// failure rather than a job that quietly never fires.
//
// Both outcomes have to be caught: Bun.cron.parse throws on a malformed expression and
// returns null for a well-formed one with no match in the next eight years, like 31
// February. Left to throw it would take the process down at import time, from a module
// whose entire job is to collect problems and report them together.
if (config.backupCron) {
  try {
    if (!Bun.cron.parse(config.backupCron)) {
      problems.push(
        `BACKUP_CRON never comes round: ${JSON.stringify(config.backupCron)} has no match` +
          ` in the next eight years. Set it empty to disable backups.`,
      );
    }
  } catch (err) {
    problems.push(`BACKUP_CRON is not a cron expression: ${String(err)}`);
  }
}

// A host named for one algorithm with POOL_ALGO set to another is the single mistake
// that costs everything and reports nothing: the pool takes the connection, hands out
// work, and rejects every share as invalid. Only a host that names a *different* known
// algorithm counts, so a neutral or self-hosted hostname raises nothing.
for (const other of MINER_ALGOS) {
  if (other !== config.pool.algo && config.pool.host.toLowerCase().includes(other)) {
    problems.push(
      `POOL_HOST is ${config.pool.host} but POOL_ALGO is ${config.pool.algo}` +
        ` - mining ${config.pool.algo} at a ${other} pool means every share is rejected`,
    );
  }
}

/** Prints anything wrong with the environment and stops the process.
 *
 *  Problems are collected rather than thrown as they are found, and the entry point is
 *  the only caller: importing config from a test must not require a full production
 *  environment, and one bad value should list all of them, not just the first. */
export function exitIfMisconfigured(): void {
  // Not a problem - a board may legitimately want no word list - but it is the one
  // setting whose off position is an empty string, and an .env copied from an older
  // .env.example carries exactly that. Said out loud so the check is never off by
  // accident.
  if (config.security.blockedWords.length === 0) {
    console.warn("BLOCKED_WORDS is empty: listing names and taglines are not checked.");
  }
  if (problems.length === 0) return;
  console.error("Configuration is not usable:");
  for (const problem of problems) console.error(`  - ${problem}`);
  console.error("See .env.example.");
  process.exit(1);
}
