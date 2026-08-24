import { expect, test } from "bun:test";
import { StratumClient, type Job, type StratumEvents } from "./stratum";

// The parser is fed by a socket in production; `feed` is the same entry point without
// one. Framing is the part that actually breaks: stratum is newline-delimited JSON
// over TCP, so a message can arrive split across chunks or two-to-a-chunk.
const NOTIFY = {
  id: null,
  method: "mining.notify",
  params: ["job1", "ffee", "01ab", "cd02", ["11", "22"], "20000000", "1d0a3758", "68a80000", true],
};

const makeClient = (events: StratumEvents = {}) => new StratumClient("host", 1, "user", "pass", events);

test("a message split across two chunks is parsed once whole", () => {
  const jobs: Job[] = [];
  const client = makeClient({ onJob: (j) => void jobs.push(j) });
  const line = JSON.stringify(NOTIFY) + "\n";

  client.feed(line.slice(0, 30));
  expect(jobs).toHaveLength(0); // nothing usable yet
  client.feed(line.slice(30));

  expect(jobs).toHaveLength(1);
  expect(jobs[0]!.jobId).toBe("job1");
  expect(jobs[0]!.merkleBranch).toEqual(["11", "22"]);
  expect(jobs[0]!.cleanJobs).toBe(true);
});

test("two messages in one chunk both arrive", () => {
  const jobs: Job[] = [];
  const diffs: number[] = [];
  const client = makeClient({ onJob: (j) => void jobs.push(j), onDifficulty: (d) => void diffs.push(d) });

  client.feed(
    JSON.stringify({ id: null, method: "mining.set_difficulty", params: [0.5] }) + "\n" +
      JSON.stringify(NOTIFY) + "\n",
  );

  expect(diffs).toEqual([0.5]);
  expect(jobs).toHaveLength(1);
});

test("blank lines and trailing partials do not derail the stream", () => {
  const jobs: Job[] = [];
  const client = makeClient({ onJob: (j) => void jobs.push(j) });
  client.feed("\n\n" + JSON.stringify(NOTIFY) + "\n" + '{"id":9,"partial"');
  expect(jobs).toHaveLength(1);
});

test("subscribe response reports extranonce1 and its size", () => {
  const seen: { e1: string; size: number }[] = [];
  const client = makeClient({ onSubscribed: (e1, size) => void seen.push({ e1, size }) });
  const id = client.subscribe();
  client.feed(JSON.stringify({ id, result: [[["mining.notify", "x"]], "800c87c1", 4], error: null }) + "\n");
  expect(seen).toEqual([{ e1: "800c87c1", size: 4 }]);
});

test("submit results are routed back by request id", () => {
  // With one pool connection shared by many miners, the id is the only thing that
  // says whose share this was. Getting it wrong credits the wrong listing silently.
  const results: { id: number; ok: boolean }[] = [];
  const client = makeClient({
    onSubmitResult: (ok, _err, id) => void results.push({ id, ok }),
  });

  const first = client.submit("job1", "00000000", "68a80000", "0000002a");
  const second = client.submit("job1", "00000001", "68a80000", "0000002b");
  expect(second).not.toBe(first);

  // Answered out of order, as a real pool may well do.
  client.feed(JSON.stringify({ id: second, result: true, error: null }) + "\n");
  client.feed(JSON.stringify({ id: first, result: false, error: [23, "Low difficulty share", null] }) + "\n");

  expect(results).toEqual([
    { id: second, ok: true },
    { id: first, ok: false },
  ]);
});

test("an unsolicited error response reaches onError", () => {
  const errors: unknown[] = [];
  const client = makeClient({ onError: (e) => void errors.push(e) });
  const id = client.authorize();
  client.feed(JSON.stringify({ id, result: null, error: [24, "Unauthorized worker", null] }) + "\n");
  expect(errors).toHaveLength(1);
});

test("garbage on the wire is reported, not thrown", () => {
  const errors: unknown[] = [];
  const client = makeClient({ onError: (e) => void errors.push(e) });
  expect(() => client.feed("this is not json\n")).not.toThrow();
  expect(errors).toHaveLength(1);
});

test("a dropped connection is reestablished on its own", async () => {
  // Against a local socket rather than the pool: the point is that a drop is survived,
  // and a real pool cannot be told to hang up on cue.
  let connects = 0;
  const server = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      open(socket) {
        connects++;
        if (connects === 1) socket.end(); // hang up on the first attempt
      },
      data() {},
    },
  });

  const client = new StratumClient("127.0.0.1", server.port, "user", "pass", {});
  await client.connect();

  const deadline = Date.now() + 10_000;
  while (connects < 2 && Date.now() < deadline) await Bun.sleep(100);

  expect(connects).toBeGreaterThanOrEqual(2);
  client.close();
  server.stop(true);
});

test("close() stops the reconnect loop for good", async () => {
  let connects = 0;
  const server = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: { open: (socket) => { connects++; socket.end(); }, data() {} },
  });

  const client = new StratumClient("127.0.0.1", server.port, "user", "pass", {});
  await client.connect();

  // Wait for the first connection to actually register before taking a baseline:
  // connect() resolving does not mean the listener has run its open handler yet.
  while (connects < 1) await Bun.sleep(20);
  client.close();

  const after = connects;
  await Bun.sleep(2500); // longer than the first backoff step
  expect(connects).toBe(after);
  server.stop(true);
});
