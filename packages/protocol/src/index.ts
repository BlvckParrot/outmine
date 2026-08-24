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
