// The HTML a crawler gets, rendered from the same components the visitor sees.
//
// Not hydration. `main.tsx` mounts with createRoot, which empties the container before
// its first render, so this markup is throwaway - which is exactly why it can be built
// from a blank slate. App reads localStorage in three lazy useState initialisers
// (consent, the last listing, owned listings); a server has none of them, so hydrating
// this would mismatch for every returning visitor, and moving those reads into effects
// to fix it would flash the consent banner at them - the thing the inline theme script
// in index.html exists to prevent.
//
// So: static markup for whoever does not run JavaScript, and the real app for everyone
// who does.
import { renderToStaticMarkup } from "react-dom/server";
import { type BoardSnapshot, isPagePath, normalizePath } from "@outmine/protocol";
import { Footer } from "./components/Footer";
import { Header } from "./components/Header";
import { About } from "./pages/About";
import { Faq } from "./pages/Faq";
import { Home } from "./pages/Home";
import { Rules } from "./pages/Rules";
import { Support } from "./pages/Support";
import { SessionContext, type Session } from "./session";

// apiUrl() falls back to location.origin, which is empty in production, and ui.tsx and
// BoardRow both call it *during* render - for icon sources and the click-out href. An
// empty origin leaves those root-relative, which is what belongs in the HTML anyway:
// the server does not know which host was asked, and /icon/x.webp is right for all of
// them. Set here rather than in api.ts so nothing about the browser build changes.
(globalThis as { location?: { origin: string } }).location ??= { origin: "" };

/** The board is live and nothing here is interactive: every callback is a no-op and
 *  the visitor is treated as not having consented, which is the state a first-time
 *  arrival - and a crawler - is actually in. */
const sessionFor = (board: BoardSnapshot): Session => ({
  board,
  online: false,
  consented: false,
  accept: () => {},
  mineFor: null,
  startMining: () => {},
  claim: () => {},
});

/** Mirrors the switch in App.tsx. Two pages are deliberately absent: /stats renders
 *  "Loading…" without its fetch, and /l/:id fetches the listing in an effect, so both
 *  would put a placeholder in front of a crawler instead of content. They keep the
 *  head tags and the sitemap they already have. */
function pageFor(path: string) {
  switch (normalizePath(path)) {
    case "/about": return <About />;
    case "/rules": return <Rules />;
    case "/faq": return <Faq />;
    case "/support": return <Support />;
    case "/stats": return null;
    default: return <Home />;
  }
}

/** Static HTML for `path`, or "" when there is nothing worth serving - which the caller
 *  writes into the page as-is, leaving the empty #root the site shipped before this. */
export function renderPath(path: string, board: BoardSnapshot): string {
  if (!isPagePath(path)) return "";
  const page = pageFor(path);
  if (!page) return "";
  // Header and Footer come too, and not for looks: they are every internal link on the
  // site. Without them a crawler that reaches /about finds no way to /rules or /faq and
  // the sitemap is the only thing holding the pages together. Both are safe here -
  // storage.ts guards every localStorage read in a try/catch for private browsing, and
  // a server with no localStorage at all takes the same branch.
  //
  // The panels App puts above the page do not: consent, owned listings and the miner
  // are all browser state, and none of them is anything a crawler should be told about.
  return renderToStaticMarkup(
    <SessionContext.Provider value={sessionFor(board)}>
      <div className="flex min-h-screen flex-col font-sans">
        <Header path={path} />
        <div className="mx-auto flex w-full max-w-4xl flex-1 flex-col px-4 pt-4 pb-16">{page}</div>
        <Footer />
      </div>
    </SessionContext.Provider>,
  );
}
