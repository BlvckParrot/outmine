// The mining hub: one WebSocket per visitor, miners grouped onto shared pool sockets.
//
// Score is credited only when the pool accepts a share. A forged nonce is rejected
// upstream, so there is nothing to cheat and no heuristic to tune.
import type { ServerWebSocket } from "bun";
import type { BoardSnapshot, ClientMessage, ServerMessage } from "@outmine/protocol";
import {
  buildHeader, bytesToHex, diffToTarget, NONCE_SUBMIT_LITTLE_ENDIAN, type StratumJob,
} from "./blockheader";
import { config } from "./config";
import { countBoard, countHit, creditShares, listBoard, listingExists, refKeysToday } from "./listings";
import { log, makeThrottledLog } from "./log";
import { StratumClient } from "./stratum";

/** Stale shares are normal at job rotation and would otherwise log per share. */
const throttledLog = makeThrottledLog(30_000);

/** Bun needs the socket's data shape up front, but a Client can only be made once the
 *  socket exists, so the slot starts empty and `open` fills it. */
export type SocketData = { client: Client | null; address: string };

export type Client = {
  ws: ServerWebSocket<SocketData>;
  listingId: string | null;
  conn: PoolConnection | null;
  /** Index into this connection's extranonce2 space, distinct per live miner so no two
   *  build the same header and race to the same shares. */
  extranonce2Index: number;
  /** Self-reported, so clamped and never trusted for anything that scores. */
  hashrate: number;
  /** Unaccepted submits since the last accepted one. Deliberately not reset by a new
   *  `mine`: it is the only brake on a client that submits nothing but junk, and one
   *  that a message could clear would be no brake at all. */
  badSubmits: number;
  messagesThisSecond: number;
  secondStartedAt: number;
  /** The address this socket came from, kept so the per-address count can be undone
   *  when it closes. */
  address: string;
  lastMineAt: number;
  /** Traffic bookkeeping, per socket. `counted` and `mined` make a visit and a
   *  conversion count once however many times the browser says them; `seen` holds the
   *  keys already counted for this socket, which is what stops a client repeating a
   *  page to inflate the number - and, since every write here is a write to SQLite,
   *  what bounds how much disk one socket can spend. */
  counted: boolean;
  mined: boolean;
  seen: Set<string>;
};

type PoolConnection = {
  stratum: StratumClient;
  miners: Set<Client>;
  /** Miners this socket will take, moved by tuneConnections towards the share interval
   *  a browser should see. Not the configured maximum - that is only the ceiling. */
  capacity: number;
  /** Shares the pool accepted on this socket since the last tune. The controller's only
   *  input, because it is the only number the pool itself produced. */
  acceptedInWindow: number;
  /** Extranonce2 slots not currently held by a miner. Bounded and reused, so two live
   *  miners can never share one - which an ever-growing counter cannot promise once
   *  the pool reports a small extranonce2 size. */
  freeSlots: number[];
  extranonce1: string;
  extranonce2Size: number;
  difficulty: number;
  jobs: Map<string, StratumJob>;
  currentJobId: string | null;
  /** Submit request id -> the miner who found it. Without this the credit would land
   *  on whoever happened to be next on the socket. */
  submits: Map<number, Client>;
  /** Set when the last miner leaves, cleared if one arrives before it fires. */
  idleTimer: ReturnType<typeof setTimeout> | null;
};

/** The topic every socket subscribes to. Bun encodes and compresses a published
 *  message once for the whole topic; the loop it replaced did both per client. */
export const BOARD_TOPIC = "board";

const clients = new Set<Client>();
/** Sockets held per address. One entry per address with a live socket, deleted when its
 *  last one closes, so this never outgrows the client set. */
const perAddress = new Map<string, number>();
const connections = new Set<PoolConnection>();
/** Credited shares not yet written to SQLite, by listing id. */
const unflushed = new Map<string, { shares: number; diffSum: number }>();
const feed: { ts: number; text: string }[] = [];

