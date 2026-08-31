// The HTTP surface, exercised through ((await app.request() - no socket, no Bun.serve.
//
// The database is a scratch file: scripts/test-setup.ts points DB_PATH at one before
// anything here imports db.ts.
import { expect, test } from "bun:test";
import { CARD_HEIGHT, CARD_WIDTH } from "./cards";
import { config } from "./config";
import { db } from "./db";
import { creditShares } from "./listings";
import { app } from "./routes";

/** Every request carries its own address. The rate limit is keyed on it, so without
 *  this the twentieth test in the file would start getting 429 from the first ones. */
/** app.request() answers `Response | Promise<Response>`, which is awaitable but not
 *  chainable, so the body of a read is unwrapped here once. */
const json = async (...args: Parameters<typeof app.request>) => (await app.request(...args)).json();

let addresses = 0;
const from = () => ({ socketAddress: `10.0.0.${++addresses}` });

let targets = 0;
const uniqueTarget = () => `t${++targets}-${process.pid}.example.com`;

const post = (body: unknown, env = from()) =>
  app.request(
    "/api/listings",
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
    env,
  );

/** The smallest real PNG there is, for the routes that need actual image bytes. */
const PNG_1X1 = new Uint8Array(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  ),
);

/** A listing plus the token it was created with, for the owner-only routes. */
async function create(overrides: Record<string, unknown> = {}) {
  const res = await post({ kind: "domain", target: uniqueTarget(), name: "Test", ...overrides });
  expect(res.status).toBe(201);
  return (await res.json()) as { listing: { id: string }; editToken: string };
}

// --- reads -------------------------------------------------------------------------

test("/health reports a live database", async () => {
  const res = await app.request("/health");
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ ok: true });
});

test("/api/board answers the shape the client expects", async () => {
  const body = await json("/api/board");
  expect(Array.isArray(body.entries)).toBe(true);
  expect(Array.isArray(body.pending)).toBe(true);
  expect(body.limit).toBe(config.board.entries);
  expect(body.threshold).toBe(config.board.visibilityThreshold);
});

test("/api/board finds a pending listing by name", async () => {
  const { listing } = await create({ name: "Findable Widget" });
  const body = await json("/api/board?q=Findable+Widget");
  expect(body.pending.map((e: { id: string }) => e.id)).toContain(listing.id);
});

test("/api/board escapes LIKE wildcards rather than matching everything", async () => {
  await create({ name: "Wildcard Probe" });
  const body = await json("/api/board?q=%25");
  expect(body.pendingTotal).toBe(0);
});

test("/api/stats totals are numbers, not nulls", async () => {
  const body = await json("/api/stats");
  for (const key of ["listings", "onBoard", "shares", "score", "clicks", "shares24h"]) {
    expect(typeof body[key]).toBe("number");
  }
});

test("/api/trending answers a list", async () => {
  expect(Array.isArray(await json("/api/trending"))).toBe(true);
});

// --- creating ----------------------------------------------------------------------

test("a new listing comes back with its edit token exactly once", async () => {
  const { listing, editToken } = await create();
  expect(editToken).toBeTruthy();
  // The hash is stored, never the token, and no route may hand back the column.
  expect(JSON.stringify(listing)).not.toContain("edit_token_hash");

  const fetched = await json(`/api/listings/${listing.id}`);
  expect(fetched).not.toHaveProperty("edit_token_hash");
});

test("the same target cannot be listed twice", async () => {
  const target = uniqueTarget();
  expect((await post({ kind: "domain", target, name: "First" })).status).toBe(201);

  const second = await post({ kind: "domain", target, name: "Second" });
  expect(second.status).toBe(400);
  expect((await second.json()).error).toBe("That target is already listed.");
});

test.each([
  ["a link shortener", { kind: "domain", target: "https://bit.ly/abc", name: "S" }],
  ["a bare host", { kind: "domain", target: "localhost", name: "S" }],
  ["an empty target", { kind: "domain", target: "", name: "S" }],
  ["a nameless listing", { kind: "domain", target: "nameless.example.com", name: "" }],
])("%s is refused with a reason", async (_label, body) => {
  const res = await post(body);
  expect(res.status).toBe(400);
  expect(typeof (await res.json()).error).toBe("string");
});

