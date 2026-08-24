import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "./config";

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
// is a no-op on a database that already exists - so a column added after the first
// deploy has to arrive this way or only fresh installs would ever get it.
for (const column of ["icon BLOB"]) {
  try {
    db.exec(`ALTER TABLE listings ADD COLUMN ${column}`);
  } catch {
    /* already there */
  }
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
