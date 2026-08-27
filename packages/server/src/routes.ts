// The HTTP surface. Socket plumbing is in server.ts, share cards and crawler tags in
// share.ts, every SQL statement in listings.ts - what is left here reads as a list of
// what the API does.
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { etag } from "hono/etag";
import { NONCE, secureHeaders } from "hono/secure-headers";
import { rateLimiter } from "hono-rate-limiter";
import { HTTPException } from "hono/http-exception";
import { validator } from "hono/validator";
import {
  isKnownPath,
  type BoardPageResponse, type ListingDetail, type ListingKind, type StatsResponse,
  type TrendingItem,
} from "@outmine/protocol";
import { config } from "./config";
import { dbAlive, type Listing } from "./db";
import {
  clientCount, connectionCount, dropListing, loopLag, miningCount, poolHealthy, pushFeed,
} from "./hub";
import {
  AuthError, boardTotals, countClick, createListing, deleteListing, getIcon, getListing,
  listingRank, searchBoard, setIcon, TargetError, trafficByDay, trafficListings, trafficTop,
  trending, updateListing, visitsToday,
} from "./listings";
import { log, makeThrottledLog } from "./log";
import { clientAddress, originAllowed, secretsMatch } from "./security";
import { origin, pageMeta, replaceMeta, share, withNonce } from "./share";

/** Handed in by server.ts, which is the only layer that can see the socket. */
export type RequestContext = { socketAddress?: string };

export const app = new Hono<{ Bindings: RequestContext }>();

/** For the four events below - a refused origin, a refused rate, a wrong token - which
 *  all fire once per abusive request and would otherwise bury everything else in the
 *  log. Same interval as the hub's. Caddy's access log already has the status of every
 *  request; what these add is the reason, which the edge cannot see. */
const throttled = makeThrottledLog(30_000);

/** The badge and the share card exist to be loaded by other origins - that is the
 *  entire feature. secureHeaders defaults Cross-Origin-Resource-Policy to same-origin,
 *  which tells a browser to refuse exactly that.
 *
 *  Registered before secureHeaders on purpose: middleware unwinds in reverse, so the
 *  outermost one has the last word on a header both of them set. */
const embeddable = async (c: Context, next: () => Promise<void>) => {
  await next();
  c.res.headers.set("Cross-Origin-Resource-Policy", "cross-origin");
};

app.use("/badge/*", embeddable);
app.use("/og/*", embeddable);

/** Content-Security-Policy.
 *
 *  Worth the care on this site in particular: it serves PNGs that its own visitors
 *  uploaded, from its own origin, and it stitches text into index.html on the way out.
 *
 *  'wasm-unsafe-eval' is not optional. The miner is a WebAssembly module and the
 *  emscripten glue reaches it through WebAssembly.instantiateStreaming, which Chrome
 *  refuses under a script-src that does not say this - and the failure is the whole
 *  product, silently. (The glue contains no eval and no new Function, so plain
 *  'unsafe-eval' is not needed and is not granted.)
 *
 *  'unsafe-inline' in style-src covers the style attributes React writes for the
 *  progress bars; CSP has no way to allow those by hash. */
app.use(secureHeaders({
  contentSecurityPolicy: {
    defaultSrc: ["'self'"],
    scriptSrc: [NONCE, "'self'", "'wasm-unsafe-eval'"],
    styleSrc: ["'self'", "'unsafe-inline'"],
    imgSrc: ["'self'", "data:"],
    fontSrc: ["'self'"],
    connectSrc: ["'self'"],
    workerSrc: ["'self'", "blob:"],
    objectSrc: ["'none'"],
    baseUri: ["'self'"],
    frameAncestors: ["'none'"],
  },
}));

app.use("/api/*", cors({
  origin: (origin, c) => {
    if (originAllowed(origin, c.req.url)) return origin;
    // The WebSocket twin of this refusal is logged as ws_origin_rejected. Both guard
    // the same thing - a third-party page spending its visitors' CPUs against this
    // pool account - so a silent one here was an accident, not a decision.
    throttled("cors_rejected", { origin });
    return null;
  },
  allowHeaders: ["content-type", "x-edit-token", "x-admin-token"],
  allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
}));

