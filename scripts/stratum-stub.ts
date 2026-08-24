// A pool that says yes to everything, so the server can be loaded without loading zpool.
//
// Five thousand miners pointed at a real pool is a flood from one address, which is the
// exact thing the connection controller exists to avoid - so the load test cannot use
// one. This speaks enough stratum for the hub: subscribe, authorize, a job every few
// seconds, and an accepted answer to every submit.
//
// Usage: PORT=3399 bun scripts/stratum-stub.ts
import { log } from "../packages/server/src/log";

const PORT = Number(process.env.PORT ?? 3399);
/** How often a fresh job goes out, like a pool that keeps miners on current work. */
const JOB_MS = Number(process.env.JOB_MS ?? 20_000);
/** Answer to mining.submit. Set STUB_ACCEPT=0 to make every share invalid, which is what
 *  a wrong algorithm or a bad header looks like from here. */
const ACCEPT = process.env.STUB_ACCEPT !== "0";

let connections = 0;
let submits = 0;
let jobCounter = 0;

/** Distinct per connection, as a pool's is: two miners building the same header would
 *  race to the same nonces, and the hub splits extranonce2 assuming this is unique. */
const extranonce1 = () => (0x10000000 + connections).toString(16);

const hex = (n: number, bytes: number) => n.toString(16).padStart(bytes * 2, "0");

function job() {
  jobCounter++;
  return {
    id: null,
    method: "mining.notify",
    params: [
      `stub-${jobCounter}`,
      hex(jobCounter, 32), // prevhash
      "01000000010000000000000000000000000000000000000000000000000000000000000000ffffffff20",
      "ffffffff0100f2052a010000001976a914000000000000000000000000000000000000000088ac00000000",
      [], // no merkle branch: one transaction
      "20000000",
      "1d00ffff",
      hex(Math.floor(Date.now() / 1000), 4),
      true,
    ],
  };
}

const server = Bun.listen<{ buffer: string; timer?: ReturnType<typeof setInterval> }>({
  hostname: "127.0.0.1",
  port: PORT,
  socket: {
    open(socket) {
      connections++;
      socket.data = { buffer: "" };
      const send = (msg: unknown) => socket.write(JSON.stringify(msg) + "\n");
      // A pool pushes work without being asked; the hub only broadcasts once it has both
      // a subscription and a job.
      socket.data.timer = setInterval(() => send(job()), JOB_MS);
    },
    data(socket, chunk) {
      socket.data.buffer += chunk.toString();
      const lines = socket.data.buffer.split("\n");
      socket.data.buffer = lines.pop() ?? "";
      const send = (msg: unknown) => socket.write(JSON.stringify(msg) + "\n");

      for (const line of lines) {
        if (!line.trim()) continue;
        const msg = JSON.parse(line);
        if (msg.method === "mining.subscribe") {
          send({ id: msg.id, result: [[], extranonce1(), 4], error: null });
          send({ id: null, method: "mining.set_difficulty", params: [0.0005] });
          send(job());
          continue;
        }
        if (msg.method === "mining.authorize") {
          send({ id: msg.id, result: true, error: null });
          continue;
        }
        if (msg.method === "mining.submit") {
          submits++;
          send({
            id: msg.id,
            result: ACCEPT,
            error: ACCEPT ? null : [23, "Low difficulty share", null],
          });
          continue;
        }
        send({ id: msg.id, result: null, error: [20, "unknown method", null] });
      }
    },
    close(socket) {
      connections--;
      if (socket.data.timer) clearInterval(socket.data.timer);
    },
    error(_socket, err) {
      log("stub_error", { error: String(err) });
    },
  },
});

setInterval(() => log("stub", { connections, submits }), 10_000).unref();

log("stub_listening", { port: server.port, jobMs: JOB_MS, accepting: ACCEPT });
