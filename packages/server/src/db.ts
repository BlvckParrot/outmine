import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";

// Anchored to the repo root, not the working directory. `bun --filter` runs the server
// from packages/server, so a relative path means two different files depending on how
// the process was started - and the second one silently looks like an empty board.
// Relative DB_PATH values are resolved here too, not just the default.
const REPO_ROOT = new URL("../../../", import.meta.url).pathname;
const configured = process.env.DB_PATH ?? "data/outmine.sqlite";
const DB_PATH = isAbsolute(configured) ? configured : `${REPO_ROOT}${configured}`;
mkdirSync(dirname(DB_PATH), { recursive: true });

export const db = new Database(DB_PATH, { create: true });
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA busy_timeout = 5000");
db.exec(await Bun.file(new URL("./schema.sql", import.meta.url)).text());

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
};
