// Toolshed API Worker.
//
// Three routes, and they are metered very differently:
//
//   POST /b            the beacon. Two event types, rows ~200 bytes. Unchanged
//                      from the beacon-only Worker this file grew out of — same
//                      rungs, same salt, same writes.
//   GET  /check        availability lookup over the catalog compiled into this
//                      bundle at build time (worker/catalog.generated.js). No
//                      fetch, no KV, no D1 — so it is cheap, and it is exempt
//                      from the rungs below.
//   POST /convert/<id> the hosted conversions. Rungs 1 and 2 apply here too,
//                      sharing the same daily counters as /b.
//
// The file keeps its name because the beacon is still the thing that has to keep
// working byte-for-byte; the conversions grew around it.
//
// Rungs (dossier § Limits):
//   0  edge rate-limiting rule, 5 req / 10 s per IP, action block  [dashboard, not here]
//      NOTE: the rule's expression must cover /b AND /convert/* — see README § Deploy.
//   1  per-identifier token count, 100 events / identifier / UTC day   [below]
//   2  global fail-closed, 200,000 events / UTC day                    [below]
//   3  the residual — priced, not bounded by mechanism; detective controls
//      are the $25 billing alert plus the route-disable runbook in README.md
//
// CPU is metered separately from requests, so every reject path stays
// CPU-minimal: method, path and size are checked before any body read, any
// crypto, any D1, and before any conversion runs.
//
// Where /b and /convert differ on failure: /b drops silently (metrics loss is
// the acceptable failure), /convert fails CLOSED with a 503 when the rate-limit
// store is unreachable. Failing open on a metered endpoint is the runaway-cost
// scenario rung 3 has no mechanism for, so an unavailable limiter means no
// conversions rather than unlimited conversions.
//
// No `scheduled` handler by design — zero crons. The salt rotates lazily on the
// first request of a new UTC day; blocklist expiry and the 90-day events prune
// are operator queries, documented in README.md.

import { marked } from 'marked';
import yaml from 'js-yaml';
import TurndownService from 'turndown';
import domino from '@mixmark-io/domino';
import { CATALOG, SITE_BASE } from './catalog.generated.js';

const MAX_BODY = 1024; // bytes; a legitimate beacon body is ~40
const MAX_ENTRY_ID = 64;
const RUNG1_PER_ID_PER_DAY = 100;
const RUNG2_GLOBAL_PER_DAY = 200_000;

const MAX_CONVERT_BODY = 256 * 1024; // 256 KB
const MAX_QUERY_LEN = 64;

// USDC on Base, 6 decimals. $0.001 is therefore "1000" atomic units.
const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const USDC_DECIMALS = 6;
const X402_TIMEOUT_SECONDS = 60;

// Self-declared bots only. No claim to perfect human detection is made.
const BOT_UA = /bot|crawl|spider|slurp|headless/i;

const CORS = { 'access-control-allow-origin': '*' };

// Every outcome on the /b path answers 204 — accepted, rate-limited, bot-dropped
// and malformed are indistinguishable from outside, so the response leaks no state.
const noContent = () => new Response(null, { status: 204, headers: CORS });

const json = (body, status = 200, headers = {}) =>
  new Response(`${JSON.stringify(body)}\n`, {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (path === '/check') return handleCheck(request);
    if (path.startsWith('/convert/')) return handleConvert(request, env, path);
    return handleBeacon(request, env, path);
  },
};

// ------------------------------------------------------------------ /b
//
// Unchanged. The guards, the order of the rung checks, the salt handling and the
// two writes are the same as they were when this was the only route.

async function handleBeacon(request, env, path) {
  // --- reject path: no body read, no crypto, no D1 -----------------------
  if (request.method !== 'POST') return new Response(null, { status: 405 });
  if (path !== '/b') return new Response(null, { status: 404 });

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

    // --- rungs 1 and 2 -----------------------------------------------------
    if (await rungsExceeded(db, idHash, day, dayStart)) return noContent();

    // --- write ------------------------------------------------------------
    // Coarse referrer class only. The raw referrer is never stored.
    await recordEvent(db, { now, day, type, idHash, entry, refClass: classifyReferer(request) });
  } catch {
    // Metrics loss is the acceptable failure. Never surface store state.
    return noContent();
  }

  return noContent();
}

