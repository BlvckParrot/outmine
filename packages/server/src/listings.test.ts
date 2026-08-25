import { expect, test } from "bun:test";
import { ICON_MAX_PX } from "@outmine/protocol";
import { config } from "./config";
import {
  checkedIcon, createListing, creditShares, deleteListing, getListing, likePattern,
  normalizeTarget,
} from "./listings";

test.each([
  // input                                    -> canonical
  ["https://Example.COM/path/", "example.com/path"],
  ["example.com", "example.com"],
  ["http://www.example.com", "example.com"],
  ["https://example.com/p?utm_source=x&ref=y", "example.com/p"],
  ["https://example.com/r?tag=aff-20", "example.com/r"], // stripping the query kills the affiliate tag
  ["https://example.com/p#section", "example.com/p"],
  ["  https://example.com  ", "example.com"],
])("domain %s normalizes to %s", (input, expected) => {
  expect(normalizeTarget("domain", input)).toBe(expected);
});

test.each([
  ["@Jack", "jack"],
  ["jack", "jack"],
  ["https://x.com/jack", "jack"],
  ["https://twitter.com/jack", "jack"],
])("handle %s normalizes to %s", (input, expected) => {
  expect(normalizeTarget("handle", input)).toBe(expected);
});

test.each([
  ["https://bit.ly/abc", "shortener"],
  ["https://t.co/abc", "shortener"],
  ["https://amzn.to/xyz", "shortener"],
  ["not a url at all", "invalid"],
  ["https://localhost:3000", "invalid"],
  ["ftp://example.com", "invalid"],
  ["", "invalid"],
])("domain %s is rejected", (input) => {
  expect(() => normalizeTarget("domain", input)).toThrow();
});

test.each([["@a b", "invalid"], ["", "invalid"], ["@" + "x".repeat(60), "invalid"]])(
  "handle %s is rejected",
  (input) => {
    expect(() => normalizeTarget("handle", input)).toThrow();
  },
);

test("query stripping cannot be bypassed by a second question mark", () => {
  expect(normalizeTarget("domain", "https://example.com/a??utm=1")).toBe("example.com/a");
});

test.each([
  // a search for a wildcard must look for that character, not match everything
  ["%", "%\\%%"],
  ["_", "%\\_%"],
  ["100%_off", "%100\\%\\_off%"],
  ["c:\\dev", "%c:\\\\dev%"], // the escape character itself needs escaping first
  ["acme", "%acme%"],
])("search %j becomes the LIKE pattern %j", (input, expected) => {
  expect(likePattern(input)).toBe(expected);
});

// --- uploaded icons ------------------------------------------------------------------
// The endpoint takes raw bytes from anyone holding an edit token, so what is and is not
// a PNG is decided here rather than by a Content-Type the uploader chose.

const PNG_1X1 = new Uint8Array(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  ),
);

/** The same PNG with a different size written into its IHDR. Only the header is read,
 *  so this is enough to exercise the dimension cap. */
function pngSized(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(PNG_1X1);
  new DataView(bytes.buffer).setUint32(16, width);
  new DataView(bytes.buffer).setUint32(20, height);
  return bytes;
}

test("a real png of a sane size is accepted", () => {
  expect(checkedIcon(PNG_1X1)).toBe(PNG_1X1);
  expect(checkedIcon(pngSized(ICON_MAX_PX, ICON_MAX_PX))).toBeTruthy();
});

test.each([
  // A JPEG, a GIF and an SVG all decode in a browser; none of them may be stored.
  // SVG especially: it is a scriptable document and it would be served from our origin.
  ["jpeg", new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...new Array(40).fill(0)])],
  ["gif", new Uint8Array([...new TextEncoder().encode("GIF89a"), ...new Array(40).fill(0)])],
  ["svg", new TextEncoder().encode(`<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>`)],
  ["empty", new Uint8Array()],
  ["png signature with no IHDR", new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new Array(40).fill(0)])],
])("%s is refused", (_name, bytes) => {
  expect(() => checkedIcon(bytes)).toThrow();
});

test.each([
  [ICON_MAX_PX + 1, ICON_MAX_PX],
  [ICON_MAX_PX, ICON_MAX_PX + 1],
  [10_000, 10_000], // a few hundred bytes on the wire, gigabytes decoded
  [0, 8],
])("a png declaring %ix%i is refused", (width, height) => {
  expect(() => checkedIcon(pngSized(width, height))).toThrow();
});

test("a file past the byte ceiling is refused before its header is trusted", () => {
  const huge = new Uint8Array(config.limits.maxIconBytes + 1);
  huge.set(PNG_1X1);
  expect(() => checkedIcon(huge)).toThrow();
});

// --- the foreign key that makes a takedown dangerous ----------------------------------

test("a share batch naming a deleted listing takes every other listing down with it", () => {
  const alive = createListing({ kind: "domain", target: "alive-fk.example.com", name: "Alive" }).listing;
  const doomed = createListing({ kind: "domain", target: "doomed-fk.example.com", name: "Doomed" }).listing;
  deleteListing(doomed.id);

  // share_buckets.listing_id REFERENCES listings(id) with foreign_keys ON, and
  // creditShares runs the whole batch in one transaction.
  expect(() =>
    creditShares([
      [alive.id, { shares: 5, diffSum: 5 }],
      [doomed.id, { shares: 5, diffSum: 5 }],
    ]),
  ).toThrow();

  // The rollback is the whole point: the healthy listing was credited nothing, and the
  // hub keeps its counters and retries the same poisoned batch forever. hub.dropListing
  // is what stops a deleted id from reaching this list - see the DELETE route.
  expect(getListing(alive.id)!.shares).toBe(0);
});

test("the same batch without the deleted listing credits normally", () => {
  const alive = createListing({ kind: "domain", target: "alive-ok.example.com", name: "Fine" }).listing;
  creditShares([[alive.id, { shares: 5, diffSum: 5 }]]);
  expect(getListing(alive.id)!.shares).toBe(5);
});
