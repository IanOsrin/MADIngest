-- Optional local tracking table (SQLite or Postgres)
-- Only needed if you want a local log of imports separate from FileMaker.
-- GalloIngest works without this — FileMaker IS the record of truth.

CREATE TABLE IF NOT EXISTS imports (
  id             SERIAL PRIMARY KEY,
  title          TEXT,
  artist         TEXT,
  s3_key         TEXT,
  s3_url         TEXT,
  fm_record_id   TEXT,
  format         TEXT,
  submitted_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  synced_at      TIMESTAMP,           -- set by sync-utility once pulled to Vision
  synced_path    TEXT                 -- local Vision path after sync
);
