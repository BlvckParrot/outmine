import { useEffect, useState } from "react";
import { POINT_SCALE, type ListingDetail } from "@outmine/protocol";
import { apiUrl } from "../api";
import { colorOf, fmt } from "../format";
import { linkProps } from "../router";
import { useSession } from "../session";

/** One listing on its own URL. This is the page a shared link points at, so it has to
 *  stand on its own: rank, score, and a way to start mining without going home first. */
export function Listing({ id }: { id: string }) {
  const { board, mineFor, startMining, consented, accept } = useSession();
  const [listing, setListing] = useState<ListingDetail | null>(null);
  const [missing, setMissing] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    setListing(null);
    setMissing(false);
    fetch(apiUrl(`/api/listings/${id}`))
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then(setListing)
      .catch(() => setMissing(true));
  }, [id]);

  // The board snapshot arrives every couple of seconds; the fetch above happens once.
  // Preferring the snapshot keeps the live numbers moving while someone mines.
  const liveEntry = [...board.entries, ...board.pending].find((e) => e.id === id);

  if (missing) {
    return (
      <p className="mt-8 rounded border border-zinc-800 p-6 text-sm text-zinc-500">
        No such listing. <a {...linkProps("/")}>Back to the board</a>.
      </p>
    );
  }
  if (!listing) return <p className="mt-8 text-sm text-zinc-500">Loading…</p>;

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
        <span
          className="grid size-14 shrink-0 place-items-center rounded text-2xl font-bold text-white"
          style={{ background: colorOf(listing.target) }}
        >
          {listing.name[0]?.toUpperCase()}
        </span>
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
        <Cell label="rank" value={listing.rank ? `#${listing.rank}` : "in the queue"} />
        <Cell label="points" value={fmt(score * POINT_SCALE)} />
        <Cell label="shares" value={fmt(shares)} />
        <Cell
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

const Cell = ({ label, value }: { label: string; value: string }) => (
  <div className="rounded border border-zinc-800 bg-zinc-900/40 p-3">
    <div className="text-lg font-bold text-white">{value}</div>
    <div className="mt-1 text-[10px] uppercase tracking-wider text-zinc-500">{label}</div>
  </div>
);
