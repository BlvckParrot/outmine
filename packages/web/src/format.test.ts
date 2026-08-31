// ago() had no test, and it is now built on Intl, whose output is worth pinning:
// a locale leaking in would put French in an English row.
import { expect, test } from "bun:test";
import { ago } from "./format";

const SECOND = 1_000, MINUTE = 60 * SECOND, HOUR = 60 * MINUTE, DAY = 24 * HOUR;

test.each([
  [0, "1 second ago"],
  [500, "1 second ago"],
  [SECOND, "1 second ago"],
  [45 * SECOND, "45 seconds ago"],
  [MINUTE, "1 minute ago"],
  [90 * SECOND, "1 minute ago"],
  [59 * MINUTE, "59 minutes ago"],
  [HOUR, "1 hour ago"],
  [20 * HOUR, "20 hours ago"],
  [DAY, "1 day ago"],
  [400 * DAY, "400 days ago"],
])("%i ms ago reads as %s", (elapsed, expected) => {
  expect(ago(Date.now() - elapsed)).toBe(expected);
});

test("a timestamp in the future does not count backwards", () => {
  expect(ago(Date.now() + 60_000)).toBe("1 second ago");
});
