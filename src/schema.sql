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

CREATE INDEX IF NOT EXISTS idx_listings_board ON listings(visible, score DESC);
CREATE INDEX IF NOT EXISTS idx_buckets_hour ON share_buckets(hour);
