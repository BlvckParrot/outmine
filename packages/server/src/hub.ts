// The mining hub: one WebSocket per visitor, miners grouped onto shared pool sockets.
//
// Score is credited only when the pool accepts a share. A forged nonce is rejected
// upstream, so there is nothing to cheat and no heuristic to tune.
import type { ServerWebSocket } from "bun";
import type { BoardSnapshot, ClientMessage, ServerMessage } from "@outmine/protocol";
import { buildHeader, bytesToHex, diffToTarget, type StratumJob } from "./blockheader";
import { config } from "./config";
import { countBoard, creditShares, listBoard, listingExists } from "./listings";
import { log, makeThrottledLog } from "./log";
import { StratumClient } from "./stratum";

/** Stale shares are normal at job rotation and would otherwise log per share. */
const throttledLog = makeThrottledLog(30_000);

/** Bun needs the socket's data shape up front, but a Client can only be made once the
 *  socket exists, so the slot starts empty and `open` fills it. */
export type SocketData = { client: Client | null };

export type Client = {
  ws: ServerWebSocket<SocketData>;
  listingId: string | null;
  conn: PoolConnection | null;
  /** Index into this connection's extranonce2 space, distinct per live miner so no two
   *  build the same header and race to the same shares. */
  extranonce2Index: number;
  /** Self-reported, so clamped and never trusted for anything that scores. */
  hashrate: number;
  badSubmits: number;
  messagesThisSecond: number;
  secondStartedAt: number;
};

type PoolConnection = {
  stratum: StratumClient;
  miners: Set<Client>;
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
};

const clients = new Set<Client>();
const connections = new Set<PoolConnection>();
/** Credited shares not yet written to SQLite, by listing id. */
const unflushed = new Map<string, { shares: number; diffSum: number }>();
const feed: { ts: number; text: string }[] = [];

export const clientCount = () => clients.size;
export const miningCount = () => [...clients].filter((c) => c.listingId).length;
export const connectionCount = () => connections.size;
export const poolHealthy = () => [...connections].every((c) => c.stratum.connected);

/** Returns null when the server is already at capacity; the caller closes the socket. */
export function addClient(ws: ServerWebSocket<SocketData>): Client | null {
  if (clients.size >= config.limits.maxClients) {
    throttledLog("client_rejected_at_capacity", { clients: clients.size });
    return null;
  }
  const client: Client = {
    ws, listingId: null, conn: null, extranonce2Index: 0,
    hashrate: 0, badSubmits: 0, messagesThisSecond: 0, secondStartedAt: 0,
  };
  clients.add(client);
  send(client, { t: "board", ...boardSnapshot() });
  return client;
}

export function removeClient(client: Client) {
  stopMining(client);
  clients.delete(client);
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

// --- pool connections ---------------------------------------------------------

function openConnection(): PoolConnection {
  const conn: PoolConnection = {
    stratum: null as unknown as StratumClient,
    miners: new Set(),
    freeSlots: Array.from({ length: config.pool.minersPerConnection }, (_, i) => i),
    extranonce1: "",
    extranonce2Size: 4,
    difficulty: 1,
    jobs: new Map(),
    currentJobId: null,
    submits: new Map(),
  };

  conn.stratum = new StratumClient(
    config.pool.host, config.pool.port, config.pool.user, config.pool.password,
    {
      onSubscribed: (extranonce1, size) => {
        // Also fires after a reconnect with a fresh extranonce1, which invalidates
        // every header built from the old one - hence a re-send, not a no-op.
        conn.extranonce1 = extranonce1;
        conn.extranonce2Size = size || 4;
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
          creditShare(miner, conn.difficulty);
        }
        send(miner, { t: "shareResult", ok, error: ok ? null : String(err) });
      },
      onError: (err) => throttledLog("pool_error", { error: String(err) }),
      onDisconnected: () => {
        conn.submits.clear(); // answers will never come; do not credit them later
        for (const miner of conn.miners) send(miner, { t: "error", message: "pool reconnecting" });
        log("pool_disconnected", { miners: conn.miners.size });
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
    if (candidate.freeSlots.length > 0) {
      conn = candidate;
      break;
    }
  }
  if (!conn) {
    if (connections.size >= config.pool.maxConnections) {
      throttledLog("pool_connection_ceiling", { connections: connections.size });
      return null;
    }
    conn = openConnection();
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

  // Nobody left on this socket: close it rather than hold it open against the pool.
  if (conn.miners.size === 0) {
    conn.stratum.close();
    connections.delete(conn);
    log("pool_closed", { connections: connections.size });
  }
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
      target,
    });
  }
}

// --- mining -------------------------------------------------------------------

function startMining(client: Client, listingId: string) {
  if (!listingExists(listingId)) return send(client, { t: "error", message: "no such listing" });

  stopMining(client);
  const conn = joinConnection(client);
  if (!conn) return send(client, { t: "error", message: "mining is at capacity, try again shortly" });

  client.listingId = listingId;
  client.badSubmits = 0;
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
  new DataView(bytes.buffer).setUint32(0, nonce >>> 0, true); // cpuminer submits it little-endian
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

/** Writes the in-memory counters to SQLite and flips listings past the PoW gate. */
export function flush() {
  if (unflushed.size === 0) return;
  const batch = [...unflushed.entries()];

  try {
    for (const { id, name } of creditShares(batch)) {
      pushFeed(`${name} mined its way onto the board`);
      log("gate_passed", { listingId: id, name });
    }
  } catch (err) {
    // Counters stay put so the next flush retries them. Clearing first - the obvious
    // order - would throw away shares that were mined, accepted by the pool and paid
    // for, on any transient database error.
    log("flush_failed", { error: String(err), listings: batch.length });
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

let lastBoard = "";

export function startLoops() {
  setInterval(flush, config.board.flushMs);
  setInterval(() => {
    if (clients.size === 0) return;
    const json = JSON.stringify({ t: "board", ...boardSnapshot() });
    if (json === lastBoard) return; // nothing moved; skip the broadcast
    lastBoard = json;
    for (const client of clients) {
      try {
        client.ws.send(json);
      } catch {
        /* closing */
      }
    }
  }, config.board.broadcastMs);
}
