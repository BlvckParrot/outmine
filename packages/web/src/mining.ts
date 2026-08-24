// Owns the worker pool. The server hands out jobs; workers hand back nonces.
import type { MinerAlgo } from "@outmine/protocol";

type Job = { jobId: string; header: string; target: string; algo: MinerAlgo };

export class Miner {
  #workers: Worker[] = [];
  #rates = new Map<number, number>();
  #job: Job | null = null;
  #throttle = 0;

  constructor(
    private onShare: (jobId: string, nonce: number) => void,
    private onRate: (hashrate: number) => void,
  ) {}

  get running() {
    return this.#workers.length > 0;
  }

  start(threads: number) {
    this.stop();
    for (let i = 0; i < threads; i++) {
      const worker = new Worker(new URL("./miner.worker.ts", import.meta.url), { type: "module" });
      const index = i;
      worker.onmessage = (e) => {
        if (e.data.t === "share") this.onShare(e.data.jobId, e.data.nonce);
        if (e.data.t === "hashrate") {
          this.#rates.set(index, e.data.hs);
          this.onRate([...this.#rates.values()].reduce((a, b) => a + b, 0));
        }
      };
      worker.postMessage({ t: "throttle", value: this.#throttle });
      this.#workers.push(worker);
    }
    // Straight to the workers rather than through setJob, which drops a job the last
    // set of workers was already on - and these are new ones, hashing nothing. Without
    // it, moving the threads slider parked the miner at zero until the pool happened
    // to send fresh work, which can be a minute.
    if (this.#job) this.#dispatch(this.#job);
  }

  setJob(job: Job) {
    // Workers restart their nonce range on every job, which is right for new work and
    // pure waste for a repeat: they would re-hash the same nonces and submit shares the
    // pool rejects as duplicates. Compare the header, not the id - a reconnect brings a
    // fresh extranonce1, so the same job id can carry a genuinely different header.
    if (this.#job?.header === job.header) return;
    this.#job = job;
    this.#dispatch(job);
  }

  #dispatch(job: Job) {
    this.#workers.forEach((w, i) =>
      w.postMessage({ t: "job", job, threadIndex: i, threadCount: this.#workers.length }),
    );
  }

  setThrottle(value: number) {
    this.#throttle = value;
    this.#workers.forEach((w) => w.postMessage({ t: "throttle", value }));
  }

  stop() {
    this.#workers.forEach((w) => {
      w.postMessage({ t: "stop" });
      w.terminate();
    });
    this.#workers = [];
    this.#rates.clear();
    this.onRate(0);
  }
}
