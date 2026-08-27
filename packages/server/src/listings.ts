import { ICON_MAX_PX, POINT_SCALE } from "@outmine/protocol";
import { config } from "./config";
import { db, type Listing } from "./db";
import { blockedWord, cleanText, secretsMatch } from "./security";

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
const PUBLIC_COLUMNS =
  "id, kind, target, name, tagline, created_at, visible, clicks, shares, score, icon IS NOT NULL AS has_icon";

export class TargetError extends Error {}

/** A wrong secret, as opposed to a malformed request. A subclass so every existing
 *  `instanceof TargetError` catch still holds; routes.ts checks for this one first, to
 *  answer 401 rather than 400 and to log it. Guessing an edit token used to be
 *  indistinguishable from a typo in a name, in the response and in the access log. */
export class AuthError extends TargetError {}

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

  // The host is bounded by the regex above; the path is not, so it is capped here -
  // otherwise a listing carries however long a path the sender chose into every row
  // that renders it.
  return (host + url.pathname.replace(/\/+$/, "")).slice(0, 200);
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
  return refused(name, "name");
}

const checkedTagline = (raw: string) =>
  refused(cleanText(raw).slice(0, config.board.maxTaglineLength), "tagline");

/** Both fields go on the public board, into the rasterised share card and into the
 *  <title> of a page people post elsewhere. Checked after truncation, so a word cannot
 *  be smuggled past the ceiling by padding in front of it. */
function refused(value: string, field: string): string {
  const word = blockedWord(value);
  if (word) throw new TargetError(`${field} contains a word this board does not take`);
  return value;
}

type CreateResult = { listing: Listing; editToken: string };

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

/** The listing, if this token is the one it was created with. Every owner-only write
 *  goes through here so there is one place the comparison is constant-time. */
function owned(id: string, editToken: string): Listing {
  const row = db
    .query<{ edit_token_hash: string }, [string]>(`SELECT edit_token_hash FROM listings WHERE id = ?`)
    .get(id);
  if (!row) throw new TargetError("no such listing");
  if (!secretsMatch(row.edit_token_hash, hashToken(editToken))) throw new AuthError("bad edit token");
  return getListing(id)!;
}

/** `unknown` rather than `string`, because the caller is a JSON body. Declaring the
 *  fields as strings did not make them strings: a `Record<string, unknown>` satisfies
 *  that signature - TypeScript does not narrow through an index signature - so
 *  `{"name": 123}` reached `cleanText`, which iterates its argument, and the route
 *  answered 500 where it owed the sender a 400.
 *
 *  Checked here rather than in the route: this is the one door every writer goes
 *  through, tests included. */
export function updateListing(
  id: string,
  editToken: string,
  patch: { name?: unknown; tagline?: unknown },
): Listing {
  owned(id, editToken);

  if (patch.name !== undefined) {
    db.query(`UPDATE listings SET name = ? WHERE id = ?`).run(checkedName(text(patch.name, "name")), id);
  }
  if (patch.tagline !== undefined) {
    db.query(`UPDATE listings SET tagline = ? WHERE id = ?`)
      .run(checkedTagline(text(patch.tagline, "tagline")), id);
  }
  return getListing(id)!;
}

const text = (value: unknown, field: string): string => {
  if (typeof value !== "string") throw new TargetError(`${field} must be text`);
  return value;
};

/** Decoded and re-encoded rather than inspected, so the bytes that reach the row are the
 *  ones our own encoder wrote. Nothing rides along in an ancillary chunk, and a file that
 *  only looks like an image from its header no longer gets served from our own origin.
 *
 *  Any raster format Bun reads is taken and normalised. SVG is not one of them, which is
 *  the point: it is a document with scripts in it and this one would be same-origin.
 *
 *  maxPixels is the decompression-bomb guard and is checked before the decode, so a few
 *  hundred bytes on the wire cannot ask for gigabytes of pixels.
 *
 *  Both WebP encoders run because neither wins twice. A flat logo - the common case -
 *  goes to a third of PNG losslessly, and lossy would only fray its edges. A photograph
 *  goes the other way: lossless barely beats PNG, quality 90 is six times smaller. */
