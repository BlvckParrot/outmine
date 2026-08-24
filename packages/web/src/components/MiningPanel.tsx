import { Pickaxe } from "lucide-react";
import { fmt } from "../format";
import { StatTile } from "./ui";

export function MiningPanel(props: {
  name: string; hashrate: number; accepted: number; rejected: number;
  threads: number; setThreads: (n: number) => void;
  throttle: number; setThrottle: (n: number) => void; onStop: () => void;
}) {
  const cores = navigator.hardwareConcurrency || 8;
  return (
    <div className="rounded-2xl border-2 border-primary/40 bg-primary/8 p-4">
      <div className="flex items-baseline justify-between gap-3">
        <p className="flex items-center gap-1.5 text-sm">
          <Pickaxe className="size-4 shrink-0 text-primary" />
          mining for <span className="font-bold">{props.name}</span>
        </p>
        <button
          onClick={props.onStop}
          className="shrink-0 cursor-pointer rounded-full border border-border px-3 py-1 text-xs font-medium transition-colors hover:bg-muted"
        >
          stop
        </button>
      </div>
      <div className="mt-3 grid grid-cols-3 gap-3 text-center">
        <StatTile size="sm" label="hashrate" value={`${fmt(props.hashrate)} H/s`} />
        <StatTile size="sm" label="accepted" value={String(props.accepted)} />
        <StatTile size="sm" label="rejected" value={String(props.rejected)} />
      </div>
      <div className="mt-4 space-y-3 text-xs text-muted-foreground">
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
