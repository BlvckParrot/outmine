// Where the API lives. Empty in production, so everything stays same-origin and the
// deployed behaviour is unchanged.
//
// In development the browser talks to the Bun server directly instead of through a
// Vite proxy. Proxying a long-lived WebSocket to a server that `bun --watch` restarts
// on every save floods the terminal with EPIPE and is a known Vite problem; there is
// nothing to proxy if the client dials the API itself.
export const API_ORIGIN = import.meta.env.VITE_API_ORIGIN || location.origin;

export const apiUrl = (path: string) => `${API_ORIGIN}${path}`;

export const wsUrl = (path: string) => `${API_ORIGIN.replace(/^http/, "ws")}${path}`;
