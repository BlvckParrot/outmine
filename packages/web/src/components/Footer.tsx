import { linkProps } from "../router";

/** The links the header has no room for. Rules is in both places on purpose: it is
 *  the page a listing owner goes looking for after reading the board. */
export function Footer() {
  return (
    <footer className="mx-auto mt-16 w-full max-w-4xl px-4 pb-10 text-center text-sm text-muted-foreground">
      <p>
        Rank paid in CPU time ·{" "}
        <a {...linkProps("/faq")} className="text-primary hover:underline">FAQ</a> ·{" "}
        <a {...linkProps("/rules")} className="text-primary hover:underline">Rules</a> ·{" "}
        <a {...linkProps("/stats")} className="text-primary hover:underline">Stats</a> ·{" "}
        {/* The one link that leaves the site. GPL-2.0 asks anyone running this to point
            at the source, and a visitor being asked for their CPU has earned the right
            to go and read what it does. */}
        <a
          href="https://github.com/BlvckParrot/outmine"
          target="_blank"
          rel="noreferrer"
          className="text-primary hover:underline"
        >
          Source
        </a>
      </p>
    </footer>
  );
}
