// The live connection and the worker pool, as one hook.
//
// Lifted out of App so that file is layout again. It has to live above the router:
// a page that owned the socket would stop mining the moment somebody opened /about.
import { useEffect, useRef, useState } from "react";
import type { BoardSnapshot, ServerMessage } from "@outmine/protocol";
import { wsUrl } from "./api";
import { Miner } from "./mining";
import { rememberListing } from "./storage";

const EMPTY: BoardSnapshot = {
  entries: [], pending: [], total: 0, limit: 1, threshold: 1, iconMinPoints: Infinity,
  maxNameLength: 60, maxTaglineLength: 200, online: 0, mining: 0, feed: [],
};

/** Reconnect delay, doubling up to the ceiling and reset by a connection that opens.
 *
 *  With a fixed delay every visitor comes back in the same second after a restart, and
 *  each arrival costs the server a board snapshot - so the moment it has least to spare
 *  is the moment it is asked for the most. The jitter is what actually spreads them;
 *  the backoff is what stops a server that is down from being asked every two seconds
 *  by everyone who was watching. */
const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
const HASHRATE_REPORT_MS = 3_000;

/** How long to wait before asking for a mining slot again, and how far apart to spread
 *  those retries. Spread because everyone turned away was turned away at once, and a
 *  crowd that all comes back in the same second is the same crowd. */
const RETRY_MIN_MS = 5_000;
const RETRY_SPREAD_MS = 10_000;

/** Module scope rather than a ref, so it survives a reconnect and only resets on a real
 *  page load - which is exactly what "one visit" means. The referrer rides along with
 *  it because it describes the load, not the page. */
let firstView = true;

/** Sends only when the socket is actually open, and says whether it did.
 *
 *  `ws.current?.send(...)` guards null, not readyState. The socket is assigned
 *  synchronously on creation, so it is non-null and CONNECTING for the whole of every
 *  reconnect backoff - up to thirty seconds - and `send` throws InvalidStateError in
 *  that state. The throw used to escape `stop()` before `miner.stop()` ran, which left
 *  every worker hashing at full tilt with the panel, and the stop button, gone. */
export const send = (socket: WebSocket | null, payload: unknown): boolean => {
  if (socket?.readyState !== WebSocket.OPEN) return false;
  socket.send(typeof payload === "string" ? payload : JSON.stringify(payload));
  return true;
};

export type MinerSession = {
  board: BoardSnapshot;
  /** The last thing worth telling the visitor: a connection state, or the reason the
   *  server refused something. Rendered by MiningPanel. */
  status: string;
  /** Whether the socket is up. Separate from `status` because the two answer different
   *  questions: a server that said "at capacity" is still connected, and the board is
   *  still live, so the two must not share one flag. */
  online: boolean;
  mineFor: string | null;
  hashrate: number;
  accepted: number;
  rejected: number;
  threads: number;
  setThreads: (n: number) => void;
  throttle: number;
  setThrottle: (n: number) => void;
  start: (listingId: string) => void;
  stop: () => void;
};

