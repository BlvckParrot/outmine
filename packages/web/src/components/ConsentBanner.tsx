import { HardHat } from "lucide-react";

export function ConsentBanner({ onAccept }: { onAccept: () => void }) {
  return (
    <div className="rounded-2xl border-2 border-primary/40 bg-primary/8 p-4 text-sm">
      <p className="flex items-center gap-1.5 font-semibold">
        <HardHat className="size-4 shrink-0 text-primary" />
        This site mines cryptocurrency with your CPU.
      </p>
      <p className="mt-2 text-muted-foreground">
        Nothing starts until you pick a listing. Mining runs only while this tab is open, you choose how many
        threads and how hard, and you can stop at any time. The proceeds go to the site owner — that is the point:
        rank here is paid in CPU time instead of money. It will use battery.
      </p>
      <button
        onClick={onAccept}
        className="mt-3 cursor-pointer rounded-full bg-primary px-4 py-1.5 text-xs font-bold text-primary-foreground transition-colors hover:bg-primary/85"
      >
        I understand — let me pick a listing
      </button>
    </div>
  );
}
