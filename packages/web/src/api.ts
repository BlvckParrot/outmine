// Where the API lives, and how pages read from it.
//
// In development the browser talks to the Bun server directly instead of through a
// Vite proxy. Proxying a long-lived WebSocket to a server that `bun --watch` restarts
// on every save floods the terminal with EPIPE and is a known Vite problem; there is
// nothing to proxy if the client dials the API itself. Empty in production, so
// everything stays same-origin and the deployed behaviour is unchanged.
import { useEffect, useState } from "react";

// Read when a URL is built rather than when this module loads. At module scope it made
// importing anything that reaches api.ts require a browser - `location` is not defined
// in a test runner, so a unit test of a pure function three imports away failed on a
// line it never runs.
const origin = () => import.meta.env.VITE_API_ORIGIN || location.origin;

export const apiUrl = (path: string) => `${origin()}${path}`;

export const wsUrl = (path: string) => `${origin().replace(/^http/, "ws")}${path}`;

/** A write that reports failure instead of throwing it.
 *
 *  Every form used to `await fetch(...)` and then `await res.json()` bare. A server
 *  that is down rejects the first; a proxy answering with an HTML 502 rejects the
 *  second. Either way the rejection escaped the submit handler, so the button did
 *  nothing at all - no message, no spinner, nothing on screen to say why. `data.error`
 *  was read unguarded too, so an error body shaped differently rendered "undefined". */
export async function request<T>(
  path: string,
  init: RequestInit,
): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  let res: Response;
  try {
    res = await fetch(apiUrl(path), init);
  } catch {
    return { ok: false, error: "could not reach the server — check your connection" };
  }
  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  if (!res.ok) return { ok: false, error: body?.error ?? `failed (${res.status})` };
  return { ok: true, data: body as T };
}

/** Fetches `path` and keeps it fresh, or fetches it once when `everyMs` is omitted.
 *
 *  Three pages had their own copy of this and only one of them guarded against a
 *  response arriving after the component had gone - which is a React warning at best
 *  and a state update into a dead tree at worst. A failed refresh keeps the last good
 *  value rather than blanking the page: this data is decoration, not the board. */
export function usePolled<T>(path: string | null, everyMs?: number): T | null {
  const [data, setData] = useState<T | null>(null);

  useEffect(() => {
    if (!path) return;
    // A changed path is a different question. Without this the previous query's rows
    // stayed on screen under the new search until its response landed, and `null` is
    // also how the caller tells "no answer yet" from "no results" - see Home.
    setData(null);
    let live = true;
    const load = () =>
      fetch(apiUrl(path))
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
        .then((value: T) => live && setData(value))
        .catch(() => {/* keep whatever we last had */});

    load();
    if (!everyMs) return () => { live = false; };

    const timer = setInterval(load, everyMs);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [path, everyMs]);

  return data;
}
