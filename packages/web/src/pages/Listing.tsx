import { useState } from "react";
import { Gem } from "lucide-react";
import type { ListingDetail } from "@outmine/protocol";
import { apiUrl, usePolled } from "../api";
import { Avatar, Card, StatTile } from "../components/ui";
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
      <p className="mt-8 text-sm text-muted-foreground">
        Loading… if nothing appears, this listing is gone —{" "}
        <a {...linkProps("/")} className="text-primary hover:underline">back to the board</a>.
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
    <article>
      <div className="flex items-start gap-4">
        <Avatar entry={listing} size="lg" />
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-2xl font-bold tracking-[-0.02em]">{listing.name}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{listing.tagline}</p>
          <a
            href={apiUrl(`/r/${listing.id}`)}
            rel="sponsored nofollow noopener"
            target="_blank"
            className="mt-1 inline-block truncate text-xs text-primary hover:underline"
          >
            {listing.kind === "handle" ? `@${listing.target}` : listing.target} ↗
          </a>
        </div>
        <button
          onClick={() => (consented ? startMining(listing.id) : accept())}
          disabled={mineFor === listing.id}
          className="shrink-0 cursor-pointer rounded-full bg-primary px-4 py-2 text-sm font-bold text-primary-foreground transition-colors hover:bg-primary/85 disabled:opacity-50"
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
        <div className="mt-4 rounded-2xl border border-dashed border-border p-4 text-sm text-muted-foreground">
          Still short of the board: {shares} of {board.threshold} shares.
          <div className="mt-2 h-1 w-full overflow-hidden rounded-full bg-muted">
            <div
              className="h-full bg-primary"
              style={{ width: `${Math.min(100, (shares / board.threshold) * 100)}%` }}
            />
          </div>
        </div>
      )}

      <section className="mt-8">
        <h2 className="mb-3 flex items-center gap-1.5 text-sm font-semibold tracking-[-0.02em]">
          <Gem className="size-4 text-primary" /> Share it
        </h2>
        <div className="flex flex-wrap gap-2">
          <a
            href={`https://x.com/intent/tweet?text=${encodeURIComponent(shareText)}&url=${encodeURIComponent(pageUrl)}`}
            target="_blank"
            rel="noopener"
            className="rounded-full bg-foreground px-4 py-1.5 text-xs font-bold text-background transition-opacity hover:opacity-85"
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
            className="cursor-pointer rounded-full border border-border px-4 py-1.5 text-xs font-medium transition-colors hover:bg-muted"
          >
            {copied ? "copied" : "copy badge markdown"}
          </button>
        </div>
        <img src={apiUrl(`/badge/${id}.svg`)} alt="" className="mt-3 h-5" />
        <pre className="mt-2 overflow-x-auto rounded-xl bg-muted p-3 font-mono text-[10px] text-muted-foreground">
          {badgeMarkdown}
        </pre>
      </section>
    </article>
  );
}
