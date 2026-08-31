import { linkProps } from "../router";
import { Prose } from "./Prose";

export function Faq() {
  return (
    <Prose title="Questions">
      <h2>Is this cryptojacking?</h2>
      <p>
        Cryptojacking is mining without telling you. Everything here is the opposite: a banner
        before anything runs, a button you have to press, a live hashrate, a throttle, and a stop.
        The one rule we hold ourselves to is that a page load never starts the CPU — not even for a
        visitor who accepted last week.
      </p>

      <h2>How much will I actually mine?</h2>
      <p>
        A modern laptop manages something like ten thousand hashes a second per thread. In money
        that is a fraction of a cent an hour, which is exactly why this works as a game and would
        not work as a business. The point is the leaderboard, not the payout.
      </p>

      <h2>Do you make money from this?</h2>
      <p>
        The work goes to zpool, which credits a single BTC address belonging to the site owner. It
        is the only revenue and there are no ads. <a {...linkProps("/stats")}>The stats page</a>{" "}
        shows every share that has ever been accepted.
      </p>

      <h2>Can I mine for my own listing?</h2>
      <p>Yes. That is the intended way to climb. So can everyone else, for theirs.</p>

      <h2>Can I cheat?</h2>
      <p>
        Not usefully. Score is credited only when the mining pool accepts a share, and the pool
        checks the hash. Making one up costs the same work as finding one honestly.
      </p>

      <h2>What if I lose my edit token?</h2>
      <p>
        It is shown once and only its hash is stored, so it cannot be recovered. The listing keeps
        working; only editing its name and tagline is gone.
      </p>

      <h2>Does it work on a phone?</h2>
      <p>
        It runs, but a phone is slow at this and hot afterwards. If you try it anyway, use one
        thread and a high throttle.
      </p>
    </Prose>
  );
}