export async function checkedIcon(bytes: Uint8Array): Promise<Uint8Array> {
  if (bytes.length > config.limits.maxIconBytes) throw new TargetError("icon too large");

  // One Image per encoder rather than one pipeline used twice: the pipeline is mutable,
  // and sharing it makes the second webp() hand back the first one's bytes without an
  // error, which turns the comparison below into a coin flip.
  const fitted = () =>
    new Bun.Image(bytes, { maxPixels: ICON_MAX_PX ** 2 })
      .resize(ICON_MAX_PX, ICON_MAX_PX, { fit: "inside", withoutEnlargement: true });

  let lossless: Uint8Array;
  let lossy: Uint8Array;
  try {
    [lossless, lossy] = await Promise.all([
      fitted().webp({ lossless: true }).bytes(),
      fitted().webp({ quality: 90 }).bytes(),
    ]);
  } catch {
    // Names the formats the picker offers rather than everything Bun happens to read:
    // this line is the only feedback someone uploading an SVG by hand ever gets.
    throw new TargetError(
      `icon must be a png, jpeg, webp or gif of at most ${ICON_MAX_PX}x${ICON_MAX_PX}`,
    );
  }
  return lossless.length <= lossy.length ? lossless : lossy;
}

/** Replaces a listing's icon. Gated on points as well as on the token: the token only
 *  says whose listing it is, and an icon is the loudest thing on a row. */
export async function setIcon(
  id: string,
  editToken: string,
  bytes: Uint8Array,
): Promise<Listing> {
  const listing = owned(id, editToken);
  if (listing.score * POINT_SCALE < config.board.iconMinPoints) {
    throw new TargetError(`an icon unlocks at ${config.board.iconMinPoints} points`);
  }

  const icon = await checkedIcon(bytes);
  db.query(`UPDATE listings SET icon = ? WHERE id = ?`).run(icon, id);
  return getListing(id)!;
}

/** The bytes, selected on their own so no other query ever carries them. */
export const getIcon = (id: string): Uint8Array | null =>
  db.query<{ icon: Uint8Array | null }, [string]>(`SELECT icon FROM listings WHERE id = ?`)
    .get(id)?.icon ?? null;

export const getListing = (id: string) =>
  db.query<Listing, [string]>(`SELECT ${PUBLIC_COLUMNS} FROM listings WHERE id = ?`).get(id);

export const deleteListing = (id: string) => db.query(`DELETE FROM listings WHERE id = ?`).run(id);

export const listingExists = (id: string) =>
  db.query(`SELECT 1 FROM listings WHERE id = ?`).get(id) !== null;

/** One outbound click. Counted here rather than in the route so every statement that
 *  touches this table lives in one file. */
export const countClick = (id: string) =>
  db.query(`UPDATE listings SET clicks = clicks + 1 WHERE id = ?`).run(id);

/** 12 hex characters, 48 bits. The previous 8 gave a coin-flip chance of collision
 *  around 77k listings, which is inside the range a board like this could reach. */
const newListingId = () => crypto.randomUUID().replaceAll("-", "").slice(0, 12);

/** The token is a 122-bit random UUID, so a plain digest is enough; there is nothing
 *  to brute force and no need for a password KDF. */
const hashToken = (token: string) =>
  new Bun.CryptoHasher("sha256").update(token).digest("hex");

// --- the board ---------------------------------------------------------------------

export type BoardWindow = "all" | "24h";

export type BoardQuery = {
  /** "24h" scores a listing by what was mined for it in the last day instead of since
   *  it was created. Without it the board settles: a listing from launch week can sit
   *  on top forever while nobody mines for it any more. */
  window?: BoardWindow;
  q?: string;
  offset?: number;
  limit?: number;
  /** 1 is the board, 0 is the queue waiting on the proof-of-work gate. A search that
   *  covered only the board would hide exactly the listings that most need someone to
   *  find them and mine for them. */
  visible?: 0 | 1;
};

