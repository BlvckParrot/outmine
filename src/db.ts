import { Database } from "bun:sqlite";

export const db = new Database(process.env.DB_PATH ?? "data/outmine.sqlite", { create: true });
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
