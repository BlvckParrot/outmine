import { useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import type { BoardEntry, BoardPageResponse } from "@outmine/protocol";
import { usePolled } from "../api";
import { Activity } from "../components/Activity";
import { BoardRow, PendingRow, RankDivider } from "../components/BoardRow";
import { Hero } from "../components/Hero";
import { Trending } from "../components/Trending";
import { Card } from "../components/ui";
import { useSession } from "../session";

type Tab = "all" | "24h";

type View = {
  entries: BoardEntry[];
  pending: BoardEntry[];
  total: number;
  limit: number;
};

/** Where the board is cut into "the podium" and "the rest". Only dividers that fall
 *  inside the current page are drawn. */
const DIVIDERS = [3, 10, 20];

export function Home() {
  const { board, mineFor, startMining, consented, accept } = useSession();
  const [tab, setTab] = useState<Tab>("all");
  const [typed, setTyped] = useState("");
  const [q, setQ] = useState("");
  const [offset, setOffset] = useState(0);

  // The hub pushes the unfiltered top of the all-time board every couple of seconds.
  // That push is the right source only for exactly that view; under any filter it
  // would overwrite what the visitor asked for with the default list. So: live while
  // the view is the default one, HTTP with its own refresh as soon as it is not.
  const live = tab === "all" && !q && offset === 0;

  // A request per keystroke would be one per character typed; the board is not so
  // urgent that it cannot wait a third of a second.
  useEffect(() => {
    const id = setTimeout(() => {
      setQ(typed.trim());
      setOffset(0); // page 4 of the old search is meaningless for a new one
    }, 300);
    return () => clearTimeout(id);
  }, [typed]);

  // Memoised because it is the hook's dependency: a fresh string every render would
  // restart the poll on every render.
  const path = useMemo(
    () => (live ? null : `/api/board?${new URLSearchParams({ window: tab, q, offset: String(offset) })}`),
    [live, tab, q, offset],
  );
  const page = usePolled<BoardPageResponse>(path, 10_000);

  const view: View = live
    ? { entries: board.entries, pending: board.pending, total: board.total, limit: board.limit }
    : page
      ? { entries: page.entries, pending: page.pending, total: page.total, limit: page.limit }
      : { entries: [], pending: [], total: 0, limit: 1 };

  const mine = (id: string) => (consented ? startMining(id) : accept());
  const limit = Math.max(1, view.limit);
  const pageCount = Math.max(1, Math.ceil(view.total / limit));
  const current = Math.floor(offset / limit);
  // Podium styling and the TOP-N dividers only make sense on an actual ranking.
  const ranked = !q;

  return (
    <>
      <Hero />

      <div className="mb-6 grid grid-cols-1 items-stretch gap-4 md:grid-cols-2">
        <Trending />
        <Activity />
      </div>

      <section id="board">
        <div className="mb-3 flex flex-wrap items-center gap-3">
          <div className="flex gap-1 text-xs">
            <TabButton active={tab === "all"} onClick={() => { setTab("all"); setOffset(0); }}>
              all time
            </TabButton>
            {/* Cumulative scoring never forgets, so without this the launch week owns
                the top forever and a listing added today has nothing to aim at. */}
            <TabButton active={tab === "24h"} onClick={() => { setTab("24h"); setOffset(0); }}>
              24h
            </TabButton>
          </div>
          <input
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder="search"
            className="ml-auto h-8 w-40 rounded-full border border-input bg-card px-3 text-xs outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-primary"
          />
        </div>

        {view.entries.length === 0 && (
          <Card className="p-6 text-sm text-muted-foreground">
            {q
              ? `Nothing matches "${q}".`
              : "Nothing on the board yet. A listing appears once someone has mined for it."}
          </Card>
        )}

        <ol>
          {view.entries.flatMap((entry, i) => {
            const rank = offset + i + 1;
            // A search result is the Nth match, not the Nth on the board, so the first
            // hit must not get the leader's gold card. The 24h tab is a real ranking.
            const divider = ranked && DIVIDERS.includes(rank - 1);
            const row = (
              <BoardRow
                key={entry.id}
                entry={entry}
                rank={ranked ? rank : null}
                podium={ranked && rank <= 3}
                topOfBlock={divider || i === 0}
                mining={mineFor === entry.id}
                onMine={() => mine(entry.id)}
              />
            );
            return divider ? [<RankDivider key={`d${rank}`} after={rank - 1} />, row] : [row];
          })}
        </ol>

        {pageCount > 1 && (
          <Pagination
            current={current}
            pageCount={pageCount}
            onGo={(p) => setOffset(p * limit)}
            from={offset + 1}
            to={offset + view.entries.length}
            total={view.total}
          />
        )}
      </section>

      {view.pending.length > 0 && (
        <section className="mt-10">
          <h2 className="mb-1 text-sm font-semibold tracking-[-0.02em]">Waiting for hashes</h2>
          <p className="mb-3 text-xs text-muted-foreground">
            These are not on the board yet. Mine {board.threshold} shares for one and it joins.
          </p>
          <ul className="space-y-2">
            {view.pending.map((entry) => (
              <PendingRow
                key={entry.id}
                entry={entry}
                threshold={board.threshold}
                mining={mineFor === entry.id}
                onMine={() => mine(entry.id)}
              />
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

function TabButton(props: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={props.onClick}
      className={`cursor-pointer rounded-full px-3 py-1 font-medium transition-colors ${
        props.active ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"
      }`}
    >
      {props.children}
    </button>
  );
}

/** First, last, and a window around the current page. Fifty listings a page means
 *  fourteen pages at outbid's size, which is too many to list in full on a phone. */
function pageNumbers(current: number, count: number): (number | "gap")[] {
  const wanted = new Set([0, count - 1, current - 1, current, current + 1]);
  const shown = [...wanted].filter((p) => p >= 0 && p < count).sort((a, b) => a - b);
  return shown.flatMap((p, i) => {
    const missing = i === 0 ? 0 : p - shown[i - 1]! - 1;
    // An ellipsis standing in for a single page is wider than the page it hides.
    if (missing === 1) return [p - 1, p];
    return missing > 1 ? ["gap" as const, p] : [p];
  });
}

function Pagination(props: {
  current: number; pageCount: number; onGo: (page: number) => void;
  from: number; to: number; total: number;
}) {
  const step = (delta: number) =>
    props.onGo(Math.min(props.pageCount - 1, Math.max(0, props.current + delta)));

  return (
    <div className="mt-6 flex flex-col items-center gap-1.5">
      <div className="flex items-center gap-1">
        <PageButton onClick={() => step(-1)} disabled={props.current === 0} label="Previous page">
          <ChevronLeft className="size-4" />
        </PageButton>
        {pageNumbers(props.current, props.pageCount).map((p, i) =>
          p === "gap" ? (
            <span key={`gap${i}`} className="px-1 text-sm text-muted-foreground">…</span>
          ) : (
            <PageButton key={p} onClick={() => props.onGo(p)} active={p === props.current}>
              {p + 1}
            </PageButton>
          ),
        )}
        <PageButton
          onClick={() => step(1)}
          disabled={props.current >= props.pageCount - 1}
          label="Next page"
        >
          <ChevronRight className="size-4" />
        </PageButton>
      </div>
      <p className="font-mono text-xs tabular-nums text-muted-foreground">
        {props.from} – {props.to} of {props.total}
      </p>
    </div>
  );
}

function PageButton(props: {
  onClick: () => void; children: React.ReactNode;
  active?: boolean; disabled?: boolean; label?: string;
}) {
  return (
    <button
      onClick={props.onClick}
      disabled={props.disabled}
      aria-label={props.label}
      aria-current={props.active ? "page" : undefined}
      className={`grid size-8 cursor-pointer place-items-center rounded-full text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-30 ${
        props.active
          ? "bg-primary text-primary-foreground"
          : "text-muted-foreground hover:bg-muted hover:text-foreground"
      }`}
    >
      {props.children}
    </button>
  );
}
