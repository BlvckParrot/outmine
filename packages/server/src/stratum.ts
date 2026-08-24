// Stratum client for zpool. One instance owns one TCP connection, which may be shared
// by several miners - see hub.ts for how extranonce2 is split between them.
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
  /** Fires on every (re)connect. extranonce1 changes each time, so any header built
   *  from the old one is stale and must be rebuilt. */
  onSubscribed?: (extranonce1: string, extranonce2Size: number) => void;
  onDifficulty?: (difficulty: number) => void;
  onJob?: (job: Job) => void;
  /** `id` is the request id returned by submit(). With a shared connection it is the
   *  only thing identifying whose share this was. */
  onSubmitResult?: (accepted: boolean, error: unknown, id: number) => void;
  onError?: (err: unknown) => void;
  onDisconnected?: () => void;
};

const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 60_000;

export class StratumClient {
  #socket: Socket<unknown> | null = null;
  #buffer = "";
  #nextId = 1;
  #pending = new Map<number, string>();
  #closed = false;
  #reconnectDelay = RECONNECT_BASE_MS;
  #reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private host: string,
    private port: number,
    private user: string,
    private password: string,
    private events: StratumEvents = {},
  ) {}

  get connected() {
    return this.#socket !== null;
  }

  async connect(): Promise<void> {
    if (this.#closed) return;
    try {
      this.#socket = await Bun.connect({
        hostname: this.host,
        port: this.port,
        socket: {
          data: (_s, chunk) => this.feed(chunk),
          error: (_s, err) => this.events.onError?.(err),
          close: () => this.#onClose(),
        },
      });
    } catch (err) {
      this.events.onError?.(err);
      this.#scheduleReconnect();
      return;
    }
    this.#buffer = "";
    this.#pending.clear();
    this.#reconnectDelay = RECONNECT_BASE_MS;
    this.subscribe();
    this.authorize();
  }

  subscribe(): number {
    return this.#send("mining.subscribe", ["outmine/0.1"]);
  }

  authorize(): number {
    return this.#send("mining.authorize", [this.user, this.password]);
  }

  /** Returns the request id, which onSubmitResult echoes back. */
  submit(jobId: string, extranonce2: string, ntime: string, nonce: string): number {
    return this.#send("mining.submit", [this.user, jobId, extranonce2, ntime, nonce]);
  }

  /** Stops for good. Reconnection is not attempted after this. */
  close() {
    this.#closed = true;
    if (this.#reconnectTimer) clearTimeout(this.#reconnectTimer);
    this.#socket?.end();
    this.#socket = null;
  }

  /** Entry point for bytes off the wire. Public so the framing can be tested without
   *  a socket, which is where this code actually goes wrong. */
  feed(chunk: string | Uint8Array) {
    this.#buffer += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
    const lines = this.#buffer.split("\n");
    this.#buffer = lines.pop() ?? ""; // last piece may be a partial message
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        this.handleMessage(JSON.parse(line));
      } catch (err) {
        this.events.onError?.(err);
      }
    }
  }

  handleMessage(msg: any) {
    if (msg.method === "mining.notify") {
      const [jobId, prevHash, coinb1, coinb2, merkleBranch, version, nbits, ntime, cleanJobs] = msg.params;
      this.events.onJob?.({ jobId, prevHash, coinb1, coinb2, merkleBranch, version, nbits, ntime, cleanJobs });
      return;
    }
    if (msg.method === "mining.set_difficulty") {
      this.events.onDifficulty?.(msg.params[0]);
      return;
    }
    if (msg.id == null) return;

    const method = this.#pending.get(msg.id);
    this.#pending.delete(msg.id);

    if (method === "mining.subscribe" && Array.isArray(msg.result)) {
      this.events.onSubscribed?.(msg.result[1], msg.result[2]);
      return;
    }
    if (method === "mining.submit") {
      this.events.onSubmitResult?.(msg.result === true, msg.error, msg.id);
      return;
    }
    if (msg.error) this.events.onError?.(msg.error);
  }

  #send(method: string, params: unknown[]): number {
    const id = this.#nextId++;
    this.#pending.set(id, method);
    this.#socket?.write(JSON.stringify({ id, method, params }) + "\n");
    return id;
  }

  #onClose() {
    this.#socket = null;
    this.events.onDisconnected?.();
    this.#scheduleReconnect();
  }

  #scheduleReconnect() {
    if (this.#closed || this.#reconnectTimer) return;
    const delay = this.#reconnectDelay;
    this.#reconnectDelay = Math.min(delay * 2, RECONNECT_MAX_MS);
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null;
      void this.connect();
    }, delay);
  }
}