/** The last broadcast, and when it was built. Both the "has anything moved" check and
 *  the snapshot a joining socket is handed. */
let lastBoard = "";
let lastBoardAt = 0;

/** Set when the pool drops us or errors: until it passes, no new pool socket is opened
 *  and no miner is admitted that would need one. */
let openingFrozenUntil = 0;

export const clientCount = () => clients.size;
export const miningCount = () => [...clients].filter((c) => c.listingId).length;
export const connectionCount = () => connections.size;
export const poolHealthy = () => [...connections].every((c) => c.stratum.connected);

/** Returns null when the server is already at capacity; the caller closes the socket.
 *
 *  Two ceilings, and the per-address one is the one that matters: a single global count
 *  is filled by whoever opens sockets fastest, and every visitor after that is refused
 *  by a server that is not busy at all. */
export function addClient(ws: ServerWebSocket<SocketData>, address: string): Client | null {
  if (clients.size >= config.limits.maxClients) {
    throttledLog("client_rejected_at_capacity", { clients: clients.size });
    return null;
  }
  const held = perAddress.get(address) ?? 0;
  if (held >= config.limits.maxClientsPerAddress) {
    throttledLog("client_rejected_per_address", { held });
    return null;
  }

  const client: Client = {
    ws, listingId: null, conn: null, extranonce2Index: 0,
    hashrate: 0, badSubmits: 0, messagesThisSecond: 0, secondStartedAt: 0,
    address, lastMineAt: 0,
    counted: false, mined: false, seen: new Set(),
  };
  perAddress.set(address, held + 1);
  clients.add(client);
  sendBoard(client);
  return client;
}

/** The snapshot a socket opens with, from the last broadcast while that is still
 *  current.
 *
 *  Building one is three queries and a walk of every client, and it used to happen per
 *  connection - so a restart, which brings the whole site back within seconds, was
 *  quadratic in the number of visitors at exactly the moment the server had least to
 *  spare. */
function sendBoard(client: Client) {
  // The whole thing is inside the try, not just the send. Building a snapshot is three
  // queries, and a throw here reaches Bun's websocket open handler, which ends the
  // process - so a database that cannot answer for a moment would take the site down
  // rather than cost one visitor their first paint. The next broadcast reaches them.
  try {
    if (!lastBoard || Date.now() - lastBoardAt >= config.board.broadcastMs) {
      lastBoard = JSON.stringify({ t: "board", ...boardSnapshot() });
      lastBoardAt = Date.now();
    }
    client.ws.send(lastBoard);
  } catch (err) {
    throttledLog("send_board_failed", { error: String(err) });
  }
}

export function removeClient(client: Client) {
  stopMining(client);
  clients.delete(client);

  const held = (perAddress.get(client.address) ?? 1) - 1;
  if (held > 0) perAddress.set(client.address, held);
  else perAddress.delete(client.address);
}

export function handleMessage(client: Client, raw: string) {
  if (overMessageRate(client)) {
    throttledLog("client_message_flood", { listingId: client.listingId });
    client.ws.close(1008, "too many messages");
    return;
  }

  let msg: ClientMessage;
  try {
    msg = JSON.parse(raw) as ClientMessage;
  } catch {
    return;
  }

  switch (msg?.t) {
    case "mine":
      return startMining(client, String(msg.listingId));
    case "stop":
      return stopMining(client);
    case "share":
      return submitShare(client, String(msg.jobId), Number(msg.nonce));
    case "hashrate":
      // Clamped, not trusted: the board shows this and nothing verifies it, so one
      // client must not be able to claim the whole leaderboard's hashrate.
      client.hashrate = Math.min(config.limits.maxReportedHashrate, Math.max(0, Number(msg.hs) || 0));
      return;
    case "view":
      return countView(client, msg);
    default:
      return;
  }
}

