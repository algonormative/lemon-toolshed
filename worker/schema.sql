-- Toolshed store (D1). Five tables plus one counter row per day.
--
-- Retention is an operator chore, not a cron (the Worker exports no `scheduled`
-- handler by design). The queries that enforce the published retention promises
-- live in README.md § Operator queries.

-- Raw events. ~200 bytes a row. Kept 90 days at most, then compacted into
-- daily_aggregates and deleted. `id_hash` is the first 16 hex chars of
-- SHA-256(daily_salt + ip + ua) — unlinkable once the day's salt is overwritten.
-- No IP, no user-agent and no raw referrer are ever written here, and no
-- conversion input is ever written here.
--
-- One row per beacon event AND one row per accepted /convert call. The three
-- types share one table because they are one measurement — what got used — but
-- they no longer share one BUDGET: rung 1 counts rows where type <> 'convert',
-- and conversions are metered by convert_quota below.
CREATE TABLE IF NOT EXISTS events (
  ts        INTEGER,  -- unix seconds, UTC
  type      TEXT,     -- 'visit' | 'click' | 'convert'
  id_hash   TEXT,     -- truncated day-scoped hash
  entry     TEXT,     -- entry id for clicks and conversions, NULL for visits
  ref_class TEXT      -- 'internal' | 'external' | 'none'
);

-- Counts only. Contains no personal data, so it is kept.
CREATE TABLE IF NOT EXISTS daily_aggregates (
  day    TEXT,
  metric TEXT,
  value  INTEGER,
  PRIMARY KEY (day, metric)
);

-- Abuse defence. Keyed on the address, therefore attributable: purged on
-- request, and rows expire 90 days after last_seen.
CREATE TABLE IF NOT EXISTS blocklist (
  ip         TEXT PRIMARY KEY,
  first_seen INTEGER,
  last_seen  INTEGER,
  counter    INTEGER,
  reason     TEXT
);

-- One row, key = 'current'. Overwritten with fresh random bytes on the first
-- request of a new UTC day; the overwrite is the discard.
CREATE TABLE IF NOT EXISTS salt (
  key   TEXT PRIMARY KEY,
  day   TEXT,
  value TEXT
);

-- Rung 2's global fail-closed counter: one row read before every insert.
CREATE TABLE IF NOT EXISTS counters (
  day   TEXT PRIMARY KEY,
  total INTEGER
);

-- The conversion free tier: one row per caller per UTC day, claimed by a guarded
-- upsert in worker/beacon.js. `ip_hash` is the first 16 hex chars of
-- SHA-256(daily_salt + ip) — the IP ALONE, no user-agent, because rotating a UA
-- string must not mint a fresh daily allowance. It is unlinkable across days for
-- the same reason `events.id_hash` is: the salt is overwritten, and the overwrite
-- is the discard. Only today's row is ever read; older rows are pruned on the
-- same 90-day chore as the raw events (README.md § Retention chores).
CREATE TABLE IF NOT EXISTS convert_quota (
  day     TEXT,     -- UTC date, YYYY-MM-DD
  ip_hash TEXT,     -- truncated day-scoped hash of the IP alone
  used    INTEGER,  -- conversions claimed today
  PRIMARY KEY (day, ip_hash)
);

-- Rung 1 looks up by identifier; the operator read and the 90-day prune scan by time.
CREATE INDEX IF NOT EXISTS idx_events_id_hash ON events (id_hash);
CREATE INDEX IF NOT EXISTS idx_events_ts      ON events (ts);
CREATE INDEX IF NOT EXISTS idx_events_entry   ON events (entry);
