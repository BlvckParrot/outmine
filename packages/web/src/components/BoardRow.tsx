import { POINT_SCALE, type BoardEntry } from "@outmine/protocol";
import { apiUrl } from "../api";
import { colorOf, fmt } from "../format";
import { linkProps } from "../router";

const Avatar = ({ entry, dim }: { entry: BoardEntry; dim?: boolean }) => (
  <span
    className={`grid size-9 shrink-0 place-items-center rounded font-bold ${dim ? "text-white/70" : "text-white"}`}
    style={{ background: colorOf(entry.target) }}
  >
    {entry.name[0]?.toUpperCase()}
  </span>
);

export function BoardRow(props: { entry: BoardEntry; rank: number; onMine: () => void; mining: boolean }) {
  const { entry } = props;
  return (
    <li className="flex items-center gap-3 rounded border border-zinc-800 bg-zinc-900/40 p-3">
      <a {...linkProps(`/l/${entry.id}`)} className="w-8 shrink-0 text-right text-zinc-500 hover:text-zinc-300">
        #{props.rank}
      </a>
      <a {...linkProps(`/l/${entry.id}`)}>
        <Avatar entry={entry} />
      </a>
      <div className="min-w-0 flex-1">
        {/* Placement here is paid for in CPU time, so the outbound link is sponsored
            and says so. Without it the board is link selling as far as a crawler
            is concerned. */}
        <a
          href={apiUrl(`/r/${entry.id}`)}
          rel="sponsored nofollow noopener"
          target="_blank"
          className="truncate font-semibold text-white hover:underline"
        >
          {entry.name}
        </a>
        <p className="truncate text-xs text-zinc-500">{entry.tagline || entry.target}</p>
      </div>
      <div className="shrink-0 text-right text-xs">
        <div className="text-emerald-400">{fmt(entry.score * POINT_SCALE)} pts</div>
        <div className="text-zinc-600">
          {entry.miners > 0 && (
            <span className="text-emerald-600">
              {entry.miners} mining · {fmt(entry.hashrate)} H/s ·{" "}
            </span>
          )}
          {entry.clicks} clicks
        </div>
      </div>
      <MineButton onMine={props.onMine} mining={props.mining} />
    </li>
  );
}

export function PendingRow(props: {
  entry: BoardEntry; threshold: number; onMine: () => void; mining: boolean;
}) {
  const { entry } = props;
  return (
    <li className="flex items-center gap-3 rounded border border-dashed border-zinc-800 p-3">
      <a {...linkProps(`/l/${entry.id}`)}>
        <Avatar entry={entry} dim />
      </a>
      <div className="min-w-0 flex-1">
        <a {...linkProps(`/l/${entry.id}`)} className="truncate font-semibold text-zinc-300 hover:text-white">
          {entry.name}
        </a>
        <p className="truncate text-xs text-zinc-600">{entry.tagline || entry.target}</p>
        <div className="mt-1 h-1 w-full overflow-hidden rounded bg-zinc-800">
          <div
            className="h-full bg-emerald-700"
            style={{ width: `${Math.min(100, (entry.shares / props.threshold) * 100)}%` }}
          />
        </div>
      </div>
      <span className="shrink-0 text-xs text-zinc-600">
        {entry.shares}/{props.threshold}
      </span>
      <MineButton onMine={props.onMine} mining={props.mining} outline />
    </li>
  );
}

function MineButton(props: { onMine: () => void; mining: boolean; outline?: boolean }) {
  const style = props.outline
    ? "border border-emerald-700 text-emerald-400 hover:bg-emerald-950 disabled:opacity-50"
    : "bg-emerald-600 text-white hover:bg-emerald-500 disabled:bg-zinc-700";
  return (
    <button
      onClick={props.onMine}
      disabled={props.mining}
      className={`shrink-0 rounded px-3 py-1.5 text-xs font-semibold ${style}`}
    >
      {props.mining ? "mining" : "mine for this"}
    </button>
  );
}
