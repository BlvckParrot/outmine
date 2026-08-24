// Drives the real server over a real WebSocket against the real pool.
// This is the only check that proves the whole chain: job -> header -> WASM ->
// submit -> pool accepts -> score lands in SQLite.
//
// Skipped unless POOL_USER is set, since it needs a payout address and network.
import { expect, test } from "bun:test";
import { createModule } from "@outmine/wasm";

// Explicit opt-in, not merely "POOL_USER is set": Bun auto-loads .env, so keying off
// the payout address alone makes `bun run check` demand a live server and a live pool.
const RUN = process.env.INTEGRATION === "1" && !!process.env.POOL_USER;
const BASE = process.env.TEST_BASE ?? "http://localhost:3000";

test.skipIf(!RUN)("a browser-equivalent client moves a listing onto the board", async () => {
  const target = `test-${Date.now()}.example.com`;
  const created = await fetch(`${BASE}/api/listings`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind: "domain", target, name: "Integration Test" }),
  }).then((r) => r.json());
  expect(created.listing?.id).toBeTruthy();

  const Module = await createModule();
  const inPtr = Module._malloc(80);
  const tPtr = Module._malloc(32);
  const outPtr = Module._malloc(32);
  const unhex = (s: string) => Uint8Array.from(s.match(/../g)!.map((b) => parseInt(b, 16)));

  const ws = new WebSocket(`${BASE.replace("http", "ws")}/ws`);
  let accepted = 0;
  let job: any = null;

  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data as string);
    if (msg.t === "job") job = msg;
    if (msg.t === "shareResult" && msg.ok) accepted++;
  };
  await new Promise((r) => (ws.onopen = r));
  ws.send(JSON.stringify({ t: "mine", listingId: created.listing.id }));

  const deadline = Date.now() + 90_000;
  let nonce = 0;
  while (accepted < 2 && Date.now() < deadline) {
    if (!job) {
      await Bun.sleep(200);
      continue;
    }
    const current = job;
    Module.HEAPU8.set(unhex(current.header), inPtr);
    Module.HEAPU8.set(unhex(current.target), tPtr);
    const found = Module._mine(inPtr, tPtr, nonce, (nonce + 5000) >>> 0, outPtr);
    if (found >= 0) {
      ws.send(JSON.stringify({ t: "share", jobId: current.jobId, nonce: found }));
      nonce = (found + 1) >>> 0;
      await Bun.sleep(400);
    } else {
      nonce = (nonce + 5000) >>> 0;
    }
    await Bun.sleep(0);
  }
  ws.close();

  expect(accepted).toBeGreaterThan(0);
}, 120_000);

test.skipIf(!RUN)("a forged nonce is rejected by the pool and scores nothing", async () => {
  const target = `cheat-${Date.now()}.example.com`;
  const created = await fetch(`${BASE}/api/listings`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind: "domain", target, name: "Cheater" }),
  }).then((r) => r.json());

  const ws = new WebSocket(`${BASE.replace("http", "ws")}/ws`);
  let job: any = null;
  let accepted = 0;
  let rejected = 0;
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data as string);
    if (msg.t === "job") job = msg;
    if (msg.t === "shareResult") msg.ok ? accepted++ : rejected++;
  };
  await new Promise((r) => (ws.onopen = r));
  ws.send(JSON.stringify({ t: "mine", listingId: created.listing.id }));

  while (!job) await Bun.sleep(200);

  // Nonces picked at random, never hashed. The pool is the only thing that can
  // tell the difference, which is exactly why scoring is anchored there.
  for (let i = 0; i < 5; i++) {
    ws.send(JSON.stringify({ t: "share", jobId: job.jobId, nonce: Math.floor(Math.random() * 2 ** 32) }));
    await Bun.sleep(300);
  }
  await Bun.sleep(2000);
  ws.close();

  // Guessing is not a shortcut, but it is not impossible either: at this pool
  // difficulty a random nonce is valid about 1 in 8,600 times, which is exactly the
  // number of hashes honest mining needs. So the invariant is not "forgery always
  // fails" - it is "score never exceeds what the pool accepted".
  expect(accepted + rejected).toBeGreaterThan(0);
  const listing = await fetch(`${BASE}/api/listings/${created.listing.id}`).then((r) => r.json());
  expect(listing.shares).toBe(accepted);
}, 60_000);

