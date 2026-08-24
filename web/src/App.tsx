import { useEffect, useRef, useState } from "react";
import { Miner } from "./mining";
import { POINT_SCALE, type BoardEntry, type BoardSnapshot, type ServerMessage } from "../../src/protocol";

const fmt = (n: number) =>
  n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : Math.round(n).toString();

const colorOf = (s: string) => {
  let h = 0;
  for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return `oklch(0.55 0.16 ${h})`;
};

export default function App() {
  const [board, setBoard] = useState<BoardSnapshot>({ entries: [], pending: [], threshold: 1, online: 0, mining: 0, feed: [] });
  const [mineFor, setMineFor] = useState<string | null>(null);
  const [threads, setThreads] = useState(() => Math.max(1, Math.floor((navigator.hardwareConcurrency || 4) / 2)));
  const [throttle, setThrottle] = useState(0.3);
  const [hashrate, setHashrate] = useState(0);
  const [accepted, setAccepted] = useState(0);
  const [rejected, setRejected] = useState(0);
  const [consented, setConsented] = useState(false);
  const [status, setStatus] = useState("connecting…");

  const ws = useRef<WebSocket | null>(null);
  const miner = useRef<Miner | null>(null);

  useEffect(() => {
    miner.current = new Miner(
      (jobId, nonce) => ws.current?.send(JSON.stringify({ t: "share", jobId, nonce })),
      (hs) => setHashrate(hs),
    );
    return () => miner.current?.stop();
  }, []);

  useEffect(() => {
    let closed = false;
    const connect = () => {
      const socket = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
      ws.current = socket;
      socket.onopen = () => setStatus("connected");
      socket.onclose = () => {
        setStatus("reconnecting…");
        if (!closed) setTimeout(connect, 2000);
      };
      socket.onmessage = (e) => {
        const msg: ServerMessage = JSON.parse(e.data);
        if (msg.t === "board") setBoard(msg);
        if (msg.t === "job") miner.current?.setJob(msg);
        if (msg.t === "shareResult") (msg.ok ? setAccepted : setRejected)((n) => n + 1);
        if (msg.t === "error") setStatus(msg.message);
      };
    };
    connect();
    return () => {
      closed = true;
      ws.current?.close();
    };
  }, []);

  // Report our hashrate so the board can show per-listing totals.
  useEffect(() => {
    const id = setInterval(() => {
      if (ws.current?.readyState === WebSocket.OPEN) ws.current.send(JSON.stringify({ t: "hashrate", hs: hashrate }));
    }, 3000);
    return () => clearInterval(id);
  }, [hashrate]);

  useEffect(() => miner.current?.setThrottle(throttle), [throttle]);

  const startMining = (listingId: string) => {
    setMineFor(listingId);
    ws.current?.send(JSON.stringify({ t: "mine", listingId }));
    miner.current?.start(threads);
  };

  const stopMining = () => {
    setMineFor(null);
    ws.current?.send(JSON.stringify({ t: "stop" }));
    miner.current?.stop();
    setHashrate(0);
  };

  useEffect(() => {
    if (mineFor && miner.current?.running) miner.current.start(threads);
  }, [threads]);

  const mining = [...board.entries, ...board.pending].find((e) => e.id === mineFor);

  return (
    <div className="min-h-screen text-zinc-200 font-mono">
      <div className="mx-auto max-w-3xl px-4 py-10">
        <header className="mb-8">
          <h1 className="text-3xl font-bold text-white">outmine</h1>
          <p className="mt-2 text-zinc-400">
            A leaderboard you cannot buy. Rank is paid in CPU time — pick a listing and mine for it.
          </p>
          <p className="mt-3 text-xs text-zinc-500">
            {board.online} online · {board.mining} mining · {status}
          </p>
        </header>

        {!consented && (
          <ConsentBanner onAccept={() => setConsented(true)} />
        )}

        {consented && mineFor && (
          <MiningPanel
            name={mining?.name ?? mineFor}
            hashrate={hashrate}
            accepted={accepted}
            rejected={rejected}
            threads={threads}
            setThreads={setThreads}
            throttle={throttle}
            setThrottle={setThrottle}
            onStop={stopMining}
          />
        )}

        <section className="mt-8">
          <h2 className="mb-3 text-sm uppercase tracking-widest text-zinc-500">Board</h2>
          {board.entries.length === 0 && (
            <p className="rounded border border-zinc-800 p-6 text-sm text-zinc-500">
              Nothing on the board yet. A listing appears once someone has mined for it.
            </p>
          )}
          <ol className="space-y-2">
            {board.entries.map((entry, i) => (
              <li key={entry.id} className="flex items-center gap-3 rounded border border-zinc-800 bg-zinc-900/40 p-3">
                <span className="w-8 shrink-0 text-right text-zinc-500">#{i + 1}</span>
                <span
                  className="grid size-9 shrink-0 place-items-center rounded font-bold text-white"
                  style={{ background: colorOf(entry.target) }}
                >
                  {entry.name[0]?.toUpperCase()}
                </span>
                <div className="min-w-0 flex-1">
                  <a href={`/r/${entry.id}`} className="truncate font-semibold text-white hover:underline">
                    {entry.name}
                  </a>
                  <p className="truncate text-xs text-zinc-500">{entry.tagline || entry.target}</p>
                </div>
                <div className="shrink-0 text-right text-xs">
                  <div className="text-emerald-400">{fmt(entry.score * POINT_SCALE)} pts</div>
                  <div className="text-zinc-600">
                    {entry.hashrate > 0 ? `${fmt(entry.hashrate)} H/s · ` : ""}{entry.clicks} clicks
                  </div>
                </div>
                <button
                  onClick={() => (consented ? startMining(entry.id) : setConsented(true))}
                  disabled={mineFor === entry.id}
                  className="shrink-0 rounded bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-500 disabled:bg-zinc-700"
                >
                  {mineFor === entry.id ? "mining" : "mine for this"}
                </button>
              </li>
            ))}
          </ol>
        </section>

        {board.pending.length > 0 && (
          <section className="mt-8">
            <h2 className="mb-3 text-sm uppercase tracking-widest text-zinc-500">Waiting for hashes</h2>
            <p className="mb-3 text-xs text-zinc-500">
              These are not on the board yet. Mine {board.threshold} shares for one and it joins.
            </p>
            <ul className="space-y-2">
              {board.pending.map((entry) => (
                <li key={entry.id} className="flex items-center gap-3 rounded border border-dashed border-zinc-800 p-3">
                  <span className="grid size-9 shrink-0 place-items-center rounded font-bold text-white/70"
                    style={{ background: colorOf(entry.target) }}>
                    {entry.name[0]?.toUpperCase()}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-semibold text-zinc-300">{entry.name}</p>
                    <p className="truncate text-xs text-zinc-600">{entry.tagline || entry.target}</p>
                    <div className="mt-1 h-1 w-full overflow-hidden rounded bg-zinc-800">
                      <div className="h-full bg-emerald-700"
                        style={{ width: `${Math.min(100, (entry.shares / board.threshold) * 100)}%` }} />
                    </div>
                  </div>
                  <span className="shrink-0 text-xs text-zinc-600">
                    {entry.shares}/{board.threshold}
                  </span>
                  <button
                    onClick={() => (consented ? startMining(entry.id) : setConsented(true))}
                    disabled={mineFor === entry.id}
                    className="shrink-0 rounded border border-emerald-700 px-3 py-1.5 text-xs font-semibold text-emerald-400 hover:bg-emerald-950 disabled:opacity-50"
                  >
                    {mineFor === entry.id ? "mining" : "mine for this"}
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}

        <SubmitForm />

        {board.feed.length > 0 && (
          <section className="mt-8">
            <h2 className="mb-3 text-sm uppercase tracking-widest text-zinc-500">Activity</h2>
            <ul className="space-y-1 text-xs text-zinc-500">
              {board.feed.slice().reverse().map((f, i) => (
                <li key={i}>
                  <span className="text-zinc-700">{new Date(f.ts).toLocaleTimeString()}</span> {f.text}
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </div>
  );
}

function ConsentBanner({ onAccept }: { onAccept: () => void }) {
  return (
    <div className="rounded border border-amber-700/50 bg-amber-950/30 p-4 text-sm">
      <p className="font-semibold text-amber-200">This site mines cryptocurrency with your CPU.</p>
      <p className="mt-2 text-amber-100/70">
        Nothing starts until you pick a listing. Mining runs only while this tab is open, you choose how many
        threads and how hard, and you can stop at any time. The proceeds go to the site owner — that is the point:
        rank here is paid in CPU time instead of money. It will use battery.
      </p>
      <button
        onClick={onAccept}
        className="mt-3 rounded bg-amber-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-amber-500"
      >
        I understand — let me pick a listing
      </button>
    </div>
  );
}

function MiningPanel(props: {
  name: string; hashrate: number; accepted: number; rejected: number;
  threads: number; setThreads: (n: number) => void;
  throttle: number; setThrottle: (n: number) => void; onStop: () => void;
}) {
  const cores = navigator.hardwareConcurrency || 8;
  return (
    <div className="rounded border border-emerald-800/50 bg-emerald-950/20 p-4">
      <div className="flex items-baseline justify-between">
        <p className="text-sm">
          mining for <span className="font-bold text-white">{props.name}</span>
        </p>
        <button onClick={props.onStop} className="rounded border border-zinc-700 px-3 py-1 text-xs hover:bg-zinc-800">
          stop
        </button>
      </div>
      <div className="mt-3 grid grid-cols-3 gap-3 text-center">
        <Stat label="hashrate" value={`${fmt(props.hashrate)} H/s`} />
        <Stat label="accepted" value={String(props.accepted)} />
        <Stat label="rejected" value={String(props.rejected)} />
      </div>
      <div className="mt-4 space-y-3 text-xs text-zinc-400">
        <label className="block">
          threads: {props.threads} of {cores}
          <input type="range" min={1} max={cores} value={props.threads}
            onChange={(e) => props.setThreads(Number(e.target.value))} className="mt-1 w-full" />
        </label>
        <label className="block">
          throttle: {Math.round(props.throttle * 100)}% idle
          <input type="range" min={0} max={90} value={props.throttle * 100}
            onChange={(e) => props.setThrottle(Number(e.target.value) / 100)} className="mt-1 w-full" />
        </label>
      </div>
    </div>
  );
}

const Stat = ({ label, value }: { label: string; value: string }) => (
  <div className="rounded bg-black/30 p-2">
    <div className="text-lg font-bold text-white">{value}</div>
    <div className="text-[10px] uppercase tracking-wider text-zinc-500">{label}</div>
  </div>
);

function SubmitForm() {
  const [kind, setKind] = useState<"domain" | "handle">("domain");
  const [target, setTarget] = useState("");
  const [name, setName] = useState("");
  const [tagline, setTagline] = useState("");
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const res = await fetch("/api/listings", {
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
