// Display helpers. The number formatting itself lives in @outmine/protocol, because
// the server prints the same scores onto the share card and the two used to disagree.
export { compact as fmt, points } from "@outmine/protocol";

const UNITS: [limit: number, per: number, name: string][] = [
  [60_000, 1_000, "second"],
  [3_600_000, 60_000, "minute"],
  [86_400_000, 3_600_000, "hour"],
  [Infinity, 86_400_000, "day"],
];

/** "20 hours ago". A listing's age says whether the top of the board is settled or
 *  still moving, which a timestamp does not. */
export function ago(at: number): string {
  const elapsed = Math.max(0, Date.now() - at);
  const [, per, name] = UNITS.find(([limit]) => elapsed < limit)!;
  const n = Math.max(1, Math.floor(elapsed / per));
  return `${n} ${name}${n === 1 ? "" : "s"} ago`;
}
