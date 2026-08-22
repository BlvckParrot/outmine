// The mining hub: one WebSocket per visitor, one pool connection per miner.
//
// Score is credited only when the pool accepts a share. A forged nonce is
// rejected upstream, so there is nothing to cheat and no heuristic to tune.
import type { ServerWebSocket } from "bun";
import { db } from "./db";
import { buildHeader, bytesToHex, diffToTarget, type StratumJob } from "./blockheader";
import { getBoard, getPending, logEvent, VISIBILITY_THRESHOLD } from "./listings";
import { StratumClient } from "./stratum";

const POOL_HOST = process.env.POOL_HOST ?? "minotaurx.mine.zpool.ca";
const POOL_PORT = Number(process.env.POOL_PORT ?? 7019);
const POOL_USER = process.env.POOL_USER ?? "";
const POOL_PASS = process.env.POOL_PASS ?? "c=BTC";
const EXTRANONCE2 = "00000000";
const FLUSH_MS = 30_000;
const BOARD_MS = 2_000;
/** Jobs kept per miner so a share that raced a job switch is dropped, not submitted. */
const JOB_HISTORY = 3;
/** Submits allowed to go unaccepted per connection before we cut it off.
 *  Counting rejects alone is not enough: a pool that has had enough of bad shares
 *  simply stops replying, so silence has to count against the client too.
 *  A client spraying random nonces cannot beat honest mining (the odds match the
 *  work either way), but it can get the server's IP banned by the pool. */
const MAX_BAD_SUBMITS = 10;

export type Client = {
  ws: ServerWebSocket<{ id: string }>;
  listingId: string | null;
  pool: StratumClient | null;
  extranonce1: string;
  difficulty: number;
  jobs: Map<string, StratumJob>;
  shares: number;
  diffSum: number;
  hashrate: number;
  /** Consecutive submits the pool has not accepted. */
  badSubmits: number;
};

const clients = new Set<Client>();
/** Credited shares not yet written to SQLite, by listing id. */
const pending = new Map<string, { shares: number; diffSum: number }>();
const feed: { ts: number; text: string }[] = [];

export const clientCount = () => clients.size;

export function addClient(ws: ServerWebSocket<{ id: string }>): Client {
  const client: Client = {
    ws, listingId: null, pool: null, extranonce1: "",
    difficulty: 1, jobs: new Map(), shares: 0, diffSum: 0, hashrate: 0, badSubmits: 0,
  };
  clients.add(client);
  send(client, { t: "board", ...boardSnapshot() });
  return client;
}

export function removeClient(client: Client) {
  // Without this the pool sockets outlive the tabs and pile up within a day.
  client.pool?.close();
  client.pool = null;
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

function startMining(client: Client, listingId: string) {
  const listing = db.query(`SELECT id FROM listings WHERE id = ?`).get(listingId);
  if (!listing) return send(client, { t: "error", message: "no such listing" });

  stopMining(client);
  client.listingId = listingId;

  // The wallet and algorithm come from the server's env. Anything the client
  // says about where to mine is ignored on purpose.
  client.pool = new StratumClient(POOL_HOST, POOL_PORT, POOL_USER, POOL_PASS, {
    onSubscribed: (e1) => (client.extranonce1 = e1),
    onDifficulty: (d) => (client.difficulty = d),
    onJob: (job) => {
      client.jobs.set(job.jobId, job);
      while (client.jobs.size > JOB_HISTORY) client.jobs.delete(client.jobs.keys().next().value!);
      if (client.extranonce1) sendJob(client, job);
    },
    onSubmitResult: (ok, err) => {
      if (ok) {
        client.badSubmits = 0; // only a run of failures is a signal; an old stale share is not
        creditShare(client);
      }
      send(client, { t: "shareResult", ok, error: ok ? null : String(err) });
    },
    onError: (err) => send(client, { t: "error", message: String(err) }),
    onClose: () => send(client, { t: "error", message: "pool disconnected" }),
  });
  client.pool.connect().catch((err) => send(client, { t: "error", message: String(err) }));
}

function stopMining(client: Client) {
  client.pool?.close();
  client.pool = null;
  client.jobs.clear();
  client.listingId = null;
}

function sendJob(client: Client, job: StratumJob) {
  send(client, {
    t: "job",
    jobId: job.jobId,
    header: bytesToHex(buildHeader(job, client.extranonce1, EXTRANONCE2)),
    target: bytesToHex(diffToTarget(client.difficulty)),
  });
}

function submitShare(client: Client, jobId: string, nonce: number) {
  // A share for a job the pool already replaced comes back as "Invalid job id";
  // dropping it here keeps that noise off the wire.
  if (!client.pool || !client.jobs.has(jobId)) return;
  if (++client.badSubmits > MAX_BAD_SUBMITS) {
    send(client, { t: "error", message: "too many invalid shares" });
    stopMining(client);
    return;
  }
  const job = client.jobs.get(jobId)!;
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, nonce >>> 0, true); // cpuminer submits the nonce little-endian
  client.pool.submit(jobId, EXTRANONCE2, job.ntime, bytesToHex(bytes));
}

function creditShare(client: Client) {
  if (!client.listingId) return;
  client.shares++;
  client.diffSum += client.difficulty;
  const acc = pending.get(client.listingId) ?? { shares: 0, diffSum: 0 };
  acc.shares++;
  acc.diffSum += client.difficulty;
  pending.set(client.listingId, acc);
}

function boardSnapshot() {
  const entries = getBoard();
  const miners = new Map<string, number>();
  for (const c of clients) {
    if (c.listingId) miners.set(c.listingId, (miners.get(c.listingId) ?? 0) + c.hashrate);
  }
  // Add the not-yet-flushed counters, otherwise a share takes up to 30s to show
  // up and the board looks frozen while people are actively mining.
  return {
    entries: entries
      .map((e) => ({
        ...e,
        hashrate: Math.round(miners.get(e.id) ?? 0),
        shares: e.shares + (pending.get(e.id)?.shares ?? 0),
        score: e.score + (pending.get(e.id)?.diffSum ?? 0),
      }))
      .sort((a, b) => b.score - a.score),
    pending: getPending().map((e) => ({
      ...e,
      shares: e.shares + (pending.get(e.id)?.shares ?? 0),
      hashrate: Math.round(miners.get(e.id) ?? 0),
    })),
    threshold: VISIBILITY_THRESHOLD,
    online: clients.size,
    mining: [...clients].filter((c) => c.listingId).length,
    feed: feed.slice(-15),
  };
}

const send = (client: Client, payload: unknown) => {
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
        logEvent("gate_passed", listingId, { name: row.name });
        pushFeed(`${row.name} mined its way onto the board`);
      }
    }
  })();
}

let lastBoard = "";
export function startLoops() {
  setInterval(flush, FLUSH_MS);
  setInterval(() => {
    if (clients.size === 0) return;
    const snapshot = { t: "board", ...boardSnapshot() };
    const json = JSON.stringify(snapshot);
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
