// Share surfaces: the badge people paste into a README and the image a link preview
// shows. Both are the same few numbers drawn two ways.
//
// The card has to be a raster image. X, Slack and Facebook all refuse an SVG as
// og:image, so the SVG below is rendered to PNG on the way out. The badge stays SVG,
// which is what shields-style badges are and what GitHub renders happily.
import { Resvg } from "@resvg/resvg-js";
import { points, type ListingDetail } from "@outmine/protocol";
import { config } from "./config";

const FONT_DIR = new URL("../assets/", import.meta.url).pathname;
const FONTS = [`${FONT_DIR}JetBrainsMono-Regular.ttf`, `${FONT_DIR}JetBrainsMono-Bold.ttf`];
const FONT_FAMILY = "JetBrains Mono";

/** JetBrains Mono advances 600/1000 of an em per glyph. Every glyph, which is the
 *  point of a monospace face and the reason a badge can be laid out with arithmetic
 *  instead of a text measuring pass. */
/** The share surfaces stay dark in both site themes: a card lands in someone else's
 *  feed and a badge in someone else's README, neither of which we get to theme. Dark
 *  with gold is the site's night side, and it reads on white and on black alike. */
const INK = "#14100c";
const GOLD = "#e0a53a";
const PAPER = "#f7f2e8";
const DIM = "#a89880";
const FAINT = "#6b5c47";

const ADVANCE = 0.6;
const textWidth = (text: string, size: number) => Math.ceil(text.length * size * ADVANCE);

/** SVG is XML: an unescaped listing name closes the text element and the rest of the
 *  document is whatever the submitter wrote. */
function escapeXml(value: string): string {
  return value.replace(/[<>&"']/g, (ch) =>
    ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[ch]!);
}

const truncate = (value: string, max: number) =>
  value.length <= max ? value : `${value.slice(0, max - 1)}…`;

/** The line a badge and a card both lead with. */
export const standing = (listing: Pick<ListingDetail, "rank" | "score">) =>
  listing.rank ? `#${listing.rank} · ${points(listing.score)} pts` : "in the queue";

// --- badge ------------------------------------------------------------------------

const BADGE_HEIGHT = 20;
const BADGE_FONT = 11;
const BADGE_PADDING = 8;

export function badgeSvg(listing: Pick<ListingDetail, "rank" | "score">): string {
  const label = "outmine";
  const value = standing(listing);
  const labelWidth = textWidth(label, BADGE_FONT) + BADGE_PADDING * 2;
  const valueWidth = textWidth(value, BADGE_FONT) + BADGE_PADDING * 2;
  const total = labelWidth + valueWidth;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${total}" height="${BADGE_HEIGHT}" role="img" aria-label="${escapeXml(`${label}: ${value}`)}">
  <rect width="${total}" height="${BADGE_HEIGHT}" rx="3" fill="${INK}"/>
  <rect x="${labelWidth}" width="${valueWidth}" height="${BADGE_HEIGHT}" rx="3" fill="${GOLD}"/>
  <rect x="${labelWidth}" width="4" height="${BADGE_HEIGHT}" fill="${GOLD}"/>
  <g font-family="${FONT_FAMILY},monospace" font-size="${BADGE_FONT}">
    <text x="${BADGE_PADDING}" y="14" fill="${DIM}">${escapeXml(label)}</text>
    <text x="${labelWidth + BADGE_PADDING}" y="14" fill="${INK}" font-weight="bold">${escapeXml(value)}</text>
  </g>
</svg>`;
}

// --- share card ---------------------------------------------------------------------

/** Exported so the og:image:width/height tags in share.ts quote the size the card is
 *  actually drawn at rather than a copy of it that can go stale. */
export const CARD_WIDTH = 1200;
export const CARD_HEIGHT = 630;

export function cardSvg(listing: ListingDetail): string {
  const name = escapeXml(truncate(listing.name, 26));
  const tagline = escapeXml(truncate(listing.tagline || displayTarget(listing), 52));
  // A queued listing has no rank, and a dash set at 150px reads as a rendering fault
  // rather than as an absence. It gets its progress instead - which is also the more
  // useful thing to put in front of whoever the link reached.
  const headline = listing.rank
    ? { text: `#${listing.rank}`, size: 150 }
    : { text: "in the queue", size: 76 };
  const footing = listing.rank
    ? `${points(listing.score)} pts · ${listing.shares} share${listing.shares === 1 ? "" : "s"}`
    : `${listing.shares} of ${config.board.visibilityThreshold} shares needed`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_WIDTH}" height="${CARD_HEIGHT}">
  <rect width="${CARD_WIDTH}" height="${CARD_HEIGHT}" fill="${INK}"/>
  <rect x="0" y="0" width="${CARD_WIDTH}" height="6" fill="${GOLD}"/>
  <g font-family="${FONT_FAMILY},monospace">
    <text x="72" y="112" font-size="28" fill="${FAINT}">outmine</text>
    <text x="72" y="250" font-size="${headline.size}" font-weight="bold" fill="${GOLD}">${headline.text}</text>
    <text x="72" y="360" font-size="60" font-weight="bold" fill="${PAPER}">${name}</text>
    <text x="72" y="412" font-size="28" fill="${DIM}">${tagline}</text>
    <text x="72" y="516" font-size="34" fill="${PAPER}">${footing}</text>
    <text x="72" y="566" font-size="24" fill="${FAINT}">a leaderboard paid for in CPU time, not money</text>
  </g>
</svg>`;
}

const displayTarget = (listing: ListingDetail) =>
  listing.kind === "handle" ? `@${listing.target}` : listing.target;

/** Rendered PNGs, briefly. A crawler fetches this once, but the URL is public and
 *  rasterising on every request is a way to hand anyone our CPU - on a site whose
 *  whole subject is CPU, that would be a poor joke. */
const CACHE_TTL_MS = 60_000;
const CACHE_MAX = 200;
const cache = new Map<string, { png: Buffer; at: number }>();

export function cardPng(listing: ListingDetail): Buffer {
  // Rank, not score. Score moves on every flush for any listing anyone is mining, so a
  // score in the key changed the key faster than the TTL could ever expire it - the
  // cache missed on exactly the listings being shared, which are the ones it is for.
  // A card up to CACHE_TTL_MS out of date is a social preview, not the board.
  const key = `${listing.id}:${listing.rank}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.png;

  const png = render(cardSvg(listing));

  // Oldest first, which for a Map is insertion order. Good enough: entries expire on
  // their own and this only bounds a burst.
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value!);
  cache.set(key, { png, at: Date.now() });
  return png;
}

