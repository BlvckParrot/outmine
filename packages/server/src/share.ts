// Everything a shared link needs: a listing's own page, its preview card, its badge.
//
// The drawing lives in cards.ts; this is the HTTP layer over it, kept apart from
// routes.ts because none of it is API surface - it exists for crawlers, chat clients
// and READMEs, which have their own rules about absolute URLs and escaping.
import { Hono, type Context } from "hono";
import { isPagePath, normalizePath, PAGES, pageFor, type ListingDetail } from "@outmine/protocol";
import { badgeSvg, CARD_HEIGHT, CARD_WIDTH, cardPng, homeCardPng, standing } from "./cards";
import { config } from "./config";
import { getListing, listBoard, listingRank } from "./listings";

export const share = new Hono();

/** Where a crawler will fetch our images from. Configured wins; otherwise the request
 *  itself, which is right in development and behind a proxy we control. */
export const origin = (c: { req: { url: string } }) =>
  config.publicOrigin || new URL(c.req.url).origin;

/** The span of index.html that is rewritten per request. Markers rather than a regex
 *  over the head: this runs on every crawler hit and a parse would be both slower and
 *  easier to get wrong.
 *
 *  A span and not a single marker because a document gets one <title> and one
 *  description. Injecting them at a point would leave the file's own copies in place
 *  below, and which one a parser used would be its business rather than ours. */
export const OG_OPEN = "<!--og-->";
export const OG_CLOSE = "<!--/og-->";

/** index.html with the crawler tags for `path` in place of whatever is between the
 *  markers. `meta` is a function, not a string: $&, $` and $' are replacement patterns
 *  and Bun.escapeHTML does not escape $, so a listing named `$\`` would otherwise
 *  splice the surrounding page into its own title.
 *
 *  A file with no markers goes out untouched. That is Vite's dev output only - the
 *  build copies this file verbatim - and it is better than serving a half-cut head. */
export function replaceMeta(html: string, meta: () => string): string {
  const start = html.indexOf(OG_OPEN);
  const end = html.indexOf(OG_CLOSE);
  if (start === -1 || end === -1 || end < start) return html;
  return html.slice(0, start) + meta() + html.slice(end + OG_CLOSE.length);
}

/** The theme script in index.html has to run before the first paint, so it is inline,
 *  and CSP has to be told it is ours. A per-request nonce rather than a hash of the
 *  script: the file is already being rewritten here for the crawler tags, so this
 *  costs one more substitution and cannot go stale when the script changes. */
export const NONCE_MARKER = "__CSP_NONCE__";

export const withNonce = (c: Context, html: string) =>
  html.replaceAll(NONCE_MARKER, c.get("secureHeadersNonce") ?? "");

const detailOf = (id: string): ListingDetail | null => {
  const listing = getListing(id);
  if (!listing) return null;
  return { ...listing, rank: listing.visible ? listingRank(listing) : null };
};

/** Images are cached briefly rather than not at all: a crawler fetches one once, but
 *  the URL is public and rasterising per request is a way to hand anyone our CPU. */
const CACHE = "public, max-age=300";

/** A shields-style badge for a README or a site footer. GitHub proxies images through
 *  its own cache, so this max-age is what actually controls freshness. */
share.get("/badge/:id{.+\\.svg}", (c) => {
  const listing = detailOf(c.req.param("id").replace(/\.svg$/, ""));
  if (!listing) return c.notFound();
  c.header("Content-Type", "image/svg+xml; charset=utf-8");
  c.header("Cache-Control", CACHE);
  return c.body(badgeSvg(listing));
});

share.get("/og/home.png", (c) => {
  c.header("Content-Type", "image/png");
  c.header("Cache-Control", CACHE);
  return c.body(homeCardPng(listBoard({ limit: 3 })) as unknown as ArrayBuffer);
});

share.get("/og/:id{.+\\.png}", (c) => {
  const listing = detailOf(c.req.param("id").replace(/\.png$/, ""));
  if (!listing) return c.notFound();
  c.header("Content-Type", "image/png");
  c.header("Cache-Control", CACHE);
  return c.body(cardPng(listing) as unknown as ArrayBuffer);
});

/** A listing's own page. The SPA renders it, but a crawler runs no JavaScript, so the
 *  per-listing tags are stitched into index.html here. Registered before the catch-all
 *  in routes.ts, which would otherwise answer first with the generic tags. */
share.get("/l/:id", async (c) => {
  const index = Bun.file(`${config.webDist}/index.html`);
  if (!(await index.exists())) return c.text("frontend not built - run: bun run build", 503);

  const listing = detailOf(c.req.param("id"));
  const html = withNonce(c, await index.text());
  // A listing that does not exist is a 404, not a 200 carrying the board's tags. It
  // used to leave the marker itself in the page, so the one case most in need of a
  // noindex was the only one with no crawler tags at all.
  const meta = listing
    ? () => listingMeta(listing, origin(c))
    : () => pageMeta(origin(c), c.req.path);
  return c.html(replaceMeta(html, meta), listing ? 200 : 404);
});

/** robots.txt with the one line it cannot carry on disk. Sitemap: has to be an
 *  absolute URL, and the file is built by Vite long before anyone knows the host.
 *
 *  Falls back to the bare directive if the build is missing, so a crawler that arrives
 *  mid-deploy is told nothing false rather than being handed a 503. */
