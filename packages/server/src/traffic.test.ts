// Counting is a one-line UPSERT; what can go wrong is what it is asked to count. Both
// the path and the referrer come from a browser and both become part of a primary key,
// so a key that is not narrowed to a fixed set is a table with no ceiling.
import { expect, test } from "bun:test";
import { pageKey, refHost } from "./hub";
import { countHit, trafficByDay, trafficTop, visitsToday } from "./listings";

test.each([
  ["/", "/"],
  ["/about", "/about"],
  ["/stats", "/stats"],
  ["/l/abc123", "/l/:id"],
  ["/l/ABC123", "/l/:id"], // the app's own route matches case-insensitively
  ["/nope", "/other"],
  ["/l/", "/other"],
  ["/l/abc123/extra", "/other"],
  [`/${"x".repeat(5000)}`, "/other"], // a key is not a place to put 5 kB
  ["", "/other"],
])("path %j counts as %j", (path, expected) => {
  expect(pageKey(path)).toBe(expected);
});

test.each([
  ["https://news.ycombinator.com/item?id=1", "news.ycombinator.com"], // host only, no path
  ["https://www.reddit.com/r/x/", "reddit.com"],
  ["https://X.COM/someone", "x.com"],
  ["https://outmine.example/l/abc", ""], // our own page is not a referral
  ["https://www.outmine.example/", ""],
  ["not a url", ""],
  ["", ""],
  [undefined, ""],
])("referrer %j reduces to %j", (ref, expected) => {
  expect(refHost(ref, "outmine.example")).toBe(expected);
});

test("hits of the same kind and key land in one row", () => {
  const start = trafficByDay(1)[0] ?? { visits: 0, pages: 0, views: 0, mines: 0 };
  const before = visitsToday();
  countHit("visit");
  countHit("visit");
  expect(visitsToday()).toBe(before + 2);

  countHit("ref", "example.com");
  countHit("ref", "example.com");
  countHit("ref", "other.example");
  const refs = trafficTop("ref");
  expect(refs.find((r) => r.key === "example.com")?.n).toBe(2);
  expect(refs.find((r) => r.key === "other.example")?.n).toBe(1);

  // Today's row exists and the kinds are pivoted into their own columns rather than
  // summed together - a page is not a visit and the conversion rate depends on it.
  countHit("page", "/");
  countHit("mine");
  const today = trafficByDay(1)[0]!;
  expect(today.visits).toBe(before + 2);
  expect(today.pages).toBe(start.pages + 1);
  expect(today.mines).toBe(start.mines + 1);
});
