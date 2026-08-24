// One worker = one mining thread. Each gets its own WASM instance and its own
// slice of the nonce space, so threads never duplicate work on the same job.
import type { OutmineModule } from "@outmine/wasm";

type Job = { jobId: string; header: string; target: string };

const CHUNK = 2_000; // nonces per call: long enough to amortise the call, short enough to stay responsive
const unhex = (s: string) => Uint8Array.from(s.match(/../g)!.map((b) => parseInt(b, 16)));

let Module: OutmineModule;
let job: Job | null = null;
let nonce = 0;
let throttle = 0; // 0 = flat out, 0.8 = idle 80% of the time
let running = false;

// Loaded at runtime rather than bundled: emscripten's glue resolves mine.wasm
// relative to itself, so the path must reach the browser untouched. Going through a
// variable also stops TypeScript trying to resolve it.
//
// Absolute, not root-relative: given "/mine.mjs" Vite's dev server treats the import
// as one of its own modules and serves it as /mine.mjs?import, which the glue does
// not survive. A full URL is left alone, in dev and in the build alike.
const WASM_URL = new URL("/mine.mjs", self.location.origin).href;

const ready = (import(/* @vite-ignore */ WASM_URL) as Promise<{
  default: () => Promise<OutmineModule>;
}>)
  .then((mod) => mod.default())
  .then((m) => {
  Module = m;
  return {
    header: m._malloc(80),
    target: m._malloc(32),
    out: m._malloc(32),
  };
  });

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
  const ptr = await ready;
  running = true;

  // Hashrate is measured over wall-clock time and counts only nonces actually
  // tried. Timing just the mine() call would report the burst rate: an early
  // return on a found share looks like a million H/s, and throttled idle time
  // would vanish from the average.
  let hashes = 0;
  let windowStart = performance.now();

  while (running && job) {
    const current = job;
    Module.HEAPU8.set(unhex(current.header), ptr.header);
    Module.HEAPU8.set(unhex(current.target), ptr.target);

    const started = performance.now();
    const end = (nonce + CHUNK) >>> 0;
    const found = Module._mine(ptr.header, ptr.target, nonce, end, ptr.out);
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
  running = false;
}