// ------------------------------------------------------------------ /check
//
// A pure in-memory filter over the compiled catalog. No D1, so no rungs.
// Matching is field-BOUND: `from` is tested against the have side only, `to`
// against the need side only, both as case-insensitive substrings. With no
// parameters at all, the answer is every hosted entry.

function handleCheck(request) {
  if (request.method !== 'GET') {
    return json({ error: 'GET only' }, 405, { ...CORS, allow: 'GET' });
  }

  const params = new URL(request.url).searchParams;
  const from = params.get('from');
  const to = params.get('to');
  if ((from && from.length > MAX_QUERY_LEN) || (to && to.length > MAX_QUERY_LEN)) {
    return json({ error: `from and to are limited to ${MAX_QUERY_LEN} characters` }, 400, CORS);
  }

  const f = from ? from.trim().toLowerCase() : '';
  const t = to ? to.trim().toLowerCase() : '';

  const matches =
    !f && !t
      ? CATALOG.filter((e) => e.hosted)
      : CATALOG.filter(
          (e) => (!f || e.x.toLowerCase().includes(f)) && (!t || e.y.toLowerCase().includes(t))
        );

  return json(
    {
      query: { from: from ?? null, to: to ?? null },
      matches: matches.map((e) => ({
        id: e.id,
        x: e.x,
        y: e.y,
        hosted: e.hosted,
        local: e.local,
        url: e.url,
      })),
    },
    200,
    CORS
  );
}

// ------------------------------------------------------------------ /convert
//
// Order of checks is the reject discipline: method, then whether the id exists,
// then the declared size — all before the rate-limit round trip, the body read
// and the conversion itself.

async function handleConvert(request, env, path) {
  if (request.method !== 'POST') {
    return json({ error: 'POST the input as the request body' }, 405, { allow: 'POST' });
  }

  const id = path.slice('/convert/'.length);
  const entry = HOSTED.get(id);
  if (!entry) return json({ error: `no hosted conversion with id "${id}" — see GET /check` }, 404);

  const conv = CONVERTERS[id];
  if (!conv) return json({ error: `conversion "${id}" is listed but not implemented` }, 501);

  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_CONVERT_BODY) return tooLarge();

  // --- rungs 1 and 2, sharing /b's daily counters ------------------------
  const db = env.DB;
  if (!db) return json({ error: 'conversion is unavailable' }, 503);

  const now = Math.floor(Date.now() / 1000);
  const day = new Date(now * 1000).toISOString().slice(0, 10); // UTC
  const dayStart = Math.floor(Date.parse(`${day}T00:00:00Z`) / 1000);

  try {
    const salt = await currentSalt(db, day);
    const ip = request.headers.get('cf-connecting-ip') || '';
    const ua = request.headers.get('user-agent') || '';
    const idHash = await truncatedHash(salt + ip + ua);

    if (await rungsExceeded(db, idHash, day, dayStart)) {
      return json({ error: 'daily call limit reached' }, 429);
    }

    // One row per accepted call: that a call happened, and which tool. The
    // input is never written. This is also what makes rung 1 bite on /convert.
    await recordEvent(db, {
      now,
      day,
      type: 'convert',
      idHash,
      entry: id,
      refClass: classifyReferer(request),
    });
  } catch {
    // Fail closed: an unreachable limiter means no conversions, not unlimited ones.
    return json({ error: 'conversion is unavailable' }, 503);
  }

  // --- payment gate ------------------------------------------------------
  const gate = paymentGate(entry, conv, env, request);
  if (gate.response) return gate.response;

  // --- read, convert -----------------------------------------------------
  let input;
  try {
    const buf = await request.arrayBuffer();
    if (buf.byteLength > MAX_CONVERT_BODY) return tooLarge();
    input = new TextDecoder().decode(buf);
  } catch {
    return json({ error: 'could not read the request body' }, 400);
  }
  if (!input.trim()) return json({ error: 'the request body is empty' }, 400);

  let output;
  try {
    output = conv.run(input);
  } catch (err) {
    if (err instanceof ConvertError) return json({ error: err.message }, 400);
    // Never surface a stack trace. Anything unexpected is still the input's
    // most likely cause, so it is reported as a bad request, not as a crash.
    return json({ error: `could not convert the input: ${oneLineMessage(err)}` }, 400);
  }

  return new Response(output, {
    status: 200,
    headers: { 'content-type': conv.contentType, ...gate.headers },
  });
}

