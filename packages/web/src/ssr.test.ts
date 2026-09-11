// The crawler renderer fails silently by design: share.ts swallows a throw and serves
// the empty #root the site shipped before it. That is right for a live request and
// wrong for a regression - it means someone can reach for `location` or `document` in
// a page component, lose every crawler's copy of the site, and see nothing break.
//
// So this asserts the markup is actually there. Run against the source, not the
// bundle: no build step, and it fails in the pull request rather than in production.
import { expect, test } from "bun:test";
import type { BoardSnapshot } from "@outmine/protocol";
import { renderPath } from "./ssr";

const board: BoardSnapshot = {
  entries: [{
    id: "abc123", kind: "domain", target: "example.com", name: "Example",
    tagline: "a listing", created_at: 1, clicks: 0, shares: 40,
    score: 1, has_icon: 1, hashrate: 0, miners: 0,
  }],
  pending: [], total: 1, limit: 50, threshold: 10, iconMinPoints: 20_000,
  maxNameLength: 40, maxTaglineLength: 100, online: 0, mining: 0, hashrate: 0,
  feed: [{ ts: 1, text: "Example mined its way onto the board" }],
};

// Prose is the only thing on this site a search engine can rank, and it lives in these
// components rather than in any string the server owns.
test.each(["/about", "/rules", "/faq", "/support"])("%s renders its prose", (path) => {
  const html = renderPath(path, board);
  expect(html.length).toBeGreaterThan(500);
  expect(html).toContain("<h1");
});

test.each(["/", "/about", "/faq"])("%s carries the site's internal links", (path) => {
  // Header and Footer are every link between pages. Before they were rendered here a
  // crawler on /about had no route to /rules, /faq, /stats or /support at all.
  const html = renderPath(path, board);
  for (const to of ["/", "/about", "/rules", "/faq", "/stats", "/support"]) {
    expect(html).toContain(`href="${to}"`);
  }
});

test("the board links to its listings", () => {
  // The board is a WebSocket render, so before this the sitemap was the only route a
  // crawler had to a listing page.
  expect(renderPath("/", board)).toContain('href="/l/abc123"');
});

test("URLs built during render are root-relative", () => {
  // apiUrl falls back to location.origin, which ssr.tsx stubs as "". Absolute URLs
  // here would bake one host into every page the server renders for all of them.
  const html = renderPath("/", board);
  expect(html).toContain('src="/icon/abc123.webp"');
  expect(html).not.toContain("undefined/");
});

test.each(["/stats", "/l/abc123", "/nope"])("%s renders nothing", (path) => {
  // Not a failure: /stats and a listing page both fetch in an effect, so rendering
  // them server-side would put "Loading…" in front of a crawler.
  expect(renderPath(path, board)).toBe("");
});
