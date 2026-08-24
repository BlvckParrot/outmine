// HTTP surface. Kept apart from server.ts so the routes read as a list of what the
// API does, with the socket plumbing and process lifecycle elsewhere.
import { Hono } from "hono";
import { cors } from "hono/cors";
import type { BoardPageResponse, ListingDetail, StatsResponse, TrendingItem } from "@outmine/protocol";
import { badgeSvg, cardPng, homeCardSvg, render, standing } from "./cards";
import { config } from "./config";
import { db, type Listing } from "./db";
import { clientCount, connectionCount, miningCount, poolHealthy, pushFeed } from "./hub";
import {
  createListing, deleteListing, getBoard, getBoardPage, getListing, getPending, listingRank,
  TargetError, updateListing,
} from "./listings";
import { log } from "./log";
import { clientAddress, originAllowed, secretsMatch } from "./security";

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
  try {
    db.query("SELECT 1").get();
  } catch (err) {
    log("health_check_failed", { error: String(err) });
    return c.json({ ok: false }, 503);
  }
  return c.json({
    ok: true,
    clients: clientCount(),
    poolConnections: connectionCount(),
    poolHealthy: poolHealthy(),
  });
});

/** The board over HTTP: first paint, clients without a WebSocket, and every filtered
 *  or paged view. The socket only ever pushes the unfiltered top, so searching and
 *  paging have to come from here.
 *
 *  With no parameters the answer is what it always was, which keeps first paint and
 *  the pre-existing clients unchanged. */
app.get("/api/board", (c) => {
  const url = new URL(c.req.url);
  const window = url.searchParams.get("window") === "24h" ? "24h" : "all";
  const q = url.searchParams.get("q") ?? "";
  const offset = Math.max(Number(url.searchParams.get("offset") ?? 0) || 0, 0);

  const board = getBoardPage({ window, q, offset, visible: 1 });
  // The queue is only paged alongside the board when searching. Unfiltered it is a
  // short reminder that these exist, not a second list to walk through.
  const waiting = q ? null : getPending();
  const queue = waiting
    ? { rows: waiting, total: waiting.length }
    : getBoardPage({ window, q, visible: 0, limit: config.board.pendingEntries });

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

app.get("/api/trending", (c) => {
  const since = Math.floor(Date.now() / 3_600_000) - 1;
  const items = db.query(
    `SELECT l.id, l.name, l.target, SUM(b.diff_sum) AS recent
     FROM share_buckets b JOIN listings l ON l.id = b.listing_id
     WHERE b.hour >= ? AND l.visible = 1
     GROUP BY l.id ORDER BY recent DESC LIMIT ?`,
  ).all(since, config.board.trendingEntries) as TrendingItem[];
  return c.json(items);
});

/** Public counters. A site that spends other people's CPU should be able to say
 *  exactly how much it has spent; nothing here is derived or estimated. Deliberately
 *  no figure in currency - we do not know the exchange rate and a guess would read
 *  as a promise. */
app.get("/api/stats", (c) => {
  const totals = db.query(
    `SELECT COUNT(*) AS listings, COALESCE(SUM(visible), 0) AS onBoard,
            COALESCE(SUM(shares), 0) AS shares, COALESCE(SUM(score), 0) AS score,
            COALESCE(SUM(clicks), 0) AS clicks
     FROM listings`,
  ).get() as Omit<StatsResponse, "shares24h" | "online" | "mining" | "poolConnections">;

  const since = Math.floor(Date.now() / 3_600_000) - 23;
  const { shares24h } = db.query(
    `SELECT COALESCE(SUM(shares), 0) AS shares24h FROM share_buckets WHERE hour >= ?`,
  ).get(since) as { shares24h: number };

  const response: StatsResponse = {
    ...totals,
    shares24h,
    online: clientCount(),
    mining: miningCount(),
    poolConnections: connectionCount(),
  };
  return c.json(response);
});

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
  db.query(`UPDATE listings SET clicks = clicks + 1 WHERE id = ?`).run(listing.id);
  const url = listing.kind === "handle" ? `https://x.com/${listing.target}` : `https://${listing.target}`;
  // Paid placement, so the link must not read as an endorsement to a crawler. The
  // page-level rel=sponsored covers the anchor; this covers the hop itself, which a
  // crawler can reach directly from a shared URL.
  c.header("X-Robots-Tag", "noindex, nofollow");
  return c.redirect(url, 302);
});

// --- share surfaces ---------------------------------------------------------------

/** Where a crawler will fetch our images from. Configured wins; otherwise the request
 *  itself, which is right in development and behind a proxy we control. */
const origin = (c: { req: { url: string } }) =>
  config.publicOrigin || new URL(c.req.url).origin;