const tooLarge = () =>
  json({ error: `input is larger than the ${MAX_CONVERT_BODY / 1024} KB limit` }, 413);

// ------------------------------------------------------------------ x402
//
// What is implemented, and what is not:
//
//   PAYTO unset            → the conversion is served free, with `x-pricing: pending`.
//   PAYTO set, no payment  → HTTP 402 with a spec-valid x402 v1 envelope.
//   PAYTO set, X-PAYMENT   → the conversion is served free, with `x-pricing: pending`
//                            and `x-payment-verified: false`.
//
// The last line is the honest one: settlement verification needs a facilitator,
// FACILITATOR_URL is not wired up yet, and this Worker will not pretend to have
// checked a payment it cannot check. Full enforcement lands with the facilitator.

function paymentGate(entry, conv, env, request) {
  const price = entry.hosted.price;
  if (price === 'free') return { headers: {} };

  const payTo = env.PAYTO;
  if (!payTo) return { headers: { 'x-pricing': 'pending' } };

  if (request.headers.get('x-payment')) {
    return { headers: { 'x-pricing': 'pending', 'x-payment-verified': 'false' } };
  }

  return {
    response: json(
      {
        x402Version: 1,
        error: 'X-PAYMENT header is required',
        accepts: [
          {
            scheme: price.scheme || 'exact',
            network: 'base',
            maxAmountRequired: atomicAmount(price.amount_usd),
            resource: `${SITE_BASE}${entry.hosted.path}`,
            description: conv.description,
            mimeType: conv.mimeType,
            payTo,
            maxTimeoutSeconds: X402_TIMEOUT_SECONDS,
            asset: USDC_BASE,
          },
        ],
      },
      402
    ),
  };
}

const atomicAmount = (usd) => String(Math.round(usd * 10 ** USDC_DECIMALS));

// ------------------------------------------------------------------ converters

class ConvertError extends Error {}

function oneLineMessage(err) {
  const raw = String((err && err.message) || err || 'unknown error');
  return raw.replace(/\s+/g, ' ').trim().slice(0, 200);
}

const CONVERTERS = {
  'md-html': {
    description: 'Markdown to HTML conversion',
    mimeType: 'text/html',
    contentType: 'text/html; charset=utf-8',
    run: (input) => marked.parse(input),
  },

  'json-yaml': {
    description: 'JSON to YAML conversion',
    mimeType: 'application/yaml',
    contentType: 'application/yaml; charset=utf-8',
    run: (input) => {
      let parsed;
      try {
        parsed = JSON.parse(input);
      } catch (err) {
        throw new ConvertError(`input is not valid JSON: ${oneLineMessage(err)}`);
      }
      return yaml.dump(parsed);
    },
  },

  'yaml-json': {
    description: 'YAML to JSON conversion',
    mimeType: 'application/json',
    contentType: 'application/json; charset=utf-8',
    run: (input) => {
      let docs;
      try {
        // A stream converts as its first document; the caveat on the entry says so.
        docs = yaml.loadAll(input);
      } catch (err) {
        throw new ConvertError(`input is not valid YAML: ${oneLineMessage(err)}`);
      }
      if (!docs.length || docs[0] === undefined) throw new ConvertError('input has no YAML document');
      return `${JSON.stringify(docs[0], null, 2)}\n`;
    },
  },

  'csv-json': {
    description: 'CSV to JSON conversion',
    mimeType: 'application/json',
    contentType: 'application/json; charset=utf-8',
    run: (input) => `${JSON.stringify(csvToRecords(input), null, 2)}\n`,
  },

  'html-markdown': {
    description: 'HTML to Markdown conversion',
    mimeType: 'text/markdown',
    contentType: 'text/markdown; charset=utf-8',
    run: (input) => {
      // Turndown's browser build reaches for a global `document` that workerd
      // does not have, so the HTML is parsed with domino here and the resulting
      // element handed to Turndown, which skips its own parser entirely.
      const doc = domino.createDocument(input, true);
      return turndown.turndown(doc.body);
    },
  },
};

