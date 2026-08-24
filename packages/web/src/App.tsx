// Layout: consent, the mining panel, and whichever page the URL names.
//
// The socket and the worker pool are in useMiner, above the router, because they have
// to survive navigation.
import { useState } from "react";
import { ConsentBanner } from "./components/ConsentBanner";
import { MiningPanel } from "./components/MiningPanel";
import { ResumePanel } from "./components/ResumePanel";
import { useMiner } from "./miner-session";
import { About } from "./pages/About";
import { Faq } from "./pages/Faq";
import { Home } from "./pages/Home";
import { Listing } from "./pages/Listing";
import { Rules } from "./pages/Rules";
import { Stats } from "./pages/Stats";
import { linkProps, usePath } from "./router";
import { SessionContext } from "./session";
import { hasConsented, lastListing, rememberConsent, rememberListing } from "./storage";

export default function App() {
  const path = usePath();
  const miner = useMiner();
  const [consented, setConsented] = useState(hasConsented);
  // The listing this browser mined for last time. Offered as a button, never acted on:
  // starting the CPU on page load, even with consent stored from an earlier visit, is
  // the line between this project and cryptojacking. Remembering saves a click, it
  // does not spend the visitor's machine for them.
  const [resumable, setResumable] = useState(lastListing);

  const accept = () => {
    setConsented(true);
    rememberConsent();
  };

  const start = (listingId: string) => {
    setResumable(listingId);
    miner.start(listingId);
  };

  const { board, mineFor } = miner;
  const all = [...board.entries, ...board.pending];
  const mining = all.find((e) => e.id === mineFor);
  // Only offer to resume for a listing that is still there. A takedown, or a target
  // that never cleared the gate, would otherwise leave a button that does nothing.
  const resume = !mineFor ? all.find((e) => e.id === resumable) : undefined;

  return (
    <SessionContext.Provider value={{ board, consented, accept, mineFor, startMining: start }}>
      <div className="min-h-screen text-zinc-200 font-mono">
        <div className="mx-auto max-w-3xl px-4 py-10">
          <header className="mb-8">
            <a {...linkProps("/")} className="text-3xl font-bold text-white">outmine</a>
            <p className="mt-2 text-zinc-400">
              A leaderboard you cannot buy. Rank is paid in CPU time — pick a listing and mine for it.
            </p>
            <p className="mt-3 text-xs text-zinc-500">
              {board.online} online · {board.mining} mining · {miner.status}
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
              onResume={() => start(resume.id)}
              onDismiss={() => {
                setResumable(null);
                rememberListing(null);
              }}
            />
          )}

          {consented && mineFor && (
            <MiningPanel
              name={mining?.name ?? mineFor}
              hashrate={miner.hashrate}
              accepted={miner.accepted}
              rejected={miner.rejected}
              threads={miner.threads}
              setThreads={miner.setThreads}
              throttle={miner.throttle}
              setThrottle={miner.setThrottle}
              onStop={miner.stop}
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
