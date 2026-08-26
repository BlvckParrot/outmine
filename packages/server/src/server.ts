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
      if (!ws.data.client) return;
      // handleMessage reaches SQLite - countHit is a write, and every {"t":"view"}
      // message gets there. A throw inside a websocket handler ends the process, so one
      // client and one bad moment would disconnect everyone else.
      try {
        handleMessage(ws.data.client, String(msg));
      } catch (err) {
        log("message_failed", { error: String(err) });
      }
    },
    close(ws) {
      if (ws.data.client) removeClient(ws.data.client);
    },
  },
});

// After the server exists, because the broadcast publishes through it.
startLoops(server);

startBackupJob();

/** The nightly SQLite snapshot, on BACKUP_CRON.
 *
 *  In a subprocess rather than inline: VACUUM INTO is synchronous and everything here
 *  shares one thread, so a backup on the event loop would hold up the broadcast for as
 *  long as the copy takes. Both paths it needs are passed explicitly - the script
 *  resolves its own defaults against the working directory, and the server's are
 *  resolved against the repo root, which are the same place only when the process was
 *  started from there. */
function startBackupJob() {
  if (!config.backupCron) return;
  const script = new URL("../../../scripts/backup.ts", import.meta.url).pathname;

  Bun.cron(config.backupCron, async () => {
    // Nothing in here may throw. Bun.cron hands a handler's error to
    // uncaughtException, and the handler below exits the process - so a full disk
    // during a backup would take the site down with it.
    try {
      const proc = Bun.spawn([process.execPath, script, config.backupDir], {
        env: { ...process.env, DB_PATH: config.dbPath },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [out, err, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      log(code === 0 ? "backup_done" : "backup_failed", { code, out: out.trim(), err: err.trim() });
    } catch (err) {
      log("backup_failed", { error: String(err) });
    }
  }).unref(); // a pending backup is never the reason the process stays alive

  log("backup_scheduled", { cron: config.backupCron, next: Bun.cron.parse(config.backupCron) });
}

/** The built frontend, served by Bun itself.
 *
 *  A `dir` route streams with sendfile and answers Content-Type, ETag, Last-Modified,
 *  304 and Range in native code; going through Hono's serveStatic meant a JS handler,
 *  a read and a hash of the whole body on every request, in the same loop that
 *  broadcasts the board.
 *
 *  index.html and robots.txt are deliberately left out: both go through Hono, which is
 *  the only layer that knows the host. Everything else in dist is content-hashed or
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
    // Both are rewritten per request and have to reach Hono: index.html has its head
    // stitched in and its nonce filled, robots.txt has a Sitemap: line appended. Only
    // Hono knows the host, and both need it.
    if (entry.name === "index.html" || entry.name === "robots.txt") continue;
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

// The last net. A throw anywhere else - a socket callback, a promise nobody awaited -
// ends the Bun process, and unlike SIGTERM it skips the flush below, losing every share
// credited since the last write. Restarting is still right; losing the counters is not.
for (const event of ["uncaughtException", "unhandledRejection"] as const) {
  process.on(event, (err) => {
    log("fatal", { event, error: String(err) });
    try {
      flush();
    } catch {
      /* already the failing path - exiting matters more than the last interval */
    }
    process.exit(1);
  });
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