test("a body that is not JSON is refused as JSON", async () => {
  const res = await app.request(
    "/api/listings",
    { method: "POST", headers: { "content-type": "application/json" }, body: "not json at all" },
    from(),
  );
  expect(res.status).toBe(400);
  // The frontend reads data.error after res.json(); a plain-text error would throw there.
  expect(typeof (await res.json()).error).toBe("string");
});

test("listings are rate limited per address", async () => {
  const env = { socketAddress: "10.9.9.9" };
  const statuses: number[] = [];
  for (let i = 0; i <= config.limits.newListingsPerMinute; i++) {
    statuses.push((await post({ kind: "domain", target: uniqueTarget(), name: "Flood" }, env)).status);
  }
  expect(statuses.at(-1)).toBe(429);
  // A different address is unaffected by that flood.
  expect((await post({ kind: "domain", target: uniqueTarget(), name: "Innocent" })).status).toBe(201);
});

// --- editing -----------------------------------------------------------------------

const patch = (id: string, body: unknown, token?: string) =>
  app.request(`/api/listings/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", ...(token ? { "x-edit-token": token } : {}) },
    body: JSON.stringify(body),
  });

test("an edit needs the token it was created with", async () => {
  const { listing, editToken } = await create();

  expect((await patch(listing.id, { name: "New" })).status).toBe(401);
  // 401 rather than 400: a wrong token is a refused secret, not a malformed request,
  // and it is the one that gets an auth_failed line. See AuthError in listings.ts.
  expect((await patch(listing.id, { name: "New" }, "not-the-token")).status).toBe(401);

  const ok = await patch(listing.id, { name: "New Name" }, editToken);
  expect(ok.status).toBe(200);
  expect((await ok.json()).name).toBe("New Name");
});

test("a name that is not text is refused, not a 500", async () => {
  const { listing, editToken } = await create();
  const res = await patch(listing.id, { name: 123 }, editToken);
  expect(res.status).toBe(400);
  expect(typeof (await res.json()).error).toBe("string");
});

// --- icons -------------------------------------------------------------------------

test("an icon needs the token", async () => {
  const { listing } = await create();
  const res = await app.request(`/api/listings/${listing.id}/icon`, {
    method: "PUT",
    body: new Uint8Array(8),
  });
  expect(res.status).toBe(401);
});

test("an oversized icon is refused before it is read", async () => {
  const { listing, editToken } = await create();
  const res = await app.request(`/api/listings/${listing.id}/icon`, {
    method: "PUT",
    headers: { "x-edit-token": editToken },
    body: new Uint8Array(config.limits.maxIconBytes + 1024),
  });
  expect(res.status).toBe(413);
});

test("an icon is gated on points, not only on the token", async () => {
  const { listing, editToken } = await create();
  const res = await app.request(`/api/listings/${listing.id}/icon`, {
    method: "PUT",
    headers: { "x-edit-token": editToken },
    body: new Uint8Array(64),
  });
  expect(res.status).toBe(400);
  expect((await res.json()).error).toContain("icon unlocks");
});

test("an icon that was never uploaded is a 404", async () => {
  const { listing } = await create();
  expect((await app.request(`/icon/${listing.id}.png`)).status).toBe(404);
});

test("an uploaded icon comes back as a webp", async () => {
  const { listing, editToken } = await create();
  makeVisible(listing.id); // the same credit that unlocks the icon

  // Copied into a plain ArrayBuffer: bytes() hands back a view whose buffer type is
  // wider than BodyInit accepts.
  const png = new Uint8Array(
    await new Bun.Image(PNG_1X1).resize(64, 64, { fit: "fill" }).png().bytes(),
  );
  const put = await app.request(`/api/listings/${listing.id}/icon`, {
    method: "PUT",
    headers: { "x-edit-token": editToken },
    body: png,
  });
  expect(put.status).toBe(200);

  const res = await app.request(`/icon/${listing.id}.webp`);
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("image/webp");
  expect((await new Bun.Image(await res.bytes()).metadata()).format).toBe("webp");
});

test("an icon stored before the switch to webp is still served as a png", async () => {
  const { listing } = await create();
  // Written straight into the column: this is the shape every row uploaded before the
  // switch already has, and the read side has to keep telling the truth about it.
  db.query(`UPDATE listings SET icon = ? WHERE id = ?`).run(PNG_1X1, listing.id);

  const res = await app.request(`/icon/${listing.id}.png`);
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("image/png");
});

// --- the rest ----------------------------------------------------------------------

test("a listing that does not exist is a 404, not a 500", async () => {
  expect((await app.request("/api/listings/nope")).status).toBe(404);
});

test("takedown is closed without an admin token", async () => {
  const { listing } = await create();
  expect((await app.request(`/api/listings/${listing.id}`, { method: "DELETE" })).status).toBe(401);
  // Still there.
  expect((await app.request(`/api/listings/${listing.id}`)).status).toBe(200);
});

test("the outbound hop counts a click and refuses to be indexed", async () => {
  const { listing } = await create();
  const res = await app.request(`/r/${listing.id}`);
  expect(res.status).toBe(302);
  expect(res.headers.get("x-robots-tag")).toContain("noindex");

  const after = await json(`/api/listings/${listing.id}`);
  expect(after.clicks).toBe(1);
});

// --- headers and templating ----------------------------------------------------------

test("the badge and the card may be embedded cross-origin, the icon may not", async () => {
  const { listing } = await create();
  // secureHeaders defaults CORP to same-origin, which would tell a browser to refuse
  // the one thing a badge is for.
  const badge = await app.request(`/badge/${listing.id}.svg`);
  expect(badge.headers.get("cross-origin-resource-policy")).toBe("cross-origin");

  const og = await app.request(`/og/${listing.id}.png`);
  expect(og.headers.get("cross-origin-resource-policy")).toBe("cross-origin");

  // Loaded by our own board only, so it keeps the stricter default.
  expect((await app.request("/health")).headers.get("cross-origin-resource-policy"))
    .toBe("same-origin");
});

test("the CSP refuses framing and inline script", async () => {
  const csp = (await app.request("/health")).headers.get("content-security-policy") ?? "";
  // Framing is the way around originAllowed: a frame is same-origin to us, so the
  // consent banner can be clicked through from someone else's page.
  expect(csp).toContain("frame-ancestors 'none'");
  expect(csp).toContain("object-src 'none'");
  expect(csp).toMatch(/script-src 'nonce-[^']+'/);
});

test("/index.html is templated, not served from disk", async () => {
  // serveStatic would answer this one with the file as it sits on disk: og marker
  // unreplaced, and a nonce placeholder that matches no nonce, so the CSP blocks the
  // theme script the placeholder exists to bless.
  const body = await (await app.request("/index.html")).text();
  expect(body).not.toContain("__CSP_NONCE__");
  // The analytics marker goes the same way. Nothing is configured in a test run, so
  // what replaces it is the empty string - but it is replaced, or a deployment with no
  // analytics would ship an HTML comment saying where they would have gone.
  expect(body).not.toContain("<!--analytics-->");
  expect(body).not.toContain("/api/script.js");
  // Same for the error reporter's settings block: nothing is configured in a test run,
  // so the marker is replaced by the empty string rather than left in the document.
  expect(body).not.toContain("<!--observe-->");
  expect(body).not.toContain("observe-config");
  // Both ends of the replaced span. A leftover closing marker would mean the fallback
  // title survived alongside the injected one.
  expect(body).not.toContain("<!--og-->");
  expect(body).not.toContain("<!--/og-->");
  // Closing tags: the comment above the span mentions <title> by name and an opening
  // tag would count that too.
  expect(body.match(/<\/title>/g)?.length).toBe(1);
});

test("a listing name cannot splice the page into its own title", async () => {
  // $& and $` are String.replace patterns and Bun.escapeHTML does not escape $.
  const { listing } = await create({ name: "$`x" });
  const body = await (await app.request(`/l/${listing.id}`)).text();
  expect(body).not.toContain("<!--og-->");
  expect(body).not.toContain("<!--/og-->");
  expect(body.match(/<!doctype/gi)?.length ?? 0).toBe(1);
});

