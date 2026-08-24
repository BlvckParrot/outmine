import { expect, test } from "bun:test";
import { likePattern, normalizeTarget } from "./listings";

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