function overMessageRate(client: Client): boolean {
  const now = Date.now();
  if (now - client.secondStartedAt >= 1000) {
    client.secondStartedAt = now;
    client.messagesThisSecond = 0;
  }
  return ++client.messagesThisSecond > config.limits.maxMessagesPerSecond;
}

// --- traffic ------------------------------------------------------------------
// Counted here because the socket is already open and already origin-checked and rate
// limited. Everything below turns what the browser said into one of a fixed set of
// keys: (day, kind, key) is a primary key, so an unbounded key is an unbounded table.

const PAGES = new Set(["/", "/about", "/rules", "/faq", "/stats"]);
const LISTING_PATH = /^\/l\/([a-z0-9]{1,24})$/i;

/** The key a path is counted under. Whitelisted rather than stored as sent - a path is
 *  whatever the address bar contained. Exported for its test. */
export function pageKey(path: string): string {
  if (LISTING_PATH.test(path)) return "/l/:id";
  return PAGES.has(path) ? path : "/other";
}

/** The host a visitor came from, never the full URL: which page on Hacker News someone
 *  was reading is their business, and the host is the whole answer to "who sends us
 *  people". Our own pages, and anything that will not parse, drop out. */
export function refHost(ref: string | undefined, self: string): string {
  if (!ref) return "";
  let host: string;
  try {
    host = new URL(ref).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
  if (!host || host === self) return "";
  return /^[a-z0-9.-]{1,100}$/.test(host) ? host : "";
}

/** Our own hostname, so a click from one of our pages is not a referral. Empty when
 *  PUBLIC_ORIGIN is unset, which is development, where there is nothing to filter. */
const SELF_HOST = refHost(config.publicOrigin, "");

/** Distinct referrer hosts admitted in a day. */
const REF_MAX_PER_DAY = 500;
const REF_OTHER = "(other)";

let refDay = -1;
let refSeen = new Set<string>();

/** The key a referrer host is counted under.
 *
 *  `ref` is the one key here that is neither whitelisted nor checked against a table: a
 *  host is whatever the visitor's browser sent, and it becomes part of a primary key, so
 *  an unbounded host is an unbounded table - one permanent row per socket, from a sender
 *  who only has to connect and name a host nobody has named before.
 *
 *  Past the ceiling, further new hosts are counted together under one key rather than
 *  dropped: the total stays right, only the breakdown stops growing.
 *
 *  Exported for its test - the ceiling is the point of it. */
export function refKey(host: string): string {
  const day = Math.floor(Date.now() / 86_400_000);
  if (day !== refDay) {
    refDay = day;
    // Seeded from the table, not emptied: a restart would otherwise re-admit a fresh
    // ceiling's worth of hosts on top of the ones already stored for today.
    refSeen = new Set(refKeysToday());
  }
  if (refSeen.has(host)) return host;
  if (refSeen.size >= REF_MAX_PER_DAY) return REF_OTHER;
  refSeen.add(host);
  return host;
}

/** Counts a key once per socket. Every count here is a write to SQLite, so this is both
 *  what keeps the numbers honest - a page said twice is one view - and what bounds the
 *  disk one socket can spend within its message rate. */
function countOnce(client: Client, kind: string, key = "") {
  const seen = `${kind}:${key}`;
  if (client.seen.has(seen)) return;
  // A real visitor reads a handful of pages. The cap only matters for a client walking
  // the whole board to make writes happen.
  if (client.seen.size >= 100) return;
  client.seen.add(seen);
  countHit(kind, key);
}

function countView(client: Client, msg: { path?: unknown; ref?: unknown; first?: unknown }) {
  const path = String(msg.path ?? "");

  // Once per page load, not once per socket: the browser reconnects every couple of
  // seconds while the server is restarting, and each of those is the same visit.
  if (msg.first && !client.counted) {
    client.counted = true;
    countHit("visit");
    const host = refHost(typeof msg.ref === "string" ? msg.ref : undefined, SELF_HOST);
    if (host) countHit("ref", refKey(host));
  }

  countOnce(client, "page", pageKey(path));

  // Checked against the table rather than trusted. The id becomes part of a primary
  // key, so a made-up one is a row that stays there.
  const listing = LISTING_PATH.exec(path)?.[1]?.toLowerCase();
  if (listing && listingExists(listing)) countOnce(client, "listing", listing);
}

// --- how many miners share a socket -------------------------------------------------
//
// Not a constant, because the right number is not knowable here. What a miner waits for
// an accepted share is set by vardiff: the pool holds a *connection* to a few submits a
// minute whatever hashrate is behind it, so the wait is roughly that interval times the
// miners sharing the socket - and the constant that used to encode this was a guess at
// what the pool would do.
//
// So it is measured instead. Every window, each socket reports what the pool actually
// credited, and the number of miners the socket will take moves towards the target.

const TUNE_MS = 30_000;
const TUNE_STEP = 4;
const STARTING_CAPACITY = 16;

/** Below this a socket is not shrunk further. Vardiff has a floor: once the pool is
 *  already at its lowest difficulty, splitting miners across more sockets does not make
 *  shares arrive any faster - the hashrate is the same and so is the share rate - and
 *  all it buys is more connections from one address, which is the thing that gets an
 *  address banned. A miner waiting on a phone is not a socket that is too full. */
const MIN_CAPACITY = 4;

/** Seconds one miner on this socket waits for an accepted share, from what the pool
 *  credited in the last window. Infinity when it credited nothing, which is the same
 *  signal as "too slow", only louder. */
export const shareInterval = (miners: number, accepted: number, windowMs = TUNE_MS) =>
  accepted > 0 ? ((windowMs / 1000) * miners) / accepted : Infinity;

/** Where the capacity of one socket goes next. Split out from the loop because it is
 *  the whole policy, and a policy that cannot be tested without a pool is a policy
 *  nobody checks. */
export function nextCapacity(capacity: number, miners: number, seconds: number): number {
  // Only a full socket is evidence about how full a socket should be. Half empty and
  // slow is a phone, not a crowd - shrinking then would spill the next arrivals onto a
  // new connection while this one still had room. Half empty and fast is fast *because*
  // it is half empty, and growing on that would let one socket swallow the next crowd.
  if (miners < capacity) return capacity;

  const target = config.pool.targetShareSeconds;
  if (seconds > target) return Math.max(MIN_CAPACITY, capacity - TUNE_STEP);
  if (seconds < target / 2) return Math.min(config.pool.minersPerConnection, capacity + TUNE_STEP);
  return capacity;
}

/** Moves each socket's capacity towards the target share interval, once per window. */
function tuneConnections() {
  const frozen = Date.now() < openingFrozenUntil;

  for (const conn of connections) {
    const miners = conn.miners.size;
    const accepted = conn.acceptedInWindow;
    conn.acceptedInWindow = 0;
    // Frozen means the pool just complained and capacity has already been cut; measuring
    // a window that straddles a disconnection would only argue with that.
    if (miners === 0 || frozen) continue;

    const seconds = shareInterval(miners, accepted);
    const before = conn.capacity;
    conn.capacity = nextCapacity(conn.capacity, miners, seconds);

    // The one line that says what the controller is doing. Without it, a capacity that
    // has walked down to the floor looks exactly like a pool that has gone quiet.
    if (conn.capacity !== before) {
      throttledLog("pool_capacity", {
        from: before, to: conn.capacity, miners, accepted,
        secondsPerShare: Number.isFinite(seconds) ? Math.round(seconds) : null,
      });
    }
  }
}

/** The pool is unhappy: stop taking on new miners for a while and halve what each
 *  socket will hold. A controller that only ever opens connections is how one address
 *  earns a ban, and a ban takes every listing's earnings with it. */
function poolTrouble(reason: string) {
  openingFrozenUntil = Date.now() + config.pool.backoffMs;
  for (const conn of connections) {
    conn.capacity = Math.max(MIN_CAPACITY, Math.floor(conn.capacity / 2));
  }
  throttledLog("pool_backoff", { reason, seconds: Math.round(config.pool.backoffMs / 1000) });
}

// --- pool connections ---------------------------------------------------------

function openConnection(): PoolConnection {
  const conn: PoolConnection = {
    stratum: null as unknown as StratumClient,
    miners: new Set(),
    capacity: STARTING_CAPACITY,
    acceptedInWindow: 0,
    freeSlots: Array.from({ length: config.pool.minersPerConnection }, (_, i) => i),
    extranonce1: "",
    extranonce2Size: 4,
    difficulty: 1,
    jobs: new Map(),
    currentJobId: null,
    submits: new Map(),
    idleTimer: null,
  };

  conn.stratum = new StratumClient(
    config.pool.host, config.pool.port, config.pool.user, config.pool.password,
    {
      onSubscribed: (extranonce1, size) => {
        // Also fires after a reconnect with a fresh extranonce1, which invalidates
        // every header built from the old one - hence a re-send, not a no-op.
        conn.extranonce1 = extranonce1;
        conn.extranonce2Size = size || 4;
        // And the remembered jobs go with it. They were built on the old extranonce1,
        // so submitShare would still find them, send them, and have them rejected -
        // against a badSubmits counter that only an accepted share clears. Reconnecting
        // is not something a miner should be cut off for.
        conn.jobs.clear();
        conn.currentJobId = null;
        broadcastJob(conn);
      },
      onDifficulty: (difficulty) => {
        conn.difficulty = difficulty;
        broadcastJob(conn); // the target travels with the job
      },
      onJob: (job) => {
        conn.jobs.set(job.jobId, job);
        while (conn.jobs.size > config.pool.jobHistory) {
          conn.jobs.delete(conn.jobs.keys().next().value!);
        }
        conn.currentJobId = job.jobId;
        broadcastJob(conn);
      },
      onSubmitResult: (ok, err, id) => {
        const miner = conn.submits.get(id);
        conn.submits.delete(id);
        if (!miner) return; // miner left before the pool answered
        if (ok) {
          miner.badSubmits = 0; // a run of failures is the signal; one stale share is not
          conn.acceptedInWindow++;
          creditShare(miner, conn.difficulty);
        }
        // The pool's own words are logged, not forwarded: they are untrusted
        // third-party text, and "Invalid share" tells a visitor nothing they can act on.
        if (!ok) throttledLog("share_rejected", { error: String(err) });
        send(miner, { t: "shareResult", ok, error: ok ? null : "rejected by the pool" });
      },
      onError: (err) => {
        throttledLog("pool_error", { error: String(err) });
        poolTrouble("error");
      },
      onDisconnected: () => {
        conn.submits.clear(); // answers will never come; do not credit them later
        for (const miner of conn.miners) send(miner, { t: "error", message: "pool reconnecting" });
        log("pool_disconnected", { miners: conn.miners.size });
        poolTrouble("disconnected");
      },
    },
  );

  connections.add(conn);
  void conn.stratum.connect();
  log("pool_connected", { connections: connections.size });
  return conn;
}

/** Puts a miner on a socket with room, opening one if needed. Null when the pool
 *  connection ceiling is reached: better to turn a miner away than to earn a ban that
 *  would stop everyone earning. */
function joinConnection(client: Client): PoolConnection | null {
  let conn: PoolConnection | undefined;
  for (const candidate of connections) {
    // Capacity is the controller's number and freeSlots is the protocol's: extranonce2
    // slots are what stops two miners on one socket hashing the same nonces, and there
    // is no share of the work to hand out once they run out.
    if (candidate.miners.size < candidate.capacity && candidate.freeSlots.length > 0) {
      conn = candidate;
      break;
    }
  }
  if (!conn) {
    if (Date.now() < openingFrozenUntil) {
      throttledLog("pool_opening_frozen", { connections: connections.size });
      return null;
    }
    if (connections.size >= config.pool.maxConnections) {
      throttledLog("pool_connection_ceiling", { connections: connections.size });
      return null;
    }
    conn = openConnection();
  }

  // Reusing a socket that was about to be closed is the whole point of the grace
  // period: the miner it is waiting for has arrived.
  if (conn.idleTimer) {
    clearTimeout(conn.idleTimer);
    conn.idleTimer = null;
  }

  client.extranonce2Index = conn.freeSlots.pop()!;
  conn.miners.add(client);
  client.conn = conn;
  return conn;
}

function leaveConnection(client: Client) {
  const conn = client.conn;
  if (!conn) return;

  conn.miners.delete(client);
  conn.freeSlots.push(client.extranonce2Index);
  for (const [id, miner] of conn.submits) if (miner === client) conn.submits.delete(id);
  client.conn = null;

  // Nobody left on this socket. Held for a grace period rather than closed here: a
  // visitor switching listings leaves and rejoins in the same tick, and closing on the
  // spot makes that a fresh connect, subscribe and authorize against the pool. Repeated
  // fast enough - which one socket can do within its own message rate - that is a
  // connection flood from our address, and the ban would take every listing's earnings
  // with it.
  if (conn.miners.size === 0 && !conn.idleTimer) {
    conn.idleTimer = setTimeout(() => closeConnection(conn), config.pool.idleConnectionMs);
    conn.idleTimer.unref?.(); // an idle socket must not hold the process open at exit
  }
}

function closeConnection(conn: PoolConnection) {
  conn.idleTimer = null;
  if (conn.miners.size > 0) return; // someone joined; the timer lost the race
  conn.stratum.close();
  connections.delete(conn);
  log("pool_closed", { connections: connections.size });
}

const extranonce2Of = (client: Client, conn: PoolConnection) =>
  client.extranonce2Index.toString(16).padStart(conn.extranonce2Size * 2, "0");

/** Sends the current job. `only` restricts it to one miner, which matters when someone
 *  joins a busy socket: the others are mid-range and must not be restarted. */
function broadcastJob(conn: PoolConnection, only?: Client) {
  if (!conn.extranonce1 || !conn.currentJobId) return;
  const job = conn.jobs.get(conn.currentJobId);
  if (!job) return;

  const target = bytesToHex(diffToTarget(conn.difficulty));
  for (const miner of only ? [only] : conn.miners) {
    send(miner, {
      t: "job",
      jobId: job.jobId,
      header: bytesToHex(buildHeader(job, conn.extranonce1, extranonce2Of(miner, conn))),
      algo: config.pool.algo,
      target,
    });
  }
}

// --- mining -------------------------------------------------------------------

function startMining(client: Client, listingId: string) {
  // Before the lookup, so a flood of `mine` costs no query either.
  const now = Date.now();
  if (now - client.lastMineAt < config.pool.mineCooldownMs) {
    return send(client, { t: "error", message: "one moment" });
  }
  client.lastMineAt = now;

  if (!listingExists(listingId)) return send(client, { t: "error", message: "no such listing" });

  stopMining(client);
  const conn = joinConnection(client);
  if (!conn) {
    return send(client, { t: "error", message: "mining is at capacity, try again shortly", retry: true });
  }

  // Once per socket, so switching listings is not a second conversion.
  if (!client.mined) {
    client.mined = true;
    countHit("mine");
  }

  client.listingId = listingId;
  // badSubmits is deliberately not cleared here. It is reset by an accepted share and
  // by nothing else: a counter a client can zero with a message it chooses to send is
  // not a limit on that client.
  broadcastJob(conn, client); // a socket that is already subscribed can start them now
}

function stopMining(client: Client) {
  leaveConnection(client);
  client.listingId = null;
}

function submitShare(client: Client, jobId: string, nonce: number) {
  const conn = client.conn;
  if (!conn) return;

  // A share for a job the pool already replaced comes back as "Invalid job id";
  // dropping it here keeps that noise off the wire. Logged, because a silent drop is
  // indistinguishable from a miner that has stopped finding anything.
  const job = conn.jobs.get(jobId);
  if (!job) {
    throttledLog("share_dropped_stale", { jobId });
    return;
  }

  if (++client.badSubmits > config.pool.maxBadSubmits) {
    send(client, { t: "error", message: "too many invalid shares" });
    log("miner_cut_off", { listingId: client.listingId });
    stopMining(client);
    return;
  }

  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, nonce >>> 0, NONCE_SUBMIT_LITTLE_ENDIAN[config.pool.algo]);
  const id = conn.stratum.submit(jobId, extranonce2Of(client, conn), job.ntime, bytesToHex(bytes));
  conn.submits.set(id, client);
}

