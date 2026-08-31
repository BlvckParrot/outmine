import { Activity as ActivityIcon } from "lucide-react";
import { useSession } from "../session";
import { Card } from "./ui";

/** The feed the hub pushes with every board snapshot: who joined, who passed the gate.
 *  Beside Trending rather than at the bottom of the page, because a board nobody is
 *  moving looks the same as a board nobody is watching. */
export function Activity() {
  const { board } = useSession();
  if (board.feed.length === 0) return null;

  return (
    <Card className="flex h-full flex-col px-4 pt-3.5 pb-1 md:px-5 md:pt-4 md:only:col-span-2">
      <h2 className="mb-1 flex items-center gap-1.5 text-sm font-semibold tracking-[-0.02em]">
        <ActivityIcon className="size-4 text-live" /> Latest activity
      </h2>
      <ul className="flex flex-1 flex-col">
        {board.feed.slice().reverse().map((item, i) => (
          <li
            key={`${item.ts}-${i}`}
            className={`flex items-center gap-2 py-1.5 text-xs ${i === 0 ? "" : "border-t border-border"}`}
          >
            <p className="min-w-0 flex-1 truncate">{item.text}</p>
            <span className="shrink-0 font-mono tabular-nums text-muted-foreground">
              {new Date(item.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}
