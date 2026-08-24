export function ConsentBanner({ onAccept }: { onAccept: () => void }) {
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
