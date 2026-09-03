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

-- One row per payment that has already bought a conversion. The claim is what
-- makes an authorization single-use HERE, before the work is served.
--
-- Verify is a READ: the facilitator says the signature is good and the funds
-- are there, and says it again every time it is asked. Nothing is spent until
-- settle, and settle runs after the response. So the same paid header presented
-- concurrently verified every time and bought a conversion every time — the
-- per-caller ceiling was the only thing bounding it, and that is per IP.
--
-- The row is claimed BETWEEN verify and the conversion, so the first request
-- through owns the payment and every later one is answered 402 'payment already
-- used' — and it is RELEASED on every exit that does not serve a conversion,
-- because a claim with no compensating delete would spend the buyer's
-- authorization on a 400. Same rule as the ordering around settle: YOU ARE ONLY
-- CHARGED FOR CONVERSIONS THAT ARE SERVED.
--
-- WHAT THIS IS NOT: an authoritative double-spend guard. The hash is of the
-- payment header as presented, so the same authorization re-encoded with its
-- keys in another order hashes differently. The authoritative backstop is on
-- chain — an EIP-3009 nonce is single-use, and a second settle comes back
-- `nonce_already_used`, which `settlements` records. This table exists to stop
-- the amplification BEFORE the conversion is served, which the chain cannot do.
--
-- `created_at` is for the operator: prune on the same 90-day chore as the raw
-- events, past any authorization's maxTimeoutSeconds. `route` is for the
-- operator too — which tool a replay was aimed at — and is deliberately NOT part
-- of the key: one authorization buys one call anywhere on this service, not one
-- per tool.
CREATE TABLE IF NOT EXISTS payment_seen (
  hash       TEXT PRIMARY KEY,  -- SHA-256 of the presented payment header, hex
  created_at INTEGER,           -- unix seconds, UTC
  route      TEXT               -- entry id the claim was taken for, e.g. 'md-html'
);

-- Settlement ledger. One row per payment ATTEMPT that reached the facilitator,
-- so this table is the answer to "did anyone actually pay, and did the money
-- land". It is written on three paths, and the three stay distinguishable:
--
--   verify_ok = 1, settle_ok = 1  the money moved; tx_hash is the chain hash
--   verify_ok = 1, settle_ok = 0  the conversion was served and settlement then
--                                 failed. The accepted exposure, $0.001 a row.
--   verify_ok = 0, settle_ok = 0  either the facilitator REJECTED the payment
--                                 (error = its invalidReason, and no conversion
--                                 was served) or it could not be reached (error
--                                 = facilitator-unreachable / -unconfigured /
--                                 -error, and the conversion WAS served free).
--
-- `payer` is an address its owner revealed by paying, and `tx_hash` is public
-- chain data. Neither is derived from an IP, a user-agent or any other passive
-- signal, so neither is covered by the daily-salt discard the other tables rely
-- on — and these rows are kept rather than pruned: they are the revenue record.
--
-- NOT written for free-tier calls. The free tier is not a payment path and the
-- facilitator is never called inside it, so it has nothing to record here.
CREATE TABLE IF NOT EXISTS settlements (
  ts        INTEGER,  -- unix seconds, UTC
  tool      TEXT,     -- entry id, e.g. 'md-html'
  payer     TEXT,     -- payer address from the payment payload, or NULL
  amount    TEXT,     -- atomic units as a string, '1000' for $0.001
  verify_ok INTEGER,  -- 1 | 0
  settle_ok INTEGER,  -- 1 | 0
  tx_hash   TEXT,     -- settlement transaction hash, or NULL
  error     TEXT      -- invalidReason / errorReason / transport reason, or NULL
);

-- Rung 1 looks up by identifier; the operator read and the 90-day prune scan by time.
CREATE INDEX IF NOT EXISTS idx_events_id_hash ON events (id_hash);
CREATE INDEX IF NOT EXISTS idx_events_ts      ON events (ts);
CREATE INDEX IF NOT EXISTS idx_events_entry   ON events (entry);

-- The operator read on settlements is "what happened lately", so it scans by time.
CREATE INDEX IF NOT EXISTS idx_settlements_ts ON settlements (ts);
