// Toolshed beacon Worker.
//
// One route: POST /b on the directory hostname. Two event types, rows ~200 bytes.
// The pathgrip pattern is adopted here and nowhere else in this repo — the read
// surface is static Cloudflare Pages with zero Functions, so this is the only
// metered path in the system.
//
// Rungs (dossier § Limits):
//   0  edge rate-limiting rule, /b, 5 req / 10 s per IP, action block  [configured in the dashboard, not here]
//   1  per-identifier token count, 100 events / identifier / UTC day   [below]
//   2  global fail-closed, 200,000 events / UTC day                    [below]
//   3  the residual — priced, not bounded by mechanism; detective controls
//      are the $25 billing alert plus the route-disable runbook in README.md
//
// CPU is metered separately from requests, so the reject path stays CPU-minimal:
// method, path and size are checked before any body read, any crypto, any D1.
//
// No `scheduled` handler by design — zero crons. The salt rotates lazily on the
// first request of a new UTC day; blocklist expiry and the 90-day events prune
// are operator queries, documented in README.md.

const MAX_BODY = 1024; // bytes; a legitimate beacon body is ~40
const MAX_ENTRY_ID = 64;
const RUNG1_PER_ID_PER_DAY = 100;
const RUNG2_GLOBAL_PER_DAY = 200_000;

// Self-declared bots only. No claim to perfect human detection is made.
const BOT_UA = /bot|crawl|spider|slurp|headless/i;

const CORS = { 'access-control-allow-origin': '*' };

// Every outcome on the /b path answers 204 — accepted, rate-limited, bot-dropped
// and malformed are indistinguishable from outside, so the response leaks no state.
const noContent = () => new Response(null, { status: 204, headers: CORS });

export default {
  async fetch(request, env) {
    // --- reject path: no body read, no crypto, no D1 -----------------------
    if (request.method !== 'POST') return new Response(null, { status: 405 });
    if (new URL(request.url).pathname !== '/b') return new Response(null, { status: 404 });

    const declared = Number(request.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > MAX_BODY) return noContent();

    const ua = request.headers.get('user-agent') || '';
    if (BOT_UA.test(ua)) return noContent();

    // --- parse -------------------------------------------------------------
    let body;
    try {
      const raw = await request.text();
      if (raw.length > MAX_BODY) return noContent();
      body = JSON.parse(raw);
    } catch {
      return noContent();
    }
    if (!body || typeof body !== 'object') return noContent();

    const type = body.t;
    if (type !== 'visit' && type !== 'click') return noContent();

    let entry = null;
    if (body.e != null) {
      if (typeof body.e !== 'string' || body.e.length > MAX_ENTRY_ID) return noContent();
      entry = body.e;
    }

    const db = env.DB;
    if (!db) return noContent();

    const now = Math.floor(Date.now() / 1000);
    const day = new Date(now * 1000).toISOString().slice(0, 10); // UTC
    const dayStart = Math.floor(Date.parse(`${day}T00:00:00Z`) / 1000);

    try {
      // --- identity: day-scoped, unlinkable once the salt is overwritten ----
      const salt = await currentSalt(db, day);
      const ip = request.headers.get('cf-connecting-ip') || '';
      const idHash = await truncatedHash(salt + ip + ua);

      // --- rung 1: per-identifier token count ------------------------------
      // Identifiers expire daily with the salt, so today's rows are all this
      // identifier has; the ts predicate is belt-and-braces across a rotation.
      const seen = await db
        .prepare('SELECT COUNT(*) AS n FROM events WHERE id_hash = ?1 AND ts >= ?2')
        .bind(idHash, dayStart)
        .first();
      if ((seen?.n ?? 0) >= RUNG1_PER_ID_PER_DAY) return noContent();

      // --- rung 2: global fail-closed --------------------------------------
      const counter = await db.prepare('SELECT total FROM counters WHERE day = ?1').bind(day).first();
      if ((counter?.total ?? 0) >= RUNG2_GLOBAL_PER_DAY) return noContent();

      // --- write ------------------------------------------------------------
      // Coarse referrer class only. The raw referrer is never stored.
      const refClass = classifyReferer(request);
      await db.batch([
        db
          .prepare('INSERT INTO events (ts, type, id_hash, entry, ref_class) VALUES (?1, ?2, ?3, ?4, ?5)')
          .bind(now, type, idHash, entry, refClass),
        db
          .prepare('INSERT INTO counters (day, total) VALUES (?1, 1) ON CONFLICT(day) DO UPDATE SET total = total + 1')
          .bind(day),
      ]);
    } catch {
      // Metrics loss is the acceptable failure. Never surface store state.
      return noContent();
    }

    return noContent();
  },
};

// The day's salt, rotated lazily. The overwrite IS the discard: no derived or
// HMAC salt, because a recomputable salt is the negation of discarded-at-rotation.
async function currentSalt(db, day) {
  const row = await db.prepare("SELECT day, value FROM salt WHERE key = 'current'").first();
  if (row && row.day === day && row.value) return row.value;

  const fresh = randomHex(32);
  // The guarded upsert makes rotation atomic: a racing isolate that finds the
  // day already rotated updates nothing and gets no row back, so it re-reads
  // the winner's salt rather than minting a second identity space for the day.
  const written = await db
    .prepare(
      "INSERT INTO salt (key, day, value) VALUES ('current', ?1, ?2) " +
        'ON CONFLICT(key) DO UPDATE SET day = excluded.day, value = excluded.value ' +
        'WHERE salt.day <> excluded.day ' +
        'RETURNING value'
    )
    .bind(day, fresh)
    .first();
  if (written?.value) return written.value;

  const after = await db.prepare("SELECT value FROM salt WHERE key = 'current'").first();
  return after?.value || fresh;
}

async function truncatedHash(input) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return hex(new Uint8Array(digest)).slice(0, 16);
}

function randomHex(bytes) {
  return hex(crypto.getRandomValues(new Uint8Array(bytes)));
}

function hex(bytes) {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

function classifyReferer(request) {
  const ref = request.headers.get('referer');
  if (!ref) return 'none';
  try {
    return new URL(ref).origin === new URL(request.url).origin ? 'internal' : 'external';
  } catch {
    return 'none';
  }
}
