import { expect, test } from "bun:test";
import { cleanText, clientAddress, originAllowed, secretsMatch } from "./security";

// The characters under test are invisible. Pasting them into the source would make
// this file unreviewable - git even classifies it as binary - so they are built from
// their code points and named.
const ch = (code: number) => String.fromCharCode(code);
const NUL = ch(0x00);
const TAB = ch(0x09);
const NEWLINE = ch(0x0a);
const ZERO_WIDTH_SPACE = ch(0x200b);
const RIGHT_TO_LEFT_OVERRIDE = ch(0x202e);
const FIRST_STRONG_ISOLATE = ch(0x2068);
const POP_DIRECTIONAL_ISOLATE = ch(0x2069);

// These run with ALLOWED_ORIGINS unset, which is the shape a fresh deployment has.
// The additive case is covered end to end in hub.integration.test.ts.
const REQUEST = "http://outmine.example/ws";

test("same origin is allowed even with no origins configured", () => {
  expect(originAllowed("http://outmine.example", REQUEST)).toBe(true);
});

test("a foreign origin is refused", () => {
  // The threat: a third-party page driving mining on its own visitors' CPUs against
  // our pool account, with no consent banner in sight.
  expect(originAllowed("https://evil.example", REQUEST)).toBe(false);
});

test("a missing origin is allowed, since browsers always send one", () => {
  expect(originAllowed(undefined, REQUEST)).toBe(true);
  expect(originAllowed(null, REQUEST)).toBe(true);
});

test("an unparseable origin is refused", () => {
  expect(originAllowed("not a url", REQUEST)).toBe(false);
});

test("secrets compare equal only when identical", () => {
  expect(secretsMatch("abc123", "abc123")).toBe(true);
  expect(secretsMatch("abc123", "abc124")).toBe(false);
  expect(secretsMatch("abc", "abcdef")).toBe(false); // differing lengths must not throw
  expect(secretsMatch("", "")).toBe(true);
});

test("client address ignores a forged X-Forwarded-For when no proxy is trusted", () => {
  // The default is zero trusted proxies. Reading the header here - the obvious
  // implementation - would let anyone reset their rate limit with one header.
  const headers = new Headers({ "x-forwarded-for": "1.2.3.4, 5.6.7.8" });
  expect(clientAddress(headers, "203.0.113.9")).toBe("203.0.113.9");
});

test("client address falls back when the socket address is unknown", () => {
  expect(clientAddress(new Headers(), undefined)).toBe("unknown");
});

test("cleanText removes control characters", () => {
  expect(cleanText(`a${NUL}b${TAB}c${NEWLINE}d`)).toBe("abcd");
});

test("cleanText removes zero-width and bidi characters", () => {
  // A right-to-left override makes the rest of a board row render backwards.
  expect(cleanText(`moc${RIGHT_TO_LEFT_OVERRIDE}kilc`)).toBe("mockilc");
  expect(cleanText(`zero${ZERO_WIDTH_SPACE}width`)).toBe("zerowidth");
  expect(cleanText(`${FIRST_STRONG_ISOLATE}isolated${POP_DIRECTIONAL_ISOLATE}`)).toBe("isolated");
});

test("cleanText leaves ordinary text alone, accents and emoji included", () => {
  expect(cleanText("  Anthropic  ")).toBe("Anthropic");
  expect(cleanText("Přílíš žluťoučký kůň")).toBe("Přílíš žluťoučký kůň");
  expect(cleanText("emoji 🎉 ok")).toBe("emoji 🎉 ok");
});

test("cleanText can empty a string that looked non-empty", () => {
  // Callers must treat the result as possibly empty: a name of pure zero-width
  // characters would otherwise render as a blank row on the board.
  expect(cleanText(ZERO_WIDTH_SPACE.repeat(3))).toBe("");
});
