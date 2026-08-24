import { useState } from "react";
import { Check, Copy, KeyRound, Pencil } from "lucide-react";
import type { ListingDetail } from "@outmine/protocol";
import { apiUrl, usePolled } from "../api";
import { points } from "../format";
import { linkProps } from "../router";
import { useSession } from "../session";
import { Avatar } from "./ui";

/** A listing this browser created, pinned to the top of every page.
 *
 *  Without it, claiming a spot ends with the listing dropped somewhere into a list of
 *  fifty - and a new one starts at zero points, so it is at the bottom of it. The
 *  whole point of claiming is to mine for it, and that button has to be where the
 *  claim happened, not somewhere the owner has to search for.
 *
 *  It also carries the edit token, which is otherwise a random string printed once
 *  under a form with nothing that can be done with it: the PATCH route existed and no
 *  screen ever called it. */
export function OwnedPanel({ id, token, onForget }: {
  id: string;
  token: string;
  onForget: () => void;
}) {
  const { board, mineFor, startMining, consented, accept } = useSession();
  const [editing, setEditing] = useState(false);
  const [copied, setCopied] = useState(false);

  const onBoard = board.entries.find((e) => e.id === id);
  const entry = onBoard ?? board.pending.find((e) => e.id === id);
  // Only when the live snapshot does not carry it. It holds one page of the board, so
  // a listing below the fiftieth row is not in it even though it is on the board.
  const fetched = usePolled<ListingDetail>(entry ? null : `/api/listings/${id}`, 15_000);
  // What was just saved, until the snapshot or the poll catches up. The server has it
  // either way - this only stops the old name sitting there looking like a failed save.
  const [patched, setPatched] = useState<{ name: string; tagline: string } | null>(null);

  const listing = entry ?? fetched;
  if (!listing) return null;

  const visible = onBoard != null || fetched?.visible === 1;
  const name = patched?.name ?? listing.name;
  const tagline = patched?.tagline ?? listing.tagline;
  const mining = mineFor === id;

  return (
    <div className="rounded-2xl border border-primary/30 bg-primary/5 p-3">
      <p className="mb-2 text-[10px] font-semibold tracking-wider text-primary uppercase">
        Your listing
      </p>

      <div className="flex items-center gap-3">
        <a {...linkProps(`/l/${id}`)}>
          <Avatar entry={{ ...listing, name }} size="xs" />
        </a>
        <div className="min-w-0 flex-1">
          <a {...linkProps(`/l/${id}`)} className="block truncate text-sm font-bold hover:text-primary">
            {name}
          </a>
          <p className="truncate text-xs text-muted-foreground">
            {visible
              ? `on the board · ${points(listing.score)} pts`
              : `in the queue · ${listing.shares} of ${board.threshold} shares`}
          </p>
        </div>
        <button
          onClick={() => (consented ? startMining(id) : accept())}
          disabled={mining}
          className="shrink-0 cursor-pointer rounded-full bg-primary px-3 py-1.5 text-xs font-bold whitespace-nowrap text-primary-foreground transition-colors hover:bg-primary/85 disabled:opacity-50"
        >
          {mining ? "mining" : "mine for it"}
        </button>
      </div>

      {!visible && (
        <div className="mt-2 h-1 w-full overflow-hidden rounded-full bg-muted">
          <div
            className="h-full bg-primary"
            style={{ width: `${Math.min(100, (listing.shares / board.threshold) * 100)}%` }}
          />
        </div>
      )}

      {editing ? (
        <EditForm
          id={id}
          token={token}
          name={name}
          tagline={tagline}
          onSaved={(next) => {
            setPatched(next);
            setEditing(false);
          }}
          onCancel={() => setEditing(false)}
        />
      ) : (
        <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
          <button
            onClick={() => setEditing(true)}
            className="flex cursor-pointer items-center gap-1 rounded-full border border-border px-2.5 py-1 font-medium transition-colors hover:bg-muted"
          >
            <Pencil className="size-3" /> edit name & tagline
          </button>
          <button
            onClick={() => {
              navigator.clipboard?.writeText(token).then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 2000);
              }).catch(() => {/* clipboard blocked; the token is on screen anyway */});
            }}
            className="flex cursor-pointer items-center gap-1 rounded-full border border-border px-2.5 py-1 font-medium transition-colors hover:bg-muted"
          >
            {copied ? <Check className="size-3 text-live" /> : <Copy className="size-3" />}
            {copied ? "copied" : "copy edit token"}
          </button>
          <button
            onClick={() => {
              if (confirm("Forget this listing? The edit token goes with it and cannot be shown again.")) {
                onForget();
              }
            }}
            className="cursor-pointer text-muted-foreground hover:text-foreground"
          >
            forget
          </button>
        </div>
      )}

      <p className="mt-2 flex items-start gap-1.5 text-[11px] leading-relaxed text-muted-foreground">
        <KeyRound className="mt-0.5 size-3 shrink-0" />
        <span>
          <span className="font-mono break-all">{token}</span> — the edit token. It is what
          proves the listing is yours, this browser is the only place it is kept, and it
          cannot be shown again. Copy it if you want to edit from another machine.
        </span>
      </p>
    </div>
  );
}

function EditForm(props: {
  id: string;
  token: string;
  name: string;
  tagline: string;
  onSaved: (next: { name: string; tagline: string }) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(props.name);
  const [tagline, setTagline] = useState(props.tagline);
  const [error, setError] = useState<string | null>(null);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    const res = await fetch(apiUrl(`/api/listings/${props.id}`), {
      method: "PATCH",
      headers: { "content-type": "application/json", "x-edit-token": props.token },
      body: JSON.stringify({ name, tagline }),
    });
    const data = await res.json();
    if (!res.ok) return setError(data.error ?? "could not save");
    props.onSaved({ name: data.name, tagline: data.tagline });
  };

  return (
    <form onSubmit={save} className="mt-3 flex flex-col gap-2">
      <div className="flex flex-col gap-2 md:flex-row">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
          className="h-9 w-full min-w-0 rounded-xl border border-input bg-card px-3 text-sm outline-none transition-colors focus-visible:border-primary md:w-44"
        />
        <input
          value={tagline}
          onChange={(e) => setTagline(e.target.value)}
          placeholder="one line about it"
          className="h-9 w-full min-w-0 flex-1 rounded-xl border border-input bg-card px-3 text-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-primary"
        />
      </div>
      <div className="flex items-center gap-2 text-xs">
        <button className="cursor-pointer rounded-full bg-primary px-3 py-1.5 font-bold text-primary-foreground transition-colors hover:bg-primary/85">
          save
        </button>
        <button
          type="button"
          onClick={props.onCancel}
          className="cursor-pointer text-muted-foreground hover:text-foreground"
        >
          cancel
        </button>
        {error && <span className="text-destructive">{error}</span>}
      </div>
    </form>
  );
}
