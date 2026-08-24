// The WebSocket contract, shared by the server and the browser.
//
// These used to be written twice, and they drifted: `pending` was added to the hub
// and neither the client nor /api/board learned about it. One definition, both sides.

export type ListingKind = "domain" | "handle";

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
};

export type FeedItem = { ts: number; text: string };

export type BoardSnapshot = {
  entries: BoardEntry[];
  /** Listings that have not cleared the proof-of-work gate yet. They stay visible so
   *  somebody can mine them onto the board; hiding them would make the gate a wall. */
  pending: BoardEntry[];
  threshold: number;
  online: number;
  mining: number;
  feed: FeedItem[];
};

export type ServerMessage =
  | ({ t: "board" } & BoardSnapshot)
  | { t: "job"; jobId: string; header: string; target: string }
  | { t: "shareResult"; ok: boolean; error: string | null }
  | { t: "error"; message: string };

export type ClientMessage =
  | { t: "mine"; listingId: string }
  | { t: "stop" }
  | { t: "share"; jobId: string; nonce: number }
  | { t: "hashrate"; hs: number };

/** Score is a sum of pool difficulties, around 0.000002 per share. Raw, every listing
 *  reads "0 pts"; scaled, one share is worth a couple of points. */
export const POINT_SCALE = 1e6;

// --- REST-only shapes -------------------------------------------------------------
// The WebSocket only ever pushes the unfiltered top of the board. Anything filtered,
// paged or aggregated is a request the client makes, so these types live apart from
// the socket contract above.

export type TrendingItem = { id: string; name: string; target: string; recent: number };

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
  /** Position on the all-time board, or null while the listing is still short of the
   *  proof-of-work gate and therefore not on it. */
  rank: number | null;
};
