// Shared display helpers. Small enough to inline, repeated often enough not to.

/** 1234 -> "1.2k". Hashrates and scores both span several orders of magnitude and a
 *  raw number in a table column is unreadable at either end. */
export const fmt = (n: number) =>
  n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : Math.round(n).toString();

/** A stable colour per listing, so a row is recognisable before it is read. Derived
 *  from the target rather than the name, which the owner can edit. */
export const colorOf = (s: string) => {
  let h = 0;
  for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return `oklch(0.55 0.16 ${h})`;
};
