import { config } from "./config";
import { db, type Listing } from "./db";
import { cleanText, secretsMatch } from "./security";

// Rule borrowed from outbid.lol: the board links to the real thing, not to a
// tracker. Query strings are stripped, link shorteners are refused.
const SHORTENERS = new Set([
  "bit.ly", "t.co", "tinyurl.com", "goo.gl", "ow.ly", "buff.ly", "is.gd",
  "amzn.to", "rebrand.ly", "cutt.ly", "shorturl.at", "rb.gy", "lnkd.in",
]);
const HANDLE_HOSTS = new Set(["x.com", "www.x.com", "twitter.com", "www.twitter.com"]);

/** Columns safe to hand to a client. Never `SELECT *`: that table also holds
 *  edit_token_hash, and the Listing type does not mention it, so a leak through a
 *  route would typecheck cleanly and go unnoticed. */
const PUBLIC_COLUMNS = "id, kind, target, name, tagline, created_at, visible, clicks, shares, score";

export class TargetError extends Error {}

export function normalizeTarget(kind: "domain" | "handle", raw: string): string {
  const input = raw.trim();
  if (!input) throw new TargetError("empty target");
  return kind === "handle" ? normalizeHandle(input) : normalizeDomain(input);
}

function normalizeHandle(input: string): string {
  // Accept a bare handle, an @handle, or a link to the profile.
  let handle = input;
  if (/^https?:\/\//i.test(input)) {
    const url = parseUrl(input);
    if (!HANDLE_HOSTS.has(url.hostname.toLowerCase())) throw new TargetError("not an x.com profile");
    handle = url.pathname.replace(/^\/+/, "");
  }
  handle = handle.replace(/^@/, "").toLowerCase();
  if (!/^[a-z0-9_]{1,15}$/.test(handle)) throw new TargetError("invalid handle");
  return handle;
}

function normalizeDomain(input: string): string {
  // No separate affiliate rule: dropping the query string below already removes every
  // ?tag=/?ref= tracker. Shorteners are the only case stripping cannot fix, because
  // the tracking lives in the redirect rather than the URL.
  const url = parseUrl(/^https?:\/\//i.test(input) ? input : `https://${input}`);
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  if (SHORTENERS.has(host)) throw new TargetError("link shortener");
  // A public listing needs a public name: at least one dot, no bare hosts or IPs.
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host)) throw new TargetError("invalid domain");
  if (/^\d+(\.\d+)*$/.test(host)) throw new TargetError("invalid domain");

  return host + url.pathname.replace(/\/+$/, "");
}

function parseUrl(candidate: string): URL {
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new TargetError("invalid url");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new TargetError("invalid protocol");
  return url;
}

function checkedName(raw: string): string {
  const name = cleanText(raw).slice(0, config.board.maxNameLength);
  // cleanText can empty a string that looked non-empty: a name of pure zero-width
  // characters would render as a blank row on the board.
  if (!name) throw new TargetError("name required");
  return name;
}

const checkedTagline = (raw: string) => cleanText(raw).slice(0, config.board.maxTaglineLength);

export type CreateResult = { listing: Listing; editToken: string };