app.onError((err, c) => {
  // A middleware that rejects a request - a body over the limit, a body that is not
  // JSON - reports it by throwing, and its status is the answer the sender is owed.
  // Everything else is ours: logged with detail and answered without, because an
  // internal message can name a table, a path or a query.
  //
  // Answered as JSON either way. Hono's own default is text/plain, and every caller in
  // the frontend reads `data.error` after `res.json()`, so a plain-text 400 would
  // surface there as a parse failure instead of as the reason.
  if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);

  log("request_failed", { path: new URL(c.req.url).pathname, error: String(err) });
  return c.json({ error: "internal error" }, 500);
});

/** Bodies are bounded before they are read. Unbounded, one request could buffer as
 *  much memory as the sender cares to send. */
const boundedBody = (maxSize: number) =>
  bodyLimit({ maxSize, onError: (c) => c.json({ error: "too large" }, 413) });

/** The JSON a new listing is made of. Only the shape is checked here - what counts as
 *  a valid target, and what a name is trimmed to, stays in listings.ts, which is the
 *  gate every writer goes through. */
const newListingBody = validator("json", (value, c) => {
  const { kind: raw, target, name, tagline } = value as Record<string, unknown>;
  // Matched positively rather than rejected with !==: TypeScript narrows `unknown` on
  // an equality, but cannot subtract from it, so the negative form leaves `string`
  // behind and the literal union has to be asserted back in.
  const kind = raw === "handle" ? "handle" : raw === "domain" ? "domain" : null;
  if (kind === null) return c.json({ error: "kind must be domain or handle" }, 400);
  if (typeof target !== "string" || typeof name !== "string") {
    return c.json({ error: "target and name are required" }, 400);
  }

  // Annotated, not inferred. Hono reads the validator's return type to type
  // c.req.valid(), and an inferred object literal widens "domain" back to string.
  const checked: { kind: ListingKind; target: string; name: string; tagline: string } = {
    kind, target, name, tagline: typeof tagline === "string" ? tagline : "",
  };
  return checked;
});

/** A patch names only the fields it changes, so absent and present-but-wrong are
 *  different answers. */
const editListingBody = validator("json", (value, c) => {
  const body = value as Record<string, unknown>;
  for (const field of ["name", "tagline"] as const) {
    if (body[field] !== undefined && typeof body[field] !== "string") {
      return c.json({ error: `${field} must be text` }, 400);
    }
  }
  // An empty patch is also what a body the validator declined to parse looks like: it
  // hands the handler {} when the Content-Type is not JSON, and answering 200 with the
  // unchanged listing would tell the sender an edit happened that did not.
  if (body.name === undefined && body.tagline === undefined) {
    return c.json({ error: "name or tagline is required" }, 400);
  }
  return body as { name?: string; tagline?: string };
});

app.get("/health", (c) => {
  if (!dbAlive()) {
    log("health_check_failed", {});
    return c.json({ ok: false }, 503);
  }
  return c.json({
    ok: true,
    clients: clientCount(),
    mining: miningCount(),
    poolConnections: connectionCount(),
    poolHealthy: poolHealthy(),
    // How late the broadcast loop ran. Everything in this process shares one thread, so
    // this is the number that says whether it is keeping up.
    lagMs: loopLag(),
  });
});

// --- rate limits ---------------------------------------------------------------------

/** What every limiter keys on, and it is not the library's default: that reads
 *  X-Forwarded-For from the left, which is the end a client writes, so anyone could
 *  reset their own limit with one forged header. clientAddress counts from the right,
 *  by TRUSTED_PROXIES. Security control, not configuration - see security.ts. */
const byAddress = (c: Context<{ Bindings: RequestContext }>) =>
  clientAddress(c.req.raw.headers, c.env?.socketAddress);

/** A wrong secret: the admin token, or a listing's edit token. Logged rather than only
 *  answered, because this is the one thing Caddy's access log cannot tell apart - a
 *  guess against ADMIN_TOKEN and a client bug both leave the same line at the edge.
 *
 *  A *missing* token is deliberately not routed through here. It is what a cleared
 *  localStorage looks like, it happens to honest people, and since the throttle keys on
 *  the event name that noise would hide the guessing it exists to show. */
