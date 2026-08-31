// Display helpers. The number formatting itself lives in @outmine/protocol, because
// the server prints the same scores onto the share card and the two used to disagree.
export { compact as fmt, points } from "@outmine/protocol";

/** Locked to English rather than the visitor's locale: every other word on the page is
 *  English, and a lone "il y a 3 heures" in an English row reads as a bug. */
const RELATIVE = new Intl.RelativeTimeFormat("en", { numeric: "always" });

/** Largest first, so the first unit the elapsed time fills is the one used. The
 *  smallest is named separately because it is also the floor when none is filled. */
const SECOND = [1_000, "second"] as const;
const UNITS = [[86_400_000, "day"], [3_600_000, "hour"], [60_000, "minute"], SECOND] as const;

/** "1 click", "2 clicks". Board rows print counts that spend most of their life at 1,
 *  and "1 clicks" on every fresh listing is the first thing a reader sees. */
export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** "20 hours ago". A listing's age says whether the top of the board is settled or
 *  still moving, which a timestamp does not. */
export function ago(at: number): string {
  const elapsed = Math.max(0, Date.now() - at);
  // Nothing under a second: "0 seconds ago" is not what a fresh row should say, and
  // the smallest unit is the fallback when no threshold is reached.
  const [per, unit] = UNITS.find(([ms]) => elapsed >= ms) ?? SECOND;
  return RELATIVE.format(-Math.max(1, Math.floor(elapsed / per)), unit);
}