function creditShare(client: Client, difficulty: number) {
  if (!client.listingId) return;
  const acc = unflushed.get(client.listingId) ?? { shares: 0, diffSum: 0 };
  acc.shares++;
  acc.diffSum += difficulty;
  unflushed.set(client.listingId, acc);
}

// --- board --------------------------------------------------------------------

function boardSnapshot(): BoardSnapshot {
  const hashrates = new Map<string, number>();
  const miners = new Map<string, number>();
  for (const c of clients) {
    if (!c.listingId) continue;
    hashrates.set(c.listingId, (hashrates.get(c.listingId) ?? 0) + c.hashrate);
    miners.set(c.listingId, (miners.get(c.listingId) ?? 0) + 1);
  }

  // Counters not yet flushed are added in, otherwise a share takes up to the flush
  // interval to appear and the board looks frozen while people are actively mining.
  const live = (entry: ReturnType<typeof listBoard>[number]) => ({
    ...entry,
    hashrate: Math.round(hashrates.get(entry.id) ?? 0),
    miners: miners.get(entry.id) ?? 0,
    shares: entry.shares + (unflushed.get(entry.id)?.shares ?? 0),
    score: entry.score + (unflushed.get(entry.id)?.diffSum ?? 0),
  });

  return {
    entries: listBoard().map(live).sort((a, b) => b.score - a.score),
    pending: listBoard({ visible: 0 }).map(live),
    // The rows above are the first page. The count is what lets a visitor who has
    // touched no filter reach the second one.
    total: countBoard(),
    limit: config.board.entries,
    threshold: config.board.visibilityThreshold,
    iconMinPoints: config.board.iconMinPoints,
    maxNameLength: config.board.maxNameLength,
    maxTaglineLength: config.board.maxTaglineLength,
    online: clients.size,
    mining: miningCount(),
    feed: feed.slice(-config.board.feedEntries),
  };
}

