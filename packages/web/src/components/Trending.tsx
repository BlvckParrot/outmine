import { Flame } from "lucide-react";
import type { TrendingItem } from "@outmine/protocol";
import { usePolled } from "../api";
import { points } from "../format";
import { linkProps } from "../router";
import { Avatar, Card } from "./ui";

/** What has been mined for in the last two hours, which is a different question from
 *  who is on top. On its own timer rather than the board's: the window is hours wide,
 *  so a two-second push would show the same numbers over and over. */
export function Trending() {
  const all = usePolled<TrendingItem[]>("/api/trending", 60_000);
  if (!all || all.length === 0) return null;
  // A teaser beside the board, not a second board.
  const items = all.slice(0, 6);

  return (
    <Card className="flex h-full flex-col px-4 pt-3.5 pb-1 md:px-5 md:pt-4 md:only:col-span-2">
      <h2 className="mb-1 flex items-center gap-1.5 text-sm font-semibold tracking-[-0.02em]">
        <Flame className="size-4 text-primary" /> Trending
        <span className="font-normal text-muted-foreground">· last 2h</span>
      </h2>
      <ul className="flex flex-1 flex-col">
        {items.map((item, i) => (
          <li key={item.id} className={i === 0 ? "" : "border-t border-border"}>
            <a {...linkProps(`/l/${item.id}`)} className="flex items-center gap-2 py-1.5 text-xs">
              <Avatar entry={item} size="xs" />
              <p className="min-w-0 flex-1 truncate font-semibold">{item.name}</p>
              <span className="shrink-0 font-mono tabular-nums text-primary">
                +{points(item.recent)} pts
              </span>
            </a>
          </li>
        ))}
      </ul>
    </Card>
  );
}
