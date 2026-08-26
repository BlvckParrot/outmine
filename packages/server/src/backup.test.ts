// The backup is the one job with no user to notice it failing, so what is tested here
// is the wiring rather than the SQL: the script is spawned the way startBackupJob in
// server.ts spawns it, and the file it leaves behind is opened and read.
import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "./config";
import { db } from "./db";

const script = new URL("../../../scripts/backup.ts", import.meta.url).pathname;

test("the default BACKUP_CRON is a usable expression that fires at 04:00", () => {
  const next = Bun.cron.parse(config.backupCron);
  expect(next).not.toBeNull();
  expect(next!.getHours()).toBe(4);
  expect(next!.getMinutes()).toBe(0);
});

test("a malformed BACKUP_CRON throws rather than returning null", () => {
  // Which is why config.ts catches around parse instead of testing its result: an
  // unwrapped throw there would end the process at import time, out of the one module
  // written to collect every bad value and print them together.
  expect(() => Bun.cron.parse("nonsense")).toThrow();
  expect(() => Bun.cron.parse("")).toThrow(); // and why an empty value is guarded first
});

test("the spawned script writes a snapshot that opens and carries the schema", async () => {
  db.exec("PRAGMA wal_checkpoint(FULL)"); // the tables exist in this connection's WAL
  const outDir = mkdtempSync(join(tmpdir(), "outmine-backup-"));
  // Whatever the rest of the suite has left in the shared test database. Bun runs test
  // files one at a time in one process, so nothing writes between here and the spawn.
  const live = db.query<{ n: number }, []>("SELECT count(*) AS n FROM listings").get()!.n;

  try {
    // Both paths absolute and DB_PATH forced, exactly as server.ts passes them - the
    // point of the test is that a working directory the script never saw still works.
    const proc = Bun.spawn([process.execPath, script, outDir], {
      env: { ...process.env, DB_PATH: config.dbPath },
      cwd: tmpdir(),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [err, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    expect(err).toBe("");
    expect(code).toBe(0);

    const [snapshot, ...rest] = readdirSync(outDir);
    expect(rest).toEqual([]);
    expect(snapshot).toMatch(/^outmine-.*\.sqlite$/);

    const copy = new Database(join(outDir, snapshot!), { readonly: true });
    // A VACUUM INTO of the wrong path, or of nothing, still leaves a valid database
    // behind - an empty one. So the assertion is on the rows, not on the file: a
    // missing table throws here, and a snapshot of some other database misses them.
    expect(copy.query("SELECT count(*) AS n FROM listings").get()).toEqual({ n: live });
    copy.close();
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});