// --- bounds --------------------------------------------------------------------------

test("a patch that changes nothing is refused rather than answered 200", async () => {
  const { listing, editToken } = await create();
  // Also the shape a body the validator declined to parse arrives in.
  const res = await patch(listing.id, {}, editToken);
  expect(res.status).toBe(400);
});

test("an oversized search and offset are clamped, not run as sent", async () => {
  const body = await json(`/api/board?q=${"a".repeat(5000)}&offset=999999999`);
  expect(Array.isArray(body.entries)).toBe(true);
  expect(body.entries.length).toBe(0);
});

test("the outbound hop is rate limited", async () => {
  const { listing } = await create();
  const env = { socketAddress: "10.8.8.8" };
  let last = 200;
  for (let i = 0; i <= config.limits.expensiveReadsPerMinute; i++) {
    last = (await app.request(`/r/${listing.id}`, {}, env)).status;
  }
  expect(last).toBe(429);
});

// --- crawler surface -----------------------------------------------------------------
//
// Everything here is invisible in a browser and decides what a search engine does with
// the site, which is exactly the combination that rots without tests.

/** Mines a listing onto the board the way the pool does, so a test that needs a visible
 *  listing gets one through the real gate rather than an UPDATE behind it. */
function makeVisible(id: string) {
  creditShares([[id, { shares: config.board.visibilityThreshold, diffSum: 5 }]]);
}

