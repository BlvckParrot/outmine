// The hub without a socket or a pool: everything here is reachable through addClient
// and handleMessage, neither of which touches the network until a client asks to mine.
import { expect, test } from "bun:test";
import { config } from "./config";
import {
  addClient, dropListing, handleMessage, nextCapacity, refKey, removeClient, shareInterval,
} from "./hub";

/** Enough of a ServerWebSocket for the hub: it sends and it closes. */
const socket = () => {
  const sent: string[] = [];
  const ws = { sent, send: (m: string) => sent.push(m), close: () => {}, data: {} };
  return ws as unknown as Parameters<typeof addClient>[0] & { sent: string[] };
};

let addresses = 0;
const address = () => `10.7.0.${++addresses}`;

const errors = (ws: { sent: string[] }) =>
  ws.sent.map((m) => JSON.parse(m)).filter((m) => m.t === "error").map((m) => m.message);

// --- capacity -------------------------------------------------------------------------

test("one address cannot take more than its share of sockets", () => {
  const from = address();
  const held = [];
  for (let i = 0; i < config.limits.maxClientsPerAddress; i++) {
    const client = addClient(socket(), from);
    expect(client).not.toBeNull();
    held.push(client!);
  }
  // The global ceiling is nowhere near reached; this one is what refuses.
  expect(addClient(socket(), from)).toBeNull();
  // Another visitor is unaffected by that flood.
  const other = addClient(socket(), address());
  expect(other).not.toBeNull();

  // A closed socket gives its slot back.
  removeClient(held[0]!);
  const after = addClient(socket(), from);
  expect(after).not.toBeNull();

  for (const c of [...held.slice(1), other!, after!]) removeClient(c);
});

// --- mining ---------------------------------------------------------------------------

test("a second mine in the same breath is refused before it costs anything", () => {
  const ws = socket();
  const client = addClient(ws, address())!;

  // No such listing, so neither call reaches the pool - what is under test is that the
  // second one is turned away by the cooldown rather than by the lookup.
  handleMessage(client, JSON.stringify({ t: "mine", listingId: "nope" }));
  handleMessage(client, JSON.stringify({ t: "mine", listingId: "nope" }));

  expect(errors(ws)).toEqual(["no such listing", "one moment"]);
  removeClient(client);
});

// --- traffic ---------------------------------------------------------------------------
// pageKey and refHost have their own tests in traffic.test.ts; what is here is the part
// that bounds them.

test("distinct referrer hosts are bounded, since each one is a permanent row", () => {
  // The host is neither whitelisted nor checked against a table, so without a ceiling
  // one row per socket is a row anyone can add by connecting and naming a new host.
  const keys = new Set(Array.from({ length: 2000 }, (_, i) => refKey(`h${i}.example`)));
  expect(keys.size).toBeLessThanOrEqual(501);
  expect(keys.has("(other)")).toBe(true);
  // A host already admitted keeps its own key.
  expect(refKey("h0.example")).toBe("h0.example");
});

test("a page repeated on one socket is counted once", () => {
  const client = addClient(socket(), address())!;
  const view = (path: string) => handleMessage(client, JSON.stringify({ t: "view", path }));

  view("/");
  view("/stats");
  view("/"); // said again, and alternating is what defeats a last-one-wins check

  // Two keys seen, whatever the order they were said in.
  expect(client.seen).toEqual(new Set(["page:/", "page:/stats"]));
  removeClient(client);
});

// --- how many miners share a pool socket ------------------------------------------------
// The policy, without a pool: what the controller does with a window of evidence.

test("a full socket that is slow for its miners takes fewer of them", () => {
  const target = config.pool.targetShareSeconds;
  // Sixteen miners and one accepted share in the window: everyone is waiting minutes.
  expect(shareInterval(16, 1)).toBeGreaterThan(target);
  expect(nextCapacity(16, 16, shareInterval(16, 1))).toBeLessThan(16);

  // Nothing credited at all is the same answer, arrived at without dividing by zero.
  expect(shareInterval(16, 0)).toBe(Infinity);
  expect(nextCapacity(16, 16, Infinity)).toBeLessThan(16);
});

test("one slow miner on a socket with room does not shrink it", () => {
  // A single browser that has found nothing for a window is a slow machine, not a
  // crowded socket. Shrinking on that walked capacity down to the floor while fifteen
  // slots sat empty, and the next arrivals then had to open a connection of their own.
  expect(nextCapacity(16, 1, Infinity)).toBe(16);
});

test("a full socket with shares to spare takes more", () => {
  const fast = config.pool.targetShareSeconds / 4;
  // Started below the ceiling, whatever the ceiling is here: MINERS_PER_CONNECTION is
  // read from the environment, and a test that hardcodes a number passes or fails on
  // whoever's .env happens to be next to it.
  const room = Math.max(1, config.pool.minersPerConnection - 8);
  expect(nextCapacity(room, room, fast)).toBeGreaterThan(room);

  // But only while it is full. Half-empty and fast is what half-empty looks like, and
  // growing on that evidence would let one socket swallow the next crowd.
  expect(nextCapacity(room, 1, fast)).toBe(room);
});

test("capacity stays between the floor and the configured ceiling", () => {
  // Vardiff has a floor of its own: past a point, splitting miners across more sockets
  // buys no shares and only spends connections, which is what gets an address banned.
  let capacity = config.pool.minersPerConnection;
  for (let i = 0; i < 100; i++) capacity = nextCapacity(capacity, capacity, Infinity);
  expect(capacity).toBeGreaterThanOrEqual(Math.min(4, config.pool.minersPerConnection));

  const ceiling = config.pool.minersPerConnection;
  for (let i = 0; i < 100; i++) capacity = nextCapacity(capacity, capacity, 1);
  expect(capacity).toBe(ceiling);
});

// --- takedown ---------------------------------------------------------------------------

test("a takedown detaches the miners on that listing and leaves the rest alone", () => {
  // listingId is set directly rather than through `mine`: startMining only assigns it
  // after joinConnection has opened a real pool socket, and what is under test here is
  // what dropListing does with the clients it finds, not how they got there.
  const removed = socket();
  const onRemoved = addClient(removed, address())!;
  onRemoved.listingId = "gone000000aa";

  const other = socket();
  const onOther = addClient(other, address())!;
  onOther.listingId = "stays00000bb";

  dropListing("gone000000aa");

  // Without this the miner keeps crediting into unflushed, and the next flush tries to
  // write a share_bucket for a listing that no longer exists - which fails the foreign
  // key and rolls back every other listing's shares with it. See listings.test.ts.
  expect(onRemoved.listingId).toBeNull();
  expect(errors(removed)).toContain("this listing has been removed");

  expect(onOther.listingId).toBe("stays00000bb");
  expect(errors(other)).toEqual([]);

  removeClient(onRemoved);
  removeClient(onOther);
});
