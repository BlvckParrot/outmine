import { linkProps } from "../router";
import { Prose } from "./Prose";

export function Rules() {
  return (
    <Prose title="Rules">
      <h2>Mining on your machine</h2>
      <ul>
        <li>Nothing mines until you accept the banner and choose a listing. Never on load.</li>
        <li>It will warm your machine and drain a battery. Throttle it or stop it at any time.</li>
        <li>Closing the tab ends it. There is no background worker and no service worker.</li>
        <li>
          If a stored consent from an earlier visit is remembered, it saves you the banner, not the
          click. Mining still needs a fresh press of the button.
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
        <li>No adult content, malware, or anything unlawful where this server runs.</li>
      </ul>

      <h2>How rank is decided</h2>
      <ul>
        <li>Score is the sum of pool difficulty over shares the pool accepted. Nothing else counts.</li>
        <li>All-time score never decays. The 24h tab exists so a new listing still has a race to run.</li>
        <li>Equal scores go to the older listing.</li>
        <li>
          Outbound links carry <strong>rel="sponsored"</strong>. Placement here is paid for, even
          though it is paid in hashes, and a search engine is entitled to know that.
        </li>
      </ul>

      <h2>Removal</h2>
      <p>
        Listings can be edited with the token shown once at submission. Anything breaking the rules
        above is removed by the operator without notice. See <a {...linkProps("/faq")}>the FAQ</a>{" "}
        for the practical questions.
      </p>
    </Prose>
  );
}
