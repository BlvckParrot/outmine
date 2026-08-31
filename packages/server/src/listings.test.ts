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
// an image is decided here rather than by a Content-Type the uploader chose. Every case
// below goes through a real decode: a file is accepted only if it survives being taken
// apart and written back out by our own encoder.

const PNG_1X1 = new Uint8Array(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  ),
);

/** The same PNG with a different size written into its IHDR. The bytes after it still
 *  describe one pixel, so this is a header that lies - which is the whole point. */
function pngSized(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(PNG_1X1);
  new DataView(bytes.buffer).setUint32(16, width);
  new DataView(bytes.buffer).setUint32(20, height);
  return bytes;
}

/** The same PNG with a text chunk spliced in after its IHDR - the shape a payload takes
 *  when it rides inside a file that is otherwise a perfectly valid image. A PNG chunk is
 *  its length, its type, its data and a CRC32 over the type and the data. */
function pngWithText(png: Uint8Array, payload: string): Uint8Array {
  const data = new TextEncoder().encode(`Comment\0${payload}`);
  const chunk = new Uint8Array(12 + data.length);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, data.length);
  chunk.set(new TextEncoder().encode("tEXt"), 4);
  chunk.set(data, 8);
  view.setUint32(8 + data.length, crc32(chunk.subarray(4, 8 + data.length)));

  const IHDR_END = 33; // eight bytes of signature, then a twenty-five byte IHDR
  const out = new Uint8Array(png.length + chunk.length);
  out.set(png.subarray(0, IHDR_END));
  out.set(chunk, IHDR_END);
  out.set(png.subarray(IHDR_END), IHDR_END + chunk.length);
  return out;
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** A real PNG at the size cap, drawn rather than declared. */
const pngAtCap = async (): Promise<Uint8Array> =>
  await new Bun.Image(PNG_1X1).resize(ICON_MAX_PX, ICON_MAX_PX, { fit: "fill" }).png().bytes();

test("a real png of a sane size is accepted, and comes back out as a webp", async () => {
  for (const source of [PNG_1X1, await pngAtCap()]) {
    const meta = await new Bun.Image(await checkedIcon(source)).metadata();
    expect(meta.format).toBe("webp");
    expect(meta.width).toBeLessThanOrEqual(ICON_MAX_PX);
    expect(meta.height).toBeLessThanOrEqual(ICON_MAX_PX);
  }
});

test("the smaller of the two encodings is the one kept", async () => {
  const source = await pngAtCap();
  const [lossless, lossy] = await Promise.all([
    new Bun.Image(source).webp({ lossless: true }).bytes(),
    new Bun.Image(source).webp({ quality: 90 }).bytes(),
  ]);
  // Reusing one pipeline for both encoders returns the first one's bytes twice without
  // an error, so this is the only thing standing between that bug and production.
  expect(lossless.length).not.toBe(lossy.length);
  expect((await checkedIcon(source)).length).toBe(Math.min(lossless.length, lossy.length));
});

test("what rode along in an ancillary chunk does not survive", async () => {
  const marker = "SMUGGLED".repeat(8);
  const dirty = pngWithText(PNG_1X1, marker);
  expect(Buffer.from(dirty).includes(marker)).toBe(true);

  const clean = await checkedIcon(dirty);
  expect(Buffer.from(clean).includes(marker)).toBe(false);
  expect((await new Bun.Image(clean).metadata()).format).toBe("webp");
});

test("a valid header over a body of garbage is refused", async () => {
  // The shape the old header-only check accepted: eight good bytes, an IHDR, then
  // sixty kilobytes of whatever the sender liked, served back from our own origin.
  const garbage = new Uint8Array(60_000).fill(0x42);
  const bytes = new Uint8Array(PNG_1X1.length + garbage.length);
  bytes.set(PNG_1X1.subarray(0, 33));
  bytes.set(garbage, 33);
  await expect(checkedIcon(bytes)).rejects.toThrow();
});

test.each([
  // The jpeg and the gif are refused for being truncated rather than for their format:
  // a whole one of either is now taken and re-encoded. SVG is refused for its format and
  // always will be - it is a scriptable document and it would be served from our origin.
  ["truncated jpeg", new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...new Array(40).fill(0)])],
  ["truncated gif", new Uint8Array([...new TextEncoder().encode("GIF89a"), ...new Array(40).fill(0)])],
  ["svg", new TextEncoder().encode(`<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>`)],
  ["empty", new Uint8Array()],
  ["png signature with no IHDR", new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new Array(40).fill(0)])],
])("%s is refused", async (_name, bytes) => {
  await expect(checkedIcon(bytes)).rejects.toThrow();
});

test.each([
  [ICON_MAX_PX + 1, ICON_MAX_PX],
  [ICON_MAX_PX, ICON_MAX_PX + 1],
  [10_000, 10_000], // a few hundred bytes on the wire, gigabytes decoded
  [0, 8],
])("a png declaring %ix%i is refused", async (width, height) => {
  await expect(checkedIcon(pngSized(width, height))).rejects.toThrow();
});

test("a file past the byte ceiling is refused before it is decoded", async () => {
  const huge = new Uint8Array(config.limits.maxIconBytes + 1);
  huge.set(PNG_1X1);
  await expect(checkedIcon(huge)).rejects.toThrow();
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
