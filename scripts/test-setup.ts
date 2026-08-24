// Preloaded by `bun test`, see bunfig.toml.
//
// routes.test.ts creates and deletes listings, which must never land in
// data/outmine.sqlite. A test file cannot arrange that for itself: Bun shares one
// module registry across every test file, so db.ts is evaluated once by whichever
// file imports it first and a later `process.env.DB_PATH = …` - even in front of a
// dynamic import - arrives after the database is already open. Preload is the only
// point guaranteed to run before that.
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const path = join(tmpdir(), `outmine-test-${process.pid}.sqlite`);

// Cleared here rather than on exit: a pid is reused eventually, and an exit hook does
// not fire on every way a test run can end. Clearing up front is what actually
// guarantees an empty database. WAL leaves two more files beside the main one.
for (const suffix of ["", "-shm", "-wal"]) rmSync(path + suffix, { force: true });

process.env.DB_PATH = path;