const detailOf = (id: string): ListingDetail | null => {
  const listing = getListing(id);
  if (!listing) return null;
  return { ...listing, rank: listing.visible ? listingRank(listing) : null };
};

/** A shields-style badge for a README or a site footer. GitHub proxies images through
 *  its own cache, so a short max-age is what actually controls freshness. */
app.get("/badge/:id{.+\\.svg}", (c) => {
  const listing = detailOf(c.req.param("id").replace(/\.svg$/, ""));
  if (!listing) return c.notFound();
  c.header("Content-Type", "image/svg+xml; charset=utf-8");
  c.header("Cache-Control", "public, max-age=300");
  return c.body(badgeSvg(listing));
});

app.get("/og/home.png", (c) => {
  const png = render(homeCardSvg(getBoard(3)));
  c.header("Content-Type", "image/png");
  c.header("Cache-Control", "public, max-age=300");
  return c.body(png as unknown as ArrayBuffer);
});

app.get("/og/:id{.+\\.png}", (c) => {
  const listing = detailOf(c.req.param("id").replace(/\.png$/, ""));
  if (!listing) return c.notFound();
  c.header("Content-Type", "image/png");
  c.header("Cache-Control", "public, max-age=300");
  return c.body(cardPng(listing) as unknown as ArrayBuffer);
});

/** A listing's own page. The SPA renders it, but a crawler runs no JavaScript, so the
 *  per-listing tags are stitched into index.html here. Registered before the catch-all
 *  below, which would otherwise answer first with the generic tags. */
app.get("/l/:id", async (c) => {
  const index = Bun.file(`${config.webDist}/index.html`);
  if (!(await index.exists())) return c.text("frontend not built - run: bun run build", 503);

  const listing = detailOf(c.req.param("id"));
  const html = await index.text();
  return c.html(listing ? html.replace(OG_MARKER, listingMeta(listing, origin(c))) : html);
});

/** Replaced in index.html. A marker rather than a regex over the head: this runs on
 *  every crawler hit and a parse would be both slower and easier to get wrong. */
const OG_MARKER = "<!--og-->";

function listingMeta(listing: ListingDetail, site: string): string {
  // Bun.escapeHTML, not cleanText: cleanText removes invisible characters, and the
  // dangerous ones here are the perfectly visible " and < that end an attribute and
  // start a tag. A listing named `"><script>` would otherwise execute.
  const e = Bun.escapeHTML;
  const title = `${listing.name} — ${standing(listing)} on outmine`;
  const description = listing.tagline || `${listing.name} on outmine, a leaderboard paid for in CPU time.`;
  const url = `${site}/l/${listing.id}`;
  const image = `${site}/og/${listing.id}.png`;

  return [
    `<title>${e(title)}</title>`,
    `<meta name="description" content="${e(description)}" />`,
    `<meta property="og:title" content="${e(title)}" />`,
    `<meta property="og:description" content="${e(description)}" />`,
    `<meta property="og:url" content="${e(url)}" />`,
    `<meta property="og:image" content="${e(image)}" />`,
    `<meta name="twitter:card" content="summary_large_image" />`,
    `<meta name="twitter:image" content="${e(image)}" />`,
  ].join("\n    ");
}

// SPA: everything else is the built frontend, with index.html as the fallback.
app.get("*", async (c) => {
  const path = new URL(c.req.url).pathname;
  const file = Bun.file(`${config.webDist}${path === "/" ? "/index.html" : path}`);
  if (path !== "/" && (await file.exists())) return new Response(file);

  const index = Bun.file(`${config.webDist}/index.html`);
  if (!(await index.exists())) return c.text("frontend not built - run: bun run build", 503);
  return c.html((await index.text()).replace(OG_MARKER, siteMeta(origin(c))));
});

/** og:image has to be absolute, and index.html is a static file that cannot know the
 *  host it will be served from. Hence the same stitching the listing pages use. */
function siteMeta(site: string): string {
  const image = `${site}/og/home.png`;
  return [
    `<meta property="og:url" content="${Bun.escapeHTML(site)}/" />`,
    `<meta property="og:image" content="${Bun.escapeHTML(image)}" />`,
    `<meta name="twitter:image" content="${Bun.escapeHTML(image)}" />`,
  ].join("\n    ");
}

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
  rateBuckets.set(address, hits);

  // Evict the least recently seen rather than clearing everything: a flat clear would
  // hand every rate-limited address a fresh allowance the moment the map filled up.
  if (rateBuckets.size > config.limits.rateBuckets) {
    const oldest = [...rateBuckets.entries()]
      .sort((a, b) => (a[1].at(-1) ?? 0) - (b[1].at(-1) ?? 0))
      .slice(0, Math.floor(config.limits.rateBuckets / 10));
    for (const [key] of oldest) rateBuckets.delete(key);
  }

  return hits.length > config.limits.newListingsPerMinute;
}
