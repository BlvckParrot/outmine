// The hub without a socket or a pool: everything here is reachable through addClient
// and handleMessage, neither of which touches the network until a client asks to mine.
import { expect, test } from "bun:test";
import { config } from "./config";
import { addClient, handleMessage, refKey, removeClient } from "./hub";

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
