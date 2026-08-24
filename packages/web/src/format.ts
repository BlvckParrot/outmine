// Display helpers. The number formatting itself lives in @outmine/protocol, because
// the server prints the same scores onto the share card and the two used to disagree.
export { compact as fmt, points } from "@outmine/protocol";

/** A stable colour per listing, so a row is recognisable before it is read. Derived
 *  from the target rather than the name, which the owner can edit. */
export const colorOf = (s: string) => {
  let h = 0;
  for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return `oklch(0.55 0.16 ${h})`;
};
