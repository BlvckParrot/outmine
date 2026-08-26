// The pieces that were being written out again on every page that needed them.
import type { BoardEntry } from "@outmine/protocol";
import { apiUrl } from "../api";

const TONE = { live: "text-live", destructive: "text-destructive" } as const;

/** A number with its label. The mining panel, the stats page and a listing all show
 *  grids of these; they were three copies of the same markup.
 *
 *  The value comes first in the DOM and the label second - browser-check finds a tile
 *  by its label and then reads the sibling above it. */
export const StatTile = ({ label, value, size = "md", tone }: {
  label: string;
  value: string;
  /** "lg" is the stats page, which has nothing else on it to compete with. */
  size?: "sm" | "md" | "lg";
  /** Colours the number. Only the mining panel has counters that are good or bad on
   *  their own - a share accepted is the whole point, a share rejected is a fault. */
  tone?: keyof typeof TONE;
}) => (
  <div className={`rounded-xl bg-muted ${size === "sm" ? "p-2" : "p-3"}`}>
    <div className={`font-mono font-bold tabular-nums ${size === "lg" ? "text-2xl" : "text-lg"} ${
      tone ? TONE[tone] : ""
    }`}>
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
      //
      // No width/height needed - the span above is sized by AVATAR_SIZE, so the box is
      // reserved whether or not the icon ever arrives and nothing shifts when it does.
      // lazy/async are for the board, which is fifty of these: without them fifty icon
      // requests and fifty decodes compete with the first render.
      <img
        src={apiUrl(`/icon/${entry.id}.png`)}
        alt=""
        loading="lazy"
        decoding="async"
        className="size-full object-cover"
      />
    ) : (
      entry.name[0]?.toUpperCase()
    )}
  </span>
);

/** The panel shape the whole site is built out of.
 *
 *  `role` is passed through so a card whose text changes in place - the board's empty
 *  and searching states - can be announced rather than silently swapped. */
export const Card = ({ className = "", role, children }: {
  className?: string;
  role?: string;
  children: React.ReactNode;
}) => (
  <section role={role} className={`rounded-2xl bg-card shadow-[var(--shadow-card)] ${className}`}>
    {children}
  </section>
);
