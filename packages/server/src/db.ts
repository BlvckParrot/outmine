import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "./config";
import { log } from "./log";

mkdirSync(dirname(config.dbPath), { recursive: true });

export const db = new Database(config.dbPath, { create: true });
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA busy_timeout = 5000");
// The usual pairing for WAL. At the default FULL every commit waits for an fsync,
// including the one behind every outbound click. NORMAL still cannot corrupt the
// database; a power cut can cost the last transactions, which here is at most one
// flush interval of shares.
db.exec("PRAGMA synchronous = NORMAL");
db.exec(await Bun.file(new URL("./schema.sql", import.meta.url)).text());

// SQLite has no ADD COLUMN IF NOT EXISTS, and CREATE TABLE IF NOT EXISTS in schema.sql
// is a no-op on a database that already exists - so anything added after the first
// deploy has to arrive this way or only fresh installs would ever get it.
//
// Append only, never edit or reorder: the index of a step is its version, and a
// database that has already run step 2 will never look at it again.
const MIGRATIONS = [
  `ALTER TABLE listings ADD COLUMN icon BLOB`, // 0 -> 1
];

migrate();

function migrate() {
  let version = db.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version;

  // Databases from before this loop existed: the icon column was added by a
  // try/catch ALTER that left no record of itself, so version 0 does not mean the
  // step below is still owed. Running it anyway would fail on a duplicate column and
  // take the process down at import time.
  if (version === 0 && hasColumn("listings", "icon")) {
    db.exec("PRAGMA user_version = 1");
    version = 1;
  }

  for (; version < MIGRATIONS.length; version++) {
    const step = MIGRATIONS[version]!;
    // One transaction per step, so a failure leaves the version pointing at the step
    // that has to be retried rather than at one that never ran.
    db.transaction(() => {
      db.exec(step);
      db.exec(`PRAGMA user_version = ${version + 1}`); // PRAGMA takes no bound parameter
    })();
    log("migrated", { version: version + 1, step });
  }
}

// A declaration, not a const: migrate() runs at import time, above this line.
function hasColumn(table: string, column: string): boolean {
  return db.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all()
    .some((c) => c.name === column);
}


/** Liveness probe for /health. A query rather than a flag: the file can go away or
 *  the disk can fill under a process that is otherwise perfectly happy. */
export function dbAlive(): boolean {
  try {
    db.query("SELECT 1").get();
    return true;
  } catch {
    return false;
  }
}

export type Listing = {
  id: string;
  kind: "domain" | "handle";
  target: string;
  name: string;
  tagline: string;
  created_at: number;
  visible: number;
  clicks: number;
  shares: number;
  score: number;
  /** 1 when an icon has been uploaded. The bytes themselves are never selected with
   *  the row: a board page is fifty rows and would carry a megabyte of PNG. */
  has_icon: number;
};
