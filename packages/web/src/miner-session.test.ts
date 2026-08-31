// No DOM here: `send` takes the socket as an argument precisely so the one rule that
// matters about it can be checked without a browser.
import { expect, test } from "bun:test";
import { send } from "./miner-session";

/** A socket in a given readyState that records what reached it - and throws the way a
 *  real one does when it is not open yet. */
const socket = (readyState: number) => {
  const sent: string[] = [];
  return {
    sent,
    readyState,
    send(payload: string) {
      if (readyState !== WebSocket.OPEN) throw new Error("InvalidStateError");
      sent.push(payload);
    },
  };
};

test.each([
  ["CONNECTING", WebSocket.CONNECTING],
  ["CLOSING", WebSocket.CLOSING],
  ["CLOSED", WebSocket.CLOSED],
])("a %s socket is not sent to, and does not throw", (_name, state) => {
  const ws = socket(state);
  // The whole point. `ws?.send(...)` guards null and not readyState, and the throw used
  // to escape stop() before the workers were told - leaving every core busy with the
  // panel, and the stop button, gone from the page.
  expect(() => send(ws as unknown as WebSocket, { t: "stop" })).not.toThrow();
  expect(send(ws as unknown as WebSocket, { t: "stop" })).toBe(false);
  expect(ws.sent).toEqual([]);
});

test("a null socket is not sent to", () => {
  expect(send(null, { t: "stop" })).toBe(false);
});

test("an open socket gets the payload as JSON, and a string through unchanged", () => {
  const ws = socket(WebSocket.OPEN);
  expect(send(ws as unknown as WebSocket, { t: "mine", listingId: "abc" })).toBe(true);
  // A queued pageview is already serialised; re-encoding it would double-quote it.
  expect(send(ws as unknown as WebSocket, '{"t":"view","path":"/"}')).toBe(true);
  expect(ws.sent).toEqual(['{"t":"mine","listingId":"abc"}', '{"t":"view","path":"/"}']);
});
