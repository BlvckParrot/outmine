// HTTP surface. Kept apart from server.ts so the routes read as a list of what the
// API does, with the socket plumbing and process lifecycle elsewhere.
import { Hono } from "hono";
import { cors } from "hono/cors";
import type { BoardSnapshot } from "@outmine/protocol";
import { config } from "./config";
import { db } from "./db";
import { clientCount, connectionCount, poolHealthy, pushFeed } from "./hub";
import {
  createListing, deleteListing, getBoard, getListing, getPending, TargetError, updateListing,
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

// Fallback for first paint and for clients without a WebSocket. Shape matches the
// "board" message the hub broadcasts, minus the live-only fields.
app.get("/api/board", (c) => {
  const snapshot: Omit<BoardSnapshot, "feed" | "mining"> = {
    entries: getBoard().map((e) => ({ ...e, hashrate: 0 })),
    pending: getPending().map((e) => ({ ...e, hashrate: 0 })),
    threshold: config.board.visibilityThreshold,
    online: clientCount(),
  };
  return c.json(snapshot);
});

app.get("/api/trending", (c) => {
  const since = Math.floor(Date.now() / 3_600_000) - 1;
  return c.json(
    db.query(
      `SELECT l.id, l.name, l.target, SUM(b.diff_sum) AS recent
       FROM share_buckets b JOIN listings l ON l.id = b.listing_id
       WHERE b.hour >= ? AND l.visible = 1
       GROUP BY l.id ORDER BY recent DESC LIMIT ?`,
    ).all(since, config.board.trendingEntries),
  );
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
  return listing ? c.json(listing) : c.json({ error: "not found" }, 404);
});

app.get("/r/:id", (c) => {
  const listing = getListing(c.req.param("id"));
  if (!listing) return c.notFound();
  db.query(`UPDATE listings SET clicks = clicks + 1 WHERE id = ?`).run(listing.id);
  const url = listing.kind === "handle" ? `https://x.com/${listing.target}` : `https://${listing.target}`;
  return c.redirect(url, 302);
});

// SPA: everything else is the built frontend, with index.html as the fallback.
app.get("*", async (c) => {
  const path = new URL(c.req.url).pathname;
  const file = Bun.file(`${config.webDist}${path === "/" ? "/index.html" : path}`);
  if (await file.exists()) return new Response(file);

  const index = Bun.file(`${config.webDist}/index.html`);
  if (await index.exists()) return new Response(index);
  return c.text("frontend not built - run: bun run build", 503);
});

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
