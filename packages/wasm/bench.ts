// Measures single-thread WASM hashrate and converts it to what zpool pays.
// Run: bun wasm/bench.ts
import { createModule } from "./module";

const NONCES = 3000;
const Module = await createModule();

const inPtr = Module._malloc(80);
const tPtr = Module._malloc(32);
const outPtr = Module._malloc(32);
Module.HEAPU8.set(new Uint8Array(80).fill(0xab), inPtr);
Module.HEAPU8.set(new Uint8Array(32), tPtr); // all-zero target: never hits, full range runs

Module._mine(inPtr, tPtr, 0, 200, outPtr); // warm up
const t0 = performance.now();
Module._mine(inPtr, tPtr, 0, NONCES, outPtr);
const seconds = (performance.now() - t0) / 1000;

const hs = NONCES / seconds;
const cores = navigator.hardwareConcurrency ?? 8;
const threads = Math.max(1, cores - 1);

// estimate_last24h from https://zpool.ca/api/status, BTC per MH/s per day
const BTC_PER_MHS_DAY = 0.00012169;
const BTC_USD = 76_700;
const usdPerDay = (hs / 1e6) * BTC_PER_MHS_DAY * BTC_USD;

console.log(`minotaurx, 1 thread: ${hs.toFixed(1)} H/s`);
console.log(`this machine (${threads} of ${cores} threads): ~${(hs * threads).toFixed(0)} H/s`);
console.log(`revenue per 1-thread session: $${(usdPerDay / 24).toFixed(6)}/hour`);
console.log(`1000 such tabs open: $${(usdPerDay * 1000 * 30).toFixed(2)}/month`);

// yescrypt(2048,8) does essentially the work of one yespower round, so timing a
// bare round tells us what yescrypt would cost without adding a second upstream.
const ROUNDS = 2000;
const inPtr64 = Module._malloc(64);
Module.HEAPU8.set(new Uint8Array(64).fill(0x5a), inPtr64);
Module._bench_yespower(inPtr64, 50, outPtr); // warm up
const y0 = performance.now();
Module._bench_yespower(inPtr64, ROUNDS, outPtr);
const yHs = ROUNDS / ((performance.now() - y0) / 1000);

const YESCRYPT_BTC_PER_MHS_DAY = 0.00008714;
const ratio = (yHs * YESCRYPT_BTC_PER_MHS_DAY) / (hs * BTC_PER_MHS_DAY);
console.log(`\nyespower/yescrypt round, 1 thread: ${yHs.toFixed(1)} H/s (${(yHs / hs).toFixed(2)}x minotaurx)`);
console.log(`yescrypt revenue vs minotaurx: ${ratio.toFixed(2)}x  ->  ${ratio > 1 ? "SWITCH to yescrypt" : "stay on minotaurx"}`);
