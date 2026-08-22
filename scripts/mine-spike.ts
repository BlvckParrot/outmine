// End-to-end spike: job from zpool -> header -> WASM nonce loop -> submit -> accepted?
// The pool is the only real oracle for byte order; unit tests cannot prove this part.
// Burn address on purpose: nobody receives the (fractional) proceeds.
import createModule from "../wasm/build/mine.mjs";
import { buildHeader, bytesToHex, diffToTarget, type StratumJob } from "../src/blockheader";
import { StratumClient } from "../src/stratum";

const Module = await createModule();
const EXTRANONCE2 = "00000000";

let extranonce1 = "";
let difficulty = 1;
let job: StratumJob | null = null;
let submitted = 0;
let accepted = 0;

const leHex = (n: number) => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n >>> 0, true);
  return bytesToHex(b);
};

const client = new StratumClient(
  "minotaurx.mine.zpool.ca",
  7019,
  "1BitcoinEaterAddressDontSendf59kuE",
  "c=BTC",
  {
    onSubscribed: (e1) => (extranonce1 = e1),
    onDifficulty: (d) => (difficulty = d),
    onJob: (j) => (job = j),
    onSubmitResult: (ok, err) => {
      accepted += ok ? 1 : 0;
      console.log(ok ? "  ACCEPTED" : `  REJECTED ${JSON.stringify(err)}`);
    },
    onError: (e) => console.log("error", e),
  },
);

await client.connect();
while (!job || !extranonce1) await Bun.sleep(200);
console.log(`job ${job!.jobId}, difficulty ${difficulty}, extranonce1 ${extranonce1}`);

const inPtr = Module._malloc(80);
const tPtr = Module._malloc(32);
const outPtr = Module._malloc(32);
Module.HEAPU8.set(diffToTarget(difficulty), tPtr);

let nonce = 0;
const started = Date.now();
while (submitted < 3 && Date.now() - started < 120_000) {
  const header = buildHeader(job!, extranonce1, EXTRANONCE2);
  Module.HEAPU8.set(header, inPtr);
  const found = Module._mine(inPtr, tPtr, nonce, nonce + 20_000, outPtr);
  if (found < 0) {
    nonce = (nonce + 20_000) >>> 0;
    continue;
  }
  const hash = Module.HEAPU8.slice(outPtr, outPtr + 32);
  console.log(`share nonce=${found} hash=${bytesToHex(hash.slice().reverse())}`);
  client.submit(job!.jobId, EXTRANONCE2, job!.ntime, leHex(found));
  submitted++;
  nonce = (found + 1) >>> 0;
  await Bun.sleep(1500);
}

await Bun.sleep(3000);
console.log(`\nsubmitted ${submitted}, accepted ${accepted}`);
client.close();
process.exit(accepted > 0 ? 0 : 1);
