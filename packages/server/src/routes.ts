// The HTTP surface. Socket plumbing is in server.ts, share cards and crawler tags in
// share.ts, every SQL statement in listings.ts - what is left here reads as a list of
// what the API does.
import { Hono } from "hono";
import { cors } from "hono/cors";
import type { BoardPageResponse, ListingDetail, StatsResponse, TrendingItem } from "@outmine/protocol";
import { config } from "./config";
import { dbAlive, type Listing } from "./db";
import { clientCount, connectionCount, miningCount, poolHealthy, pushFeed } from "./hub";
import {
  boardTotals, countClick, createListing, deleteListing, getListing, listingRank,
  searchBoard, TargetError, trending, updateListing,
} from "./listings";
import { log } from "./log";
import { clientAddress, originAllowed, secretsMatch } from "./security";
import { OG_MARKER, origin, share, siteMeta } from "./share";

/** Handed in by server.ts, which is the only layer that can see the socket. */
export type RequestContext = { socketAddress?: string };

export const app = new Hono<{ Bindings: RequestContext }>();

app.use("/api/*", cors({
  origin: (origin, c) => (originAllowed(origin, c.req.url) ? origin : null),
  allowHeaders: ["content-type", "x-edit-token", "x-admin-token"],
  allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
}));

app.onError((err, c) => {
  // Errors are logged with detail and answered without: an internal message can name
  // a table, a path or a query.
  log("request_failed", { path: new URL(c.req.url).pathname, error: String(err) });
  return c.json({ error: "internal error" }, 500);
});

app.get("/health", (c) => {
  if (!dbAlive()) {
    log("health_check_failed", {});
    return c.json({ ok: false }, 503);
  }
  return c.json({
    ok: true,
    clients: clientCount(),
    poolConnections: connectionCount(),
    poolHealthy: poolHealthy(),
  });
});

// --- the board ---------------------------------------------------------------------

/** The board over HTTP: first paint, clients without a WebSocket, and every filtered
 *  or paged view. The socket only ever pushes the unfiltered top, so searching and
 *  paging have to come from here.
 *
 *  With no parameters the answer is what the socket would have sent, which keeps first
 *  paint and pre-existing clients unchanged. */
app.get("/api/board", (c) => {
  const params = new URL(c.req.url).searchParams;
  const window = params.get("window") === "24h" ? "24h" : "all";
  const q = params.get("q") ?? "";
  const offset = Math.max(Number(params.get("offset") ?? 0) || 0, 0);

  const board = searchBoard({ window, q, offset, visible: 1 });
  const queue = searchBoard({ window, q, visible: 0 });

  const response: BoardPageResponse = {
    entries: board.rows.map(offline),
    pending: queue.rows.map(offline),
    total: board.total,
    pendingTotal: queue.total,
    limit: config.board.entries,
    threshold: config.board.visibilityThreshold,
    online: clientCount(),
  };
  return c.json(response);
});

/** Live fields have no meaning outside the hub's own snapshot, so HTTP answers zero
 *  rather than a stale number from the last broadcast. */
const offline = (entry: Listing) => ({ ...entry, hashrate: 0, miners: 0 });

app.get("/api/trending", (c) => c.json(trending() satisfies TrendingItem[]));

/** Public counters. A site that spends other people's CPU should be able to say
 *  exactly how much it has spent; nothing here is derived or estimated. Deliberately
 *  no figure in currency - we do not know the exchange rate and a guess would read
 *  as a promise. */
app.get("/api/stats", (c) => {
  const response: StatsResponse = {
    ...boardTotals(),
    online: clientCount(),
    mining: miningCount(),
    poolConnections: connectionCount(),
  };
  return c.json(response);
});

// --- listings ----------------------------------------------------------------------

app.post("/api/listings", async (c) => {
  const address = clientAddress(c.req.raw.headers, c.env?.socketAddress);
  if (rateLimited(address)) return c.json({ error: "slow down" }, 429);

  const body = await readJsonBody(c.req.raw);
  if (!body) return c.json({ error: "invalid json" }, 400);

  try {
    const { listing, editToken } = createListing({
      // createListing rejects anything that is not "domain" or "handle"; the cast only
      // gets the unknown past the type checker so that check stays the single gate.
      kind: body.kind as "domain" | "handle",
      target: String(body.target ?? ""),
      name: String(body.name ?? ""),
      tagline: String(body.tagline ?? ""),
    });
    pushFeed(`${listing.name} joined and needs hashes`);
    log("listing_created", { id: listing.id, target: listing.target });
    // The edit token is returned once here and only its hash is stored.
    return c.json({ listing, editToken }, 201);
  } catch (err) {
    if (err instanceof TargetError) return c.json({ error: err.message }, 400);
    throw err;
  }
});

