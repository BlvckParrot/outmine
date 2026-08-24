import { useEffect, useMemo, useState } from "react";
import type { BoardEntry, BoardPageResponse } from "@outmine/protocol";
import { usePolled } from "../api";
import { BoardRow, PendingRow } from "../components/BoardRow";
import { SubmitForm } from "../components/SubmitForm";
import { Trending } from "../components/Trending";
import { useSession } from "../session";

type Tab = "all" | "24h";

type View = {
  entries: BoardEntry[];
  pending: BoardEntry[];
  total: number;
  limit: number;
};

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
    ? { entries: board.entries, pending: board.pending, total: board.entries.length, limit: board.entries.length }
    : page
      ? { entries: page.entries, pending: page.pending, total: page.total, limit: page.limit }
      : { entries: [], pending: [], total: 0, limit: 1 };

  const mine = (id: string) => (consented ? startMining(id) : accept());
  const hasNext = offset + view.entries.length < view.total;

  return (
    <>
      <Trending />

      <section className="mt-8">
        <div className="mb-3 flex flex-wrap items-center gap-3">
          <h2 className="text-sm uppercase tracking-widest text-zinc-500">Board</h2>
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
            className="ml-auto w-40 rounded border border-zinc-800 bg-zinc-900 px-2 py-1 text-xs"
          />
        </div>

        {view.entries.length === 0 && (
          <p className="rounded border border-zinc-800 p-6 text-sm text-zinc-500">
            {q ? `Nothing matches "${q}".` : "Nothing on the board yet. A listing appears once someone has mined for it."}
          </p>
        )}

        <ol className="space-y-2">
          {view.entries.map((entry, i) => (
            <BoardRow
              key={entry.id}
              entry={entry}
              rank={offset + i + 1}
              mining={mineFor === entry.id}
              onMine={() => mine(entry.id)}
            />
          ))}
        </ol>

        {(offset > 0 || hasNext) && (
          <div className="mt-3 flex items-center gap-3 text-xs text-zinc-500">
            <button
              disabled={offset === 0}
              onClick={() => setOffset(Math.max(0, offset - view.limit))}
              className="rounded border border-zinc-800 px-3 py-1 hover:border-zinc-700 disabled:opacity-30"
            >
              previous
            </button>
            <button
              disabled={!hasNext}
              onClick={() => setOffset(offset + view.entries.length)}
              className="rounded border border-zinc-800 px-3 py-1 hover:border-zinc-700 disabled:opacity-30"
            >
              next
            </button>
            <span>
              {offset + 1}–{offset + view.entries.length} of {view.total}
            </span>
          </div>
        )}
      </section>

      {view.pending.length > 0 && (
        <section className="mt-8">
          <h2 className="mb-3 text-sm uppercase tracking-widest text-zinc-500">Waiting for hashes</h2>
          <p className="mb-3 text-xs text-zinc-500">
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

      <SubmitForm />

      {board.feed.length > 0 && (
        <section className="mt-8">
          <h2 className="mb-3 text-sm uppercase tracking-widest text-zinc-500">Activity</h2>
          <ul className="space-y-1 text-xs text-zinc-500">
            {board.feed.slice().reverse().map((f, i) => (
              <li key={i}>
                <span className="text-zinc-700">{new Date(f.ts).toLocaleTimeString()}</span> {f.text}
              </li>
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
      className={`rounded px-2 py-1 ${props.active ? "bg-zinc-800 text-white" : "text-zinc-500 hover:text-zinc-300"}`}
    >
      {props.children}
    </button>
  );
}
