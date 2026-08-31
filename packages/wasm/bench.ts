// How fast each algorithm runs here, and what zpool pays for it.
//
// These two questions only mean something together. A rate per MH/s ranks nothing on
// its own - RinHash pays 36x what MinotaurX does per unit *and* runs 15x faster in a
// browser, and either number alone would have understated the gap by an order of
// magnitude. Run: bun run bench
import { ALGOS, createModule, type Algo } from "./module";

const BTC_USD = Number(process.env.BTC_USD ?? 0);

/** Best of five, single thread. Best rather than mean: the slow runs are this machine
 *  doing something else, and we are measuring the code, not the afternoon. */
async function measure(algo: Algo): Promise<number> {
  const Module = await createModule(algo);
  const header = Module._malloc(80);
  const target = Module._malloc(32);
  const out = Module._malloc(32);
  Module.HEAPU8.set(new Uint8Array(80).fill(0xab), header);
  Module.HEAPU8.set(new Uint8Array(32), target); // all-zero target: never hits, full range runs

  // Enough nonces that a run takes a few hundred milliseconds whatever the algorithm.
  Module._mine(header, target, 0, 50, out); // warm up
  const probe = performance.now();
  Module._mine(header, target, 0, 200, out);
  const nonces = Math.max(200, Math.round(200 / ((performance.now() - probe) / 1000) / 4));

  const rates: number[] = [];
  for (let run = 0; run < 5; run++) {
    const started = performance.now();
    Module._mine(header, target, 0, nonces, out);
    rates.push(nonces / ((performance.now() - started) / 1000));
  }
  return Math.max(...rates);
}

type PoolAlgo = { name: string; estimate: number; hashrate: number; workers: number; port: number };

const status = (await fetch("https://zpool.ca/api/status").then((r) => r.json())) as Record<string, any>;
const pool = new Map<string, PoolAlgo>(
  Object.values(status).map((a) => [
    a.name,
    {
      name: a.name,
      estimate: Number(a.estimate_last24h) || 0,
      hashrate: Number(a.hashrate) || 0,
      workers: Number(a.workers) || 0,
      port: Number(a.port) || 0,
    },
  ]),
);

const cores = navigator.hardwareConcurrency ?? 8;
const threads = Math.max(1, cores - 1);

console.log(`one thread, this machine (${threads} of ${cores} threads would be used):\n`);
const measured: [Algo, number][] = [];
for (const algo of ALGOS) measured.push([algo, await measure(algo)]);

for (const [algo, hs] of measured) {
  const rate = pool.get(algo);
  const btcPerDay = rate ? (hs / 1e6) * rate.estimate : 0;
  const money = BTC_USD
    ? `   $${(btcPerDay * BTC_USD * 1000 * 30).toFixed(2)}/month for 1000 tabs`
    : "";
  console.log(
    `${algo.padEnd(10)} ${hs.toFixed(0).padStart(6)} H/s   ` +
      `${btcPerDay.toExponential(2)} BTC/day/thread${money}`,
  );
}

// The unit behind estimate_last24h is not the same across the board: taken at face
// value it says a browser should mine sha256. Pools whose total hashrate is in the
// same class as ours are the only ones it can be compared against, so anything with
// more than a gigahash of miners on it is filtered out rather than ranked wrongly.
const CPU_CLASS_CEILING = 1e9;

console.log(`\nzpool algorithms in the same class (< ${CPU_CLASS_CEILING.toExponential(0)} H/s of miners):`);
const candidates = [...pool.values()]
  .filter((a) => a.estimate > 0 && a.hashrate > 0 && a.hashrate < CPU_CLASS_CEILING)
  .sort((a, b) => b.estimate - a.estimate)
  .slice(0, 8);

for (const a of candidates) {
  const mine = measured.find(([algo]) => algo === a.name);
  const note = mine ? `  <- we run this at ${mine[1].toFixed(0)} H/s` : "";
  console.log(
    `  ${a.name.padEnd(16)} ${a.estimate.toFixed(8)} /MH/day   ` +
      `pool ${(a.hashrate / 1e6).toFixed(1)} MH/s over ${String(a.workers).padStart(5)} workers   ` +
      `port ${a.port}${note}`,
  );
}
console.log(
  "\nA candidate is only worth porting if (its rate x the H/s we would get) beats what\n" +
    "we run today, and the only proof of that is scripts/measure-yield.ts against the\n" +
    "real pool - these estimates are what the pool hopes to pay, not what it paid us.",
);