const send = (client: Client, payload: ServerMessage) => {
  try {
    client.ws.send(JSON.stringify(payload));
  } catch {
    /* socket already gone; the close handler cleans up */
  }
};

export function pushFeed(text: string) {
  feed.push({ ts: Date.now(), text });
  while (feed.length > config.board.feedEntries) feed.shift();
}

/** Forgets a listing that is about to be deleted. Call before the row goes.
 *
 *  Without this a takedown stops the whole site scoring. The miners on that listing
 *  keep crediting into `unflushed`, and the next flush tries to INSERT a share_bucket
 *  whose listing_id no longer exists. That fails the foreign key, and creditShares runs
 *  the batch in one transaction - so the rollback takes every *other* listing shares
 *  with it, and flush correctly keeps the counters to retry, forever. One takedown, and
 *  nothing reaches SQLite again until a restart, with one `flush_failed` line to say so. */
export function dropListing(id: string) {
  for (const client of clients) {
    if (client.listingId !== id) continue;
    send(client, { t: "error", message: "this listing has been removed" });
    stopMining(client);
  }
  unflushed.delete(id);
}

/** Consecutive failed flushes before the process gives up and lets the supervisor
 *  restart it.
 *
 *  A flush that keeps failing is a database that is gone, and everything above this
 *  line is written to keep running through exactly that - the loops are guarded, the
 *  counters are kept, /health answers 503. But `restart: unless-stopped` only reacts to
 *  a process that exits, so a container that is unhealthy and alive stays in service
 *  and keeps taking visitors' CPU for shares it can no longer record. */
