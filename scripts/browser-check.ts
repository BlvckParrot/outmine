// End-to-end check in a real browser: consent, pick a listing, mine, see shares land.
// Kept in the repo because it found three bugs no unit test could: an inflated
// hashrate readout, a board frozen at "0 pts", and a fresh install with nothing to
// mine for. Usage: BASE=http://localhost:3000 bun scripts/browser-check.ts
import { chromium } from "playwright";

const BASE = process.env.BASE ?? "http://localhost:3000";
const SHOT = process.env.SHOT_DIR ?? "/tmp";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 900, height: 1100 } });
page.on("console", (m) => console.log(`  [console.${m.type()}] ${m.text().slice(0, 200)}`));
page.on("pageerror", (e) => console.log(`  [pageerror] ${e.message.slice(0, 300)}`));

await page.goto(BASE, { waitUntil: "networkidle" });
console.log("title:", await page.title());
await page.screenshot({ path: `${SHOT}/01-board.png` });

const consent = page.getByRole("button", { name: /I understand/i });
console.log("consent banner visible:", await consent.isVisible());
await consent.click();

const mineBtn = page.getByRole("button", { name: /mine for this/i }).first();
await mineBtn.waitFor({ timeout: 5000 });
console.log("listing on board:", (await page.locator("ol li").count()) > 0);
await mineBtn.click();


// Watch the panel for a while: hashrate must move off zero and shares must be accepted.
const readStat = async (label: string) =>
  (await page.locator(`div:has(> div:text-is("${label}")) > div`).first().textContent())?.trim();

for (let i = 0; i < 10; i++) {
  await page.waitForTimeout(2500);
  const hs = await readStat("hashrate");
  const acc = await readStat("accepted");
  const rej = await readStat("rejected");
  const header = (await page.locator("header p").last().textContent())?.trim();
  console.log(`  t+${(i + 1) * 2.5}s  hashrate=${hs}  accepted=${acc}  rejected=${rej}  header="${header}"`);
}

await page.screenshot({ path: `${SHOT}/02-mining.png` });
const finalAccepted = Number(await readStat("accepted"));
const finalHashrate = await readStat("hashrate");
console.log(`\nRESULT accepted=${finalAccepted} hashrate=${finalHashrate}`);
await browser.close();
process.exit(finalAccepted > 0 ? 0 : 1);
