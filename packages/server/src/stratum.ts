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

/** Longest run of bytes accepted with no newline in it. A stratum line is a few hundred
 *  bytes; this is room for a large mining.notify and nothing else. */
const MAX_BUFFER_BYTES = 256 * 1024;

const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 60_000;

/** Longest silence tolerated from a socket that is nominally connected.
 *
 *  A pool that completes the TCP handshake and then says nothing keeps `connected`
 *  true, keeps poolHealthy() green on /health, and keeps every miner on it parked with
 *  no work - the one failure with no symptom at all. zpool sends a mining.notify well
 *  inside this, so silence this long means the connection is over whatever the socket
 *  thinks. */
const SILENCE_MS = 180_000;

/** Stratum extranonce2 is a couple of bytes. The value is pool-controlled and becomes a
 *  padStart width per miner per job, so it is clamped rather than trusted. */
const EXTRANONCE2_SIZE_MAX = 8;
const EXTRANONCE2_SIZE_DEFAULT = 4;

export class StratumClient {
  #socket: Socket<unknown> | null = null;
  #buffer = "";
  #nextId = 1;
  #pending = new Map<number, string>();
  #closed = false;
  #reconnectDelay = RECONNECT_BASE_MS;
  #reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  #silenceTimer: ReturnType<typeof setInterval> | null = null;
  #lastByteAt = 0;

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

  /** The current reconnect delay. Exposed so the backoff ladder can be tested without
   *  waiting for it - see stratum.test.ts. */
  get backoffMs() {
    return this.#reconnectDelay;
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
    // The backoff is NOT reset here. A pool that accepts the connection and then drops
    // it - which is the shape of an IP ban and of a rejected login - would reset the
    // ladder on every cycle, so 1s never became 60s and the reconnects themselves
    // became the flood. It is reset when the pool authorizes us; see handleMessage.
    this.#lastByteAt = Date.now();
    this.#startWatchdog();
    this.subscribe();
    this.authorize();
  }

  /** Notices a connection that has stopped being one without closing. Checked rather
   *  than scheduled per byte: one interval per socket, and it unrefs so it cannot hold
   *  the process open at exit. */
  #startWatchdog() {
    if (this.#silenceTimer) return;
    this.#silenceTimer = setInterval(() => {
      if (!this.#socket || Date.now() - this.#lastByteAt < SILENCE_MS) return;
      this.events.onError?.(new Error(`pool silent for ${Math.round(SILENCE_MS / 1000)}s`));
      this.#socket.end(); // close() -> #onClose -> reconnect with the usual backoff
    }, Math.floor(SILENCE_MS / 3));
    this.#silenceTimer.unref?.();
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
    if (this.#silenceTimer) clearInterval(this.#silenceTimer);
    this.#silenceTimer = null;
    this.#socket?.end();
    this.#socket = null;
  }

  /** Entry point for bytes off the wire. Public so the framing can be tested without
   *  a socket, which is where this code actually goes wrong. */
  feed(chunk: string | Uint8Array) {
    this.#lastByteAt = Date.now();
    this.#buffer += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
    // A line this long is not a stratum message. Kept bounded rather than parsed: the
    // pool is trusted to be the pool, not trusted to stay well-behaved forever.
    if (this.#buffer.length > MAX_BUFFER_BYTES) {
      this.#buffer = "";
      this.events.onError?.(new Error("pool sent an oversized line"));
      return;
    }
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
      const difficulty = Number(msg.params?.[0]);
      // The pool chooses this and it is multiplied into every score. A null, a string
      // or a zero would reach `score REAL` as NaN, and score + NaN is NaN for good -
      // which takes ORDER BY score DESC, the totals and the rank on the card with it.
      if (!Number.isFinite(difficulty) || difficulty <= 0) {
        this.events.onError?.(new Error(`unusable difficulty ${JSON.stringify(msg.params?.[0])}`));
        return;
      }
      this.events.onDifficulty?.(difficulty);
      return;
    }
    if (msg.id == null) return;

    const method = this.#pending.get(msg.id);
    this.#pending.delete(msg.id);

    if (method === "mining.subscribe" && Array.isArray(msg.result)) {
      const size = Number(msg.result[2]);
      const clamped =
        Number.isInteger(size) && size >= 1 && size <= EXTRANONCE2_SIZE_MAX
          ? size
          : EXTRANONCE2_SIZE_DEFAULT;
      this.events.onSubscribed?.(String(msg.result[1] ?? ""), clamped);
      return;
    }
    if (method === "mining.authorize") {
      // The only place the backoff is cleared: this is the first message that proves
      // the pool is willing to work with us, rather than merely willing to accept a TCP
      // connection and hang up.
      if (msg.result === true) this.#reconnectDelay = RECONNECT_BASE_MS;
      else this.events.onError?.(msg.error ?? new Error("pool refused the login"));
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
    // Recorded even when the socket is down, so the framing can be driven without one.
    // Entries for replies that will never come are cleared by the next connect().
    this.#pending.set(id, method);
    this.#socket?.write(JSON.stringify({ id, method, params }) + "\n");
    return id;
  }

  #onClose() {
    this.#socket = null;
    // Our own close() also lands here. Reporting that as a disconnection is not just
    // log noise: the hub treats one as the pool being unhappy and stops taking on new
    // miners, so closing an idle socket would throttle the site for no reason.
    if (this.#closed) return;
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
