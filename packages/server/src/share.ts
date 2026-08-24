// Everything a shared link needs: a listing's own page, its preview card, its badge.
//
// The drawing lives in cards.ts; this is the HTTP layer over it, kept apart from
// routes.ts because none of it is API surface - it exists for crawlers, chat clients
// and READMEs, which have their own rules about absolute URLs and escaping.
import { Hono, type Context } from "hono";
import type { ListingDetail } from "@outmine/protocol";
import { badgeSvg, cardPng, homeCardPng, standing } from "./cards";
import { config } from "./config";
import { getListing, listBoard, listingRank } from "./listings";

export const share = new Hono();

/** Where a crawler will fetch our images from. Configured wins; otherwise the request
 *  itself, which is right in development and behind a proxy we control. */
export const origin = (c: { req: { url: string } }) =>
  config.publicOrigin || new URL(c.req.url).origin;

/** Replaced in index.html. A marker rather than a regex over the head: this runs on
 *  every crawler hit and a parse would be both slower and easier to get wrong. */
export const OG_MARKER = "<!--og-->";

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
  // A function replacement, not a string: $&, $` and $' are replacement patterns, and
  // Bun.escapeHTML does not escape $, so a listing named `$\`` would otherwise splice
  // the surrounding page into its own <title>.
  return c.html(listing ? html.replace(OG_MARKER, () => listingMeta(listing, origin(c))) : html);
});

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

/** og:image has to be absolute, and index.html is a static file that cannot know the
 *  host it will be served from. Hence the same stitching the listing pages use. */
export function siteMeta(site: string): string {
  const image = `${site}/og/home.png`;
  return [
    `<meta property="og:url" content="${Bun.escapeHTML(site)}/" />`,
    `<meta property="og:image" content="${Bun.escapeHTML(image)}" />`,
    `<meta name="twitter:image" content="${Bun.escapeHTML(image)}" />`,
  ].join("\n    ");
}