test.skipIf(!RUN)("two miners share one pool socket without crossing credit", async () => {
  // The whole risk of multiplexing lives here. Two miners on one socket must get
  // different extranonce2 values (or they build the same header and race to the same
  // shares), and each accepted share must land on the listing of whoever found it.
  // Crossed credit is silent: totals still look plausible.
  const make = async (name: string) =>
    (await fetch(`${BASE}/api/listings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "domain", target: `mux-${name}-${Date.now()}.example.com`, name }),
    }).then((r) => r.json())).listing.id;

  const ids = [await make("MuxA"), await make("MuxB")];

  const Module = await createModule();
  const unhex = (s: string) => Uint8Array.from(s.match(/../g)!.map((b) => parseInt(b, 16)));

  // Handlers are attached in the same tick the socket is created. Awaiting them one
  // after another instead lets the second socket open during the first await, and its
  // onopen then never fires.
  const miners = ids.map((listingId) => {
    const ws = new WebSocket(`${BASE.replace("http", "ws")}/ws`);
    const m = {
      listingId, ws,
      job: null as any,
      headers: new Set<string>(),
      accepted: 0,
      nonce: 0,
      ptr: { header: Module._malloc(80), target: Module._malloc(32), out: Module._malloc(32) },
      ready: new Promise<void>((resolve) => (ws.onopen = () => resolve())),
    };
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data as string);
      if (process.env.VERBOSE) console.log(`  <- ${listingId} ${msg.t}${msg.t === "error" ? " " + msg.message : ""}`);
      if (msg.t === "job") {
        m.job = msg;
        m.headers.add(msg.header);
      }
      if (msg.t === "shareResult" && msg.ok) m.accepted++;
    };
    return m;
  });

  await Promise.all(miners.map((m) => m.ready));
  if (process.env.VERBOSE) console.log("sockets open, ids:", ids, "states:", miners.map((m) => m.ws.readyState));
  for (const m of miners) m.ws.send(JSON.stringify({ t: "mine", listingId: m.listingId }));

  const deadline = Date.now() + 90_000;
  while (miners.some((m) => m.accepted < 2) && Date.now() < deadline) {
    // Unconditional, and before the `continue` below: a spin with no await starves
    // the event loop, so the very job messages this loop waits for never get read.
    await Bun.sleep(50);

    for (const m of miners) {
      if (!m.job) continue;
      const job = m.job;
      Module.HEAPU8.set(unhex(job.header), m.ptr.header);
      Module.HEAPU8.set(unhex(job.target), m.ptr.target);
      const found = Module._mine(m.ptr.header, m.ptr.target, m.nonce, (m.nonce + 4000) >>> 0, m.ptr.out);
      if (found >= 0) {
        m.ws.send(JSON.stringify({ t: "share", jobId: job.jobId, nonce: found }));
        m.nonce = (found + 1) >>> 0;
      } else {
        m.nonce = (m.nonce + 4000) >>> 0;
      }
    }
  }
  await Bun.sleep(2500);

  // One socket for both: that is the point of multiplexing.
  const health = await fetch(`${BASE}/health`).then((r) => r.json());
  expect(health.poolConnections).toBe(1);

  // Same job, different headers - so different extranonce2 underneath.
  const [a, b] = miners;
  const shared = [...a!.headers].filter((h) => b!.headers.has(h));
  expect(shared).toHaveLength(0);

  // Credit is counted in memory and written to SQLite by a periodic flush, so poll
  // rather than read once: a single read races the flush and the comparison is only
  // meaningful once persistence has caught up.
  for (const m of miners) {
    m.ws.close();
    expect(m.accepted).toBeGreaterThan(0);

    const until = Date.now() + 40_000;
    let listing: { shares: number } = { shares: -1 };
    while (Date.now() < until) {
      listing = await fetch(`${BASE}/api/listings/${m.listingId}`).then((r) => r.json());
      if (listing.shares >= m.accepted) break;
      await Bun.sleep(1000);
    }
    expect(listing.shares).toBe(m.accepted);
  }
}, 150_000);
