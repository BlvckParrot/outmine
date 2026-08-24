import { Pickaxe } from "lucide-react";
import { fmt } from "../format";
import { StatTile } from "./ui";

/** 270 degrees of a circle whose pathLength is 100, so the arc is measured in percent
 *  and the gap sits at the bottom where a dial's gap belongs. */
const SWEEP = 75;

export function MiningPanel(props: {
  name: string; hashrate: number; accepted: number; rejected: number;
  threads: number; setThreads: (n: number) => void;
  throttle: number; setThrottle: (n: number) => void; onStop: () => void;
}) {
  const cores = navigator.hardwareConcurrency || 8;

  // How much of this machine the two sliders are asking for: the share of the cores,
  // times the share of the time those cores are not idling. Not measured from the
  // hashrate - a dial calibrated against the best rate seen so far reads 100% whatever
  // the sliders say, and calibrating per thread means dividing a hashrate by a thread
  // count that changed a render earlier, which lands four times too high. This is the
  // number the sliders actually set, and it is right the instant one moves.
  const load = (props.threads / cores) * (1 - props.throttle);

  return (
    <div className="rounded-2xl border border-primary/25 bg-gradient-to-br from-primary/12 via-card to-card p-4 shadow-[var(--shadow-card)]">
      <div className="flex items-center justify-between gap-3">
        <p className="flex min-w-0 items-center gap-2 text-sm">
          <span className="relative grid size-7 shrink-0 place-items-center rounded-full bg-primary/15">
            {props.hashrate > 0 && (
              <span className="absolute inset-0 animate-ping rounded-full bg-primary/25 motion-reduce:animate-none" />
            )}
            <Pickaxe className="relative size-4 text-primary" />
          </span>
          <span className="truncate">
            mining for <span className="font-bold">{props.name}</span>
          </span>
        </p>
        <button
          onClick={props.onStop}
          className="shrink-0 cursor-pointer rounded-full border border-border px-3 py-1 text-xs font-medium transition-colors hover:border-destructive/40 hover:bg-destructive/10 hover:text-destructive"
        >
          stop
        </button>
      </div>

      <div className="mt-4 flex flex-col items-center gap-4 sm:flex-row sm:items-stretch">
        <Gauge load={load} hashrate={props.hashrate} />

        <div className="flex w-full min-w-0 flex-1 flex-col justify-between gap-3">
          <div className="grid grid-cols-2 gap-2 text-center">
            <StatTile size="sm" label="accepted" value={String(props.accepted)}
              tone={props.accepted > 0 ? "live" : undefined} />
            <StatTile size="sm" label="rejected" value={String(props.rejected)}
              tone={props.rejected > 0 ? "destructive" : undefined} />
          </div>

          <div className="space-y-3">
            <Dial label="threads" hint={`${props.threads} of ${cores}`}
              min={1} max={cores} value={props.threads} onChange={props.setThreads} />
            <Dial label="throttle" hint={`${Math.round(props.throttle * 100)}% idle`}
              min={0} max={90} value={props.throttle * 100}
              onChange={(n) => props.setThrottle(n / 100)} />
          </div>
        </div>
      </div>
    </div>
  );
}

/** The live hashrate in the middle, the CPU it is being given as the arc around it.
 *  A bare number says nothing about whether there is room left; an arc that fills as
 *  the sliders move does, and it answers the question the sliders are there for. */
function Gauge({ load, hashrate }: { load: number; hashrate: number }) {
  return (
    <div className="relative grid size-32 shrink-0 place-items-center">
      {hashrate > 0 && <div className="absolute inset-5 rounded-full bg-primary/20 blur-xl" />}

      <svg viewBox="0 0 100 100" className="absolute size-full rotate-[135deg]" aria-hidden>
        <circle cx="50" cy="50" r="43" pathLength={100} fill="none" strokeLinecap="round"
          strokeWidth={8} strokeDasharray={`${SWEEP} 100`} className="stroke-primary/15" />
        <circle cx="50" cy="50" r="43" pathLength={100} fill="none" strokeLinecap="round"
          strokeWidth={8} strokeDasharray={`${(load * SWEEP).toFixed(2)} 100`}
          className="stroke-primary transition-[stroke-dasharray] duration-700 ease-out" />
      </svg>

      {/* Value first, label second: browser-check finds a tile by its label and reads
          the sibling above it. Same contract as StatTile, laid out for the dial. */}
      <div className="relative text-center">
        <div className="font-mono text-xl leading-none font-bold tabular-nums">
          {fmt(hashrate)}<span className="text-[11px] font-medium"> H/s</span>
        </div>
        <div className="mt-1 text-[10px] tracking-wider text-muted-foreground uppercase">hashrate</div>
        <div className="mt-1.5 font-mono text-[10px] text-primary tabular-nums">
          {Math.round(load * 100)}% of cpu
        </div>
      </div>
    </div>
  );
}

/** A range input with the filled part shown. Native gives you a grey track whichever
 *  way the thumb is dragged, so the fill is a gradient stop the input carries itself. */
function Dial(props: {
  label: string; hint: string; min: number; max: number;
  value: number; onChange: (n: number) => void;
}) {
  const span = props.max - props.min;
  const fill = span > 0 ? ((props.value - props.min) / span) * 100 : 100;
  return (
    <label className="block">
      <span className="flex items-baseline justify-between gap-2">
        <span className="text-[10px] tracking-wider text-muted-foreground uppercase">{props.label}</span>
        <span className="font-mono text-xs font-semibold tabular-nums">{props.hint}</span>
      </span>
      <input
        type="range" min={props.min} max={props.max} value={props.value}
        onChange={(e) => props.onChange(Number(e.target.value))}
        className="dial mt-1.5"
        style={{ "--fill": `${fill}%` } as React.CSSProperties}
      />
    </label>
  );
}
