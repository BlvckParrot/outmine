import { useState } from "react";
import { Pickaxe } from "lucide-react";
import { apiUrl } from "../api";
import { useSession } from "../session";

/** Anything starting with @ is a handle; everything else is a domain. The old select
 *  asked the visitor to classify their own URL, which is a question the string already
 *  answers. The server still validates the kind it is sent. */
const kindOf = (target: string) => (target.trim().startsWith("@") ? "handle" : "domain");

/** "orynth.dev" -> "Orynth", "@levelsio" -> "levelsio". Only a default: the name field
 *  appears as soon as there is a target, so it can always be overridden. */
function suggestName(target: string): string {
  const t = target.trim().replace(/^https?:\/\//, "").replace(/^www\./, "");
  if (t.startsWith("@")) return t.slice(1);
  const label = t.split("/")[0]!.split(".")[0] ?? "";
  return label.charAt(0).toUpperCase() + label.slice(1);
}

export function SubmitForm() {
  const { claim } = useSession();
  const [target, setTarget] = useState("");
  const [name, setName] = useState("");
  const [tagline, setTagline] = useState("");
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const res = await fetch(apiUrl("/api/listings"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: kindOf(target),
        target,
        name: name.trim() || suggestName(target),
        tagline,
      }),
    });
    const data = await res.json();
    if (!res.ok) return setResult({ ok: false, text: data.error });

    // The token used to be printed here and nowhere else, which made it a random
    // string under a form. It goes to the panel at the top of the page instead, next
    // to the listing it belongs to and the button that mines for it.
    claim({ id: data.listing.id, token: data.editToken });
    setResult({ ok: true, text: "Listed. It is at the top of this page — mine for it to put it on the board." });
    setTarget("");
    setName("");
    setTagline("");
  };

  return (
    <form onSubmit={submit} className="mx-auto mt-5 flex w-full max-w-2xl flex-col gap-2">
      <div className="flex flex-col gap-2 md:flex-row">
        <div className="relative flex-1">
          <Pickaxe className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <input
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            required
            autoComplete="off"
            spellCheck={false}
            placeholder="your domain or @handle"
            className="h-11 w-full min-w-0 rounded-xl border border-input bg-card pr-3 pl-10 text-base outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-primary"
          />
        </div>
        <button className="h-11 shrink-0 cursor-pointer rounded-full bg-primary px-5 text-sm font-bold text-primary-foreground transition-colors hover:bg-primary/85 md:w-auto">
          Claim a spot
        </button>
      </div>

      {/* Only once there is something to name. Three empty fields under the headline
          would read as a form to fill in rather than as one thing to type. */}
      {target.trim() && (
        <div className="flex flex-col gap-2 md:flex-row">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={suggestName(target)}
            className="h-9 w-full min-w-0 rounded-xl border border-input bg-card px-3 text-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-primary md:w-44"
          />
          <input
            value={tagline}
            onChange={(e) => setTagline(e.target.value)}
            placeholder="one line about it"
            className="h-9 w-full min-w-0 flex-1 rounded-xl border border-input bg-card px-3 text-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-primary"
          />
        </div>
      )}

      <p className="text-center text-xs leading-relaxed text-muted-foreground">
        Free to add. It reaches the board once enough hashes have been mined for it —
        that is the spam filter.
      </p>
      {result && (
        <p className={`text-center text-xs break-all ${result.ok ? "text-primary" : "text-destructive"}`}>
          {result.text}
        </p>
      )}
    </form>
  );
}
