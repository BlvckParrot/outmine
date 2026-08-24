import { Hono } from "hono";
import { cors } from "hono/cors";
import { db } from "./db";
import {
  addClient, clientCount, connectionCount, flush, handleMessage, log, poolHealthy,
  pushFeed, removeClient, startLoops, type SocketData,
} from "./hub";
import { createListing, getBoard, getListing, getPending, TargetError, updateListing, VISIBILITY_THRESHOLD } from "./listings";
import type { BoardSnapshot } from "@outmine/protocol";

// Mining with no payout address credits nobody and nothing complains. Refusing to
// start is louder and cheaper than discovering it on the pool dashboard next week.
if (!process.env.POOL_USER) {
  console.error("POOL_USER is not set - every share would be mined for nobody. See .env.example.");
  process.exit(1);
}

const ADMIN_TOKEN = process.env.ADMIN_TOKEN ?? "";

/** Origins allowed to call the API and to open a mining socket.
 *
 *  This is a security control, not a development convenience. Without it any site
 *  could run `new WebSocket("wss://outmine…/ws")` and mine on its own visitors' CPUs
 *  against our pool account, skipping the consent banner entirely - which is the one
 *  thing separating this project from cryptojacking. */
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ?? "")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

function originAllowed(origin: string | undefined, requestUrl: string): boolean {
  // Browsers always send Origin on a WebSocket handshake, so absence means a
  // non-browser client (our integration tests, curl). Those have no third party's CPU
  // to spend, so they are not the threat this guards against.
  if (!origin) return true;
  if (ALLOWED_ORIGINS.length > 0) return ALLOWED_ORIGINS.includes(origin);
  // Unconfigured: same origin only, so a deployment without the variable set is not
  // open to everyone by default.
  try {
    return new URL(origin).host === new URL(requestUrl).host;
  } catch {
    return false;
  }
}

const app = new Hono();

app.use("/api/*", cors({
  origin: (origin, c) => (originAllowed(origin, c.req.url) ? origin : null),
  allowHeaders: ["content-type", "x-edit-token", "x-admin-token"],
  allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
}));

app.get("/health", (c) => {
  try {
    db.query("SELECT 1").get();
  } catch (err) {
    return c.json({ ok: false, error: String(err) }, 503);
  }
  return c.json({
    ok: true,
    clients: clientCount(),
    poolConnections: connectionCount(),
    poolHealthy: poolHealthy(),
  });
});

// Fallback for first paint and for clients without a WebSocket. Shape must match
// the "board" message the hub broadcasts, minus the live-only fields.
app.get("/api/board", (c) => {
  const snapshot: Omit<BoardSnapshot, "feed" | "mining"> = {
    entries: getBoard().map((e) => ({ ...e, hashrate: 0 })),
    pending: getPending().map((e) => ({ ...e, hashrate: 0 })),
    threshold: VISIBILITY_THRESHOLD,
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
       GROUP BY l.id ORDER BY recent DESC LIMIT 10`,
    ).all(since),
  );
});

/** Per-IP token bucket, in memory. Without it a bot floods the pending list, which is
 *  public and ordered so that a flood pushes the real entries off the end. */
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = Number(process.env.RATE_MAX ?? 5);
const rateBuckets = new Map<string, number[]>();

function rateLimited(ip: string): boolean {
  const now = Date.now();
  const hits = (rateBuckets.get(ip) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  hits.push(now);
  rateBuckets.set(ip, hits);
  if (rateBuckets.size > 10_000) rateBuckets.clear(); // crude cap; the window makes it self-healing
  return hits.length > RATE_MAX;
}

app.post("/api/listings", async (c) => {
  const ip = c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
  if (rateLimited(ip)) return c.json({ error: "slow down" }, 429);

  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: "invalid json" }, 400);
  try {
    const { listing, editToken } = createListing({
      kind: body.kind,
      target: String(body.target ?? ""),
      name: String(body.name ?? ""),
      tagline: String(body.tagline ?? ""),
    });
    pushFeed(`${listing.name} joined and needs hashes`);
    // The edit token is shown once and only its hash is stored.
    return c.json({ listing, editToken }, 201);
  } catch (err) {
    if (err instanceof TargetError) return c.json({ error: err.message }, 400);
    throw err;
  }
});

app.patch("/api/listings/:id", async (c) => {
  const token = c.req.header("x-edit-token");
  if (!token) return c.json({ error: "missing edit token" }, 401);
  const body = await c.req.json().catch(() => ({}));
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
  if (!ADMIN_TOKEN || c.req.header("x-admin-token") !== ADMIN_TOKEN) {
    return c.json({ error: "unauthorized" }, 401);
  }
  const id = c.req.param("id");
  const listing = getListing(id);
  if (!listing) return c.json({ error: "not found" }, 404);
  db.query(`DELETE FROM listings WHERE id = ?`).run(id);
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
// Resolved from this file so it works from any working directory; WEB_DIST overrides
// it where the image lays the packages out differently.
const WEB_DIST = process.env.WEB_DIST ?? new URL("../../web/dist", import.meta.url).pathname;

app.get("*", async (c) => {
  const path = new URL(c.req.url).pathname;
  const file = Bun.file(`${WEB_DIST}${path === "/" ? "/index.html" : path}`);
  if (await file.exists()) return new Response(file);
  const index = Bun.file(`${WEB_DIST}/index.html`);
  if (await index.exists()) return new Response(index);
  return c.text("frontend not built - run: bun run build", 503);
});

startLoops();

const server = Bun.serve<SocketData>({
  port: Number(process.env.PORT ?? 3000),
  fetch(req, srv) {
    if (new URL(req.url).pathname === "/ws") {
      const origin = req.headers.get("origin") ?? undefined;
      if (!originAllowed(origin, req.url)) {
        log("ws_origin_rejected", { origin });
        return new Response("origin not allowed", { status: 403 });
      }
      const data: SocketData = { client: null };
      return srv.upgrade(req, { data }) ? undefined : new Response("upgrade failed", { status: 400 });
    }
    return app.fetch(req);
  },
  websocket: {
    open(ws) {
      ws.data.client = addClient(ws);
    },
    message(ws, msg) {
      if (ws.data.client) handleMessage(ws.data.client, String(msg));
    },
    close(ws) {
      if (ws.data.client) removeClient(ws.data.client);
    },
  },
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    flush(); // do not lose the last 30 seconds of shares on restart
    server.stop();
    process.exit(0);
  });
}

log("started", { port: server.port, pool: process.env.POOL_HOST ?? "minotaurx.mine.zpool.ca" });
