// One line of JSON per event. No dependency, greppable, and parses in whatever the
// host runs for log collection.
export function log(event: string, fields: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), event, ...fields }));
}

/** Rate-limited logging for events that can fire per share or per message, where the
 *  hundredth copy says nothing the first did not and would bury everything else. */
export function makeThrottledLog(everyMs: number) {
  const last = new Map<string, number>();
  return (event: string, fields: Record<string, unknown> = {}) => {
    const now = Date.now();
    const previous = last.get(event) ?? 0;
    if (now - previous < everyMs) return;
    last.set(event, now);
    log(event, fields);
  };
}