export function createListing(input: {
  kind: "domain" | "handle";
  target: string;
  name: string;
  tagline?: string;
}): CreateResult {
  if (input.kind !== "domain" && input.kind !== "handle") throw new TargetError("invalid kind");

  const target = normalizeTarget(input.kind, input.target);
  const name = checkedName(input.name);
  const tagline = checkedTagline(input.tagline ?? "");
  const editToken = crypto.randomUUID();
  const tokenHash = hashToken(editToken);

  const insert = db.query(
    `INSERT INTO listings (id, kind, target, name, tagline, created_at, edit_token_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );

  // Two different UNIQUE constraints live on this table. A duplicate target is the
  // user's problem; a duplicate id is ours, and retrying is the fix. Telling a user
  // "already listed" because two random ids collided would be a lie.
  for (let attempt = 0; attempt < 5; attempt++) {
    const id = newListingId();
    try {
      insert.run(id, input.kind, target, name, tagline, Date.now(), tokenHash);
      return { listing: getListing(id)!, editToken };
    } catch (err) {
      const message = String(err);
      if (!message.includes("UNIQUE")) throw err;
      if (message.includes("listings.target")) throw new TargetError("already listed");
      // otherwise: id collision, try another
    }
  }
  throw new Error("could not allocate a listing id");
}

export function updateListing(
  id: string,
  editToken: string,
  patch: { name?: string; tagline?: string },
): Listing {
  const row = db.query(`SELECT edit_token_hash FROM listings WHERE id = ?`).get(id) as
    | { edit_token_hash: string }
    | null;
  if (!row) throw new TargetError("no such listing");
  if (!secretsMatch(row.edit_token_hash, hashToken(editToken))) throw new TargetError("bad edit token");

  if (patch.name !== undefined) {
    db.query(`UPDATE listings SET name = ? WHERE id = ?`).run(checkedName(patch.name), id);
  }
  if (patch.tagline !== undefined) {
    db.query(`UPDATE listings SET tagline = ? WHERE id = ?`).run(checkedTagline(patch.tagline), id);
  }
  return getListing(id)!;
}

export const getListing = (id: string) =>
  db.query(`SELECT ${PUBLIC_COLUMNS} FROM listings WHERE id = ?`).get(id) as Listing | null;

export const deleteListing = (id: string) => db.query(`DELETE FROM listings WHERE id = ?`).run(id);

export const getBoard = (limit = config.board.entries) =>
  db.query(
    `SELECT ${PUBLIC_COLUMNS} FROM listings WHERE visible = 1
     ORDER BY score DESC, created_at ASC LIMIT ?`,
  ).all(limit) as Listing[];

/** Listings still short of the gate. They must stay discoverable, otherwise nobody
 *  can mine them onto the board and the gate becomes a wall. */
export const getPending = (limit = config.board.pendingEntries) =>
  db.query(
    `SELECT ${PUBLIC_COLUMNS} FROM listings WHERE visible = 0
     ORDER BY shares DESC, created_at DESC LIMIT ?`,
  ).all(limit) as Listing[];

export const listingExists = (id: string) =>
  db.query(`SELECT 1 FROM listings WHERE id = ?`).get(id) !== null;

/** 12 hex characters, 48 bits. The previous 8 gave a coin-flip chance of collision
 *  around 77k listings, which is inside the range a board like this could reach. */
const newListingId = () => crypto.randomUUID().replaceAll("-", "").slice(0, 12);

/** The token is a 122-bit random UUID, so a plain digest is enough; there is nothing
 *  to brute force and no need for a password KDF. */
const hashToken = (token: string) =>
  new Bun.CryptoHasher("sha256").update(token).digest("hex");


// --- board pages ----------------------------------------------------------------

export type BoardWindow = "all" | "24h";

export type BoardQuery = {
  /** "24h" scores a listing by what was mined for it in the last day instead of
   *  since it was created. Without it the board settles: a listing from launch week
   *  can sit on top forever while nobody mines for it any more. */
  window?: BoardWindow;
  q?: string;
  offset?: number;
  limit?: number;
  /** 1 is the board, 0 is the queue waiting on the proof-of-work gate. A search that
   *  covered only the board would hide exactly the listings that most need someone
   *  to find them and mine for them. */
  visible?: 0 | 1;
};

export type BoardPage = { rows: Listing[]; total: number };

/** LIKE treats % and _ as wildcards, so a search for "%" would match every row and a
 *  search for a literal underscore would match any character. SQLite has no built-in
 *  quoting for this; the pattern is escaped by hand and the query declares the
 *  escape character.
 *
 *  Exported only so the escaping has a test of its own: getBoardPage needs a database
 *  and this is the part that goes wrong silently. */
export const likePattern = (q: string) => `%${q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;

/** The board, filtered and paged. `getBoard` above stays as it is: the hub broadcasts
 *  the unfiltered top of the board on a timer and has no use for any of this. */
export function getBoardPage(query: BoardQuery = {}): BoardPage {
  const limit = Math.min(Math.max(query.limit ?? config.board.entries, 1), config.board.entries);
  const offset = Math.max(query.offset ?? 0, 0);
  const search = (query.q ?? "").trim();
  const pattern = search ? likePattern(search) : null;
  const visible = query.visible ?? 1;

  const filter = pattern
    ? `AND (l.name LIKE $pattern ESCAPE '\\' OR l.target LIKE $pattern ESCAPE '\\')`
    : "";

  const { n: total } = db.query(
    `SELECT COUNT(*) AS n FROM listings l WHERE l.visible = $visible ${filter}`,
  ).get({ $visible: visible, ...(pattern ? { $pattern: pattern } : {}) }) as { n: number };

  const page = {
    $limit: limit,
    $offset: offset,
    $visible: visible,
    ...(pattern ? { $pattern: pattern } : {}),
  };

  // The queue is ranked by how close each entry is to the gate, the board by score.
  // Sorting the queue by score would put every brand new listing in one indistinct
  // block at the bottom, which is where nobody looks.
  // In the 24h branch score and shares are aggregate aliases, so they cannot carry the
  // table prefix the plain branch needs. Two strings rather than one clever one.
  const orderAggregate = visible === 1 ? "score DESC, l.created_at ASC" : "shares DESC, l.created_at DESC";
  const orderPlain = visible === 1 ? "l.score DESC, l.created_at ASC" : "l.shares DESC, l.created_at DESC";

  if (query.window === "24h") {
    // One row per listing either way: the LEFT JOIN fans out over buckets and the
    // GROUP BY folds them back, so the count above still describes this set.
    const since = Math.floor(Date.now() / 3_600_000) - 23;
    const rows = db.query(
      `SELECT l.id, l.kind, l.target, l.name, l.tagline, l.created_at, l.visible, l.clicks,
              COALESCE(SUM(b.shares), 0) AS shares,
              COALESCE(SUM(b.diff_sum), 0) AS score
       FROM listings l
       LEFT JOIN share_buckets b ON b.listing_id = l.id AND b.hour >= $since
       WHERE l.visible = $visible ${filter}
       GROUP BY l.id
       ORDER BY ${orderAggregate}
       LIMIT $limit OFFSET $offset`,
    ).all({ ...page, $since: since }) as Listing[];
    return { rows, total };
  }

  const rows = db.query(
    `SELECT ${PUBLIC_COLUMNS.split(", ").map((c) => `l.${c}`).join(", ")}
     FROM listings l WHERE l.visible = $visible ${filter}
     ORDER BY ${orderPlain}
     LIMIT $limit OFFSET $offset`,
  ).all(page) as Listing[];
  return { rows, total };
}

/** Where a listing sits on the all-time board. Ties go to the older entry, matching
 *  `getBoard`'s ordering - a rank that disagreed with the list it labels would be
 *  worse than no rank at all. */
export function listingRank(listing: Pick<Listing, "score" | "created_at">): number {
  const { n } = db.query(
    `SELECT COUNT(*) AS n FROM listings
     WHERE visible = 1 AND (score > $score OR (score = $score AND created_at < $created))`,
  ).get({ $score: listing.score, $created: listing.created_at }) as { n: number };
  return n + 1;
}
