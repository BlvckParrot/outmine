/** Offered to a returning visitor. The button is the consent for this session: the
 *  stored one says they understood what mining is, not that they want the fans on
 *  every time they open the tab. */
export function ResumePanel(props: { name: string; onResume: () => void; onDismiss: () => void }) {
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-2xl bg-muted p-3 text-sm">
      <p className="flex-1 text-muted-foreground">
        Last time you mined for <span className="font-semibold text-foreground">{props.name}</span>.
      </p>
      <button
        onClick={props.onResume}
        className="cursor-pointer rounded-full bg-primary px-3 py-1.5 text-xs font-bold text-primary-foreground transition-colors hover:bg-primary/85"
      >
        pick up where you left off
      </button>
      <button
        onClick={props.onDismiss}
        className="cursor-pointer text-xs text-muted-foreground hover:text-foreground"
      >
        forget
      </button>
    </div>
  );
}
