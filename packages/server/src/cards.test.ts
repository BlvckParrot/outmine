import { expect, test } from "bun:test";
import { badgeSvg, cardSvg, homeCardSvg, points, render, standing } from "./cards";

const listing = {
  id: "abc123abc123", kind: "domain" as const, target: "acme.example",
  name: "Acme", tagline: "first", created_at: 0, visible: 1,
  clicks: 0, shares: 900, score: 0.004, rank: 1,
};

test("standing reads as a rank once the listing is on the board", () => {
  expect(standing({ rank: 1, score: 0.004 })).toBe("#1 · 4.0k pts");
  expect(standing({ rank: null, score: 0 })).toBe("in the queue");
});

test("points scales so a share is worth something readable", () => {
  expect(points(0.000002)).toBe("2");
  expect(points(0.004)).toBe("4.0k");
  expect(points(4)).toBe("4.0M");
});

test("a hostile name cannot escape the SVG", () => {
  // The listing name is submitted by anyone. SVG is XML, so an unescaped quote or
  // angle bracket ends the text element and the rest of the file is theirs.
  const hostile = { ...listing, name: `"><script>alert(1)</script>` };
  const svg = cardSvg(hostile);
  expect(svg).not.toContain("<script>");
  expect(svg).toContain("&lt;script&gt;");
});

test("badge width follows the text it holds", () => {
  const short = badgeSvg({ rank: 1, score: 0 });
  const long = badgeSvg({ rank: 123456, score: 4 });
  const widthOf = (svg: string) => Number(svg.match(/width="(\d+)"/)![1]);
  expect(widthOf(long)).toBeGreaterThan(widthOf(short));
});

test("both cards rasterise to a PNG with the bundled font", () => {
  // System fonts are off, so this fails loudly if the .ttf files stop being shipped -
  // which in a slim container would otherwise mean a card that is silently blank.
  for (const svg of [cardSvg(listing), homeCardSvg([{ name: "Acme", score: 0.004 }])]) {
    const png = render(svg);
    expect(png.length).toBeGreaterThan(1000);
    expect([...png.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
  }
});

test("a queued listing gets progress, not a lone dash at 150px", () => {
  const svg = cardSvg({ ...listing, visible: 0, rank: null, shares: 120 });
  expect(svg).toContain("in the queue");
  expect(svg).toContain("120 of");
  expect(svg).not.toContain(">—<");
});
