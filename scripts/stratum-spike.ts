// Spike: prove we can reach zpool over TCP from Bun and get real work.
// Burn address on purpose - this only tests transport, no shares are submitted.
import { StratumClient } from "../src/stratum";

const client = new StratumClient(
  "minotaurx.mine.zpool.ca",
  7019,
  "1BitcoinEaterAddressDontSendf59kuE",
  "c=BTC",
  {
    onSubscribed: (e1, e2size) => console.log(`subscribed  extranonce1=${e1} extranonce2Size=${e2size}`),
    onDifficulty: (d) => console.log(`difficulty  ${d}`),
    onJob: (j) => console.log(`job         ${j.jobId} prev=${j.prevHash.slice(0, 16)}… nbits=${j.nbits} clean=${j.cleanJobs}`),
    onError: (e) => console.log("error      ", e),
    onClose: () => console.log("closed"),
  },
);

await client.connect();
console.log("connected, waiting 20s for work…");
await Bun.sleep(20_000);
client.close();
