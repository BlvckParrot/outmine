// Where a browser error goes now that it goes somewhere.
//
// Until this existed, a render that threw reached console.error in ErrorBoundary and
// stopped there, which meant nobody ever found out. The browser is where the miner
// runs, so it is also where the failures that matter happen: a WASM module that will
// not instantiate in one browser, a worker that dies, a socket that never opens.
//
// Off unless the server says otherwise. See config.observe and OBSERVE_* in
// .env.example: a dev tree and a plain deployment both load this module, find no
// settings and do nothing.
// Imported dynamically below, not here. Statically it lands in the entry chunk and
// costs every visitor 21 kB gzipped before the first paint - on a page whose whole
// argument is that it spends your CPU on mining rather than on itself. As its own
// chunk it downloads alongside everything else and blocks nothing.
type Settings = { origin: string; org: string; token: string };

/** The settings the server wrote into the document, or null.
 *
 *  A JSON block rather than a global assigned by an inline script: application/json is
 *  never executed, so the server can emit it without a nonce and without the CSP
 *  growing a directive for the sake of three strings. See OBSERVE_MARKER in share.ts.
 *
 *  Every failure here is silent and returns null. This is the error reporter; a page
 *  that would not load because its error reporter could not read its own settings is
 *  worse than no error reporter. */
function settings(): Settings | null {
  try {
    const el = document.getElementById("observe-config");
    if (!el?.textContent) return null;
    const parsed = JSON.parse(el.textContent) as Partial<Settings>;
    const { origin, org, token } = parsed;
    if (!origin || !org || !token) return null;
    return { origin, org, token };
  } catch {
    return null;
  }
}

type Logs = typeof import("@openobserve/browser-logs").openobserveLogs;

let logs: Logs | null = null;

/** Errors caught before the chunk arrived. Small and bounded: the window this covers is
 *  one page load, and a page throwing hundreds of times in it has a different problem.
 *  Dropped silently past the cap rather than grown without limit. */
const pending: Array<[string, unknown, Record<string, unknown>]> = [];
const PENDING_MAX = 20;

/** Called from main.tsx before the first render. Returns immediately; the SDK arrives
 *  when it arrives, and anything reportError catches meanwhile is replayed then. */
export function startObserving(): void {
  const config = settings();
  if (!config || logs) return;

  void import("@openobserve/browser-logs").then(({ openobserveLogs }) => {
    const url = new URL(config.origin);
    openobserveLogs.init({
      clientToken: config.token,
      // Host and not the whole origin: the SDK builds the URL itself and takes the
      // scheme from insecureHTTP below.
      site: url.host,
      insecureHTTP: url.protocol === "http:",
      organizationIdentifier: config.org,
      service: "outmine",
      // The whole reason for the dependency: uncaught exceptions, unhandled promise
      // rejections and console.error, forwarded without a call site having to know.
      forwardErrorsToLogs: true,
      sessionSampleRate: 100,
      // The SDK reports on itself otherwise. This site does not need telemetry about
      // its telemetry, and every such request is one the visitor pays for.
      telemetrySampleRate: 0,
    });
    logs = openobserveLogs;
    for (const [message, error, context] of pending.splice(0)) report(message, error, context);
  }).catch(() => {
    /* a reporter that cannot load must not take the page with it */
  });
}

function report(message: string, error: unknown, context: Record<string, unknown>): void {
  try {
    logs?.logger.error(message, context, error instanceof Error ? error : new Error(String(error)));
  } catch {
    /* as above */
  }
}

/** An error the code caught itself, with whatever the catcher knows about it.
 *
 *  forwardErrorsToLogs already sees anything that reaches the window, so this is not
 *  about coverage - it is about context. ErrorBoundary knows which part of the tree
 *  stopped rendering, and that is not recoverable from the stack alone. */
export function reportError(message: string, error: unknown, context: Record<string, unknown> = {}): void {
  if (logs) return report(message, error, context);
  // The SDK is still on the wire. A render that throws on mount - the case
  // ErrorBoundary exists for - happens inside exactly this window, so dropping it
  // here would lose the errors most worth having.
  if (pending.length < PENDING_MAX) pending.push([message, error, context]);
}
