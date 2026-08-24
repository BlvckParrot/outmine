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

function list(name: string): string[] {
  return (process.env[name] ?? "").split(",").map((v) => v.trim()).filter(Boolean);
}

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

  /** Absolute origin this site is reached at, e.g. https://outmine.example.
   *
   *  Only needed for the tags a crawler reads: og:image and og:url have to be
   *  absolute, and a share card is fetched by a machine that never saw the request
   *  that produced the page. Empty falls back to the requesting Host header, which is
   *  right in development and behind a well-behaved proxy, and wrong the moment
   *  anything forwards a Host we do not control. */
  publicOrigin: (process.env.PUBLIC_ORIGIN?.trim() ?? "").replace(/\/$/, ""),

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

    /** Miners sharing one pool socket.
     *
     *  Not one socket per miner: a few hundred visitors would be a few hundred TCP
     *  connections from one IP and the pool would ban us. Not one socket for everyone
     *  either: zpool's vardiff targets 5-15 submits per minute *per connection*, so a
     *  single shared socket would cap the whole site at 5-15 shares a minute no matter
     *  how many people mine. Scoring would stay right on average, but a newcomer could
     *  mine five minutes and see zero, which kills the only feedback the game has. */
    minersPerConnection: int("MINERS_PER_CONNECTION", 16, { min: 1, max: 256 }),

    /** Hard ceiling on sockets held against the pool. Past this, mining is refused
     *  rather than risking a ban that would take the whole site's earnings with it. */
    maxConnections: int("MAX_POOL_CONNECTIONS", 64, { min: 1, max: 4096 }),

    /** Jobs kept per connection so a share that raced a job switch is dropped locally
     *  rather than sent and rejected. */
    jobHistory: int("JOB_HISTORY", 3, { min: 1, max: 32 }),

    /** Consecutive unaccepted submits tolerated per miner before cutting them off.
     *  Counting rejects alone is not enough: a pool that has had enough of bad shares
     *  simply stops replying, so silence counts against the miner too. */
    maxBadSubmits: int("MAX_BAD_SUBMITS", 10, { min: 1, max: 1000 }),
  },

  limits: {
    /** Total simultaneous visitors holding a socket, mining or just watching. */
    maxClients: int("MAX_CLIENTS", 2000, { min: 1, max: 100_000 }),
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
    /** Largest uploaded icon. The browser re-draws every pick onto a 128px canvas
     *  before sending, and the worst case that survives that is a noisy photo at
     *  roughly 55 kB, so this is headroom over our own encoder rather than a budget
     *  for whatever someone chooses to send. */
    maxIconBytes: int("MAX_ICON_BYTES", 64 * 1024, { min: 1024, max: 1 << 20 }),
    /** IPs tracked for rate limiting before the oldest are evicted. */
    rateBuckets: int("RATE_BUCKETS", 10_000, { min: 100, max: 1_000_000 }),
  },

  board: {
    /** Shares a listing needs before it appears on the board. This is the whole
     *  anti-spam mechanism: listing costs the currency the game runs on. */
    visibilityThreshold: int("VISIBILITY_THRESHOLD", 600, { min: 1 }),
    entries: int("BOARD_ENTRIES", 50, { min: 1, max: 500 }),
    /** Points a listing needs before its owner may replace the letter avatar with an
     *  uploaded icon. A logo is the loudest thing on a row, so it is earned in the
     *  currency the board runs on rather than handed to every new listing - and it
     *  keeps an upload form off a listing anyone can create in one POST. */
    iconMinPoints: int("ICON_MIN_POINTS", 2_000, { min: 0 }),
    pendingEntries: int("BOARD_PENDING_ENTRIES", 20, { min: 1, max: 500 }),
    trendingEntries: int("BOARD_TRENDING_ENTRIES", 10, { min: 1, max: 500 }),
    feedEntries: int("BOARD_FEED_ENTRIES", 15, { min: 1, max: 200 }),
    /** How often a changed board is pushed to everyone. */
    broadcastMs: int("BOARD_BROADCAST_MS", 2_000, { min: 100, max: 60_000 }),
    /** How often in-memory counters are written to SQLite. */
    flushMs: int("FLUSH_MS", 30_000, { min: 500, max: 600_000 }),
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

    /** Proxies in front of this server, counted from the outside in. X-Forwarded-For
     *  is appended to by each hop, so with one proxy the client address is the last
     *  entry. Trusting the first entry instead would let anyone forge their address
     *  and walk past the rate limit with a single header. */
    trustedProxies: int("TRUSTED_PROXIES", 0, { min: 0, max: 10 }),
  },
} as const;

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
  if (problems.length === 0) return;
  console.error("Configuration is not usable:");
  for (const problem of problems) console.error(`  - ${problem}`);
  console.error("See .env.example.");
  process.exit(1);
}
