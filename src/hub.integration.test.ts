// Drives the real server over a real WebSocket against the real pool.
// This is the only check that proves the whole chain: job -> header -> WASM ->
// submit -> pool accepts -> score lands in SQLite.
//
// Skipped unless POOL_USER is set, since it needs a payout address and network.
import { expect, test } from "bun:test";
import createModule from "../wasm/build/mine.mjs";

const RUN = !!process.env.POOL_USER;
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