/** The home card takes no parameters, so one buffer is the whole cache. Without it this
 *  is the cheapest request on the site to send and the most expensive to answer: resvg
 *  is synchronous, so every hit blocks the loop that also serves the board broadcast and
 *  the pool sockets. */
let homeCard: { png: Buffer; at: number } | null = null;

export function homeCardPng(top: { name: string; score: number }[]): Buffer {
  if (homeCard && Date.now() - homeCard.at < CACHE_TTL_MS) return homeCard.png;
  const png = render(homeCardSvg(top));
  homeCard = { png, at: Date.now() };
  return png;
}

export function render(svg: string): Buffer {
  return new Resvg(svg, {
    // The bundled font is passed explicitly and system fonts are off. A slim container
    // has no fonts installed at all, so relying on fontconfig would render a card that
    // looks right here and is blank in production.
    font: { fontFiles: FONTS, loadSystemFonts: false, defaultFontFamily: FONT_FAMILY },
    fitTo: { mode: "width", value: CARD_WIDTH },
  }).render().asPng();
}

/** The default card for every page that is not a single listing. Shows the top of the
 *  board, so a link to the site says what the site is rather than repeating its name. */
export function homeCardSvg(top: { name: string; score: number }[]): string {
  // Three slots, always, filled or not. This used to map over `top` itself, which meant
  // an empty board drew nothing below the tagline and the card went out two thirds
  // black - on the one image every share of the site renders, and the one social
  // networks cache for days off a URL with no cache-buster. A slot standing empty says
  // the place is open, which at launch is the true and the more interesting reading.
  const rows = Array.from({ length: 3 }, (_, i) => top[i]).map((entry, i) => `
    <text x="72" y="${330 + i * 62}" font-size="40" fill="${
      entry ? (i === 0 ? PAPER : DIM) : FAINT
    }">${escapeXml(`${i + 1}. ${entry ? truncate(entry.name, 22) : "unclaimed"}`)}</text>${
      entry
        ? `
    <text x="1128" y="${330 + i * 62}" font-size="40" text-anchor="end" fill="${GOLD}">${points(entry.score)}</text>`
        : ""
    }`).join("");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_WIDTH}" height="${CARD_HEIGHT}">
  <rect width="${CARD_WIDTH}" height="${CARD_HEIGHT}" fill="${INK}"/>
  <rect x="0" y="0" width="${CARD_WIDTH}" height="6" fill="${GOLD}"/>
  <g font-family="${FONT_FAMILY},monospace">
    <text x="72" y="140" font-size="72" font-weight="bold" fill="${PAPER}">outmine</text>
    <text x="72" y="200" font-size="30" fill="${DIM}">a leaderboard you cannot buy — rank is paid in CPU time</text>
    ${rows}
  </g>
</svg>`;
}