app.patch("/api/listings/:id", async (c) => {
  const token = c.req.header("x-edit-token");
  if (!token) return c.json({ error: "missing edit token" }, 401);

  const body = await readJsonBody(c.req.raw);
  if (!body) return c.json({ error: "invalid json" }, 400);

  try {
    return c.json(updateListing(c.req.param("id"), token, body));
  } catch (err) {
    if (err instanceof TargetError) return c.json({ error: err.message }, 400);
    throw err;
  }
});

/** Takedown. The board is public and the reference site bans adult content; without
 *  this the only remedy is editing SQLite by hand. */
app.delete("/api/listings/:id", (c) => {
  const offered = c.req.header("x-admin-token") ?? "";
  if (!config.security.adminToken || !secretsMatch(config.security.adminToken, offered)) {
    return c.json({ error: "unauthorized" }, 401);
  }

  const id = c.req.param("id");
  const listing = getListing(id);
  if (!listing) return c.json({ error: "not found" }, 404);

  deleteListing(id);
  log("listing_removed", { id, target: listing.target });
  return c.json({ removed: id });
});

app.get("/api/listings/:id", (c) => {
  const listing = getListing(c.req.param("id"));
  if (!listing) return c.json({ error: "not found" }, 404);
  const detail: ListingDetail = {
    ...listing,
    rank: listing.visible ? listingRank(listing) : null,
  };
  return c.json(detail);
});

app.get("/r/:id", (c) => {
  const listing = getListing(c.req.param("id"));
  if (!listing) return c.notFound();
  countClick(listing.id);
  const url = listing.kind === "handle" ? `https://x.com/${listing.target}` : `https://${listing.target}`;
  // Paid placement, so the link must not read as an endorsement to a crawler. The
  // page-level rel=sponsored covers the anchor; this covers the hop itself, which a
  // crawler can reach directly from a shared URL.
  c.header("X-Robots-Tag", "noindex, nofollow");
  return c.redirect(url, 302);
});

// --- pages -------------------------------------------------------------------------

// /l/:id, the badge and the cards. Mounted before the catch-all, which would otherwise
// answer /l/:id first and hand a crawler the generic tags.
app.route("/", share);

// Everything else is the built frontend, with index.html as the fallback.
app.get("*", async (c) => {
  const path = new URL(c.req.url).pathname;
  const file = Bun.file(`${config.webDist}${path === "/" ? "/index.html" : path}`);
  if (path !== "/" && (await file.exists())) return new Response(file);

  const index = Bun.file(`${config.webDist}/index.html`);
  if (!(await index.exists())) return c.text("frontend not built - run: bun run build", 503);
  return c.html((await index.text()).replace(OG_MARKER, siteMeta(origin(c))));
});

// --- plumbing ----------------------------------------------------------------------

/** Reads a bounded JSON body. Unbounded, a single request could buffer as much memory
 *  as the sender cares to send. Returns null for anything unparseable or oversized. */
async function readJsonBody(req: Request): Promise<Record<string, unknown> | null> {
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > config.limits.maxBodyBytes) return null;

  const text = await req.text().catch(() => null);
  if (text === null || text.length > config.limits.maxBodyBytes) return null;

  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Per-address sliding window, in memory. Without it a bot floods the pending list,
 *  which is public and ordered so a flood pushes the real entries off the end. */
const RATE_WINDOW_MS = 60_000;
const rateBuckets = new Map<string, number[]>();

function rateLimited(address: string): boolean {
  const now = Date.now();
  const hits = (rateBuckets.get(address) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  hits.push(now);

  // Deleted before being set again, which moves the address to the end of the Map.
  // Plain `set` on an existing key leaves it where it was, so insertion order was
  // first-seen order and the eviction below dropped whoever arrived first rather than
  // whoever had been quiet longest.
  rateBuckets.delete(address);
  rateBuckets.set(address, hits);

  // Map iterates in insertion order, so with the reordering above the oldest entries
  // are simply the first ones - no sort needed to find them.
  if (rateBuckets.size > config.limits.rateBuckets) {
    const excess = Math.floor(config.limits.rateBuckets / 10);
    let dropped = 0;
    for (const key of rateBuckets.keys()) {
      if (dropped++ >= excess) break;
      rateBuckets.delete(key);
    }
  }

  return hits.length > config.limits.newListingsPerMinute;
}
