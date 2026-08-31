import { expect, test } from "bun:test";
import { compact, points, POINT_SCALE } from "./index";

test("compact keeps big numbers readable", () => {
  expect(compact(0)).toBe("0");
  expect(compact(999)).toBe("999");
  expect(compact(1_500)).toBe("1.5k");
  expect(compact(4_000_000)).toBe("4.0M");
});

test("points scales a raw score for display", () => {
  expect(points(0.000002)).toBe("2"); // one accepted share
  expect(points(0.004)).toBe("4.0k");
  expect(points(4)).toBe("4.0M");
});

test("one rounding rule, so a listing page and its badge cannot disagree", () => {
  // This is the regression. The browser rounded millions to two decimals and the share
  // card to one, so above a million the same listing printed "4.00M" in one place and
  // "4.0M" in the other. Both sides now call the functions above and nothing else.
  const score = 4.2;
  expect(points(score)).toBe(compact(score * POINT_SCALE));
});