test("a written page gets its own title, description and canonical", async () => {
  const body = await (await app.request("/about")).text();
  // Not the home page's. index.html carries that one, and before this the four written
  // pages went out as four copies of it.
  expect(body).toContain("<title>What this is — outmine</title>");
  expect(body).toContain('<link rel="canonical" href="http://localhost/about" />');
  expect(body).not.toContain("<title>outmine — the board you pay for with CPU</title>");
});

test("/index.html and a trailing slash canonicalise to the page itself", async () => {
  const index = await (await app.request("/index.html")).text();
  expect(index).toContain('<link rel="canonical" href="http://localhost/" />');

  const slashed = await app.request("/about/");
  expect(slashed.status).toBe(200);
  expect(await slashed.text()).toContain('<link rel="canonical" href="http://localhost/about" />');
});

test("a path that is not a page is a 404, not a copy of the board", async () => {
  const res = await app.request("/wp-admin");
  expect(res.status).toBe(404);
  const body = await res.text();
  expect(body).toContain('<meta name="robots" content="noindex, follow" />');
  // A 404 that named a canonical would be asking to be indexed under it.
  expect(body).not.toContain('rel="canonical"');
});

test("a listing that does not exist is a 404 with tags, not a bare marker", async () => {
  const res = await app.request("/l/nosuchlisting");
  expect(res.status).toBe(404);
  const body = await res.text();
  // This used to fall through the ternary and ship the marker itself, so the one page
  // most in need of a noindex was the only page with no crawler tags at all.
  expect(body).not.toContain("<!--og-->");
  expect(body).toContain('<meta name="robots" content="noindex, follow" />');
});

test("a listing short of the gate is noindex; one on the board is canonical", async () => {
  const { listing } = await create({ name: "Queued Thing" });
  const pending = await (await app.request(`/l/${listing.id}`)).text();
  expect(pending).toContain('<meta name="robots" content="noindex, follow" />');
  expect(pending).not.toContain('rel="canonical"');

  makeVisible(listing.id);
  const onBoard = await (await app.request(`/l/${listing.id}`)).text();
  expect(onBoard).toContain(`<link rel="canonical" href="http://localhost/l/${listing.id}" />`);
  expect(onBoard).not.toContain('name="robots"');
});

test("the sitemap lists the written pages and the board, never the queue", async () => {
  const { listing: queued } = await create({ name: "Still Queued" });
  const { listing: mined } = await create({ name: "On The Board" });
  makeVisible(mined.id);

  const res = await app.request("/sitemap.xml");
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("application/xml");

  const xml = await res.text();
  expect(xml).toContain("<loc>http://localhost/</loc>");
  expect(xml).toContain("<loc>http://localhost/about</loc>");
  expect(xml).toContain(`<loc>http://localhost/l/${mined.id}</loc>`);
  // The queue is thin content by design - a name and a progress bar - and its own page
  // says noindex. A sitemap that listed it would be arguing with that.
  expect(xml).not.toContain(queued.id);
});

test("robots.txt carries an absolute sitemap URL", async () => {
  // The line cannot live in the file: it has to be absolute and the build has no idea
  // what host it will be served from.
  const body = await (await app.request("/robots.txt")).text();
  expect(body).toContain("Sitemap: http://localhost/sitemap.xml");
});

test("the card tags declare the size the card is actually drawn at", async () => {
  const body = await (await app.request("/")).text();
  expect(body).toContain(`<meta property="og:image:width" content="${CARD_WIDTH}" />`);
  expect(body).toContain(`<meta property="og:image:height" content="${CARD_HEIGHT}" />`);
  expect(body).toContain('<meta property="og:image" content="http://localhost/og/home.png" />');
});
