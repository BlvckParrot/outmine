import type { TrendingItem } from "@outmine/protocol";
import { usePolled } from "../api";
import { points } from "../format";
import { linkProps } from "../router";

/** What has been mined for in the last two hours, which is a different question from
 *  who is on top. On its own timer rather than the board's: the window is hours wide,
 *  so a two-second push would show the same numbers over and over. */
export function Trending() {
  const items = usePolled<TrendingItem[]>("/api/trending", 60_000);
  if (!items || items.length === 0) return null;

  return (
    <section className="mt-8">
      <h2 className="mb-3 text-sm uppercase tracking-widest text-zinc-500">Trending</h2>
      <ul className="flex flex-wrap gap-2">
        {items.map((item) => (
          <li key={item.id}>
            <a
              {...linkProps(`/l/${item.id}`)}
              className="inline-flex items-center gap-2 rounded-full border border-zinc-800 bg-zinc-900/40 px-3 py-1 text-xs hover:border-zinc-700"
            >
              <span className="text-zinc-300">{item.name}</span>
              <span className="text-emerald-500">+{points(item.recent)}</span>
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}
