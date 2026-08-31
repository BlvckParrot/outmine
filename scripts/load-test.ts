// How many visitors one process actually holds, measured rather than assumed.
//
// Every client here is a real WebSocket doing what a browser does: it opens, is handed a
// board, says `mine`, reports a hashrate every few seconds and submits a share now and
// then. Point the server at scripts/stratum-stub.ts first - five thousand of these
// against a real pool is a flood from one address.
//
// Each socket also carries a distinct X-Forwarded-For. With TRUSTED_PROXIES=1 that is
// what proves the per-address ceiling counts visitors and not the proxy: without the
// fix in server.ts every socket past the limit is refused with 1013.
//
// Usage:
//   bun scripts/stratum-stub.ts &
//   POOL_HOST=127.0.0.1 POOL_PORT=3399 TRUSTED_PROXIES=1 MAX_CLIENTS=6000 \
//     PORT=3400 DB_PATH=/tmp/load.sqlite bun packages/server/src/server.ts &
//   CLIENTS=5000 BASE=http://localhost:3400 bun scripts/load-test.ts
export {}; // so top-level await is allowed in a file that imports nothing

/** Bun's WebSocket takes request headers; lib.dom says the second argument is a list of
 *  subprotocols. The runtime is right and the type is not, so it is cast once, here. */
type SocketOptions = ConstructorParameters<typeof WebSocket>[1];
const withHeaders = (headers: Record<string, string>) => ({ headers }) as unknown as SocketOptions;

const BASE = process.env.BASE ?? "http://localhost:3400";
const ORIGIN = process.env.ORIGIN ?? BASE;
const CLIENTS = Number(process.env.CLIENTS ?? 1000);
/** Sockets opened per batch, and the gap between batches. A whole crowd in one tick is
 *  a different test - see RAMP_MS=0 - and is worth running too. */
const BATCH = Number(process.env.BATCH ?? 100);
const RAMP_MS = Number(process.env.RAMP_MS ?? 100);
const RUN_MS = Number(process.env.RUN_MS ?? 60_000);
const HASHRATE_MS = 3_000;
const SHARE_MS = Number(process.env.SHARE_MS ?? 20_000);
/** Server pid, so its memory can be read. Optional: everything else works without it. */
const SERVER_PID = process.env.SERVER_PID;

type Miner = {
  ws: WebSocket;
  jobId: string | null;
  boards: number[];
  lastBoardAt: number;
};

const miners: Miner[] = [];
let refused = 0;
let failed = 0;
let submitted = 0;
let accepted = 0;
let rejected = 0;
/** Times a client was told mining is full. Not a failure on its own - it is the
 *  controller doing its job - but a run that ends with clients still waiting is. */
let turnedAway = 0;

const listingId = await pickListing();
console.log(`mining for ${listingId}, ${CLIENTS} clients, ${RUN_MS / 1000}s\n`);

for (let opened = 0; opened < CLIENTS; opened += BATCH) {
  for (let i = 0; i < Math.min(BATCH, CLIENTS - opened); i++) open(opened + i);
  if (RAMP_MS > 0) await Bun.sleep(RAMP_MS);
}

const started = Date.now();
const timer = setInterval(report, 10_000);
await Bun.sleep(RUN_MS);
clearInterval(timer);
await report();

for (const m of miners) m.ws.close();
process.exit(failed + refused > 0 ? 1 : 0);

