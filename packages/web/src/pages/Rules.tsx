import { fmt } from "../format";
import { linkProps } from "../router";
import { useSession } from "../session";
import { Prose } from "./Prose";

export function Rules() {
  // The gate on an uploaded icon is the server's to set, so it is read off the board
  // rather than written here - a number in prose is a number that goes stale. Until the
  // first snapshot lands it is Infinity, which is not a sentence.
  const { board } = useSession();
  const iconPoints = Number.isFinite(board.iconMinPoints)
    ? `${fmt(board.iconMinPoints)} points`
    : "enough points";

  return (
    <Prose title="Rules">
      <h2>Mining on your machine</h2>
      <ul>
        <li>Nothing mines until you accept the banner and choose a listing. Never on load.</li>
        <li>It will warm your machine and drain a battery. Throttle it or stop it at any time.</li>
        <li>
          Closing the tab ends it. The miner is a web worker the page owns — there is no service
          worker and nothing that keeps hashing once the tab is gone.
        </li>
        <li>
          A tab left open in the background keeps mining, but browsers throttle background
          timers heavily, so it slows to a trickle rather than stopping. If you want it to
          stop, press stop.
        </li>
        <li>
          If a stored consent from an earlier visit is remembered, it saves you the banner, not the
          click. Mining still needs a fresh press of the button.
        </li>
        <li>
          Your browser keeps four things: that you accepted the banner, the last listing you mined
          for, light or dark, and the edit token of any listing you created here. None of it leaves
          the browser, and there are no cookies.
        </li>
        <li>
          Page views are counted by our own analytics, running on the same machine as this site.
          It sets no cookies and stores nothing in your browser; a visit is identified by a hash
          of your address and browser that is re-salted daily, so it cannot be followed from one
          day to the next. Nothing about you is sent anywhere else.
        </li>
      </ul>

      <h2>What you may list</h2>
      <ul>
        <li>A domain, or an x.com handle. One listing per target.</li>
        <li>
          Query strings are stripped from every submitted URL, which removes affiliate and tracking
          parameters along with them.
        </li>
        <li>
          Link shorteners are refused. The board links to the real destination, and a shortener
          hides both the destination and its own tracking.
        </li>
        <li>
          No adult content, malware, or anything unlawful where this server runs. A short
          word list refuses the obvious cases outright; everything else is removed by the
          operator after the fact.
        </li>
      </ul>

      <h2>How rank is decided</h2>
      <ul>
        <li>Score is the sum of pool difficulty over shares the pool accepted. Nothing else counts.</li>
        <li>All-time score never decays. The 24h tab exists so a new listing still has a race to run.</li>
        <li>Equal scores go to the older listing.</li>
        <li>A listing may swap its letter avatar for an uploaded icon at {iconPoints}.</li>
        <li>
          Outbound links carry <strong>rel="sponsored"</strong>. Placement here is paid for, even
          though it is paid in hashes, and a search engine is entitled to know that.
        </li>
      </ul>

      <h2>Removal</h2>
      <p>
        Listings can be edited with the token shown once at submission. Anything breaking the rules
        above is removed by the operator without notice. To report a listing — or to ask for your
        own to be taken down — open an issue on{" "}
        <a href="https://github.com/BlvckParrot/outmine/issues" target="_blank" rel="noreferrer">
          GitHub
        </a>
        . See <a {...linkProps("/faq")}>the FAQ</a> for the practical questions.
      </p>
    </Prose>
  );
}
