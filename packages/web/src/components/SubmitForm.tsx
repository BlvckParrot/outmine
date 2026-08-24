import { useState } from "react";
import { apiUrl } from "../api";

export function SubmitForm() {
  const [kind, setKind] = useState<"domain" | "handle">("domain");
  const [target, setTarget] = useState("");
  const [name, setName] = useState("");
  const [tagline, setTagline] = useState("");
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const res = await fetch(apiUrl("/api/listings"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind, target, name, tagline }),
    });
    const data = await res.json();
    setResult(
      res.ok
        ? { ok: true, text: `Listed. Save this edit token, it is shown once: ${data.editToken}` }
        : { ok: false, text: data.error },
    );
    if (res.ok) setTarget("");
  };

  return (
    <section className="mt-10">
      <h2 className="mb-3 text-sm uppercase tracking-widest text-zinc-500">Add a listing</h2>
      <form onSubmit={submit} className="space-y-2 rounded border border-zinc-800 p-4">
        <div className="flex gap-2">
          <select value={kind} onChange={(e) => setKind(e.target.value as "domain" | "handle")}
            className="rounded border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-sm">
            <option value="domain">domain</option>
            <option value="handle">@handle</option>
          </select>
          <input value={target} onChange={(e) => setTarget(e.target.value)} required
            placeholder={kind === "domain" ? "example.com" : "@yourhandle"}
            className="flex-1 rounded border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-sm" />
        </div>
        <input value={name} onChange={(e) => setName(e.target.value)} required placeholder="name"
          className="w-full rounded border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-sm" />
        <input value={tagline} onChange={(e) => setTagline(e.target.value)} placeholder="one line about it"
          className="w-full rounded border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-sm" />
        <button className="rounded bg-zinc-100 px-3 py-1.5 text-sm font-semibold text-black hover:bg-white">
          add
        </button>
        <p className="text-xs text-zinc-500">
          Free to add. It appears on the board once enough hashes have been mined for it — that is the spam filter.
        </p>
        {result && (
          <p className={`text-xs break-all ${result.ok ? "text-emerald-400" : "text-red-400"}`}>{result.text}</p>
        )}
      </form>
    </section>
  );
}
