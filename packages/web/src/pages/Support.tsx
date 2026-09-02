import { useState } from "react";
import { linkProps } from "../router";
import { Prose } from "./Prose";

/** The address, read out of the document rather than off the socket.
 *
 *  index.html carries it as application/json - see donateConfig in share.ts - so it is
 *  here at first paint. Through the board snapshot it would arrive whenever the
 *  WebSocket got around to it, and this is a page whose entire content is one string:
 *  it would render as an apology for a second and then change its mind. */
function donateAddress(): string {
  try {
    const el = document.getElementById("donate-config");
    if (!el?.textContent) return "";
    return (JSON.parse(el.textContent) as { btc?: string }).btc ?? "";
  } catch {
    return "";
  }
}

export function Support() {
  const btc = donateAddress();

  return (
    <Prose title="Support this">
      <p>
        This runs on one small server and the mining already pays for part of it
        — the work goes to a pool that credits the site owner, which{" "}
        <a {...linkProps("/faq")}>the FAQ</a> says out loud and{" "}
        <a {...linkProps("/stats")}>the stats page</a> counts in public. So this
        is not a collection tin for something with no income. It is a way to
        chip in if the thing amused you, and nothing on the board is for sale
        either way: a donation buys no rank, no placement and no exception to{" "}
        <a {...linkProps("/rules")}>the rules</a>.
      </p>

      {!btc ? (
        <p>
          Whoever runs this instance has not set up any way to take donations.
        </p>
      ) : (
        <>
          <h2>Bitcoin</h2>
          <p>
            You can send BTC to the following adress to support this project.
          </p>
          <Address value={btc} />
        </>
      )}
    </Prose>
  );
}

/** The address, written out and also copyable.
 *
 *  Written out because the clipboard is not always available - it needs a secure context
 *  and the permission, and a button that silently does nothing is worse than no button.
 *  Breaking on any character because a Bitcoin address is one 42-character word and would
 *  otherwise push the page sideways on a phone. */
function Address({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <div className="flex flex-wrap items-center gap-2">
      <code className="min-w-0 flex-1 break-all rounded-xl border border-border bg-card px-3 py-2 font-mono text-xs text-foreground">
        {value}
      </code>
      <button
        onClick={() => {
          navigator.clipboard
            ?.writeText(value)
            .then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 2000);
            })
            .catch(() => {
              /* clipboard is blocked; the address is on screen anyway */
            });
        }}
        className="shrink-0 cursor-pointer rounded-full border border-border px-4 py-1.5 text-xs font-medium transition-colors hover:bg-muted"
      >
        {copied ? "copied" : "copy"}
      </button>
    </div>
  );
}
