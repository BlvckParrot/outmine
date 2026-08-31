// One worker = one mining thread. Each gets its own WASM instance and its own
// slice of the nonce space, so threads never duplicate work on the same job.
import type { MinerAlgo } from "@outmine/protocol";
import type { OutmineModule } from "@outmine/wasm";

type Job = { jobId: string; header: string; target: string; algo: MinerAlgo };

// Nonces per call. Long enough that the call overhead is nothing next to the hashing,
// short enough that a new job, a throttle change or stop is acted on promptly: at
// MinotaurX's ~900 H/s the old 2000 meant the worker was deaf for over two seconds,
// and every share found for a job that had already moved on was thrown away.
const CHUNK = 200;
const unhex = (s: string) => Uint8Array.from(s.match(/../g)!.map((b) => parseInt(b, 16)));

let job: Job | null = null;
let nonce = 0;
let throttle = 0; // 0 = flat out, 0.8 = idle 80% of the time
let running = false;

type Buffers = { header: number; target: number; out: number };
/** A module and the scratch buffers allocated inside its own heap. They belong
 *  together: a pointer from one instance means nothing in another. */
type Loaded = { module: OutmineModule; buffers: Buffers };

// Loaded at runtime rather than bundled: emscripten's glue resolves its .wasm
// relative to itself, so the path must reach the browser untouched. Going through a
// variable also stops TypeScript trying to resolve it.
//
// Absolute, not root-relative: given "/mine-x.mjs" Vite's dev server treats the import
// as one of its own modules and serves it as /mine-x.mjs?import, which the glue does
// not survive. A full URL is left alone, in dev and in the build alike.
//
// Which module, and therefore which proof-of-work, comes from the job - so a worker
// cannot start hashing before the server has said what it wants, and 380 kB of
// MinotaurX is never downloaded by a site mining RinHash.
// Keyed by algo, and that is the whole point of the map. `ready ??= ...` computed the
// URL from the algo and then threw it away whenever anything had been loaded before, so
// the first algo a worker ever saw was the only one it could ever hash - which is
// exactly what putting `algo` on the wire was meant to prevent. Hashing the wrong
// function is silent: a dial at full tilt, zero accepted, and the server cutting the
// miner off after ten bad submits.
const loaded = new Map<MinerAlgo, Promise<Loaded>>();

function load(algo: MinerAlgo): Promise<Loaded> {
  let pending = loaded.get(algo);
  if (!pending) {
    const url = new URL(`/mine-${algo}.mjs`, self.location.origin).href;
    pending = (import(/* @vite-ignore */ url) as Promise<{
      default: () => Promise<OutmineModule>;
    }>)
      .then((mod) => mod.default())
      .then((module) => ({
        module,
        buffers: { header: module._malloc(80), target: module._malloc(32), out: module._malloc(32) },
      }));
    loaded.set(algo, pending);
  }
  return pending;
}

self.onmessage = async (e: MessageEvent) => {
  const msg = e.data;
  if (msg.t === "job") {
    job = msg.job;
    // Thread i starts a fixed distance into the nonce space; no overlap between threads.
    nonce = (msg.threadIndex * Math.floor(0xffffffff / msg.threadCount)) >>> 0;
    if (!running) void loop();
  }
  if (msg.t === "throttle") throttle = Math.min(0.95, Math.max(0, msg.value));
  if (msg.t === "stop") {
    running = false;
    job = null;
  }
};

async function loop() {
  // Set before the first await, not after it: a second job arriving while the module
  // was still loading found `running` false and started a second loop on the same
  // worker, both hashing the same nonce range.
  running = true;

  // Hashrate is measured over wall-clock time and counts only nonces actually
  // tried. Timing just the mine() call would report the burst rate: an early
  // return on a found share looks like a million H/s, and throttled idle time
  // would vanish from the average.
  let hashes = 0;
  let windowStart = performance.now();

  try {
    // Outer loop so a job that names a different algo re-resolves the module instead of
    // hashing on the one that happens to be loaded.
    while (running && job) {
      const algo = job.algo;
      const { module, buffers: ptr } = await load(algo);

      while (running && job && job.algo === algo) {
        const current = job;
        module.HEAPU8.set(unhex(current.header), ptr.header);
        module.HEAPU8.set(unhex(current.target), ptr.target);

        const started = performance.now();
        const end = (nonce + CHUNK) >>> 0;
        const found = module._mine(ptr.header, ptr.target, nonce, end, ptr.out);
        const elapsed = performance.now() - started;

        if (found >= 0) {
          hashes += (found - nonce + 1) >>> 0;
          self.postMessage({ t: "share", jobId: current.jobId, nonce: found });
          nonce = (found + 1) >>> 0;
        } else {
          hashes += CHUNK;
          nonce = end;
        }

        const window = performance.now() - windowStart;
        if (window >= 2000) {
          self.postMessage({ t: "hashrate", hs: (hashes / window) * 1000 });
          hashes = 0;
          windowStart = performance.now();
        }

        // Yielding also lets a new job land between chunks.
        if (throttle > 0) await new Promise((r) => setTimeout(r, elapsed * (throttle / (1 - throttle))));
        else await new Promise((r) => setTimeout(r, 0));
      }
    }
  } finally {
    // Including the module failing to load: leaving `running` true would mean no later
    // job could ever start the loop again.
    running = false;
  }
}
