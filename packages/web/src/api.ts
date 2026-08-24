// Where the API lives, and how pages read from it.
//
// In development the browser talks to the Bun server directly instead of through a
// Vite proxy. Proxying a long-lived WebSocket to a server that `bun --watch` restarts
// on every save floods the terminal with EPIPE and is a known Vite problem; there is
// nothing to proxy if the client dials the API itself. Empty in production, so
// everything stays same-origin and the deployed behaviour is unchanged.
import { useEffect, useState } from "react";

const API_ORIGIN = import.meta.env.VITE_API_ORIGIN || location.origin;

export const apiUrl = (path: string) => `${API_ORIGIN}${path}`;

export const wsUrl = (path: string) => `${API_ORIGIN.replace(/^http/, "ws")}${path}`;

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
