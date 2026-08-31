import { afterEach, expect, test } from "bun:test";
import { list, pattern } from "./config";

// list() reads process.env at call time, so these set and clear one name rather than
// importing config with an environment - the module is a singleton read once at import,
// and every other test file in this process shares it.
const NAME = "TEST_LIST";
const FALLBACK = ["one", "two"] as const;

afterEach(() => {
  delete process.env[NAME];
});

test("an unset variable takes the fallback", () => {
  expect(list(NAME, FALLBACK)).toEqual(["one", "two"]);
});

// The reason this function exists in this shape: an empty value used to collapse into
// "unset" and hand back the fallback, which left BLOCKED_WORDS with no way to be off.
test("an empty variable is an empty list, not the fallback", () => {
  process.env[NAME] = "";
  expect(list(NAME, FALLBACK)).toEqual([]);
});

test("a set variable replaces the fallback and is split on commas", () => {
  process.env[NAME] = " a , b ,, c ";
  expect(list(NAME, FALLBACK)).toEqual(["a", "b", "c"]);
});

test("the fallback is copied, so a caller cannot edit the default", () => {
  const returned = list(NAME, FALLBACK);
  returned.push("three");
  expect(list(NAME, FALLBACK)).toEqual(["one", "two"]);
});

// --- pattern() ---------------------------------------------------------------------
//
// The values this guards - ANALYTICS_ORIGIN and ANALYTICS_SITE_ID - are spliced into a
// <script> tag in index.html and into the Content-Security-Policy header. A .env is
// operator-written, which makes a bad value a mistake rather than an attack, but the
// consequence of the mistake is script injection into every page either way.
const ORIGIN = /^https?:\/\/[a-z0-9.-]+(:\d+)?$/i;
const SITE_ID = /^[A-Za-z0-9_-]{1,64}$/;

afterEach(() => {
  delete process.env.TEST_PATTERN;
});

test("an unset value is empty, which is the feature being off", () => {
  expect(pattern("TEST_PATTERN", ORIGIN)).toBe("");
});

test("a value that fits comes back as it was written", () => {
  process.env.TEST_PATTERN = "  https://analytics.example.com  ";
  expect(pattern("TEST_PATTERN", ORIGIN)).toBe("https://analytics.example.com");
});

// Each of these would end a src="" and start something else, or close the tag outright.
// They must come back empty rather than sanitised: a half-accepted origin is a value
// nobody wrote, pointing somewhere nobody chose.
test.each([
  ['https://a.example"></script><script>alert(1)</script>', "closes the tag"],
  ["https://a.example/ onload=alert(1)", "adds an attribute"],
  ["javascript:alert(1)", "is not a scheme we asked for"],
  ["https://a.example/api/script.js", "carries a path"],
  ["https://a.example, https://b.example", "is two of them"],
])("an origin that %s is refused", (value) => {
  process.env.TEST_PATTERN = value;
  expect(pattern("TEST_PATTERN", ORIGIN)).toBe("");
});

test("a site id is letters, digits, dash and underscore, and nothing else", () => {
  process.env.TEST_PATTERN = "my-site_1";
  expect(pattern("TEST_PATTERN", SITE_ID)).toBe("my-site_1");
  process.env.TEST_PATTERN = '1" data-x="';
  expect(pattern("TEST_PATTERN", SITE_ID)).toBe("");
});
