import { afterEach, expect, test } from "bun:test";
import { list } from "./config";

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
