import { useState } from "react";
import { Gem } from "lucide-react";
import { apiUrl } from "../api";

/** The two things an owner can actually do with a listing: post it, or paste a badge
 *  into a README.
 *
 *  Lives here rather than on the listing page because the page is not where the urge
 *  is. Someone who has just claimed a spot is the person most likely to promote it,
 *  and what they are looking at then is OwnedPanel - which offered them a way to edit
 *  the name, copy a token and forget the whole thing, and no way to tell anyone.
 *
 *  `compact` is that panel: it is pinned above every page, so the heading, the badge
 *  preview and the snippet would follow the owner around the whole site. The listing
 *  page has the room and is where the markdown is worth reading before it is copied. */
export function ShareBox({ id, name, rank, compact }: {
  id: string;
  name: string;
  rank: number | null;
  compact?: boolean;
}) {
  const [copied, setCopied] = useState(false);

  const pageUrl = `${location.origin}/l/${id}`;
  const badgeMarkdown = `[![outmine](${location.origin}/badge/${id}.svg)](${pageUrl})`;
  const shareText = rank
    ? `${name} is #${rank} on outmine — a leaderboard paid for in CPU time, not money.`
    : `${name} needs hashes to reach the outmine board.`;

  const buttons = (
    <div className="flex flex-wrap gap-2">
      <a
        href={`https://x.com/intent/tweet?text=${encodeURIComponent(shareText)}&url=${encodeURIComponent(pageUrl)}`}
        target="_blank"
        rel="noopener"
        className={compact
          ? "rounded-full bg-foreground px-2.5 py-1 text-xs font-bold text-background transition-opacity hover:opacity-85"
          : "rounded-full bg-foreground px-4 py-1.5 text-xs font-bold text-background transition-opacity hover:opacity-85"}
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
        className={compact
          ? "cursor-pointer rounded-full border border-border px-2.5 py-1 text-xs font-medium transition-colors hover:bg-muted"
          : "cursor-pointer rounded-full border border-border px-4 py-1.5 text-xs font-medium transition-colors hover:bg-muted"}
      >
        {copied ? "copied" : "copy badge markdown"}
      </button>
    </div>
  );

  if (compact) return buttons;

  return (
    <section className="mt-8">
      <h2 className="mb-3 flex items-center gap-1.5 text-sm font-semibold tracking-[-0.02em]">
        <Gem className="size-4 text-primary" /> Share it
      </h2>
      {buttons}
      {/* Not decorative: the badge is a preview of what the markdown below renders
          to, and it is the only place the standing appears as an image. */}
      <img
        src={apiUrl(`/badge/${id}.svg`)}
        alt={rank ? `outmine badge: ${name} at #${rank}` : `outmine badge: ${name}, in the queue`}
        loading="lazy"
        className="mt-3 h-5"
      />
      <pre className="mt-2 overflow-x-auto rounded-xl bg-muted p-3 font-mono text-[10px] text-muted-foreground">
        {badgeMarkdown}
      </pre>
    </section>
  );
}
