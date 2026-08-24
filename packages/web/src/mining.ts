// Owns the worker pool. The server hands out jobs; workers hand back nonces.

export class Miner {
  #workers: Worker[] = [];
  #rates = new Map<number, number>();
  #job: { jobId: string; header: string; target: string } | null = null;
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
    if (this.#job) this.setJob(this.#job);
  }

  setJob(job: { jobId: string; header: string; target: string }) {
    // Workers restart their nonce range on every job, which is right for new work and
    // pure waste for a repeat: they would re-hash the same nonces and submit shares the
    // pool rejects as duplicates. Compare the header, not the id - a reconnect brings a
    // fresh extranonce1, so the same job id can carry a genuinely different header.
    if (this.#job?.header === job.header) return;
    this.#job = job;
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
