// The mining hub: one WebSocket per visitor, one pool connection per group of miners.
//
// Score is credited only when the pool accepts a share. A forged nonce is rejected
// upstream, so there is nothing to cheat and no heuristic to tune.
import type { ServerWebSocket } from "bun";
import { db } from "./db";
import { buildHeader, bytesToHex, diffToTarget, type StratumJob } from "./blockheader";
import { getBoard, getPending, VISIBILITY_THRESHOLD } from "./listings";
import type { BoardSnapshot, ServerMessage } from "./protocol";
import { StratumClient } from "./stratum";

const POOL_HOST = process.env.POOL_HOST ?? "minotaurx.mine.zpool.ca";
const POOL_PORT = Number(process.env.POOL_PORT ?? 7019);
const POOL_USER = process.env.POOL_USER ?? "";
const POOL_PASS = process.env.POOL_PASS ?? "c=BTC";
const FLUSH_MS = Number(process.env.FLUSH_MS ?? 30_000);
const BOARD_MS = 2_000;

/** Miners sharing one pool socket.
 *
 *  Not one socket per miner: a few hundred visitors would be a few hundred TCP
 *  connections from one IP and the pool would ban us. Not one socket for everyone
 *  either: zpool's vardiff targets 5-15 submits per minute *per connection*, so a
 *  single shared socket would cap the whole site at 5-15 shares a minute no matter
 *  how many people mine. Scoring would stay right on average, but a newcomer could
 *  mine for five minutes and see zero, which kills the only feedback the game has.
 *  A group of 16 keeps shares flowing every minute or two while bounding sockets. */
const MINERS_PER_CONNECTION = 16;

/** Jobs kept per connection so a share that raced a job switch is dropped, not sent. */
const JOB_HISTORY = 3;

/** Consecutive unaccepted submits tolerated per miner before we cut them off.
 *  Counting rejects alone is not enough: a pool that has had enough of bad shares
 *  simply stops replying, so silence has to count against the miner too.
 *  Spraying random nonces cannot beat honest mining (the odds match the work either
 *  way), but it can get the server's IP banned - and now it would take the other
 *  fifteen miners on that socket down with it, so the cut-off is per miner. */
const MAX_BAD_SUBMITS = 10;

/** Bun needs the socket's data shape up front, but a Client can only be made once
 *  the socket exists, so the slot starts empty and `open` fills it. */
export type SocketData = { client: Client | null };

export type Client = {
  ws: ServerWebSocket<SocketData>;
  listingId: string | null;
  conn: PoolConnection | null;
  /** Index into this connection's extranonce2 space. Distinct per miner, so no two
   *  miners on a socket build the same header and race to the same shares. */
  extranonce2Index: number;
  hashrate: number;
  badSubmits: number;
};

type PoolConnection = {
  stratum: StratumClient;
  miners: Set<Client>;
  extranonce1: string;
  extranonce2Size: number;
  difficulty: number;
  jobs: Map<string, StratumJob>;
  currentJobId: string | null;
  /** Request id of a submit -> the miner who found it. Without this the credit would
   *  land on whoever happened to be next on the socket. */
  submits: Map<number, Client>;
  nextExtranonce2: number;
};

const clients = new Set<Client>();
const connections = new Set<PoolConnection>();
/** Credited shares not yet written to SQLite, by listing id. */
const pending = new Map<string, { shares: number; diffSum: number }>();
const feed: { ts: number; text: string }[] = [];

export const clientCount = () => clients.size;
export const connectionCount = () => connections.size;
export const poolHealthy = () => [...connections].every((c) => c.stratum.connected);

