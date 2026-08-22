// Minimal stratum client for zpool. One TCP connection per miner.
// ponytail: one pool socket per miner; multiplex via extranonce2 splitting only
// if zpool starts rate limiting or concurrency climbs past a few hundred.
import type { Socket } from "bun";

export type Job = {
  jobId: string;
  prevHash: string;
  coinb1: string;
  coinb2: string;
  merkleBranch: string[];
  version: string;
  nbits: string;
  ntime: string;
  cleanJobs: boolean;
};

export type StratumEvents = {
  onJob?: (job: Job) => void;
  onDifficulty?: (difficulty: number) => void;
  onSubscribed?: (extranonce1: string, extranonce2Size: number) => void;
  onSubmitResult?: (accepted: boolean, error: unknown) => void;
  onError?: (err: unknown) => void;
  onClose?: () => void;
};

type Pending = { method: string };

export class StratumClient {
  #socket: Socket<unknown> | null = null;
  #buffer = "";
  #nextId = 1;
  #pending = new Map<number, Pending>();
  #events: StratumEvents;

  constructor(
    private host: string,
    private port: number,
    private user: string,
    private password: string,
    events: StratumEvents = {},
  ) {
    this.#events = events;
  }

  async connect(): Promise<void> {
    this.#socket = await Bun.connect({
      hostname: this.host,
      port: this.port,
      socket: {
        data: (_s, chunk) => this.#onData(chunk),
        error: (_s, err) => this.#events.onError?.(err),
        close: () => this.#events.onClose?.(),
      },
    });
    this.#send("mining.subscribe", ["outmine/0.1"]);
    this.#send("mining.authorize", [this.user, this.password]);
  }

  submit(jobId: string, extranonce2: string, ntime: string, nonce: string) {
    this.#send("mining.submit", [this.user, jobId, extranonce2, ntime, nonce]);
  }

  close() {
    this.#socket?.end();
    this.#socket = null;
  }

  #send(method: string, params: unknown[]) {
    const id = this.#nextId++;
    this.#pending.set(id, { method });
    this.#socket?.write(JSON.stringify({ id, method, params }) + "\n");
  }

  #onData(chunk: Buffer) {
    // Stratum is newline-delimited JSON; a chunk can hold a partial line.
    this.#buffer += chunk.toString();
    const lines = this.#buffer.split("\n");
    this.#buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        this.handleMessage(JSON.parse(line));
      } catch (err) {
        this.#events.onError?.(err);
      }
    }
  }

  // Exposed for tests: feed it a parsed stratum message.
  handleMessage(msg: any) {
    if (msg.method === "mining.notify") {
      const [jobId, prevHash, coinb1, coinb2, merkleBranch, version, nbits, ntime, cleanJobs] = msg.params;
      this.#events.onJob?.({ jobId, prevHash, coinb1, coinb2, merkleBranch, version, nbits, ntime, cleanJobs });
      return;
    }
    if (msg.method === "mining.set_difficulty") {
      this.#events.onDifficulty?.(msg.params[0]);
      return;
    }
    if (msg.id == null) return;

    const pending = this.#pending.get(msg.id);
    this.#pending.delete(msg.id);
    if (pending?.method === "mining.subscribe" && Array.isArray(msg.result)) {
      this.#events.onSubscribed?.(msg.result[1], msg.result[2]);
      return;
    }
    if (pending?.method === "mining.submit") {
      this.#events.onSubmitResult?.(msg.result === true, msg.error);
      return;
    }
    if (msg.error) this.#events.onError?.(msg.error);
  }
}
