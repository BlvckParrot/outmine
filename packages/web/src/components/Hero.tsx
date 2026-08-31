import { fmt, points } from "../format";
import { linkProps } from "../router";
import { useSession } from "../session";
import { SubmitForm } from "./SubmitForm";

/** The top of the board as a price, which is what outbid.lol puts here and the only
 *  number that says what it costs to win. Ours is in points rather than dollars. */
export function Hero() {
  const { board, online } = useSession();
  const top = board.entries[0];

  return (
    <header className="mb-6 text-center">
      <h1 className="sr-only">outmine</h1>

      <a
        {...linkProps("/stats")}
        className="inline-block max-w-full rounded-full bg-muted px-3 py-1.5 text-center text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        {/* The counts come from the last snapshot, which survives the socket that
            delivered it - so when the connection is down they are a confident lie. The
            dot stops pinging and the numbers give way to the reason instead. */}
        <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
          <span className="relative inline-flex size-2 shrink-0">
            {online && (
              <span className="absolute inline-flex size-full animate-ping rounded-full bg-live opacity-75 motion-reduce:animate-none" />
            )}
            <span className={`relative inline-flex size-2 rounded-full ${online ? "bg-live" : "bg-muted-foreground"}`} />
          </span>
          {online ? (
            <span className="font-semibold text-live">{board.online} online</span>
          ) : (
            <span className="font-semibold">offline — reconnecting</span>
          )}
        </span>
        {online && <span> · {board.mining} mining · {fmt(board.hashrate)} H/s</span>}
        <span className="text-foreground"> · see stats →</span>
      </a>

      <h2 className="mt-5 flex flex-wrap items-center justify-center gap-x-3 text-center text-[28px] font-bold tracking-[-0.03em] text-pretty md:text-[40px]">
        {top ? (
          <>
            <span>#1 costs</span>
            <span className="font-mono tracking-tight tabular-nums text-primary">{points(top.score)} pts</span>
          </>
        ) : (
          <span>#1 is <span className="text-primary">unclaimed</span></span>
        )}
      </h2>

      <p className="mx-auto mt-2 max-w-xl text-sm leading-relaxed text-balance text-muted-foreground">
        <span className="text-primary">New listings start at zero.</span> Mining less than #1
        still puts you on the board, at whatever place the hashes you spend can take it.
      </p>

      <SubmitForm />
    </header>
  );
}
