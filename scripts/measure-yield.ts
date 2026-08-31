// What the pool actually paid us per hash, as opposed to what its API says it pays.
//
// Every other number in this repo is an estimate: zpool's rate per MH/s is what the
// pool hopes to pay, and its unit is not even the same across algorithms. This mines
// from a real browser for a while and divides the credited BTC by the hashes that
// earned it. It is the only way to compare two algorithms honestly.
//
// Usage: BASE=http://localhost:3000 ADDRESS=bc1... MINUTES=120 bun scripts/measure-yield.ts
//
// Run it long. A three-minute sample once suggested MinotaurX pays nine times less
// than zpool's own rate, which turned out to be a dozen shares' worth of noise and
// credit that had not landed yet. Two hours is the floor.
import { chromium } from "playwright";

const BASE = process.env.BASE ?? "http://localhost:3000";
const ADDRESS = process.env.ADDRESS ?? process.env.POOL_USER;
const MINUTES = Number(process.env.MINUTES ?? 120);
const LABEL = process.env.LABEL ?? "run";

if (!ADDRESS) {
  console.error("Set ADDRESS (or POOL_USER) to the payout address being measured.");
  process.exit(2);
}

/** zpool credits the mined coin here before it is sold for BTC, so this is the field
 *  that moves within minutes. `balance` only moves after a sale. */
async function unsold(): Promise<number> {
  const res = await fetch(`https://zpool.ca/api/wallet?address=${ADDRESS}`);
  const body = (await res.json()) as { unsold?: number; error?: string };
  if (body.error) throw new Error(`zpool: ${body.error}`);
  return Number(body.unsold ?? 0);
}

const browser = await chromium.launch();
const page = await browser.newPage();
page.on("pageerror", (e) => console.log(`  [pageerror] ${e.message.slice(0, 200)}`));

await page.goto(BASE, { waitUntil: "networkidle" });
await page.getByRole("button", { name: /I understand/i }).click();
const mine = page.getByRole("button", { name: /mine for (this|it)/i }).first();
await mine.waitFor({ timeout: 5000 });
await mine.click();

const readStat = async (label: string) =>
  (await page.locator(`div:has(> div:text-is("${label}")) > div`).first().textContent())?.trim() ?? "";

// Hashrate is reported in compact form ("2.4k H/s"), which is all the UI needs and not
// enough to integrate over two hours. Sampling it every 15 seconds is.
const before = await unsold();
console.log(`${LABEL}: unsold before ${before.toExponential(6)} BTC, mining for ${MINUTES} min`);

const started = Date.now();
let hashes = 0;
let lastSample = Date.now();

while (Date.now() - started < MINUTES * 60_000) {
  await page.waitForTimeout(15_000);
  const shown = await readStat("hashrate");
  const value = parseFloat(shown);
  const hs = shown.includes("M") ? value * 1e6 : shown.includes("k") ? value * 1e3 : value;
  const now = Date.now();
  hashes += hs * ((now - lastSample) / 1000);
  lastSample = now;

  const minutes = (now - started) / 60_000;
  if (Math.round(minutes) % 10 === 0) {
    console.log(
      `  t+${minutes.toFixed(0)}min  ${hs.toFixed(0)} H/s  ` +
        `accepted=${await readStat("accepted")} rejected=${await readStat("rejected")}  ` +
        `${(hashes / 1e6).toFixed(1)} Mhash so far`,
    );
  }
}

const accepted = Number(await readStat("accepted"));
const rejected = Number(await readStat("rejected"));
await browser.close();

// Credit for the last shares can take a few minutes to appear.
console.log("mining stopped; waiting 5 min for the pool to credit the last shares");
await Bun.sleep(5 * 60_000);
const after = await unsold();

const earned = after - before;
const perHash = hashes > 0 ? earned / hashes : 0;
console.log(`
${LABEL}
  hashes        ${(hashes / 1e6).toFixed(1)} M
  shares        ${accepted} accepted, ${rejected} rejected
  unsold        ${before.toExponential(6)} -> ${after.toExponential(6)} BTC
  earned        ${earned.toExponential(3)} BTC
  per hash      ${perHash.toExponential(3)} BTC
  per thread    ${(perHash * (hashes / ((Date.now() - started) / 1000)) * 86400).toExponential(3)} BTC/day at this hashrate
`);
if (earned <= 0) {
  console.log("Nothing credited. Either the run was too short or nothing was accepted;");
  console.log("compare `accepted` above before concluding anything about the algorithm.");
}
