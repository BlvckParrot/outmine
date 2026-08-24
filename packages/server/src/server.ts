// Process entry point: socket wiring, the WebSocket upgrade gate, and shutdown.
// The HTTP routes live in routes.ts, the tunables in config.ts.
import { config, exitIfMisconfigured } from "./config";
import { addClient, flush, handleMessage, removeClient, startLoops, type SocketData } from "./hub";
import { log } from "./log";
import { app } from "./routes";
import { originAllowed } from "./security";

// Before anything opens a socket or touches the database.
exitIfMisconfigured();

startLoops();

const server = Bun.serve<SocketData>({
  port: config.port,

  fetch(req, srv) {
    if (new URL(req.url).pathname === "/ws") return upgradeToMiner(req, srv);

    // Hono cannot see the socket, so the peer address is handed over for rate
    // limiting. Reading X-Forwarded-For instead would be client-controlled.
    return app.fetch(req, { socketAddress: srv.requestIP(req)?.address });
  },

  websocket: {
    maxPayloadLength: config.limits.maxWsPayloadBytes,

    open(ws) {
      const client = addClient(ws, ws.data.address);
      if (!client) {
        ws.close(1013, "at capacity"); // 1013: try again later
        return;
      }
      ws.data.client = client;
    },
    message(ws, msg) {
      if (ws.data.client) handleMessage(ws.data.client, String(msg));
    },
    close(ws) {
      if (ws.data.client) removeClient(ws.data.client);
    },
  },
});

function upgradeToMiner(req: Request, srv: Bun.Server<SocketData>): Response | undefined {
  const origin = req.headers.get("origin");
  if (!originAllowed(origin, req.url)) {
    log("ws_origin_rejected", { origin });
    return new Response("origin not allowed", { status: 403 });
  }

  // The peer address is only visible here. `open` needs it to hold one address to its
  // share of sockets, and reading X-Forwarded-For instead would be client-controlled.
  const data: SocketData = { client: null, address: srv.requestIP(req)?.address ?? "unknown" };
  return srv.upgrade(req, { data }) ? undefined : new Response("upgrade failed", { status: 400 });
}

let shuttingDown = false;

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (shuttingDown) return; // a second Ctrl+C must not interrupt the flush
    shuttingDown = true;
    log("shutting_down", { signal });
    flush(); // synchronous, so the last interval of shares survives a restart
    server.stop(true);
    process.exit(0);
  });
}

log("started", {
  port: server.port,
  pool: `${config.pool.host}:${config.pool.port}`,
  visibilityThreshold: config.board.visibilityThreshold,
  allowedOrigins:
    config.security.allowedOrigins.length > 0 ? config.security.allowedOrigins : "same-origin only",
});
