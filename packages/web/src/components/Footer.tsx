import { linkProps } from "../router";

/** The GitHub mark. lucide-react is already a dependency and is where every other icon
 *  on the site comes from, but v1 dropped the brand icons, so this one is inlined
 *  rather than pulling in a second icon package for a single path. Filled, not
 *  stroked, which is why it does not use the lucide props. */
const GithubMark = () => (
  <svg viewBox="0 0 16 16" className="size-4" fill="currentColor" aria-hidden>
    <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
  </svg>
);

/** The links the header has no room for. Rules is in both places on purpose: it is
 *  the page a listing owner goes looking for after reading the board. */
export function Footer() {
  return (
    <footer className="mx-auto mt-16 w-full max-w-4xl px-4 pb-10 text-center text-sm text-muted-foreground">
      <p className="flex flex-wrap items-center justify-center gap-x-2 gap-y-1">
        <span>Rank paid in CPU time</span>
        <span aria-hidden>·</span>
        <a {...linkProps("/faq")} className="text-primary hover:underline">FAQ</a>
        <span aria-hidden>·</span>
        <a {...linkProps("/rules")} className="text-primary hover:underline">Rules</a>
        <span aria-hidden>·</span>
        <a {...linkProps("/stats")} className="text-primary hover:underline">Stats</a>
        <span aria-hidden>·</span>
        {/* The link that leaves the site. GPL-2.0 asks anyone running this to point at
            the source, and a visitor being asked for their CPU has earned the right to
            go and read what it does. */}
        <a
          href="https://github.com/BlvckParrot/outmine"
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1.5 text-primary hover:underline"
        >
          <GithubMark />
          Source
        </a>
        <span aria-hidden>·</span>
        {/* rel="me" is the relation for "this profile is the same person as this site".
            The one link that says who is asking for your CPU, which the rules page
            promises and the licence's source offer implies. */}
        <span>
          Created by{" "}
          <a
            href="https://github.com/BlvckParrot"
            target="_blank"
            rel="me noreferrer"
            className="text-primary hover:underline"
          >
            BlvckParrot
          </a>
        </span>
      </p>
    </footer>
  );
}
