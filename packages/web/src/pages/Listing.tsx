import { useState } from "react";
import type { ListingDetail } from "@outmine/protocol";
import { apiUrl, usePolled } from "../api";
import { Avatar, StatTile } from "../components/ui";
import { fmt, points } from "../format";
import { linkProps } from "../router";
import { useSession } from "../session";

/** One listing on its own URL. This is the page a shared link points at, so it has to
 *  stand on its own: rank, score, and a way to start mining without going home first. */
export function Listing({ id }: { id: string }) {
  const { board, mineFor, startMining, consented, accept } = useSession();
  const [copied, setCopied] = useState(false);
  const listing = usePolled<ListingDetail>(`/api/listings/${id}`, 15_000);

  // The board snapshot arrives every couple of seconds; the fetch above happens once.
  // Preferring the snapshot keeps the live numbers moving while someone mines.
  const liveEntry = [...board.entries, ...board.pending].find((e) => e.id === id);

  if (!listing) {
    return (
      <p className="mt-8 text-sm text-zinc-500">
        Loading… if nothing appears, this listing is gone —{" "}
        <a {...linkProps("/")} className="text-emerald-400 hover:underline">back to the board</a>.
      </p>
    );
  }

  const score = liveEntry?.score ?? listing.score;
  const shares = liveEntry?.shares ?? listing.shares;
  const pageUrl = `${location.origin}/l/${id}`;
  const badgeMarkdown = `[![outmine](${location.origin}/badge/${id}.svg)](${pageUrl})`;
  const shareText = listing.rank
    ? `${listing.name} is #${listing.rank} on outmine — a leaderboard paid for in CPU time, not money.`
    : `${listing.name} needs hashes to reach the outmine board.`;

  return (
    <article className="mt-8">
      <div className="flex items-start gap-4">
        <Avatar entry={listing} size="lg" />
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-2xl font-bold text-white">{listing.name}</h1>
          <p className="mt-1 text-sm text-zinc-500">{listing.tagline}</p>
          <a
            href={apiUrl(`/r/${listing.id}`)}
            rel="sponsored nofollow noopener"
            target="_blank"
            className="mt-1 inline-block truncate text-xs text-emerald-500 hover:underline"
          >
            {listing.kind === "handle" ? `@${listing.target}` : listing.target} ↗
          </a>
        </div>
        <button
          onClick={() => (consented ? startMining(listing.id) : accept())}
          disabled={mineFor === listing.id}
          className="shrink-0 rounded bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-500 disabled:bg-zinc-700"
        >
          {mineFor === listing.id ? "mining" : "mine for this"}
        </button>
      </div>

      <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile label="rank" value={listing.rank ? `#${listing.rank}` : "in the queue"} />
        <StatTile label="points" value={points(score)} />
        <StatTile label="shares" value={fmt(shares)} />
        <StatTile
          label="mining now"
          value={liveEntry?.miners ? `${liveEntry.miners} · ${fmt(liveEntry.hashrate)} H/s` : "0"}
        />
      </div>

      {!listing.visible && (
        <div className="mt-4 rounded border border-dashed border-zinc-800 p-4 text-sm text-zinc-500">
          Still short of the board: {shares} of {board.threshold} shares.
          <div className="mt-2 h-1 w-full overflow-hidden rounded bg-zinc-800">
            <div
              className="h-full bg-emerald-700"
              style={{ width: `${Math.min(100, (shares / board.threshold) * 100)}%` }}
            />
          </div>
        </div>
      )}

      <section className="mt-8">
        <h2 className="mb-3 text-sm uppercase tracking-widest text-zinc-500">Share it</h2>
        <div className="flex flex-wrap gap-2">
          <a
            href={`https://x.com/intent/tweet?text=${encodeURIComponent(shareText)}&url=${encodeURIComponent(pageUrl)}`}
            target="_blank"
            rel="noopener"
            className="rounded bg-zinc-100 px-3 py-1.5 text-xs font-semibold text-black hover:bg-white"
          >
            post on X
          </a>
          <button
            onClick={() => {
              navigator.clipboard?.writeText(badgeMarkdown).then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 2000);
              }).catch(() => {/* clipboard is blocked; the snippet is on screen anyway */});
            }}
            className="rounded border border-zinc-700 px-3 py-1.5 text-xs hover:bg-zinc-800"
          >
            {copied ? "copied" : "copy badge markdown"}
          </button>
        </div>
        <img src={apiUrl(`/badge/${id}.svg`)} alt="" className="mt-3 h-5" />
        <pre className="mt-2 overflow-x-auto rounded border border-zinc-800 bg-black/40 p-3 text-[10px] text-zinc-500">
          {badgeMarkdown}
        </pre>
      </section>
    </article>
  );
}

