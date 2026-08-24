CREATE TABLE IF NOT EXISTS listings (
  id            TEXT PRIMARY KEY,
  kind          TEXT NOT NULL CHECK (kind IN ('domain', 'handle')),
  target        TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  tagline       TEXT NOT NULL DEFAULT '',
  created_at    INTEGER NOT NULL,
  visible       INTEGER NOT NULL DEFAULT 0,
  clicks        INTEGER NOT NULL DEFAULT 0,
  shares        INTEGER NOT NULL DEFAULT 0,
  score         REAL    NOT NULL DEFAULT 0,
  edit_token_hash TEXT NOT NULL
);

-- Hourly aggregates: one row per listing per hour, written by the flush loop.
-- Carries "trending", and makes a 24h leaderboard a WHERE clause rather than a migration.
CREATE TABLE IF NOT EXISTS share_buckets (
  listing_id TEXT NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  hour       INTEGER NOT NULL,
  shares     INTEGER NOT NULL DEFAULT 0,
  diff_sum   REAL    NOT NULL DEFAULT 0,
  PRIMARY KEY (listing_id, hour)
);

-- The two lists the hub rebuilds every broadcast. Each index carries the whole ORDER
-- BY, tie-breaker included, so SQLite reads them in order instead of sorting into a
-- temporary B-tree. Confirmed with EXPLAIN QUERY PLAN.
--
-- The DROP is not tidiness. CREATE INDEX IF NOT EXISTS matches on the name alone, so
-- on a database that already has idx_listings_board the old two-column definition
-- would silently survive and this change would only ever apply to fresh installs.
DROP INDEX IF EXISTS idx_listings_board;
CREATE INDEX IF NOT EXISTS idx_board ON listings(visible, score DESC, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_queue ON listings(visible, shares DESC, created_at DESC);

-- Used by the totals on /api/stats. The 24h board and trending both reach buckets
-- through the primary key instead.
CREATE INDEX IF NOT EXISTS idx_buckets_hour ON share_buckets(hour);

-- Traffic, aggregated as it is counted: no per-request rows, no addresses, no cookies,
-- nothing that could identify the visitor it came from. One row per day per thing being
-- counted, so a year of this is a few thousand rows.
--
-- Unlike the ALTER above, a new table does not need a migration: CREATE TABLE IF NOT
-- EXISTS makes it on a database that already exists just as well as on a fresh one.
CREATE TABLE IF NOT EXISTS traffic (
  day  INTEGER NOT NULL,          -- days since epoch, UTC
  kind TEXT NOT NULL,             -- visit | page | listing | ref | mine
  key  TEXT NOT NULL DEFAULT '',  -- path, listing id or referrer host; '' where the kind is the whole fact
  n    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, kind, key)
) WITHOUT ROWID;
