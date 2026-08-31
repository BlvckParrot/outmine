import { useState } from "react";
import { Check, Copy, ImageUp, KeyRound, Lock, Pencil } from "lucide-react";
import { compact, ICON_MAX_PX, POINT_SCALE, type ListingDetail } from "@outmine/protocol";
import { apiUrl, request, usePolled } from "../api";
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
          <IconButton id={id} token={token} listing={listing} min={board.iconMinPoints} />
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
  const { board } = useSession();
  const [name, setName] = useState(props.name);
  const [tagline, setTagline] = useState(props.tagline);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (saving) return;
    setSaving(true);
    const res = await request<{ name: string; tagline: string }>(`/api/listings/${props.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", "x-edit-token": props.token },
      body: JSON.stringify({ name, tagline }),
    });
    setSaving(false);
    if (!res.ok) return setError(res.error);
    props.onSaved({ name: res.data.name, tagline: res.data.tagline });
  };

  return (
    <form onSubmit={save} className="mt-3 flex flex-col gap-2">
      <div className="flex flex-col gap-2 md:flex-row">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          aria-label="Display name"
          maxLength={board.maxNameLength}
          required
          className="h-9 w-full min-w-0 rounded-xl border border-input bg-card px-3 text-sm outline-none transition-colors focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-primary/40 md:w-44"
        />
        <input
          value={tagline}
          onChange={(e) => setTagline(e.target.value)}
          aria-label="Tagline"
          maxLength={board.maxTaglineLength}
          placeholder="one line about it"
          className="h-9 w-full min-w-0 flex-1 rounded-xl border border-input bg-card px-3 text-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-primary/40"
        />
      </div>
      <div className="flex items-center gap-2 text-xs">
        <button
          disabled={saving}
          className="cursor-pointer rounded-full bg-primary px-3 py-1.5 font-bold text-primary-foreground transition-colors hover:bg-primary/85 disabled:cursor-wait disabled:opacity-60"
        >
          {saving ? "saving…" : "save"}
        </button>
        <button
          type="button"
          onClick={props.onCancel}
          className="cursor-pointer text-muted-foreground hover:text-foreground"
        >
          cancel
        </button>
        {error && <span role="alert" className="text-destructive">{error}</span>}
      </div>
    </form>
  );
}

/** The owner's own logo, once the listing has mined its way to it.
 *
 *  The picked file is redrawn onto a square canvas before it is sent, so the server
 *  only ever receives a PNG of a known size whatever was chosen - and the visitor does
 *  not upload a four megabyte photo to be shown at 56 pixels. The server re-checks the
 *  bytes anyway; this is a convenience, not the gate. */
function IconButton(props: {
  id: string;
  token: string;
  listing: { score: number; has_icon: number };
  min: number;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const earned = props.listing.score * POINT_SCALE;

  if (earned < props.min) {
    return (
      <span className="flex items-center gap-1 text-muted-foreground">
        <Lock className="size-3" />
        icon at {compact(props.min)} pts · {points(props.listing.score)} so far
      </span>
    );
  }

  const upload = async (file: File | undefined) => {
    if (!file) return;
    setError(null);
    setBusy(true);
    try {
      const res = await fetch(apiUrl(`/api/listings/${props.id}/icon`), {
        method: "PUT",
        headers: { "content-type": "image/png", "x-edit-token": props.token },
        body: await square(file),
      });
      if (!res.ok) setError((await res.json().catch(() => ({}))).error ?? `upload failed (${res.status})`);
    } catch {
      setError("could not read that image");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <label className="flex cursor-pointer items-center gap-1 rounded-full border border-border px-2.5 py-1 font-medium transition-colors hover:bg-muted">
        <ImageUp className="size-3" />
        {busy ? "uploading…" : props.listing.has_icon ? "replace icon" : "add an icon"}
        <input
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif"
          className="hidden"
          disabled={busy}
          onChange={(e) => {
            upload(e.target.files?.[0]);
            e.target.value = ""; // so picking the same file twice still fires
          }}
        />
      </label>
      {error && <span className="text-destructive">{error}</span>}
    </>
  );
}

/** Any image the browser can decode, centre-cropped to a square PNG of ICON_MAX_PX. */
async function square(file: File): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  const side = Math.min(bitmap.width, bitmap.height);
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = ICON_MAX_PX;

  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no 2d context");
  ctx.drawImage(
    bitmap,
    (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side,
    0, 0, ICON_MAX_PX, ICON_MAX_PX,
  );
  bitmap.close();

  return new Promise((resolve, reject) =>
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("encode failed"))), "image/png"),
  );
}
