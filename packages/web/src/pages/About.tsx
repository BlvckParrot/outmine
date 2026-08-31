import { linkProps } from "../router";
import { Prose } from "./Prose";

export function About() {
  return (
    <Prose title="What this is">
      <p>
        A public leaderboard where rank cannot be bought. The currency is your CPU: pick a listing,
        your browser mines for it, and every share the pool accepts moves that listing up.
      </p>

      <h2>How the mining works</h2>
      <p>
        Your browser runs a miner compiled to WebAssembly from the same C code a desktop miner
        uses. It hashes whichever algorithm this server mines, which here is{" "}
        <strong>RinHash</strong> — chosen because it resists the specialised hardware that makes
        browser mining pointless on every well-known coin, and because it runs fifteen times faster
        in a browser than MinotaurX, which is where this started. The work goes to a mining pool
        through this server, and the proceeds go to the site owner. That is the deal, stated
        plainly: you spend electricity, a listing you chose gains rank.
      </p>
      <p>
        Nothing is mined until you press a button. Threads and throttle are yours to set, mining
        stops when you close the tab, and no share is credited unless the pool accepts it — so
        there is nothing to fake and no score to inflate.
      </p>

      <h2>Why a listing has to be mined onto the board</h2>
      <p>
        Anyone can add a listing for free, but it stays in the queue until enough shares have been
        mined for it. That is the whole spam filter: listing costs the same thing competing costs.
        A bot can post a thousand entries and none of them will be visible.
      </p>

      <h2>Who is behind it</h2>
      <p>
        The idea is borrowed from <a href="https://outbid.lol" rel="noopener">outbid.lol</a>, which
        sells rank for dollars. This one swaps the dollars for CPU time. See{" "}
        <a {...linkProps("/rules")}>the rules</a> for what is allowed and{" "}
        <a {...linkProps("/stats")}>the numbers</a> for what has been spent so far.
      </p>
    </Prose>
  );
}
