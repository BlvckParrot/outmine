// Process entry point: socket wiring, the WebSocket upgrade gate, and shutdown.
// The HTTP routes live in routes.ts, the tunables in config.ts.
import { readdirSync } from "node:fs";
import { BOARD_TOPIC, addClient, flush, handleMessage, removeClient, startLoops, type SocketData } from "./hub";
import { config, exitIfMisconfigured } from "./config";
import { log } from "./log";
import { app } from "./routes";
import { clientAddress, originAllowed } from "./security";

// Before anything opens a socket or touches the database.
exitIfMisconfigured();

const server = Bun.serve<SocketData, string>({
  port: config.port,

  // Ahead of fetch, and therefore ahead of Hono: a hashed asset is answered by native
  // code and never reaches the loop that broadcasts the board.
  routes: staticRoutes(),

  fetch(req, srv) {
    if (new URL(req.url).pathname === "/ws") return upgradeToMiner(req, srv);

    // Hono cannot see the socket, so the peer address is handed over for rate
    // limiting. Reading X-Forwarded-For instead would be client-controlled.
    return app.fetch(req, { socketAddress: srv.requestIP(req)?.address });
  },

  websocket: {
    maxPayloadLength: config.limits.maxWsPayloadBytes,

    // The board snapshot is ~15 kB of JSON going to every socket at once. Published to
    // a topic it is compressed once for all of them rather than once each, which is the
    // difference between tens of megabytes and a few per broadcast at full capacity.
    perMessageDeflate: true,

    open(ws) {
      const client = addClient(ws, ws.data.address);
      if (!client) {
        ws.close(1013, "at capacity"); // 1013: try again later
        return;
      }
      ws.data.client = client;
      // Subscribed here rather than in the hub: the hub is tested with a plain object
      // for a socket, and pub/sub is Bun's, not ours.
      ws.subscribe(BOARD_TOPIC);
    },
    message(ws, msg) {
      if (ws.data.client) handleMessage(ws.data.client, String(msg));
    },
    close(ws) {
      if (ws.data.client) removeClient(ws.data.client);
    },
  },
});

// After the server exists, because the broadcast publishes through it.
startLoops(server);

/** The built frontend, served by Bun itself.
 *
 *  A `dir` route streams with sendfile and answers Content-Type, ETag, Last-Modified,
 *  304 and Range in native code; going through Hono's serveStatic meant a JS handler,
 *  a read and a hash of the whole body on every request, in the same loop that
 *  broadcasts the board.
 *
 *  index.html is deliberately left out: it goes through Hono, which stitches in the
 *  crawler tags and the CSP nonce. Everything else in dist is content-hashed or
 *  immutable by nature.
 *
 *  Read once at startup, so a new build needs a restart - which is what deploying one
 *  does anyway, and development serves the frontend from Vite. */
function staticRoutes(): Record<string, Bun.BunFile | { dir: string }> {
  const routes: Record<string, Bun.BunFile | { dir: string }> = {};

  let entries;
  try {
    entries = readdirSync(config.webDist, { withFileTypes: true });
  } catch {
    // Not fatal: the API and the miner work without a build, and indexHandler already
    // says what to run. Logged because in production it means an empty site.
    log("web_dist_missing", { path: config.webDist });
    return routes;
  }

  for (const entry of entries) {
    if (entry.name === "index.html") continue;
    const path = `${config.webDist}/${entry.name}`;
    if (entry.isDirectory()) routes[`/${entry.name}/*`] = { dir: path };
    else if (entry.isFile()) routes[`/${entry.name}`] = Bun.file(path);
  }
  return routes;
}

function upgradeToMiner(req: Request, srv: Bun.Server<SocketData>): Response | undefined {
  const origin = req.headers.get("origin");
  if (!originAllowed(origin, req.url)) {
    log("ws_origin_rejected", { origin });
    return new Response("origin not allowed", { status: 403 });
  }

  // The same address the HTTP limiters key on, and for the same reason: behind a proxy
  // the peer is the proxy, so counting sockets by peer counts the whole site as one
  // visitor - and the per-address ceiling then refuses everyone after the tenth.
  // clientAddress falls back to the peer when TRUSTED_PROXIES is 0, which is direct
  // exposure and development.
  const data: SocketData = {
    client: null,
    address: clientAddress(req.headers, srv.requestIP(req)?.address),
  };
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