const FLUSH_FAILURES_BEFORE_EXIT = 5;
let flushFailures = 0;

/** Writes the in-memory counters to SQLite and flips listings past the PoW gate. */
export function flush() {
  if (unflushed.size === 0) return;
  const batch = [...unflushed.entries()];

  try {
    for (const { id, name } of creditShares(batch)) {
      pushFeed(`${name} mined its way onto the board`);
      log("gate_passed", { listingId: id, name });
    }
    flushFailures = 0;
  } catch (err) {
    // Counters stay put so the next flush retries them. Clearing first - the obvious
    // order - would throw away shares that were mined, accepted by the pool and paid
    // for, on any transient database error.
    log("flush_failed", { error: String(err), listings: batch.length, run: ++flushFailures });
    if (flushFailures >= FLUSH_FAILURES_BEFORE_EXIT) {
      log("flush_failed_fatal", { runs: flushFailures });
      process.exit(1);
    }
    return;
  }

  // Only what was just written is removed; anything credited during the transaction
  // stays for the next round.
  for (const [listingId, acc] of batch) {
    const current = unflushed.get(listingId);
    if (!current) continue;
    current.shares -= acc.shares;
    current.diffSum -= acc.diffSum;
    if (current.shares <= 0) unflushed.delete(listingId);
  }
}

