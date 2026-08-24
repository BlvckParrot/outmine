// The shell: one WebSocket, one miner, and whichever page the URL names.
//
// The connection and the worker pool live here rather than in a page because they
// have to survive navigation - a page that owned them would stop mining the moment
// somebody opened /about.
import { useEffect, useRef, useState } from "react";
import type { BoardSnapshot, ServerMessage } from "@outmine/protocol";
import { wsUrl } from "./api";
import { ConsentBanner } from "./components/ConsentBanner";
import { MiningPanel } from "./components/MiningPanel";
import { ResumePanel } from "./components/ResumePanel";
import { Miner } from "./mining";
import { About } from "./pages/About";
import { Faq } from "./pages/Faq";
import { Home } from "./pages/Home";
import { Listing } from "./pages/Listing";
import { Rules } from "./pages/Rules";
import { Stats } from "./pages/Stats";
import { linkProps, usePath } from "./router";
import { SessionContext } from "./session";
import { hasConsented, lastListing, rememberConsent, rememberListing } from "./storage";

const EMPTY: BoardSnapshot = { entries: [], pending: [], threshold: 1, online: 0, mining: 0, feed: [] };

export default function App() {
  const path = usePath();
  const [board, setBoard] = useState<BoardSnapshot>(EMPTY);
  const [mineFor, setMineFor] = useState<string | null>(null);
  const [threads, setThreads] = useState(() => Math.max(1, Math.floor((navigator.hardwareConcurrency || 4) / 2)));
  const [throttle, setThrottle] = useState(0.3);
  const [hashrate, setHashrate] = useState(0);
  const [accepted, setAccepted] = useState(0);
  const [rejected, setRejected] = useState(0);
  const [consented, setConsented] = useState(hasConsented);
  const [status, setStatus] = useState("connecting…");
  // The listing this browser mined for last time. Offered as a button, never acted
  // on: starting the CPU on page load, even with consent stored from an earlier
  // visit, is the line between this project and cryptojacking. Remembering saves a
  // click, it does not spend the visitor's machine for them.
  const [resumable, setResumable] = useState(lastListing);

  const ws = useRef<WebSocket | null>(null);
  const miner = useRef<Miner | null>(null);
  // Read inside the socket callbacks, which are created once and would otherwise
  // close over the first render's value.
  const mineForRef = useRef<string | null>(null);
  mineForRef.current = mineFor;

  useEffect(() => {
    miner.current = new Miner(
      (jobId, nonce) => ws.current?.send(JSON.stringify({ t: "share", jobId, nonce })),
      (hs) => setHashrate(hs),
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
        if (!closed) setTimeout(connect, 2000);
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
    const id = setInterval(() => {
      if (ws.current?.readyState === WebSocket.OPEN) {
        ws.current.send(JSON.stringify({ t: "hashrate", hs: hashrateRef.current }));
      }
    }, 3000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => miner.current?.setThrottle(throttle), [throttle]);

  const startMining = (listingId: string) => {
    setMineFor(listingId);
    setResumable(listingId);
    rememberListing(listingId);
    ws.current?.send(JSON.stringify({ t: "mine", listingId }));
    miner.current?.start(threads);
  };

  const stopMining = () => {
    setMineFor(null);
    ws.current?.send(JSON.stringify({ t: "stop" }));
    miner.current?.stop();
    setHashrate(0);
  };

  const accept = () => {
    setConsented(true);
    rememberConsent();
  };

  useEffect(() => {
    if (mineFor && miner.current?.running) miner.current.start(threads);
  }, [threads]);

  const all = [...board.entries, ...board.pending];
  const mining = all.find((e) => e.id === mineFor);
  // Only offer to resume for a listing that is still there. A takedown, or a target
  // that never cleared the gate, would otherwise leave a button that does nothing.
  const resume = !mineFor ? all.find((e) => e.id === resumable) : undefined;

  return (
    <SessionContext.Provider value={{ board, consented, accept, mineFor, startMining }}>
      <div className="min-h-screen text-zinc-200 font-mono">
        <div className="mx-auto max-w-3xl px-4 py-10">
          <header className="mb-8">
            <a {...linkProps("/")} className="text-3xl font-bold text-white">outmine</a>
            <p className="mt-2 text-zinc-400">
              A leaderboard you cannot buy. Rank is paid in CPU time — pick a listing and mine for it.
            </p>
            <p className="mt-3 text-xs text-zinc-500">
              {board.online} online · {board.mining} mining · {status}
            </p>
            <nav className="mt-3 flex gap-4 text-xs text-zinc-600">
              <a {...linkProps("/about")} className="hover:text-zinc-300">about</a>
              <a {...linkProps("/rules")} className="hover:text-zinc-300">rules</a>
              <a {...linkProps("/faq")} className="hover:text-zinc-300">faq</a>
              <a {...linkProps("/stats")} className="hover:text-zinc-300">stats</a>
            </nav>
          </header>

          {!consented && <ConsentBanner onAccept={accept} />}

          {consented && resume && (
            <ResumePanel
              name={resume.name}
              onResume={() => startMining(resume.id)}
              onDismiss={() => {
                setResumable(null);
                rememberListing(null);
              }}
            />
          )}

          {consented && mineFor && (
            <MiningPanel
              name={mining?.name ?? mineFor}
              hashrate={hashrate}
              accepted={accepted}
              rejected={rejected}
              threads={threads}
              setThreads={setThreads}
              throttle={throttle}
              setThrottle={setThrottle}
              onStop={stopMining}
            />
          )}

          <Page path={path} />
        </div>
      </div>
    </SessionContext.Provider>
  );
}

function Page({ path }: { path: string }) {
  const listing = path.match(/^\/l\/([a-z0-9]+)$/i);
  if (listing) return <Listing id={listing[1]!} />;

  switch (path) {
    case "/about": return <About />;
    case "/rules": return <Rules />;
    case "/faq": return <Faq />;
    case "/stats": return <Stats />;
    default: return <Home />;
  }
}
