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

// Wait for the first accepted share rather than for a fixed number of seconds. How
// long that takes depends on the pool's current difficulty and on how busy this
// machine is; a fixed window made the check fail on a slow afternoon while mining was
// working perfectly. The assertion is unchanged - a share must land - only the
// patience is adaptive.
const DEADLINE_MS = 120_000;
const startedAt = Date.now();

while (Date.now() - startedAt < DEADLINE_MS) {
  await page.waitForTimeout(2500);
  const hs = await readStat("hashrate");
  const acc = await readStat("accepted");
  const rej = await readStat("rejected");
  // The live counters moved out of a paragraph in the header and into the status
  // pill above the headline; it is the only link on the page that says "online".
  const header = (await page.getByRole("link", { name: /online/ }).first().textContent())?.trim();
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(`  t+${elapsed}s  hashrate=${hs}  accepted=${acc}  rejected=${rej}  header="${header}"`);
  if (Number(acc) > 0) break;
}

await page.screenshot({ path: `${SHOT}/02-mining.png` });
const finalAccepted = Number(await readStat("accepted"));
const finalHashrate = await readStat("hashrate");

// The board must show that somebody is on this listing. The number comes from the hub
// counting sockets, so a mismatch here means the snapshot and reality have drifted.
const minersShown = await page.locator("ol li", { hasText: /\d+ mining/ }).count();
console.log(`miners shown on a row: ${minersShown > 0}`);

// Navigating must not stop mining. The socket and the workers live in the shell, so a
// page that owned them - the obvious structure - would silently kill the miner here.
await page.getByRole("link", { name: "About", exact: true }).click();
await page.waitForTimeout(4000);
const onAbout = page.url().endsWith("/about");
const stillMining = await page.getByText(/mining for/).isVisible();
const acceptedAfterNav = Number(await readStat("accepted"));
console.log(`navigated to /about: ${onAbout}  still mining: ${stillMining}  accepted ${finalAccepted} -> ${acceptedAfterNav}`);
await page.screenshot({ path: `${SHOT}/03-about-while-mining.png` });

// A reload must not ask for consent again, and must offer the last listing back
// without starting anything on its own.
await page.goto(BASE, { waitUntil: "networkidle" });
await page.waitForTimeout(2000);
const bannerBack = await page.getByRole("button", { name: /I understand/i }).isVisible().catch(() => false);
const resumeOffered = await page.getByRole("button", { name: /pick up where you left off/i }).isVisible();
const miningOnLoad = await page.getByText(/mining for/).isVisible().catch(() => false);
console.log(`after reload: consent asked again=${bannerBack}  resume offered=${resumeOffered}  mining started by itself=${miningOnLoad}`);
await page.screenshot({ path: `${SHOT}/04-returning-visitor.png` });

const checks = {
  accepted: finalAccepted > 0,
  minersShown: minersShown > 0,
  survivedNavigation: onAbout && stillMining && acceptedAfterNav >= finalAccepted,
  consentRemembered: !bannerBack,
  resumeOffered,
  // The one that matters most: a stored consent buys us the banner, not the CPU.
  didNotAutostart: !miningOnLoad,
};
console.log(`\nRESULT accepted=${finalAccepted} hashrate=${finalHashrate}`);
for (const [name, ok] of Object.entries(checks)) console.log(`  ${ok ? "ok  " : "FAIL"} ${name}`);
await browser.close();
process.exit(Object.values(checks).every(Boolean) ? 0 : 1);
