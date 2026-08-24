/** Offered to a returning visitor. The button is the consent for this session: the
 *  stored one says they understood what mining is, not that they want the fans on
 *  every time they open the tab. */
export function ResumePanel(props: { name: string; onResume: () => void; onDismiss: () => void }) {
  return (
    <div className="flex items-center gap-3 rounded border border-zinc-800 bg-zinc-900/40 p-3 text-sm">
      <p className="flex-1 text-zinc-400">
        Last time you mined for <span className="font-semibold text-white">{props.name}</span>.
      </p>
      <button
        onClick={props.onResume}
        className="rounded bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-500"
      >
        pick up where you left off
      </button>
      <button onClick={props.onDismiss} className="text-xs text-zinc-600 hover:text-zinc-400">
        forget
      </button>
    </div>
  );
}