const authFailed = (c: Context<{ Bindings: RequestContext }>, reason: string) => {
  throttled("auth_failed", { path: c.req.path, reason, address: byAddress(c) });
  return c.json({ error: reason }, 401);
};

/** Per-address sliding window. Without it a bot floods the pending list, which is
 *  public and ordered, so a flood pushes the real entries off the end.
 *
 *  Registered ahead of the body middleware: there is no reason to buffer a body that
 *  is about to be refused. */
const newListingLimit = rateLimiter<{ Bindings: RequestContext }>({
  windowMs: 60_000,
  limit: config.limits.newListingsPerMinute,
  keyGenerator: byAddress,
  handler: (c) => {
    throttled("rate_limited", { path: c.req.path, address: byAddress(c) });
    return c.json({ error: "slow down" }, 429);
  },
});

/** Everything that is not free to answer: rasterising a share card, the outbound hop
 *  (an UPDATE per request), the board search - four queries, two of them a leading-%
 *  LIKE across two columns that no index can serve - and the owner writes.
 *
 *  Deliberately not on /icon/*: a board page is fifty rows and fifty icon requests, so
 *  a per-minute ceiling there would refuse the page it was drawn for. Those are bounded
 *  by MAX_ICON_BYTES and answered with an ETag instead. */
const readLimit = rateLimiter<{ Bindings: RequestContext }>({
  windowMs: 60_000,
  limit: config.limits.expensiveReadsPerMinute,
  keyGenerator: byAddress,
  handler: (c) => {
    throttled("rate_limited", { path: c.req.path, address: byAddress(c) });
    return c.json({ error: "slow down" }, 429);
  },
});

// --- the board ---------------------------------------------------------------------

/** The board over HTTP: first paint, clients without a WebSocket, and every filtered
 *  or paged view. The socket only ever pushes the unfiltered top, so searching and
 *  paging have to come from here.
 *
 *  With no parameters the answer is what the socket would have sent, which keeps first
 *  paint and pre-existing clients unchanged. */
app.get("/api/board", readLimit, (c) => {
  const params = new URL(c.req.url).searchParams;
  const window = params.get("window") === "24h" ? "24h" : "all";
  // Both bounded. `q` runs a leading-% LIKE over two columns, which no index can
  // serve, and `offset` is walked row by row - so an uncapped one of either is a table
  // scan whose cost the sender chooses.
  const q = (params.get("q") ?? "").slice(0, config.board.maxQueryLength);
  const offset = Math.min(
    Math.max(Number(params.get("offset") ?? 0) || 0, 0),
    config.board.entries * 100,
  );

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
    visitsToday: visitsToday(),
    online: clientCount(),
    mining: miningCount(),
    poolConnections: connectionCount(),
  };
  return c.json(response);
});

// --- listings ----------------------------------------------------------------------

app.post("/api/listings", newListingLimit, boundedBody(config.limits.maxBodyBytes), newListingBody, (c) => {
  try {
    const { listing, editToken } = createListing(c.req.valid("json"));
    pushFeed(`${listing.name} joined and needs hashes`);
    log("listing_created", { id: listing.id, target: listing.target });
    // The edit token is returned once here and only its hash is stored.
    return c.json({ listing, editToken }, 201);
  } catch (err) {
    if (err instanceof TargetError) return c.json({ error: err.message }, 400);
    throw err;
  }
});

app.patch("/api/listings/:id", readLimit, boundedBody(config.limits.maxBodyBytes), editListingBody, (c) => {
  const token = c.req.header("x-edit-token");
  if (!token) return c.json({ error: "missing edit token" }, 401);

  try {
    return c.json(updateListing(c.req.param("id"), token, c.req.valid("json")));
  } catch (err) {
    // AuthError first: it extends TargetError, so the order is what decides whether a
    // guessed token is answered as 401 and logged or as an unremarkable 400.
    if (err instanceof AuthError) return authFailed(c, err.message);
    if (err instanceof TargetError) return c.json({ error: err.message }, 400);
    throw err;
  }
});

