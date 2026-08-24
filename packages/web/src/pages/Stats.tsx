import { useEffect, useState } from "react";
import { POINT_SCALE, type StatsResponse } from "@outmine/protocol";
import { apiUrl } from "../api";
import { fmt } from "../format";

/** Everything this site has ever spent of other people's CPU, in public. A project
 *  that turns visitors into miners does not get to be vague about the total. */
export function Stats() {
  const [stats, setStats] = useState<StatsResponse | null>(null);

  useEffect(() => {
    const load = () => fetch(apiUrl("/api/stats")).then((r) => r.json()).then(setStats).catch(() => {});
    load();
    const id = setInterval(load, 15_000);
    return () => clearInterval(id);
  }, []);

  if (!stats) return <p className="mt-8 text-sm text-zinc-500">Loading…</p>;

  return (
    <section className="mt-8">
      <h1 className="text-2xl font-bold text-white">Numbers</h1>
      <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Cell label="shares accepted" value={fmt(stats.shares)} />
        <Cell label="shares, last 24h" value={fmt(stats.shares24h)} />
        <Cell label="points awarded" value={fmt(stats.score * POINT_SCALE)} />
        <Cell label="listings" value={String(stats.listings)} />
        <Cell label="on the board" value={String(stats.onBoard)} />
        <Cell label="outbound clicks" value={fmt(stats.clicks)} />
        <Cell label="online now" value={String(stats.online)} />
        <Cell label="mining now" value={String(stats.mining)} />
        <Cell label="pool sockets" value={String(stats.poolConnections)} />
      </div>
      <p className="mt-6 text-xs text-zinc-600">
        No figure in currency: the exchange rate is not ours to quote and an estimate would read as
        a promise. A share is one unit of work the pool accepted, and a point is pool difficulty
        scaled so the numbers are readable.
      </p>
    </section>
  );
}

const Cell = ({ label, value }: { label: string; value: string }) => (
  <div className="rounded border border-zinc-800 bg-zinc-900/40 p-4">
    <div className="text-2xl font-bold text-white">{value}</div>
    <div className="mt-1 text-[10px] uppercase tracking-wider text-zinc-500">{label}</div>
  </div>
);
