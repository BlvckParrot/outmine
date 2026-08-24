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
        <a {...linkProps("/stats")} className="text-primary hover:underline">Stats</a>
      </p>
    </footer>
  );
}
