// Point-in-time copy of the SQLite file, safe to run while the server is writing.
// Usage: bun scripts/backup.ts [outDir]
//
// The server already runs this on BACKUP_CRON (see startBackupJob in server.ts) and
// passes both paths absolute; run it by hand for a snapshot before a migration or a
// risky DELETE. By hand, DB_PATH and outDir are relative to the working directory, so
// run it from the repo root.
import { Database } from "bun:sqlite";
import { mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";

const SOURCE = process.env.DB_PATH ?? "data/outmine.sqlite";
// Beside the database, not inside it. `data/backups` meant every snapshot shared one
// directory with the file it was a snapshot of, so `rm -rf data` took all fifteen.
const OUT_DIR = process.argv[2] ?? "backups";
// `|| 14`, not a bare Number(): BACKUP_KEEP=abc is NaN, and slice(NaN) is slice(0),
// which would delete every backup this script just listed.
const KEEP = Number(process.env.BACKUP_KEEP ?? 14) || 14;

mkdirSync(OUT_DIR, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const target = join(OUT_DIR, `outmine-${stamp}.sqlite`);

// VACUUM INTO takes a consistent snapshot without stopping writers, unlike copying
// the file, which can catch a torn page mid-checkpoint.
const db = new Database(SOURCE, { readonly: true });
db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
db.close();

const backups = readdirSync(OUT_DIR)
  .filter((f) => f.startsWith("outmine-") && f.endsWith(".sqlite"))
  .sort()
  .reverse();
for (const old of backups.slice(KEEP)) unlinkSync(join(OUT_DIR, old));

console.log(`${target}  ${(statSync(target).size / 1024).toFixed(0)} KiB  (keeping ${Math.min(backups.length, KEEP)})`);
