// The WebSocket contract, shared by the server and the browser.
//
// These used to be written twice, and they drifted: `pending` was added to the hub
// and neither the client nor /api/board learned about it. One definition, both sides.

export type ListingKind = "domain" | "handle";

/** Which proof-of-work the pool is being mined with. The browser needs it to load the
 *  matching WASM module: hashing MinotaurX at a RinHash pool is not an error anywhere,
 *  it just means every single share is rejected. */
export const MINER_ALGOS = ["minotaurx", "rinhash"] as const;
export type MinerAlgo = (typeof MINER_ALGOS)[number];

export type BoardEntry = {
  id: string;
  kind: ListingKind;
  target: string;
  name: string;
  tagline: string;
  created_at: number;
  clicks: number;
  shares: number;
  /** Sum of pool difficulty over accepted shares. Tiny numbers - the UI scales it. */
  score: number;
  /** Live, summed over everyone currently mining for this listing. */
  hashrate: number;
  /** How many people are mining for this listing right now. Hashrate alone cannot
   *  say this: one machine with sixteen threads and sixteen visitors look alike. */
  miners: number;
  /** 1 once the owner has uploaded an icon, so a row knows to fetch /icon/:id.png
   *  instead of drawing the first letter. A flag rather than the bytes: fifty rows of
   *  inlined PNG would be a megabyte of board snapshot every two seconds. */
  has_icon: number;
};

export type FeedItem = { ts: number; text: string };

export type BoardSnapshot = {
  entries: BoardEntry[];
  /** Listings that have not cleared the proof-of-work gate yet. They stay visible so
   *  somebody can mine them onto the board; hiding them would make the gate a wall. */
  pending: BoardEntry[];
  /** Listings on the board in total, not the number in `entries`. The socket only
   *  ever sends the first page, so without this the client cannot know a second page
   *  exists and the pager never appears on the default view. */
  total: number;
  /** Page size the board is cut into, so the client can turn `total` into pages. */
  limit: number;
  threshold: number;
  /** Points a listing must reach before its owner can upload an icon. Sent for the
   *  same reason as `threshold`: the gate is the server's to set, and the owner has
   *  to be told what they are mining towards. */
  iconMinPoints: number;
  online: number;
  mining: number;
  feed: FeedItem[];
};

export type ServerMessage =
  | ({ t: "board" } & BoardSnapshot)
  /** `algo` rides along with the work rather than being announced once: it is needed
   *  exactly when a job is, and a reconnect to a server configured differently then
   *  cannot leave a worker hashing the wrong function. */
  | { t: "job"; jobId: string; header: string; target: string; algo: MinerAlgo }
  | { t: "shareResult"; ok: boolean; error: string | null }
  | { t: "error"; message: string };

export type ClientMessage =
  | { t: "mine"; listingId: string }
  | { t: "stop" }
  | { t: "share"; jobId: string; nonce: number }
  | { t: "hashrate"; hs: number };

/** Longest side of an uploaded icon. The board draws it at 56 CSS pixels, so 128
 *  covers a 2x display with nothing left over. The browser resizes to exactly this
 *  before uploading and the server refuses anything larger - a dimension cap is what
 *  stops a small file from decompressing into hundreds of megabytes. */
export const ICON_MAX_PX = 128;

/** Score is a sum of pool difficulties, around 0.000002 per share. Raw, every listing
 *  reads "0 pts"; scaled, one share is worth a couple of points. */
export const POINT_SCALE = 1e6;

/** 1234 -> "1.2k". Hashrates, shares and scores all span several orders of magnitude
 *  and a raw number in a table column is unreadable at either end.
 *
 *  Here rather than on one side because both sides print the same numbers, and they
 *  disagreed: the browser rounded millions to two decimals and the share card to one,
 *  so a listing page and its own badge showed different scores. */
export function compact(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return Math.round(n).toString();
}

/** A raw score as the points everything displays. Scaling belongs in here: leaving it
 *  to each caller was the other half of the same disagreement. */
export const points = (score: number) => compact(score * POINT_SCALE);

// --- REST-only shapes -------------------------------------------------------------
// The WebSocket only ever pushes the unfiltered top of the board. Anything filtered,
// paged or aggregated is a request the client makes, so these types live apart from
// the socket contract above.

export type TrendingItem = {
  id: string; name: string; target: string; has_icon: number; recent: number;
};

/** GET /api/board. `total` is the number of listings matching the filter, not the
 *  number returned, so the client knows whether another page exists. */
export type BoardPageResponse = {
  entries: BoardEntry[];
  pending: BoardEntry[];
  total: number;
  pendingTotal: number;
  /** Page size the server actually applied, which it clamps. The client needs it to
   *  step the offset; guessing from the row count breaks on the last page. */
  limit: number;
  threshold: number;
  online: number;
};

export type StatsResponse = {
  listings: number;
  onBoard: number;
  shares: number;
  score: number;
  clicks: number;
  shares24h: number;
  online: number;
  mining: number;
  poolConnections: number;
};

/** GET /api/listings/:id. Carries `rank` because the client cannot work it out: it
 *  only ever holds one page of the board. */
export type ListingDetail = {
  id: string;
  kind: ListingKind;
  target: string;
  name: string;
  tagline: string;
  created_at: number;
  visible: number;
  clicks: number;
  shares: number;
  score: number;
  has_icon: number;
  /** Position on the all-time board, or null while the listing is still short of the
   *  proof-of-work gate and therefore not on it. */
  rank: number | null;
};
