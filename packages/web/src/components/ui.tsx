// The pieces that were being written out again on every page that needed them.
import type { BoardEntry } from "@outmine/protocol";
import { apiUrl } from "../api";

/** A number with its label. The mining panel, the stats page and a listing all show
 *  grids of these; they were three copies of the same markup.
 *
 *  The value comes first in the DOM and the label second - browser-check finds a tile
 *  by its label and then reads the sibling above it. */
export const StatTile = ({ label, value, size = "md" }: {
  label: string;
  value: string;
  /** "lg" is the stats page, which has nothing else on it to compete with. */
  size?: "sm" | "md" | "lg";
}) => (
  <div className={`rounded-xl bg-muted ${size === "sm" ? "p-2" : "p-3"}`}>
    <div className={`font-mono font-bold tabular-nums ${size === "lg" ? "text-2xl" : "text-lg"}`}>
      {value}
    </div>
    <div className="mt-1 text-[10px] tracking-wider text-muted-foreground uppercase">{label}</div>
  </div>
);

const AVATAR_SIZE = {
  xs: "size-5 text-[10px]",
  md: "size-10 text-base md:size-14 md:text-xl",
  lg: "size-14 text-xl",
} as const;

/** The owner's icon once they have earned one, and until then the initial. Neutral
 *  rather than a colour per listing: with one accent in the palette, thirty tinted
 *  squares are noise. */
export const Avatar = ({ entry, size = "md", dim }: {
  entry: Pick<BoardEntry, "id" | "name" | "has_icon">;
  size?: keyof typeof AVATAR_SIZE;
  dim?: boolean;
}) => (
  <span
    className={`grid shrink-0 place-items-center overflow-hidden rounded-md bg-muted font-semibold ${
      AVATAR_SIZE[size]
    } ${dim ? "text-muted-foreground/60" : "text-muted-foreground"}`}
  >
    {entry.has_icon ? (
      // Decorative: the name is right next to it in every place this is used.
      <img src={apiUrl(`/icon/${entry.id}.png`)} alt="" className="size-full object-cover" />
    ) : (
      entry.name[0]?.toUpperCase()
    )}
  </span>
);

/** The panel shape the whole site is built out of. */
export const Card = ({ className = "", children }: {
  className?: string;
  children: React.ReactNode;
}) => (
  <section className={`rounded-2xl bg-card shadow-[var(--shadow-card)] ${className}`}>
    {children}
  </section>
);