/** How late the broadcast loop ran, in milliseconds. The one number that says whether
 *  the process is keeping up: everything here shares a single thread, so a card being
 *  rasterised or a snapshot being built shows up as this interval slipping. Reported by
 *  /health, where the load test and a monitor can both read it. */
export const loopLag = () => lag;
let lag = 0;
let lastTick = 0;

/** setInterval with a net under it.
 *
 *  An uncaught throw in a timer ends the Bun process, and unlike a signal it skips the
 *  flush in server.ts - so a transient SQLite error inside one of these loops would
 *  cost every share credited since the last write. Each of the three reaches the
 *  database, and a loop that failed once is very likely to succeed on its next tick. */
const everyMs = (ms: number, loop: string, fn: () => void) =>
  setInterval(() => {
    try {
      fn();
    } catch (err) {
      throttledLog("loop_failed", { loop, error: String(err) });
    }
  }, ms);

export function startLoops(server: Bun.Server<SocketData>) {
  everyMs(config.board.flushMs, "flush", flush);
  everyMs(TUNE_MS, "tune", tuneConnections);
  everyMs(config.board.broadcastMs, "broadcast", () => {
    const tick = Date.now();
    if (lastTick) lag = Math.max(0, tick - lastTick - config.board.broadcastMs);
    lastTick = tick;

    if (clients.size === 0) return;
    const json = JSON.stringify({ t: "board", ...boardSnapshot() });
    // Stamped even when nothing moved: the snapshot is still current, and a socket
    // joining in the next couple of seconds can be handed it as it is.
    lastBoardAt = Date.now();
    if (json === lastBoard) return; // nothing moved; skip the broadcast
    lastBoard = json;
    // One encode and one compression for the whole topic, in native code. The loop this
    // replaced did both per socket, which at a few thousand of them is the broadcast
    // interval spent inside the broadcast.
    server.publish(BOARD_TOPIC, json, true);
  });
}
