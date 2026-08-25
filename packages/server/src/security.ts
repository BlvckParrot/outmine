// Origin policy, client identification and secret comparison.
//
// Collected here rather than inline among the routes so the rules can be read - and
// tested - without reading the whole server.
import { timingSafeEqual } from "node:crypto";
import { config } from "./config";

/** Is this Origin allowed to use the API and open a mining socket?
 *
 *  A missing Origin is allowed through. Browsers always send one on a WebSocket
 *  handshake, so the guard still holds against a third-party page driving mining on
 *  its visitors' CPUs - and that is the whole threat. A script with no browser has
 *  nobody else's CPU to spend, and blocking it would only break curl and our own
 *  integration tests. */
export function originAllowed(origin: string | undefined | null, requestUrl: string): boolean {
  if (!origin) return true;

  // Same origin is always allowed. ALLOWED_ORIGINS *adds* origins - the dev server,
  // a second domain - rather than replacing this. Treating the list as the complete
  // set would mean that setting it for a dev origin and forgetting to name your own
  // domain takes the site down, which is a trap nobody deserves.
  try {
    if (new URL(origin).host === new URL(requestUrl).host) return true;
  } catch {
    return false; // an Origin that will not parse is not one we can vouch for
  }

  return config.security.allowedOrigins.includes(origin);
}

/** The address to rate limit against.
 *
 *  X-Forwarded-For is appended to by each proxy, so the rightmost entries are the ones
 *  our own infrastructure wrote and the leftmost is whatever the client claimed.
 *  Reading from the left - the obvious way - lets anyone reset their rate limit with a
 *  single forged header. With `trustedProxies: n` we count n entries back from the
 *  end; with none configured the header is ignored and the socket address is used. */
export function clientAddress(headers: Headers, socketAddress: string | undefined): string {
  const hops = config.security.trustedProxies;
  if (hops > 0) {
    const chain = (headers.get("x-forwarded-for") ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    const candidate = chain[chain.length - hops];
    if (candidate) return candidate;
  }
  return socketAddress ?? "unknown";
}

/** Compares two secrets without leaking their contents through how long it takes.
 *
 *  Both sides are hashed first so the comparison always runs over 32 bytes. Comparing
 *  the raw strings meant returning early on a length mismatch, and with no rate limit
 *  on the routes that call this - see the admin routes in routes.ts - that early
 *  return is a length oracle: it narrows the search space before guessing starts. */
export function secretsMatch(a: string, b: string): boolean {
  const digest = (value: string) => new Bun.CryptoHasher("sha256").update(value).digest();
  return timingSafeEqual(digest(a), digest(b));
}

/** The first blocked word in `value`, or null.
 *
 *  Whole-word and case-insensitive, so it catches "porn" and leaves "popcorn" alone -
 *  the Scunthorpe rule, which a substring match gets wrong on real domain names.
 *
 *  ponytail: a literal word list. It misses "p0rn" and every other spelling, and it is
 *  meant to: the admin takedown route is what actually enforces the rules, and this
 *  only keeps the unmistakable cases out of the board, the OG image and the page title
 *  in the seconds before anyone sees them. Reach for a real moderation service if this
 *  ever becomes the thing standing between the board and its reputation. */
const BLOCKED = config.security.blockedWords.length > 0
  ? new RegExp(
      `\\b(${config.security.blockedWords.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\b`,
      "i",
    )
  : null;

export const blockedWord = (value: string): string | null => BLOCKED?.exec(value)?.[0] ?? null;

/** Code point ranges with no business in text on a public board: C0 and C1 control
 *  characters, zero-width characters, and the bidirectional overrides.
 *
 *  Spelled as numeric ranges rather than a regex literal on purpose - the characters
 *  themselves are invisible in source, so a pattern containing them cannot be reviewed. */
const STRIPPED_RANGES: readonly (readonly [number, number])[] = [
  [0x0000, 0x001f], // C0 controls
  [0x007f, 0x009f], // DEL and C1 controls
  [0x200b, 0x200f], // zero-width space through right-to-left mark
  [0x202a, 0x202e], // bidirectional embedding and override
  [0x2066, 0x2069], // bidirectional isolates
];

/** Strips those characters. React escapes markup, so this is not about script
 *  injection: it is about a name that renders as a blank row, or one that reverses the
 *  text displayed around it. */
export function cleanText(value: string): string {
  let out = "";
  for (const char of value) {
    const code = char.codePointAt(0)!;
    if (STRIPPED_RANGES.some(([low, high]) => code >= low && code <= high)) continue;
    out += char;
  }
  return out.trim();
}