export function useMiner(path: string): MinerSession {
  const [board, setBoard] = useState<BoardSnapshot>(EMPTY);
  const [status, setStatus] = useState("connecting…");
  const [online, setOnline] = useState(false);
  const [mineFor, setMineFor] = useState<string | null>(null);
  const [hashrate, setHashrate] = useState(0);
  const [accepted, setAccepted] = useState(0);
  const [rejected, setRejected] = useState(0);
  // Every core but one. Half the cores was the cautious default from when throttle
  // also started at 30%; with the throttle off, this is the last free multiple, and
  // the slider is right there for anyone who wants their laptop quiet.
  const [threads, setThreads] = useState(() => Math.max(1, (navigator.hardwareConcurrency || 4) - 1));
  // Off by default: someone who pressed "mine for this" asked for the CPU, and a
  // machine that is already idling at 30% before they touch the slider reads as a
  // miner that does not work. The slider is right there for a phone or a laptop.
  const [throttle, setThrottle] = useState(0);

  const ws = useRef<WebSocket | null>(null);
  const miner = useRef<Miner | null>(null);
  /** A pageview composed before the socket was open. The first one always is: the
   *  effect below runs on the first render and the handshake has not finished yet. */
  const pendingView = useRef<string | null>(null);
  // Read inside the socket callbacks, which are created once and would otherwise close
  // over the first render's value.
  const mineForRef = useRef<string | null>(null);
  mineForRef.current = mineFor;

  useEffect(() => {
    miner.current = new Miner(
      (jobId, nonce) => send(ws.current, { t: "share", jobId, nonce }),
      setHashrate,
    );
    return () => miner.current?.stop();
  }, []);

  useEffect(() => {
    let closed = false;
    let delay = RECONNECT_MIN_MS;
    // Retained so the effect can clear it. A reconnect already scheduled when the hook
    // tears down would otherwise still fire and open a socket nobody closes.
    let retry: ReturnType<typeof setTimeout> | null = null;
    const connect = () => {
      if (closed) return;
      const socket = new WebSocket(wsUrl("/ws"));
      ws.current = socket;
      socket.onopen = () => {
        setStatus("connected");
        setOnline(true);
        delay = RECONNECT_MIN_MS;
        // Resume after a drop. The server forgets everything about a closed socket, so
        // without this the workers keep hashing into nothing: the UI still shows a
        // healthy hashrate while every share is discarded.
        if (mineForRef.current) send(socket, { t: "mine", listingId: mineForRef.current });
        if (pendingView.current) {
          send(socket, pendingView.current);
          pendingView.current = null;
        }
      };
      socket.onclose = () => {
        setStatus("reconnecting…");
        setOnline(false);
        if (closed) return;
        // Full jitter: anywhere in [0, delay), not delay give or take a little. Half of
        // a synchronised crowd still arrives together if the spread is narrow.
        retry = setTimeout(connect, Math.random() * delay);
        delay = Math.min(delay * 2, RECONNECT_MAX_MS);
      };
      socket.onmessage = (e) => {
        // An assertion, not a parse: a frame that is not JSON throws here, and there is
        // no error boundary above this to catch it.
        let msg: ServerMessage;
        try {
          msg = JSON.parse(e.data);
        } catch {
          return;
        }
        if (msg.t === "board") setBoard(msg);
        if (msg.t === "job") miner.current?.setJob(msg);
        if (msg.t === "shareResult") (msg.ok ? setAccepted : setRejected)((n) => n + 1);
        if (msg.t === "error") {
          setStatus(msg.message);
          // "try again shortly" has to be something that actually tries. The pool side
          // is full or backing off; the listing this browser asked for is still the one
          // it wants, and the controller opens room within a window or two.
          if (msg.retry && mineForRef.current) {
            const listingId = mineForRef.current;
            setTimeout(() => {
              if (mineForRef.current !== listingId) return; // they moved on
              send(ws.current, { t: "mine", listingId });
            }, RETRY_MIN_MS + Math.random() * RETRY_SPREAD_MS);
          }
        }
      };
    };
    connect();
    return () => {
      closed = true;
      if (retry) clearTimeout(retry);
      ws.current?.close();
    };
  }, []);

  // One line per page, down the socket that is already open. No pixel and no third
  // party: the only thing that ever hears about a visit is the server serving it.
  useEffect(() => {
    const message = JSON.stringify({
      t: "view",
      path,
      ...(firstView ? { first: true, ref: document.referrer } : {}),
    });
    firstView = false;

    if (!send(ws.current, message)) pendingView.current = message; // sent by onopen
  }, [path]);

  // Report our hashrate so the board can show per-listing totals.
  //
  // Through a ref, and with no dependencies. Each worker reports every two seconds, so
  // with four threads this state changes about twice a second; an interval that listed
  // `hashrate` as a dependency was torn down and rebuilt long before its three seconds
  // were up, and the message was never sent once. The board showed 0 H/s for everyone.
  const hashrateRef = useRef(0);
  hashrateRef.current = hashrate;

  useEffect(() => {
    const timer = setInterval(() => {
      send(ws.current, { t: "hashrate", hs: hashrateRef.current });
    }, HASHRATE_REPORT_MS);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => miner.current?.setThrottle(throttle), [throttle]);

  useEffect(() => {
    if (mineFor && miner.current?.running) miner.current.start(threads);
  }, [threads]);

  const start = (listingId: string) => {
    setMineFor(listingId);
    // Written straight to the ref as well as through setState. onopen resumes from this
    // ref, and a `mine` pressed during a reconnect only survives if the ref is already
    // right - setState lands a render later, which is after the socket may have opened.
    mineForRef.current = listingId;
    rememberListing(listingId);
    send(ws.current, { t: "mine", listingId });
    miner.current?.start(threads);
  };

  const stop = () => {
    setMineFor(null);
    mineForRef.current = null;
    // Workers first. Telling the server is the part that can fail - and the part that
    // matters least: a socket that never got the message drops the miner on close
    // anyway, while a worker nobody stopped keeps a laptop at full tilt with no way
    // left on screen to stop it.
    miner.current?.stop();
    setHashrate(0);
    send(ws.current, { t: "stop" });
  };

  return {
    board, status, online, mineFor, hashrate, accepted, rejected,
    threads, setThreads, throttle, setThrottle, start, stop,
  };
}
