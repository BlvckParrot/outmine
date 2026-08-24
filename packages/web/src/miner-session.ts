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
  online: 0, mining: 0, feed: [],
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

export type MinerSession = {
  board: BoardSnapshot;
  status: string;
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
      (jobId, nonce) => ws.current?.send(JSON.stringify({ t: "share", jobId, nonce })),
      setHashrate,
    );
    return () => miner.current?.stop();
  }, []);

  useEffect(() => {
    let closed = false;
    let delay = RECONNECT_MIN_MS;
    const connect = () => {
      const socket = new WebSocket(wsUrl("/ws"));
      ws.current = socket;
      socket.onopen = () => {
        setStatus("connected");
        delay = RECONNECT_MIN_MS;
        // Resume after a drop. The server forgets everything about a closed socket, so
        // without this the workers keep hashing into nothing: the UI still shows a
        // healthy hashrate while every share is discarded.
        if (mineForRef.current) socket.send(JSON.stringify({ t: "mine", listingId: mineForRef.current }));
        if (pendingView.current) {
          socket.send(pendingView.current);
          pendingView.current = null;
        }
      };
      socket.onclose = () => {
        setStatus("reconnecting…");
        if (closed) return;
        // Full jitter: anywhere in [0, delay), not delay give or take a little. Half of
        // a synchronised crowd still arrives together if the spread is narrow.
        setTimeout(connect, Math.random() * delay);
        delay = Math.min(delay * 2, RECONNECT_MAX_MS);
      };
      socket.onmessage = (e) => {
        const msg: ServerMessage = JSON.parse(e.data);
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
              ws.current?.send(JSON.stringify({ t: "mine", listingId }));
            }, RETRY_MIN_MS + Math.random() * RETRY_SPREAD_MS);
          }
        }
      };
    };
    connect();
    return () => {
      closed = true;
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

    if (ws.current?.readyState === WebSocket.OPEN) ws.current.send(message);
    else pendingView.current = message; // sent by onopen
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
      if (ws.current?.readyState === WebSocket.OPEN) {
        ws.current.send(JSON.stringify({ t: "hashrate", hs: hashrateRef.current }));
      }
    }, HASHRATE_REPORT_MS);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => miner.current?.setThrottle(throttle), [throttle]);

  useEffect(() => {
    if (mineFor && miner.current?.running) miner.current.start(threads);
  }, [threads]);

  const start = (listingId: string) => {
    setMineFor(listingId);
    rememberListing(listingId);
    ws.current?.send(JSON.stringify({ t: "mine", listingId }));
    miner.current?.start(threads);
  };

  const stop = () => {
    setMineFor(null);
    ws.current?.send(JSON.stringify({ t: "stop" }));
    miner.current?.stop();
    setHashrate(0);
  };

  return {
    board, status, mineFor, hashrate, accepted, rejected,
    threads, setThreads, throttle, setThrottle, start, stop,
  };
}
