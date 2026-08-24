import type { StatsResponse } from "@outmine/protocol";
import { usePolled } from "../api";
import { StatTile } from "../components/ui";
import { fmt, points } from "../format";

/** Everything this site has ever spent of other people's CPU, in public. A project
 *  that turns visitors into miners does not get to be vague about the total. */
export function Stats() {
  const stats = usePolled<StatsResponse>("/api/stats", 15_000);
  if (!stats) return <p className="mt-8 text-sm text-zinc-500">Loading…</p>;

  return (
    <section className="mt-8">
      <h1 className="text-2xl font-bold text-white">Numbers</h1>
      <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-3">
        <StatTile size="lg" label="shares accepted" value={fmt(stats.shares)} />
        <StatTile size="lg" label="shares, last 24h" value={fmt(stats.shares24h)} />
        <StatTile size="lg" label="points awarded" value={points(stats.score)} />
        <StatTile size="lg" label="listings" value={String(stats.listings)} />
        <StatTile size="lg" label="on the board" value={String(stats.onBoard)} />
        <StatTile size="lg" label="outbound clicks" value={fmt(stats.clicks)} />
        <StatTile size="lg" label="online now" value={String(stats.online)} />
        <StatTile size="lg" label="mining now" value={String(stats.mining)} />
        <StatTile size="lg" label="pool sockets" value={String(stats.poolConnections)} />
      </div>
      <p className="mt-6 text-xs text-zinc-600">
        No figure in currency: the exchange rate is not ours to quote and an estimate would read as
        a promise. A share is one unit of work the pool accepted, and a point is pool difficulty
        scaled so the numbers are readable.
      </p>
    </section>
  );
}