function open(index: number) {
  // One address per client. A real crowd is not one address, and the ceiling that
  // matters is per address.
  const address = `10.${(index >> 16) & 255}.${(index >> 8) & 255}.${index & 255}`;
  const ws = new WebSocket(
    `${BASE.replace(/^http/, "ws")}/ws`,
    withHeaders({ origin: ORIGIN, "x-forwarded-for": address }),
  );
  const miner: Miner = { ws, jobId: null, boards: [], lastBoardAt: 0 };

  ws.onopen = () => {
    ws.send(JSON.stringify({ t: "view", path: "/", first: true }));
    ws.send(JSON.stringify({ t: "mine", listingId }));
    setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ t: "hashrate", hs: 12_000 + (index % 1000) }));
      }
    }, HASHRATE_MS).unref?.();
    setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN || !miner.jobId) return;
      // The nonce is nonsense and the stub accepts it anyway. What is under test is the
      // path a share takes through the hub, not the proof of work.
      submitted++;
      ws.send(JSON.stringify({ t: "share", jobId: miner.jobId, nonce: (index * 7919) >>> 0 }));
    }, SHARE_MS + (index % 1000)).unref?.();
  };

  ws.onmessage = (e) => {
    const msg = JSON.parse(String(e.data));
    if (msg.t === "board") {
      const now = Date.now();
      if (miner.lastBoardAt) miner.boards.push(now - miner.lastBoardAt);
      miner.lastBoardAt = now;
    }
    if (msg.t === "job") miner.jobId = msg.jobId;
    if (msg.t === "shareResult") (msg.ok ? accepted++ : rejected++);
    // Same as the browser does: a slot refused now is one the controller may open in a
    // window or two, so ask again rather than sit there holding a socket and nothing.
    if (msg.t === "error" && msg.retry) {
      turnedAway++;
      setTimeout(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: "mine", listingId }));
      }, 5_000 + Math.random() * 10_000).unref?.();
    }
  };

  ws.onclose = (e) => {
    // 1013 is the server saying it is full; anything else while the test is running is
    // a socket that died on its own, which is the more interesting failure.
    if (e.code === 1013) refused++;
    else if (Date.now() - started < RUN_MS) failed++;
  };
  ws.onerror = () => failed++;

  miners.push(miner);
}

async function report() {
  const health = await fetch(`${BASE}/health`).then((r) => r.json()).catch(() => null);
  const intervals = miners.flatMap((m) => m.boards).sort((a, b) => a - b);
  const at = (q: number) => intervals[Math.floor(intervals.length * q)] ?? 0;
  const open = miners.filter((m) => m.ws.readyState === WebSocket.OPEN).length;

  console.log(
    [
      `t+${Math.round((Date.now() - started) / 1000)}s`,
      `open ${open}/${CLIENTS}`,
      `refused ${refused}`,
      `failed ${failed}`,
      `server sees ${health?.clients ?? "?"}`,
      `mining ${health?.mining ?? "?"}`,
      `turned away ${turnedAway}`,
      `pool sockets ${health?.poolConnections ?? "?"}`,
      `shares ${accepted}/${submitted} (${rejected} rejected)`,
      // The broadcast is the loop everything else shares. When it slips, the event loop
      // is the thing that is full - not the socket table.
      // A gap between boards is not always lag: an unchanged board is not broadcast at
      // all. lagMs comes from the server's own loop and is the honest one.
      `board p50 ${at(0.5)}ms`,
      `lag ${health?.lagMs ?? "?"}ms`,
      SERVER_PID ? `rss ${rss()}MB` : "",
    ].filter(Boolean).join("  "),
  );
}

function rss(): string {
  const out = Bun.spawnSync(["ps", "-o", "rss=", "-p", String(SERVER_PID)]).stdout.toString().trim();
  return (Number(out) / 1024).toFixed(0);
}

/** A listing to mine for: whatever is on the board, or a fresh one. */
async function pickListing(): Promise<string> {
  const board = await fetch(`${BASE}/api/board`).then((r) => r.json());
  const existing = board.entries?.[0]?.id ?? board.pending?.[0]?.id;
  if (existing) return existing;

  const created = await fetch(`${BASE}/api/listings`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN },
    body: JSON.stringify({
      kind: "domain",
      target: `load-test-${Date.now()}.example.com`,
      name: "load test",
      tagline: "opened by scripts/load-test.ts",
    }),
  }).then((r) => r.json());
  if (!created.listing) throw new Error(`could not create a listing: ${JSON.stringify(created)}`);
  return created.listing.id;
}