const turndown = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
  bulletListMarker: '-',
});

// RFC 4180: quoted fields, doubled quotes inside them, commas and CRLF or LF
// line endings. A leading BOM is stripped. Values stay strings — guessing types
// is where leading zeros and long ids get destroyed.
function parseCsvRows(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (quoted) {
      if (ch !== '"') {
        field += ch;
      } else if (text[i + 1] === '"') {
        field += '"';
        i++;
      } else {
        quoted = false;
      }
      continue;
    }

    if (ch === '"' && field === '') {
      quoted = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += ch;
    }
  }

  if (quoted) throw new ConvertError('input has an unterminated quoted field');
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function csvToRecords(input) {
  const rows = parseCsvRows(input.replace(/^\uFEFF/, ''));
  if (!rows.length) throw new ConvertError('input has no rows');

  const header = rows[0].map((h) => h.trim());
  if (header.every((h) => h === '')) throw new ConvertError('the first row must be a non-empty header row');

  const records = [];
  for (let r = 1; r < rows.length; r++) {
    const cells = rows[r];
    if (cells.length === 1 && cells[0] === '') continue; // blank line
    if (cells.length > header.length) {
      throw new ConvertError(
        `row ${r + 1} has ${cells.length} fields but the header has ${header.length}`
      );
    }
    const record = {};
    for (let c = 0; c < header.length; c++) record[header[c]] = cells[c] ?? '';
    records.push(record);
  }
  return records;
}

// Live hosted entries, by id — the routing table for /convert.
const HOSTED = new Map(
  CATALOG.filter((e) => e.hosted && e.hosted.status === 'live').map((e) => [e.id, e])
);

// ------------------------------------------------------------------ store

// Rungs 1 and 2, in that order, shared by /b and /convert.
//   1  per-identifier token count. Identifiers expire daily with the salt, so
//      today's rows are all this identifier has; the ts predicate is
//      belt-and-braces across a rotation.
//   2  global fail-closed, read before every insert.
async function rungsExceeded(db, idHash, day, dayStart) {
  const seen = await db
    .prepare('SELECT COUNT(*) AS n FROM events WHERE id_hash = ?1 AND ts >= ?2')
    .bind(idHash, dayStart)
    .first();
  if ((seen?.n ?? 0) >= RUNG1_PER_ID_PER_DAY) return true;

  const counter = await db.prepare('SELECT total FROM counters WHERE day = ?1').bind(day).first();
  if ((counter?.total ?? 0) >= RUNG2_GLOBAL_PER_DAY) return true;

  return false;
}

async function recordEvent(db, { now, day, type, idHash, entry, refClass }) {
  await db.batch([
    db
      .prepare('INSERT INTO events (ts, type, id_hash, entry, ref_class) VALUES (?1, ?2, ?3, ?4, ?5)')
      .bind(now, type, idHash, entry, refClass),
    db
      .prepare('INSERT INTO counters (day, total) VALUES (?1, 1) ON CONFLICT(day) DO UPDATE SET total = total + 1')
      .bind(day),
  ]);
}

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
