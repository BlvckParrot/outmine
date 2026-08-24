// The two pieces that were being written out again on every page that needed them.
import type { BoardEntry } from "@outmine/protocol";
import { colorOf } from "../format";

/** A number with its label. The mining panel, the stats page and a listing all show
 *  grids of these; they were three copies of the same markup. */
export const StatTile = ({ label, value, size = "md" }: {
  label: string;
  value: string;
  /** "lg" is the stats page, which has nothing else on it to compete with. */
  size?: "sm" | "md" | "lg";
}) => (
  <div className={size === "sm" ? "rounded bg-black/30 p-2" : "rounded border border-zinc-800 bg-zinc-900/40 p-3"}>
    <div className={size === "lg" ? "text-2xl font-bold text-white" : "text-lg font-bold text-white"}>{value}</div>
    <div className="mt-1 text-[10px] uppercase tracking-wider text-zinc-500">{label}</div>
  </div>
);

/** The coloured initial that stands in for a logo. */
export const Avatar = ({ entry, size = "sm", dim }: {
  entry: Pick<BoardEntry, "target" | "name">;
  size?: "sm" | "lg";
  dim?: boolean;
}) => (
  <span
    className={[
      "grid shrink-0 place-items-center rounded font-bold",
      size === "lg" ? "size-14 text-2xl" : "size-9",
      dim ? "text-white/70" : "text-white",
    ].join(" ")}
    style={{ background: colorOf(entry.target) }}
  >
    {entry.name[0]?.toUpperCase()}
  </span>
);