/** The owner's own logo in place of the letter. Raw bytes rather than multipart or
 *  base64: the browser sends exactly what it drew on its canvas, and there is nothing
 *  else in the request to parse.
 *
 *  Both gates are here for different reasons. The token says whose listing it is; the
 *  points say the row has earned the loudest thing on it, which is also what keeps an
 *  upload form off a listing that anyone can create with one POST. */
app.put("/api/listings/:id/icon", readLimit, boundedBody(config.limits.maxIconBytes), async (c) => {
  const token = c.req.header("x-edit-token");
  if (!token) return c.json({ error: "missing edit token" }, 401);

  const bytes = new Uint8Array(await c.req.arrayBuffer());
  try {
    const listing = await setIcon(c.req.param("id"), token, bytes);
    log("listing_icon_set", { id: listing.id, bytes: bytes.length });
    return c.json({ ok: true });
  } catch (err) {
    if (err instanceof AuthError) return authFailed(c, err.message);
    if (err instanceof TargetError) return c.json({ error: err.message }, 400);
    throw err;
  }
});

/** Takedown. The board is public and the reference site bans adult content; without
 *  this the only remedy is editing SQLite by hand. */
app.delete("/api/listings/:id", readLimit, (c) => {
  const offered = c.req.header("x-admin-token") ?? "";
  if (!config.security.adminToken || !secretsMatch(config.security.adminToken, offered)) {
    return authFailed(c, "unauthorized");
  }

  const id = c.req.param("id");
  const listing = getListing(id);
  if (!listing) return c.json({ error: "not found" }, 404);

  // Before the row goes: the hub is still holding miners on this listing and their
  // unflushed counters, and a share_bucket INSERT for a listing that no longer exists
  // fails the foreign key and rolls back the whole flush batch. See dropListing.
  dropListing(id);
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

/** The uploaded icon. Served from our own origin rather than linked from wherever the
 *  owner keeps it: a remote URL on fifty rows tells fifty third parties who is reading
 *  the board, and it breaks the moment that host does. */
app.use("/icon/*", etag());

app.get("/icon/:id{.+\\.(?:png|webp)}", (c) => {
  const icon = getIcon(c.req.param("id").replace(/\.(?:png|webp)$/, ""));
  if (!icon) return c.notFound();
  // Sniffed rather than assumed: 0x52 is the R of RIFF, which only WebP starts with.
  // Icons uploaded before the switch to WebP are still PNG blobs in the same column,
  // and both extensions stay routable so a URL already in a cache keeps working.
  c.header("Content-Type", icon[0] === 0x52 ? "image/webp" : "image/png");
  // The URL does not change when the owner replaces the image, so a max-age would be
  // exactly how long a stale icon survives. Revalidating instead costs a request and
  // answers 304 with no body, and the replacement is visible immediately.
  c.header("Cache-Control", "public, no-cache");
  return c.body(icon as unknown as ArrayBuffer);
});

app.get("/r/:id", readLimit, (c) => {
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

// --- traffic -------------------------------------------------------------------------

/** The traffic report, for whoever holds the admin token.
 *
 *  A page rather than JSON because a person reads it in a browser, and that is also why
 *  the token travels in the query string: a browser cannot be asked to send a header.
 *  The two ways a token in a URL escapes are the Referer of the next click and a cache,
 *  so both are shut off below.
 *
 *  Not public, unlike everything on /stats. Referrer hosts are somebody else's traffic,
 *  and a public list of them is an invitation to spam it. */
app.get("/admin/traffic", readLimit, (c) => {
  const offered = new URL(c.req.url).searchParams.get("token") ?? "";
  if (!config.security.adminToken || !secretsMatch(config.security.adminToken, offered)) {
    return authFailed(c, "unauthorized");
  }

  c.header("X-Robots-Tag", "noindex, nofollow");
  c.header("Referrer-Policy", "no-referrer");
  c.header("Cache-Control", "no-store");
  return c.html(trafficPage());
});

const DAY_MS = 86_400_000;

const percent = (part: number, whole: number) => (whole ? `${((part / whole) * 100).toFixed(1)}%` : "—");

function table(title: string, head: string[], rows: (string | number)[][]): string {
  const cells = (row: (string | number)[], tag: string) =>
    row.map((value) => `<${tag}>${Bun.escapeHTML(String(value))}</${tag}>`).join("");
  if (rows.length === 0) return `<h2>${title}</h2><p>nothing yet</p>`;
  return `<h2>${title}</h2><table><tr>${cells(head, "th")}</tr>` +
    `${rows.map((row) => `<tr>${cells(row, "td")}</tr>`).join("")}</table>`;
}

function trafficPage(): string {
  const days = trafficByDay(30).map((d) => [
    new Date(d.day * DAY_MS).toISOString().slice(0, 10),
    d.visits, d.pages, d.views, d.mines, percent(d.mines, d.visits),
  ]);

  return `<!doctype html><meta charset="utf-8"><title>outmine traffic</title>
<style>
  body { font: 14px/1.5 ui-monospace, monospace; max-width: 52rem; margin: 2rem auto; padding: 0 1rem }
  h1 { font-size: 1.2rem } h2 { font-size: 1rem; margin-top: 2rem }
  table { border-collapse: collapse; width: 100% }
  th, td { text-align: right; padding: 2px 8px; border-bottom: 1px solid #8884 }
  th:first-child, td:first-child { text-align: left }
  p { color: #888 }
</style>
<h1>outmine traffic</h1>
<p>Last 30 days. A visit is one page load, counted on the socket the page already
holds - so nothing here saw a crawler, and nothing here knows who anyone is.</p>
${table("by day", ["day", "visits", "pageviews", "listing views", "mining starts", "conversion"], days)}
${table("referrers", ["host", "visits"], trafficTop("ref").map((r) => [r.key, r.n]))}
${table("pages", ["path", "views"], trafficTop("page").map((r) => [r.key, r.n]))}
${table(
  "listings",
  ["listing", "id", "views (30d)", "clicks (all time)"],
  trafficListings().map((l) => [l.name, l.id, l.views, l.clicks]),
)}
<p>Clicks are a running total on the listing and were never bucketed by day, so they do
not divide into 30 days of views. A listing taken down since is not listed.</p>`;
}

// --- pages -------------------------------------------------------------------------

/** index.html with the crawler tags stitched in. A crawler runs no JavaScript, so the
 *  tags cannot come from the app; index.html is a static file and cannot know the host
 *  it will be served from, so they cannot come from the build either.
 *
 *  This is also the catch-all, which is why the status is not always 200. Answering
 *  every URL ever typed at this host with the board makes the site infinitely large to
 *  a crawler, and every one of those copies competes with the real page. */
async function indexHandler(c: Context) {
  const index = Bun.file(`${config.webDist}/index.html`);
  if (!(await index.exists())) return c.text("frontend not built - run: bun run build", 503);

  const path = c.req.path;
  const html = replaceMeta(withNonce(c, await index.text()), () => pageMeta(origin(c), path));
  return c.html(html, isKnownPath(path) ? 200 : 404);
}

// Both spellings, and index.html is kept out of the native routes in server.ts, or the
// file goes out as it sits on disk: og marker unreplaced, and a nonce placeholder that
// matches no nonce - so the CSP blocks the theme script and a dark-theme visitor gets
// the white flash it exists to prevent.
app.get("/", indexHandler);
app.get("/index.html", indexHandler);

// etag saves the bytes on the way out, never the work: the middleware runs the handler
// and hashes what it produced, so a card is rasterised either way. The limiter is what
// bounds the work.
app.use("/og/*", readLimit, etag());
app.use("/badge/*", etag());

// /l/:id, the badge and the cards, for the same reason.
app.route("/", share);

// The built frontend is not here any more: server.ts hands dist to Bun.serve as native
// routes, which stream with sendfile and answer ETag, Last-Modified, 304 and Range
// without entering JavaScript. Those routes are matched before this app is ever
// consulted, so what reaches the line below is a path with no file behind it.
//
// index.html stays ours: it carries the crawler tags and the CSP nonce, neither of
// which a file on disk can know. No etag on it for the same reason - the nonce changes
// every request, so the hash would never match and the 304 would never happen.
app.get("*", indexHandler);
