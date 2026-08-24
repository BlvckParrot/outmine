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

const RECONNECT_MS = 2_000;
const HASHRATE_REPORT_MS = 3_000;

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

export function useMiner(): MinerSession {
  const [board, setBoard] = useState<BoardSnapshot>(EMPTY);
  const [status, setStatus] = useState("connecting…");
  const [mineFor, setMineFor] = useState<string | null>(null);
  const [hashrate, setHashrate] = useState(0);
  const [accepted, setAccepted] = useState(0);
  const [rejected, setRejected] = useState(0);
  const [threads, setThreads] = useState(() => Math.max(1, Math.floor((navigator.hardwareConcurrency || 4) / 2)));
  // Off by default: someone who pressed "mine for this" asked for the CPU, and a
  // machine that is already idling at 30% before they touch the slider reads as a
  // miner that does not work. The slider is right there for a phone or a laptop.
  const [throttle, setThrottle] = useState(0);

  const ws = useRef<WebSocket | null>(null);
  const miner = useRef<Miner | null>(null);
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
    const connect = () => {
      const socket = new WebSocket(wsUrl("/ws"));
      ws.current = socket;
      socket.onopen = () => {
        setStatus("connected");
        // Resume after a drop. The server forgets everything about a closed socket, so
        // without this the workers keep hashing into nothing: the UI still shows a
        // healthy hashrate while every share is discarded.
        if (mineForRef.current) socket.send(JSON.stringify({ t: "mine", listingId: mineForRef.current }));
      };
      socket.onclose = () => {
        setStatus("reconnecting…");
        if (!closed) setTimeout(connect, RECONNECT_MS);
      };
      socket.onmessage = (e) => {
        const msg: ServerMessage = JSON.parse(e.data);
        if (msg.t === "board") setBoard(msg);
        if (msg.t === "job") miner.current?.setJob(msg);
        if (msg.t === "shareResult") (msg.ok ? setAccepted : setRejected)((n) => n + 1);
        if (msg.t === "error") setStatus(msg.message);
      };
    };
    connect();
    return () => {
      closed = true;
      ws.current?.close();
    };
  }, []);

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
