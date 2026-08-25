// Layout: the header, consent, the mining panel, and whichever page the URL names.
//
// The socket and the worker pool are in useMiner, above the router, because they have
// to survive navigation.
import { useState } from "react";
import { ConsentBanner } from "./components/ConsentBanner";
import { Footer } from "./components/Footer";
import { Header } from "./components/Header";
import { MiningPanel } from "./components/MiningPanel";
import { OwnedPanel } from "./components/OwnedPanel";
import { ResumePanel } from "./components/ResumePanel";
import { useMiner } from "./miner-session";
import { About } from "./pages/About";
import { Faq } from "./pages/Faq";
import { Home } from "./pages/Home";
import { Listing } from "./pages/Listing";
import { Rules } from "./pages/Rules";
import { Stats } from "./pages/Stats";
import { usePath } from "./router";
import { SessionContext } from "./session";
import type { Owned } from "./storage";
import {
  forgetOwned, hasConsented, lastListing, ownedListings,
  rememberConsent, rememberListing, rememberOwned,
} from "./storage";

export default function App() {
  const path = usePath();
  // The path goes in so the socket can report it: pageviews ride the connection that
  // is already there rather than a second channel of their own.
  const miner = useMiner(path);
  const [consented, setConsented] = useState(hasConsented);
  // The listing this browser mined for last time. Offered as a button, never acted on:
  // starting the CPU on page load, even with consent stored from an earlier visit, is
  // the line between this project and cryptojacking. Remembering saves a click, it
  // does not spend the visitor's machine for them.
  const [resumable, setResumable] = useState(lastListing);
  // Listings created here. Pinned above the page so the owner never has to find their
  // own row in a list of fifty to mine for it.
  const [owned, setOwned] = useState(ownedListings);

  const claim = (listing: Owned) => {
    rememberOwned(listing);
    setOwned(ownedListings());
  };

  const forget = (id: string) => {
    forgetOwned(id);
    setOwned(ownedListings());
  };

  const accept = () => {
    setConsented(true);
    rememberConsent();
  };

  const start = (listingId: string) => {
    setResumable(listingId);
    miner.start(listingId);
  };

  const { board, mineFor, online } = miner;
  const all = [...board.entries, ...board.pending];
  const mining = all.find((e) => e.id === mineFor);
  // Only offer to resume for a listing that is still there. A takedown, or a target
  // that never cleared the gate, would otherwise leave a button that does nothing.
  const resume = !mineFor ? all.find((e) => e.id === resumable) : undefined;

  return (
    <SessionContext.Provider value={{ board, online, consented, accept, mineFor, startMining: start, claim }}>
      <div className="flex min-h-screen flex-col font-sans">
        <Header path={path} />

        <div className="mx-auto flex w-full max-w-4xl flex-1 flex-col px-4 pt-4 pb-16">
          <div className="mb-6 space-y-3 empty:mb-0">
            {!consented && <ConsentBanner onAccept={accept} />}

            {owned.map((o) => (
              <OwnedPanel key={o.id} id={o.id} token={o.token} onForget={() => forget(o.id)} />
            ))}

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
                status={miner.status}
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
          </div>

          <Page path={path} />
        </div>

        <Footer />
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
