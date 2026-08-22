import { Hono } from "hono";
import type { ServerWebSocket } from "bun";
import { db } from "./db";
import { addClient, clientCount, flush, handleMessage, pushFeed, removeClient, startLoops, type Client } from "./hub";
import { createListing, getBoard, getListing, getPending, TargetError, updateListing, VISIBILITY_THRESHOLD } from "./listings";

const app = new Hono();

// Fallback for first paint and for clients without a WebSocket. Shape must match
// the "board" message the hub broadcasts, minus the live-only fields.
app.get("/api/board", (c) =>
  c.json({
    entries: getBoard(),
    pending: getPending(),
    online: clientCount(),
    threshold: VISIBILITY_THRESHOLD,
  }),
);

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

app.post("/api/listings", async (c) => {
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
  const file = Bun.file(`web/dist${path === "/" ? "/index.html" : path}`);
  if (await file.exists()) return new Response(file);
  const index = Bun.file("web/dist/index.html");
  if (await index.exists()) return new Response(index);
  return c.text("frontend not built - run: bun run build:web", 503);
});

startLoops();

const server = Bun.serve<{ client: Client }, {}>({
  port: Number(process.env.PORT ?? 3000),
  fetch(req, srv) {
    if (new URL(req.url).pathname === "/ws") {
      return srv.upgrade(req, { data: {} }) ? undefined : new Response("upgrade failed", { status: 400 });
    }
    return app.fetch(req);
  },
  websocket: {
    open(ws) {
      (ws.data as any).client = addClient(ws as ServerWebSocket<any>);
    },
    message(ws, msg) {
      handleMessage((ws.data as any).client, String(msg));
    },
    close(ws) {
      removeClient((ws.data as any).client);
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

console.log(`outmine on http://localhost:${server.port}  pool=${process.env.POOL_HOST ?? "minotaurx.mine.zpool.ca"}`);
