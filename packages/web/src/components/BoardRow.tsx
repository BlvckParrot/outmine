import type { BoardEntry } from "@outmine/protocol";
import { apiUrl } from "../api";
import { ago, fmt, plural, points } from "../format";
import { linkProps } from "../router";
import { Avatar } from "./ui";

/** The top three are cards, everything below them is a row in a table. The tint fades
 *  with the rank, so where the competition actually is stays visible at a glance. */
const TOP_STYLE = [
  "my-1.5 rounded-xl border-2 border-primary bg-primary/22 px-2.5 md:my-3 md:rounded-2xl md:px-3.5",
  "my-1.5 rounded-xl border-2 border-primary/40 bg-primary/8 px-2.5 md:my-3 md:rounded-2xl md:px-3.5",
  "my-1.5 rounded-xl border-2 border-primary/15 bg-primary/3 px-2.5 md:my-3 md:rounded-2xl md:px-3.5",
];

export function BoardRow(props: {
  entry: BoardEntry; onMine: () => void; mining: boolean;
  /** Null under a search, where "third match" is not "third on the board" and any
   *  number printed here would be a lie about the board. */
  rank: number | null;
  podium: boolean;
  /** First row under a divider, or the very first row: no hairline above it. */
  topOfBlock: boolean;
}) {
  const { entry, rank } = props;
  const top = rank !== null && props.podium ? TOP_STYLE[rank - 1] : undefined;

  return (
    <li className={top ?? `px-3 md:px-4 ${props.topOfBlock ? "" : "border-t border-border"}`}>
      <div className="flex items-center gap-2 py-2 md:gap-3 md:py-3">
        <div className="flex w-10 shrink-0 flex-col items-center gap-1.5 md:w-auto md:flex-row md:gap-3">
          {rank !== null && (
            <a
              {...linkProps(`/l/${entry.id}`)}
              className={`inline-flex min-w-7 items-center justify-center font-mono text-xs tabular-nums md:min-w-10 md:text-base ${
                top
                  ? "rounded-full bg-primary px-1.5 py-px font-semibold text-primary-foreground md:px-2 md:py-0.5"
                  : "text-muted-foreground"
              }`}
            >
              #{rank}
            </a>
          )}
          <a {...linkProps(`/l/${entry.id}`)}>
            <Avatar entry={entry} />
          </a>
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            {/* Placement here is paid for in CPU time, so the outbound link is
                sponsored and says so. Without it the board is link selling as far as
                a crawler is concerned. */}
            <a
              href={apiUrl(`/r/${entry.id}`)}
              rel="sponsored nofollow noopener"
              target="_blank"
              className="min-w-0 flex-1 truncate text-sm font-bold hover:text-primary md:text-base"
            >
              {entry.name}
            </a>
            <p className="shrink-0 font-mono text-sm font-semibold tabular-nums text-primary md:text-base">
              {points(entry.score)} pts
            </p>
          </div>
          {entry.tagline && (
            <p className="line-clamp-2 min-w-0 text-xs text-muted-foreground/70 md:text-sm">
              {entry.tagline}
            </p>
          )}
          <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-[11px] text-muted-foreground/70 md:text-xs">
            <span>{ago(entry.created_at)}</span>
            {entry.miners > 0 && (
              <span className="font-semibold text-live">
                · {entry.miners} mining · {fmt(entry.hashrate)} H/s
              </span>
            )}
            <span>· {plural(entry.clicks, "click")}</span>
          </p>
        </div>

        <MineButton onMine={props.onMine} mining={props.mining} outline={!top} />
      </div>
    </li>
  );
}

export function PendingRow(props: {
  entry: BoardEntry; threshold: number; onMine: () => void; mining: boolean;
}) {
  const { entry } = props;
  return (
    <li className="flex items-center gap-3 rounded-xl border border-dashed border-border px-3 py-2.5">
      <a {...linkProps(`/l/${entry.id}`)}>
        <Avatar entry={entry} size="xs" dim />
      </a>
      <div className="min-w-0 flex-1">
        <a {...linkProps(`/l/${entry.id}`)} className="truncate text-sm font-semibold hover:text-primary">
          {entry.name}
        </a>
        <p className="truncate text-xs text-muted-foreground/70">{entry.tagline || entry.target}</p>
        {/* The same line a row on the board gets, and the row that needs it more: this
            one is asking to be mined for. The snapshot has carried `miners` and
            `hashrate` for pending listings all along - boardSnapshot maps them through
            the same live() as the board - and this component was dropping them, so on
            a fresh install, where every listing is pending, nothing on the page ever
            said anybody was here. */}
        {entry.miners > 0 && (
          <p className="truncate text-xs font-semibold text-live">
            {entry.miners} mining · {fmt(entry.hashrate)} H/s
          </p>
        )}
        <div className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-muted">
          <div
            className="h-full bg-primary"
            style={{ width: `${Math.min(100, (entry.shares / props.threshold) * 100)}%` }}
          />
        </div>
      </div>
      <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
        {entry.shares}/{props.threshold}
      </span>
      <MineButton onMine={props.onMine} mining={props.mining} outline />
    </li>
  );
}

/** The line between "the podium" and "the rest", repeated further down so a page of
 *  fifty rows keeps telling you where you are. */
export const RankDivider = ({ after }: { after: number }) => (
  <li className="flex items-center gap-4 py-4" aria-hidden>
    <span className="h-px flex-1 bg-primary/25" />
    <span className="rounded-full border border-primary/25 bg-primary/5 px-3 py-0.5 text-xs font-semibold text-primary">
      TOP {after}
    </span>
    <span className="h-px flex-1 bg-primary/25" />
  </li>
);

/** Filled on the podium, outlined everywhere else. Fifty filled gold pills down one
 *  page turn the accent into the background. */
function MineButton(props: { onMine: () => void; mining: boolean; outline?: boolean }) {
  const style = props.outline
    ? "border border-primary/50 text-primary hover:bg-primary/10 disabled:opacity-50"
    : "bg-primary text-primary-foreground hover:bg-primary/85 disabled:opacity-50";
  return (
    <button
      onClick={props.onMine}
      disabled={props.mining}
      className={`shrink-0 cursor-pointer rounded-full px-3 py-1.5 text-xs font-bold whitespace-nowrap ${style}`}
    >
      {props.mining ? "mining" : "mine for this"}
    </button>
  );
}
