// The path table, which decides three things at once: what the server writes into the
// head, what status it answers with, and which component the client renders. All three
// read these functions, so a disagreement between them would show up here first.
import { expect, test } from "bun:test";
import { isKnownPath, isListingPath, isPagePath, NOT_FOUND_PAGE, pageFor, PAGES, normalizePath } from "./index";

test("the spellings of the same page normalise to one", () => {
  // /index.html and / are both routed, and a typed trailing slash is neither a
  // redirect nor a 404. Each is a separate URL a crawler would index on its own.
  expect(normalizePath("/index.html")).toBe("/");
  expect(normalizePath("/about/")).toBe("/about");
  expect(normalizePath("/about//")).toBe("/about");
  expect(normalizePath("/")).toBe("/");
  expect(normalizePath("//")).toBe("/");
  expect(normalizePath("/about")).toBe("/about");
});

test("a page is known by any of its spellings", () => {
  expect(isPagePath("/faq")).toBe(true);
  expect(isPagePath("/faq/")).toBe(true);
  expect(isPagePath("/index.html")).toBe(true);
  expect(isPagePath("/wp-admin")).toBe(false);
  // The lookup is Object.hasOwn, not `in`: `in` answers true for every prototype
  // method and would hand a function to whatever asked for a page.
  expect(isPagePath("/toString")).toBe(false);
  expect(isPagePath("/constructor")).toBe(false);
});

test("listing paths are the one dynamic shape", () => {
  expect(isListingPath("/l/3eb1a3a4be52")).toBe(true);
  expect(isListingPath("/l/")).toBe(false);
  expect(isListingPath("/l/has-a-dash")).toBe(false);
  expect(isListingPath("/l/a/b")).toBe(false);
});

test("anything else is not a path this site has", () => {
  // The server answers 404 on this and the client renders "not found" on it. Before
  // both did, every mistyped URL was another indexable copy of the board.
  expect(isKnownPath("/")).toBe(true);
  expect(isKnownPath("/l/abc123")).toBe(true);
  expect(isKnownPath("/wp-admin")).toBe(false);
  expect(isKnownPath("/about/../etc")).toBe(false);
});

test("every page has a title and description, and a stranger gets the not-found pair", () => {
  for (const [path, page] of Object.entries(PAGES)) {
    expect(pageFor(path)).toBe(page);
    expect(page.title.length).toBeGreaterThan(0);
    // Long enough to say something, short enough that a result snippet keeps it.
    expect(page.description.length).toBeGreaterThan(50);
    expect(page.description.length).toBeLessThanOrEqual(160);
  }
  expect(pageFor("/nope")).toBe(NOT_FOUND_PAGE);
});

test("no two pages share a title or a description", () => {
  // The whole point of the table. /about, /rules, /faq and /stats used to go out
  // carrying the home page's title and description, competing with it in results
  // instead of ranking for what each is about.
  const pages = Object.values(PAGES);
  expect(new Set(pages.map((p) => p.title)).size).toBe(pages.length);
  expect(new Set(pages.map((p) => p.description)).size).toBe(pages.length);
});