export type BoardPage = { rows: Listing[]; total: number };

/** How each list is ranked, written once.
 *
 *  The board goes by score with ties to the older entry; the queue by how close it is
 *  to the gate, because sorting newcomers by score would pile them all at the bottom
 *  in one indistinguishable block. `listingRank` below reuses the board rule - a rank
 *  that disagreed with the list it labels would be worse than no rank.
 *
 *  Unqualified on purpose. In the 24h query `score` and `shares` are aggregate
 *  aliases, which SQLite resolves ahead of the table's own columns; in the plain query
 *  there is only one table and nothing to be ambiguous about. */
const ORDER = {
  board: "score DESC, created_at ASC",
  queue: "shares DESC, created_at DESC",
} as const;

const PREFIXED_COLUMNS = PUBLIC_COLUMNS.split(", ").map((column) => `l.${column}`).join(", ");

/** LIKE treats % and _ as wildcards, so a search for "%" would match every row and a
 *  search for a literal underscore would match any character. SQLite has no built-in
 *  quoting for this; the pattern is escaped by hand and the query declares the escape
 *  character.
 *
 *  Exported only so the escaping has a test of its own: the board queries need a
 *  database and this is the part that goes wrong silently. */
export const likePattern = (q: string) => `%${q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;

/** What a board query binds. Spelled out because the queries are assembled from the
 *  pieces above, so nothing else would catch a placeholder that lost its parameter. */
type FilterParams = { $visible: number; $pattern?: string };
type BoardParams = FilterParams & { $limit: number; $offset: number };

/** The WHERE every board query shares, with the parameters it binds. */
function boardFilter(query: BoardQuery) {
  const visible = query.visible ?? 1;
  const search = (query.q ?? "").trim();
  const pattern = search ? likePattern(search) : null;

  const where = pattern
    ? `l.visible = $visible AND (l.name LIKE $pattern ESCAPE '\\' OR l.target LIKE $pattern ESCAPE '\\')`
    : `l.visible = $visible`;

  return {
    visible,
    where,
    params: { $visible: visible, ...(pattern ? { $pattern: pattern } : {}) },
  };
}

/** Rows only. Paired with `countBoard` where the count is wanted, so neither path
 *  pays for work it does not use. */
export function listBoard(query: BoardQuery = {}): Listing[] {
  const { visible, where, params } = boardFilter(query);
  const order = visible === 1 ? ORDER.board : ORDER.queue;

  const ceiling = visible === 1 ? config.board.entries : config.board.pendingEntries;
  const limit = Math.min(Math.max(query.limit ?? ceiling, 1), config.board.entries);
  const page = { ...params, $limit: limit, $offset: Math.max(query.offset ?? 0, 0) };

  if (query.window === "24h") {
    // One row per listing either way: the LEFT JOIN fans out over buckets and the
    // GROUP BY folds them back, so the count below still describes this same set.
    const since = Math.floor(Date.now() / 3_600_000) - 23;
    return db.query<Listing, [BoardParams & { $since: number }]>(
      `SELECT l.id, l.kind, l.target, l.name, l.tagline, l.created_at, l.visible, l.clicks,
              l.icon IS NOT NULL AS has_icon,
              COALESCE(SUM(b.shares), 0) AS shares,
              COALESCE(SUM(b.diff_sum), 0) AS score
       FROM listings l
       LEFT JOIN share_buckets b ON b.listing_id = l.id AND b.hour >= $since
       WHERE ${where}
       GROUP BY l.id
       ORDER BY ${order}
       LIMIT $limit OFFSET $offset`,
    ).all({ ...page, $since: since });
  }

  return db.query<Listing, [BoardParams]>(
    `SELECT ${PREFIXED_COLUMNS} FROM listings l WHERE ${where}
     ORDER BY ${order}
     LIMIT $limit OFFSET $offset`,
  ).all(page);
}

/** How many listings match a filter. An index-only count over the same WHERE the
 *  rows use, which is what tells a client whether another page exists. */
export function countBoard(query: BoardQuery = {}): number {
  const { where, params } = boardFilter(query);
  const { n } = db.query<{ n: number }, [FilterParams]>(
    `SELECT COUNT(*) AS n FROM listings l WHERE ${where}`,
  ).get(params)!;
  return n;
}

/** Rows plus the count, for the API, which answers both in one response. */
export function searchBoard(query: BoardQuery = {}): BoardPage {
  return { rows: listBoard(query), total: countBoard(query) };
}

/** Where a listing sits on the all-time board. */
export function listingRank(listing: Pick<Listing, "score" | "created_at">): number {
  const { n } = db.query<{ n: number }, [{ $score: number; $created: number }]>(
    `SELECT COUNT(*) AS n FROM listings
     WHERE visible = 1 AND (score > $score OR (score = $score AND created_at < $created))`,
  ).get({ $score: listing.score, $created: listing.created_at })!;
  return n + 1;
}

/** What has been mined for recently, which is a different question from who is on top. */
export const trending = (hours = 2, limit = config.board.trendingEntries) =>
  db.query<TrendingRow, [number, number]>(
    `SELECT l.id, l.name, l.target, l.icon IS NOT NULL AS has_icon, SUM(b.diff_sum) AS recent
     FROM share_buckets b JOIN listings l ON l.id = b.listing_id
     WHERE b.hour >= ? AND l.visible = 1
     GROUP BY l.id ORDER BY recent DESC LIMIT ?`,
  ).all(Math.floor(Date.now() / 3_600_000) - (hours - 1), limit);

type TrendingRow = {
  id: string; name: string; target: string; has_icon: number; recent: number;
};

/** Everything the site has ever accumulated, for the public stats page. */
export function boardTotals() {
  const totals = db.query<
    { listings: number; onBoard: number; shares: number; score: number; clicks: number },
    []
  >(
    `SELECT COUNT(*) AS listings, COALESCE(SUM(visible), 0) AS onBoard,
            COALESCE(SUM(shares), 0) AS shares, COALESCE(SUM(score), 0) AS score,
            COALESCE(SUM(clicks), 0) AS clicks
     FROM listings`,
  ).get()!;

  const since = Math.floor(Date.now() / 3_600_000) - 23;
  const { shares24h } = db.query<{ shares24h: number }, [number]>(
    `SELECT COALESCE(SUM(shares), 0) AS shares24h FROM share_buckets WHERE hour >= ?`,
  ).get(since)!;

  return { ...totals, shares24h };
}

// --- crediting ---------------------------------------------------------------------

export type ShareBatch = readonly (readonly [string, { shares: number; diffSum: number }])[];

/** Writes a round of accepted shares and flips anything that has cleared the gate.
 *
 *  One transaction: a partial write would credit the hourly bucket without the running
 *  total, or the other way round, and the two would never agree again. Returns the
 *  listings that just became visible so the caller can announce them - the feed and the
 *  log belong to the hub, the SQL belongs here. */
export function creditShares(batch: ShareBatch): { id: string; name: string }[] {
  const hour = Math.floor(Date.now() / 3_600_000);
  const passed: { id: string; name: string }[] = [];

  db.transaction(() => {
    for (const [id, acc] of batch) {
      db.query(
        `INSERT INTO share_buckets (listing_id, hour, shares, diff_sum) VALUES (?, ?, ?, ?)
         ON CONFLICT (listing_id, hour) DO UPDATE SET
           shares = shares + excluded.shares, diff_sum = diff_sum + excluded.diff_sum`,
      ).run(id, hour, acc.shares, acc.diffSum);

      db.query(`UPDATE listings SET shares = shares + ?, score = score + ? WHERE id = ?`)
        .run(acc.shares, acc.diffSum, id);

      const row = db
        .query<{ name: string; shares: number; visible: number }, [string]>(
          `SELECT name, shares, visible FROM listings WHERE id = ?`,
        )
        .get(id);
      if (row && !row.visible && row.shares >= config.board.visibilityThreshold) {
        db.query(`UPDATE listings SET visible = 1 WHERE id = ?`).run(id);
        passed.push({ id, name: row.name });
      }
    }
  })();

  return passed;
}

// --- traffic ------------------------------------------------------------------------
// What the site gets asked for, counted as it is asked. Aggregates only: a day, a kind
// and a key, and nothing anywhere that says who - no address, no cookie, no per-request
// row that could be joined back into one.

const today = () => Math.floor(Date.now() / 86_400_000);

/** One hit. The primary key does the aggregating, so there is nothing to flush and no
 *  event log to prune later.
 *
 *  ponytail: one write per pageview. SQLite in WAL takes thousands a second and this
 *  board will not; if it ever does, buffer it the way the hub buffers shares. */
export const countHit = (kind: string, key = "") =>
  db.query(
    `INSERT INTO traffic (day, kind, key, n) VALUES (?, ?, ?, 1)
     ON CONFLICT (day, kind, key) DO UPDATE SET n = n + 1`,
  ).run(today(), kind, key);

/** The referrer hosts already counted today. Read once a day by the hub, which admits
 *  a bounded number of new ones and folds the rest together - see refKey there. */
export const refKeysToday = (): string[] =>
  db.query<{ key: string }, [number]>(
    `SELECT key FROM traffic WHERE kind = 'ref' AND day = ?`,
  ).all(today()).map((r) => r.key);

export type TrafficDay = {
  day: number; visits: number; pages: number; views: number; mines: number;
};

/** One row per day with the kinds pivoted into columns, so the report is a loop over
 *  this rather than four queries stitched together by hand. */
export const trafficByDay = (days = 30): TrafficDay[] =>
  db.query<TrafficDay, [number]>(
    `SELECT day,
            COALESCE(SUM(n) FILTER (WHERE kind = 'visit'), 0)   AS visits,
            COALESCE(SUM(n) FILTER (WHERE kind = 'page'), 0)    AS pages,
            COALESCE(SUM(n) FILTER (WHERE kind = 'listing'), 0) AS views,
            COALESCE(SUM(n) FILTER (WHERE kind = 'mine'), 0)    AS mines
     FROM traffic WHERE day >= ?
     GROUP BY day ORDER BY day DESC`,
  ).all(today() - (days - 1));

/** The busiest keys of one kind - referrer hosts, paths. */
export const trafficTop = (kind: string, days = 30, limit = 20) =>
  db.query<{ key: string; n: number }, [string, number, number]>(
    `SELECT key, SUM(n) AS n FROM traffic WHERE kind = ? AND day >= ?
     GROUP BY key ORDER BY n DESC LIMIT ?`,
  ).all(kind, today() - (days - 1), limit);

/** Views per listing beside the outbound clicks that listing has earned. A listing
 *  taken down since is dropped rather than shown as a bare id: the join is the filter.
 *  `clicks` is all-time - the column is a running total and was never bucketed by day. */
export const trafficListings = (days = 30, limit = 20) =>
  db.query<{ id: string; name: string; views: number; clicks: number }, [number, number]>(
    `SELECT l.id, l.name, SUM(t.n) AS views, l.clicks
     FROM traffic t JOIN listings l ON l.id = t.key
     WHERE t.kind = 'listing' AND t.day >= ?
     GROUP BY l.id ORDER BY views DESC LIMIT ?`,
  ).all(today() - (days - 1), limit);

/** The one traffic number that is public, on /stats with everything else. */
export const visitsToday = (): number =>
  db.query<{ n: number }, [number]>(
    `SELECT COALESCE(SUM(n), 0) AS n FROM traffic WHERE kind = 'visit' AND day = ?`,
  ).get(today())!.n;
