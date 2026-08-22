import { db, type Listing } from "./db";

// Rule borrowed from outbid.lol: the board links to the real thing, not to a
// tracker. Query strings are stripped, link shorteners are refused.
const SHORTENERS = new Set([
  "bit.ly", "t.co", "tinyurl.com", "goo.gl", "ow.ly", "buff.ly", "is.gd",
  "amzn.to", "rebrand.ly", "cutt.ly", "shorturl.at", "rb.gy", "lnkd.in",
]);
const HANDLE_HOSTS = new Set(["x.com", "www.x.com", "twitter.com", "www.twitter.com"]);

export class TargetError extends Error {}

export function normalizeTarget(kind: "domain" | "handle", raw: string): string {
  const input = raw.trim();
  if (!input) throw new TargetError("empty target");

  if (kind === "handle") {
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

  // No separate affiliate rule: dropping the query string below already removes
  // every ?tag=/?ref= tracker. Shorteners are the only case stripping cannot fix,
  // because the tracking lives in the redirect rather than the URL.
  const url = parseUrl(/^https?:\/\//i.test(input) ? input : `https://${input}`);
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  if (SHORTENERS.has(host)) throw new TargetError("link shortener");
  // A public listing needs a public name: at least one dot, no bare hosts or IPs.
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host)) throw new TargetError("invalid domain");
  if (/^\d+(\.\d+)*$/.test(host)) throw new TargetError("invalid domain");

  const path = url.pathname.replace(/\/+$/, "");
  return host + path;
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

// Shares needed before a listing shows up on the board. Costs a spammer the same
// currency the game runs on, so no separate anti-spam machinery is needed.
export const VISIBILITY_THRESHOLD = Number(process.env.VISIBILITY_THRESHOLD ?? 600);

export type CreateResult = { listing: Listing; editToken: string };

export function createListing(input: {
  kind: "domain" | "handle";
  target: string;
  name: string;
  tagline?: string;
}): CreateResult {
  const target = normalizeTarget(input.kind, input.target);
  const name = input.name.trim().slice(0, 60);
  if (!name) throw new TargetError("name required");
  const tagline = (input.tagline ?? "").trim().slice(0, 200);

  const id = crypto.randomUUID().slice(0, 8);
  const editToken = crypto.randomUUID();

  try {
    db.query(
      `INSERT INTO listings (id, kind, target, name, tagline, created_at, edit_token_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, input.kind, target, name, tagline, Date.now(), hashToken(editToken));
  } catch (err) {
    if (String(err).includes("UNIQUE")) throw new TargetError("already listed");
    throw err;
  }

  logEvent("listed", id, { name, target });
  return { listing: getListing(id)!, editToken };
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
  if (row.edit_token_hash !== hashToken(editToken)) throw new TargetError("bad edit token");

  if (patch.name !== undefined) {
    const name = patch.name.trim().slice(0, 60);
    if (!name) throw new TargetError("name required");
    db.query(`UPDATE listings SET name = ? WHERE id = ?`).run(name, id);
  }
  if (patch.tagline !== undefined) {
    db.query(`UPDATE listings SET tagline = ? WHERE id = ?`).run(patch.tagline.trim().slice(0, 200), id);
  }
  return getListing(id)!;
}

export const getListing = (id: string) =>
  db.query(`SELECT * FROM listings WHERE id = ?`).get(id) as Listing | null;

export const getBoard = (limit = 50) =>
  db.query(
    `SELECT id, kind, target, name, tagline, created_at, clicks, shares, score
     FROM listings WHERE visible = 1 ORDER BY score DESC, created_at ASC LIMIT ?`,
  ).all(limit) as Listing[];

/** Listings still short of the gate. They must stay discoverable, otherwise nobody
 *  can mine them onto the board and the gate becomes a wall. */
export const getPending = (limit = 20) =>
  db.query(
    `SELECT id, kind, target, name, tagline, created_at, clicks, shares, score
     FROM listings WHERE visible = 0 ORDER BY shares DESC, created_at DESC LIMIT ?`,
  ).all(limit) as Listing[];

export const logEvent = (type: string, listingId: string | null, payload: unknown = {}) =>
  db.query(`INSERT INTO events (ts, type, listing_id, payload) VALUES (?, ?, ?, ?)`)
    .run(Date.now(), type, listingId, JSON.stringify(payload));

const hashToken = (token: string) =>
  new Bun.CryptoHasher("sha256").update(token).digest("hex");