export function addClient(ws: ServerWebSocket<SocketData>): Client {
  const client: Client = {
    ws, listingId: null, conn: null, extranonce2Index: 0, hashrate: 0, badSubmits: 0,
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
  let msg: any;
  try {
    msg = JSON.parse(raw);
  } catch {
    return;
  }
  if (msg.t === "mine") return startMining(client, String(msg.listingId));
  if (msg.t === "stop") return stopMining(client);
  if (msg.t === "share") return submitShare(client, String(msg.jobId), Number(msg.nonce));
  if (msg.t === "hashrate") client.hashrate = Math.max(0, Number(msg.hs) || 0);
}

// --- pool connections ---------------------------------------------------------

function openConnection(): PoolConnection {
  const conn: PoolConnection = {
    stratum: null as unknown as StratumClient,
    miners: new Set(),
    extranonce1: "",
    extranonce2Size: 4,
    difficulty: 1,
    jobs: new Map(),
    currentJobId: null,
    submits: new Map(),
    nextExtranonce2: 0,
  };

  conn.stratum = new StratumClient(POOL_HOST, POOL_PORT, POOL_USER, POOL_PASS, {
    onSubscribed: (extranonce1, size) => {
      // Also fires after a reconnect with a fresh extranonce1, which invalidates every
      // header built from the old one - hence a full re-send rather than a no-op.
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
      while (conn.jobs.size > JOB_HISTORY) conn.jobs.delete(conn.jobs.keys().next().value!);
      conn.currentJobId = job.jobId;
      broadcastJob(conn);
    },
    onSubmitResult: (ok, err, id) => {
      const miner = conn.submits.get(id);
      conn.submits.delete(id);
      if (!miner) return; // miner left before the pool answered
      if (ok) {
        miner.badSubmits = 0; // only a run of failures is a signal; one stale share is not
        creditShare(miner, conn.difficulty);
      }
      send(miner, { t: "shareResult", ok, error: ok ? null : String(err) });
    },
    onError: (err) => log("pool_error", { error: String(err) }),
    onDisconnected: () => {
      conn.submits.clear(); // answers will never come; do not credit them later
      for (const miner of conn.miners) send(miner, { t: "error", message: "pool reconnecting" });
      log("pool_disconnected", { miners: conn.miners.size });
    },
  });

  connections.add(conn);
  void conn.stratum.connect();
  log("pool_connected", { connections: connections.size });
  return conn;
}

function joinConnection(client: Client): PoolConnection {
  let conn: PoolConnection | undefined;
  for (const candidate of connections) {
    if (candidate.miners.size < MINERS_PER_CONNECTION) {
      conn = candidate;
      break;
    }
  }
  conn ??= openConnection();
  client.extranonce2Index = conn.nextExtranonce2++;
  conn.miners.add(client);
  client.conn = conn;
  return conn;
}

function leaveConnection(client: Client) {
  const conn = client.conn;
  if (!conn) return;
  conn.miners.delete(client);
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
  client.extranonce2Index.toString(16).padStart(conn.extranonce2Size * 2, "0").slice(-conn.extranonce2Size * 2);

/** Sends the current job. `only` restricts it to one miner, which matters when someone
 *  joins a busy socket: the others are mid-range and must not be interrupted. */
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
  const listing = db.query(`SELECT id FROM listings WHERE id = ?`).get(listingId);
  if (!listing) return send(client, { t: "error", message: "no such listing" });

  stopMining(client);
  client.listingId = listingId;
  client.badSubmits = 0;
  const conn = joinConnection(client);
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
    log("share_dropped_stale", { jobId, known: [...conn.jobs.keys()] });
    return;
  }

  if (++client.badSubmits > MAX_BAD_SUBMITS) {
    send(client, { t: "error", message: "too many invalid shares" });
    log("miner_cut_off", { listingId: client.listingId });
    stopMining(client);
    return;
  }

  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, nonce >>> 0, true); // cpuminer submits the nonce little-endian
  const id = conn.stratum.submit(jobId, extranonce2Of(client, conn), job.ntime, bytesToHex(bytes));
  conn.submits.set(id, client);
}

function creditShare(client: Client, difficulty: number) {
  if (!client.listingId) return;
  const acc = pending.get(client.listingId) ?? { shares: 0, diffSum: 0 };
  acc.shares++;
  acc.diffSum += difficulty;
  pending.set(client.listingId, acc);
}

// --- board --------------------------------------------------------------------

function boardSnapshot(): BoardSnapshot {
  const miners = new Map<string, number>();
  for (const c of clients) {
    if (c.listingId) miners.set(c.listingId, (miners.get(c.listingId) ?? 0) + c.hashrate);
  }
  // Add the not-yet-flushed counters, otherwise a share takes up to 30s to show up
  // and the board looks frozen while people are actively mining.
  const live = (e: ReturnType<typeof getBoard>[number]) => ({
    ...e,
    hashrate: Math.round(miners.get(e.id) ?? 0),
    shares: e.shares + (pending.get(e.id)?.shares ?? 0),
    score: e.score + (pending.get(e.id)?.diffSum ?? 0),
  });

  return {
    entries: getBoard().map(live).sort((a, b) => b.score - a.score),
    pending: getPending().map(live),
    threshold: VISIBILITY_THRESHOLD,
    online: clients.size,
    mining: [...clients].filter((c) => c.listingId).length,
    feed: feed.slice(-15),
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
  if (feed.length > 50) feed.shift();
}

export function log(event: string, fields: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), event, ...fields }));
}

/** Writes the in-memory counters to SQLite and flips listings past the PoW gate. */
export function flush() {
  if (pending.size === 0) return;
  const hour = Math.floor(Date.now() / 3_600_000);
  const batch = [...pending.entries()];
  pending.clear();

  db.transaction(() => {
    for (const [listingId, acc] of batch) {
      db.query(
        `INSERT INTO share_buckets (listing_id, hour, shares, diff_sum) VALUES (?, ?, ?, ?)
         ON CONFLICT (listing_id, hour) DO UPDATE SET
           shares = shares + excluded.shares, diff_sum = diff_sum + excluded.diff_sum`,
      ).run(listingId, hour, acc.shares, acc.diffSum);

      db.query(`UPDATE listings SET shares = shares + ?, score = score + ? WHERE id = ?`)
        .run(acc.shares, acc.diffSum, listingId);

      const row = db.query(`SELECT name, shares, visible FROM listings WHERE id = ?`).get(listingId) as
        | { name: string; shares: number; visible: number }
        | null;
      if (row && !row.visible && row.shares >= VISIBILITY_THRESHOLD) {
        db.query(`UPDATE listings SET visible = 1 WHERE id = ?`).run(listingId);
        pushFeed(`${row.name} mined its way onto the board`);
        log("gate_passed", { listingId, name: row.name });
      }
    }
  })();
}

let lastBoard = "";
export function startLoops() {
  setInterval(flush, FLUSH_MS);
  setInterval(() => {
    if (clients.size === 0) return;
    const json = JSON.stringify({ t: "board", ...boardSnapshot() });
    if (json === lastBoard) return; // nothing moved; skip the broadcast
    lastBoard = json;
    for (const c of clients) {
      try {
        c.ws.send(json);
      } catch {
        /* closing */
      }
    }
  }, BOARD_MS);
}
