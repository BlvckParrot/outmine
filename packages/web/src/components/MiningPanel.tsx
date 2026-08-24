import { fmt } from "../format";
import { StatTile } from "./ui";

export function MiningPanel(props: {
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
        <StatTile size="sm" label="hashrate" value={`${fmt(props.hashrate)} H/s`} />
        <StatTile size="sm" label="accepted" value={String(props.accepted)} />
        <StatTile size="sm" label="rejected" value={String(props.rejected)} />
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