share.get("/robots.txt", async (c) => {
  const file = Bun.file(`${config.webDist}/robots.txt`);
  const body = (await file.exists()) ? await file.text() : "User-agent: *\nAllow: /\n";
  return c.text(`${body.trimEnd()}\n\nSitemap: ${origin(c)}/sitemap.xml\n`);
});

/** Where the listings are. The board is a client-rendered list behind a WebSocket, so
 *  a crawler that arrives at the home page finds no links to follow to any of them -
 *  the outbound anchors are the listing's own target, correctly nofollowed. Without
 *  this file the listing pages have no crawlable path at all.
 *
 *  Only the board: `listBoard` defaults to visible = 1, so a listing short of the gate
 *  is left out, which is the same answer its own page gives with `noindex`. */
share.get("/sitemap.xml", (c) => {
  const site = origin(c);

  // A listing id is [a-z0-9] and the paths are literals, so the only part of a loc
  // that can carry an & is the configured origin. Escaped anyway: a sitemap that is
  // not well-formed XML is rejected whole, not per entry.
  const loc = (path: string) => Bun.escapeHTML(`${site}${path}`);
  const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

  const entries = [
    ...Object.keys(PAGES).map((path) => `  <url><loc>${loc(path)}</loc></url>`),
    ...listBoard({ limit: config.board.entries }).map(
      (l) =>
        `  <url><loc>${loc(`/l/${l.id}`)}</loc><lastmod>${day(l.created_at)}</lastmod></url>`,
    ),
  ];

  c.header("Content-Type", "application/xml; charset=utf-8");
  c.header("Cache-Control", CACHE);
  return c.body(
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries.join("\n")}\n</urlset>\n`,
  );
});

// --- crawler tags -------------------------------------------------------------------

// Bun.escapeHTML, not cleanText: cleanText removes invisible characters, and the
// dangerous ones here are the perfectly visible " and < that end an attribute and
// start a tag. A listing named `"><script>` would otherwise execute.
const e = Bun.escapeHTML;

/** The tags that differ per page but not per *kind* of page. Both callers below build
 *  the same block, so it is written once: a canonical, the card, and the size the card
 *  is drawn at so a client can reserve the space before the PNG lands.
 *
 *  `canonical` is null for a page that does not exist. A 404 that named a canonical
 *  would be asking to be indexed under it. */
function shared(canonical: string | null, image: string, alt: string): string[] {
  return [
    ...(canonical
      ? [
          `<link rel="canonical" href="${e(canonical)}" />`,
          `<meta property="og:url" content="${e(canonical)}" />`,
        ]
      : // follow, not nofollow: the links out of a 404 are the site's own nav, and
        // there is no reason to stop a crawler using them to find its way back.
        [`<meta name="robots" content="noindex, follow" />`]),
    `<meta property="og:image" content="${e(image)}" />`,
    `<meta property="og:image:width" content="${CARD_WIDTH}" />`,
    `<meta property="og:image:height" content="${CARD_HEIGHT}" />`,
    `<meta property="og:image:alt" content="${e(alt)}" />`,
    // twitter:card is not here: it is "summary_large_image" on every page, so it lives
    // in index.html outside the replaced span rather than being written out per request.
    `<meta name="twitter:image" content="${e(image)}" />`,
    `<meta name="twitter:image:alt" content="${e(alt)}" />`,
  ];
}

/** index.html carries the home page's title and description, and only those. Every
 *  other written page has to replace them here or it goes out as a copy of the board -
 *  competing with it in results instead of ranking for what it is about. */
export function pageMeta(site: string, path: string): string {
  const canonical = normalizePath(path);
  const known = isPagePath(path);
  const page = pageFor(path);

  return [
    `<title>${e(page.title)}</title>`,
    `<meta name="description" content="${e(page.description)}" />`,
    `<meta property="og:title" content="${e(page.title)}" />`,
    `<meta property="og:description" content="${e(page.description)}" />`,
    ...shared(
      known ? `${site}${canonical === "/" ? "/" : canonical}` : null,
      `${site}/og/home.png`,
      "The outmine board: the top three listings and what each has been mined to.",
    ),
  ].join("\n    ");
}

function listingMeta(listing: ListingDetail, site: string): string {
  const title = `${listing.name} — ${standing(listing)} on outmine`;
  const description = listing.tagline || `${listing.name} on outmine, a leaderboard paid for in CPU time.`;
  const image = `${site}/og/${listing.id}.png`;

  return [
    `<title>${e(title)}</title>`,
    `<meta name="description" content="${e(description)}" />`,
    `<meta property="og:title" content="${e(title)}" />`,
    `<meta property="og:description" content="${e(description)}" />`,
    // A listing short of the gate is a name and a progress bar. Indexing it would put
    // a page with nothing on it in front of someone searching for the name, and the
    // listing gets its canonical back the moment it is mined onto the board.
    ...shared(
      listing.visible ? `${site}/l/${listing.id}` : null,
      image,
      `${listing.name}, ${standing(listing)} on outmine.`,
    ),
  ].join("\n    ");
}
