// Which algorithm pays most per browser hash today? The answer moves weekly.
// Multiply zpool's rate by the hashrate you actually measure with `bun run bench`.
const BROWSER_HS = Number(process.env.BROWSER_HS ?? 877); // measured, 1 thread, Apple M-series

const algos = await fetch("https://zpool.ca/api/status").then((r) => r.json());
const rows = Object.values<any>(algos)
  .filter((a) => Number(a.estimate_last24h) > 0)
  .map((a) => ({
    algo: a.name,
    btcPerMhsDay: Number(a.estimate_last24h),
    usdPerDay: (BROWSER_HS / 1e6) * Number(a.estimate_last24h) * Number(process.env.BTC_USD ?? 76700),
  }))
  .sort((a, b) => b.btcPerMhsDay - a.btcPerMhsDay)
  .slice(0, 10);

console.table(rows);
console.log("\nNote: rate per MH/s only ranks algorithms if they run at similar H/s in a browser.");
console.log("minotaurx and yescrypt both cost one yespower round per hash, so the rate decides.");

export {};
