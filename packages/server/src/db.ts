import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "./config";

mkdirSync(dirname(config.dbPath), { recursive: true });

export const db = new Database(config.dbPath, { create: true });
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
