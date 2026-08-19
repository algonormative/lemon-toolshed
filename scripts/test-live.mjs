#!/usr/bin/env node
// Live smoke test for the Toolshed API, plus a cost estimate.
//
//   node scripts/test-live.mjs                          # production
//   node scripts/test-live.mjs http://localhost:8787    # wrangler dev --local
//   TOOLSHED_URL=... node scripts/test-live.mjs
//
// THIS RUN SERVES NO CONVERSIONS AND SPENDS NOTHING. Not a cent of USDC, and
// nothing that moves a Cloudflare meter past a couple of dozen requests. That is
// the whole design of the file, and what makes it possible is that the hosted
// service HAS NO FREE TIER: POST /convert/<id> with no X-PAYMENT header answers
// 402 on the very first call, and this script never sends an X-PAYMENT header.
// Every conversion probe below therefore stops at the paywall — which is exactly
// the thing being checked.
//
// What that buys, and what it does not:
//
//   checked here      the public gate. GET /check and its aliases, the machine
//                     -readable surfaces (catalog.json, llms.txt, llms-full.txt,
//                     openapi.json, robots.txt), and one 402-envelope probe per
//                     hosted tool — the exact JSON a paying agent reads before it
//                     signs anything, down to the outputSchema.input.discoverable
//                     flag that Coinbase's Bazaar discovery index keys on. BOTH
//                     protocol versions: the v1 envelope in the body and the v2
//                     one in the PAYMENT-REQUIRED header, plus the assertion
//                     that the two name the same offer. The header half is only
//                     checkable here — the local suite proves the Worker sends
//                     it, and production is what proves it arrives.
//   NOT checked here  that any converter still converts. No 402 path runs one. A
//                     green row here says THE GATE IS RIGHT; it says nothing
//                     about the tool behind the gate.
//
// Converter coverage lives in `npm test`: the local suite against
// `wrangler dev --local`, which is free and asserts real output. End-to-end
// payment coverage lives in scripts/pay-test.mjs, which is OWNER-ONLY and spends
// real USDC. Those two plus this file are the whole picture; none of them is a
// substitute for another.
//
// On the free tier: it still exists as a MECHANISM, behind a FREE_TIER_DAILY env
// var that is unset in production. This script does not assume it is off. GET
// /check publishes the runtime value the Worker enforces, and if a deployment has
// a free tier switched on, the affected rows say so loudly rather than quietly
// asserting the wrong contract.
//
// Zero dependencies — Node 18+ for global fetch, and nothing else.

const ARGS = process.argv.slice(2);
const BASE = (
  ARGS.find((a) => !a.startsWith('--')) ||
  process.env.TOOLSHED_URL ||
  'https://toolshed.lemon-agent.dev'
).replace(/\/+$/, '');

// ---------------------------------------------------------------- harness

const results = [];

// Things that are not failures but that a reader must not miss: a deployment
// with a free tier switched on, or one with no receiving address configured.
// They are printed again under the table so they cannot scroll past.
const notes = [];
const loud = (text) => notes.push(text);

function record(name, ok, detail) {
  results.push({ name, ok, detail });
  process.stdout.write(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}\n`);
}

// A row returns either a detail string, or `{ name, detail }` when what actually
// happened is not what the row set out to check. The table is the skim surface,
// and a row titled "offers an envelope" reading PASS when no envelope was ever
// offered is a lie however good the detail next to it is.
async function test(name, fn) {
  try {
    const out = await fn();
    const detail = typeof out === 'string' ? out : out?.detail;
    record((typeof out === 'object' && out?.name) || name, true, detail);
  } catch (err) {
    record(name, false, String((err && err.message) || err).replace(/\s+/g, ' ').slice(0, 200));
  }
}

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

function parseJson(text, what) {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${what} is not JSON: ${text.replace(/\s+/g, ' ').slice(0, 120)}`);
  }
}

const sleep = (ms) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

// Rung 0 — the edge rate-limiting rule, 5 requests / 10 s per IP — will block a
// tight loop, and this run makes more requests than the old free-tier one did
// (five envelope probes plus five static files), so every request goes through a
// pacer rather than each row remembering to sleep. There is no edge in front of
// `wrangler dev`, so a local run does not wait.
const LOCAL = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(BASE);
const PACE_MS = LOCAL ? 0 : 2500;

let requestCount = 0;
let convertRequestCount = 0;
let lastRequestAt = 0;

async function paced(path, init) {
  const wait = PACE_MS - (Date.now() - lastRequestAt);
  if (wait > 0) await sleep(wait);
  requestCount += 1;
  if (path.startsWith('/convert/')) convertRequestCount += 1;
  try {
    return await fetch(`${BASE}${path}`, init);
  } finally {
    lastRequestAt = Date.now();
  }
}

const get = (path) => paced(path);
const post = (path, body, headers = {}) => paced(path, { method: 'POST', body, headers });

// ---------------------------------------------------------------- fixtures
//
// Tiny on purpose. Nothing here is converted in a normal run — the payload only
// has to be a valid body for the tool, so that the 402 that comes back is the
// paywall answering and not an input rejection. `expect` is used in one case
// only: a deployment that has a free tier switched on and serves the call.

const CONVERSIONS = [
  {
    id: 'md-html',
    input: '# Hi\n\nHello **world**.\n',
    expect: '<strong>world</strong>',
    mimeType: 'text/html',
  },
  {
    id: 'json-yaml',
    input: '{"lemon":"toolshed","n":42}',
    expect: 'lemon: toolshed',
    mimeType: 'application/yaml',
  },
  {
    id: 'yaml-json',
    input: 'lemon: toolshed\nn: 42\n',
    expect: '"lemon": "toolshed"',
    mimeType: 'application/json',
  },
  {
    id: 'csv-json',
    input: 'name,qty\nlemon,3\n',
    expect: '"name": "lemon"',
    mimeType: 'application/json',
  },
  {
    id: 'html-markdown',
    input: '<h1>Toolshed</h1><p>hello</p>',
    expect: '# Toolshed',
    mimeType: 'text/markdown',
  },
];

const HOSTED_EXPECTED = 5;
const BIG_INPUT_BYTES = 300 * 1024;

// USDC on Base, and the EIP-712 domain a client signs the transfer authorization
// over. These two are pinned exactly: a buyer's signature is computed against
// them, so a drift here does not degrade the product, it makes every payment
// verify as invalid.
const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const USDC_EXTRA = { name: 'USD Coin', version: '2' };

// The facilitator rejects paymentRequirements carrying a description longer than
// this, so an over-long description is not a cosmetic problem — it is an
// unpayable envelope.
const MAX_DESCRIPTION_CHARS = 500;

// The runtime free tier, as GET /check reports it. Production is 0. Anything
// above that is a deployment with FREE_TIER_DAILY set, which changes what the
// convert probes are allowed to see.
let runtimeFreeTier = null;

// Filled by the /check row, and reused by the alias rows so they cost no extra
// requests against rung 0.
let hostedMatches = null;

// Conversions this run actually had SERVED. It should stay 0 forever; it is a
// counter rather than a constant so the cost block below reports what happened
// rather than what was intended.
let served = 0;

// Which tool claimed which envelope description, so "each tool advertises its
// own" is checked rather than assumed.
const descriptionOwners = new Map();

// ---------------------------------------------------------------- table

function printTable() {
  const passed = results.filter((r) => r.ok).length;
  const failed = results.length - passed;
  const nameWidth = Math.max(...results.map((r) => r.name.length));

  console.log(`\n${'='.repeat(nameWidth + 10)}`);
  console.log(`${'TEST'.padEnd(nameWidth)}  RESULT`);
  console.log('-'.repeat(nameWidth + 10));
  for (const r of results) console.log(`${r.name.padEnd(nameWidth)}  ${r.ok ? 'PASS' : 'FAIL'}`);
  console.log('-'.repeat(nameWidth + 10));
  console.log(`${String(`${passed} passed, ${failed} failed`).padEnd(nameWidth)}  ${failed ? 'FAIL' : 'PASS'}`);
  console.log(`${'='.repeat(nameWidth + 10)}\n`);

  if (notes.length) {
    console.log('NOTES — not failures, but do not skim past them');
    for (const n of notes) console.log(`  * ${n}`);
    console.log('');
  }
  return failed;
}

// ---------------------------------------------------------------- envelope
//
// The x402 envelope is the product's actual API for a paying agent: it reads
// this, signs against it, and retries. Everything asserted here is something a
// buyer or a discovery index depends on.
//
// What is pinned exactly and what is only sanity-checked is a deliberate split.
// Pinned: the fields a signature is computed over (network, scheme, asset,
// extra) and the fields that identify the tool (resource, mimeType) — a wrong
// value there breaks payment or points a buyer at the wrong endpoint. Sanity
// -checked only: price and timeout, which are owner-tunable, so pinning them
// would turn a config change into a red row that says nothing.

/** Every `description` string anywhere in the envelope, at any depth. */
function everyDescription(value, out = []) {
  if (Array.isArray(value)) {
    for (const v of value) everyDescription(v, out);
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (k === 'description' && typeof v === 'string') out.push(v);
      everyDescription(v, out);
    }
  }
  return out;
}

const canonical = (obj) =>
  JSON.stringify(
    Object.fromEntries(Object.entries(obj ?? {}).sort(([a], [b]) => (a < b ? -1 : 1)))
  );

function assertEnvelope(offer, tool) {
  assert(offer && typeof offer === 'object', 'accepts[0] is not an object');

  assert(offer.scheme === 'exact', `scheme is ${JSON.stringify(offer.scheme)}, expected "exact"`);
  assert(offer.network === 'base', `network is ${JSON.stringify(offer.network)}, expected "base"`);

  // The envelope has to name THIS tool. A shared or stale resource means a buyer
  // signs a payment for one endpoint and spends it at another.
  assert(typeof offer.resource === 'string', 'the envelope names no resource');
  assert(/^https?:\/\//.test(offer.resource), `resource ${offer.resource} is not an absolute URL`);
  assert(
    offer.resource.endsWith(`/convert/${tool.id}`),
    `resource is ${offer.resource}, expected it to end /convert/${tool.id}`
  );

  assert(
    typeof offer.description === 'string' && offer.description.trim().length > 0,
    'the envelope carries no description'
  );
  const alreadyClaimedBy = descriptionOwners.get(offer.description);
  assert(
    !alreadyClaimedBy,
    `${tool.id} advertises the same description as ${alreadyClaimedBy} — the envelopes are not per-tool`
  );
  descriptionOwners.set(offer.description, tool.id);

  assert(
    offer.mimeType === tool.mimeType,
    `mimeType is ${JSON.stringify(offer.mimeType)}, expected ${JSON.stringify(tool.mimeType)}`
  );

  assert(
    /^0x[0-9a-fA-F]{40}$/.test(String(offer.payTo)),
    `payTo ${JSON.stringify(offer.payTo)} is not a plausible address`
  );

  assert(
    /^[0-9]+$/.test(String(offer.maxAmountRequired)),
    `maxAmountRequired ${JSON.stringify(offer.maxAmountRequired)} is not a numeric string`
  );
  assert(Number(offer.maxAmountRequired) > 0, 'maxAmountRequired is zero');

  assert(
    String(offer.asset).toLowerCase() === USDC_BASE.toLowerCase(),
    `asset is ${offer.asset}, expected USDC on Base (${USDC_BASE})`
  );
  assert(
    canonical(offer.extra) === canonical(USDC_EXTRA),
    `extra is ${JSON.stringify(offer.extra)}, expected ${JSON.stringify(USDC_EXTRA)} — a client that ` +
      'signs over a different EIP-712 domain produces a signature the facilitator rejects'
  );

  assert(
    Number.isInteger(offer.maxTimeoutSeconds) && offer.maxTimeoutSeconds > 0,
    `maxTimeoutSeconds is ${JSON.stringify(offer.maxTimeoutSeconds)}`
  );

  // outputSchema is what Coinbase's Bazaar reads to index the endpoint. Without
  // `discoverable`, the tool is payable but invisible: nothing crawls it.
  const schema = offer.outputSchema;
  assert(schema && typeof schema === 'object', 'the envelope has no outputSchema');
  const input = schema.input;
  const output = schema.output;
  assert(input && typeof input === 'object', 'the envelope has no outputSchema.input');
  assert(
    input.discoverable === true,
    `outputSchema.input.discoverable is ${JSON.stringify(input.discoverable)} — Bazaar will not index this tool`
  );
  assert(input.type === 'http', `outputSchema.input.type is ${JSON.stringify(input.type)}, expected "http"`);
  assert(
    input.method === 'POST',
    `outputSchema.input.method is ${JSON.stringify(input.method)}, expected "POST"`
  );
  assert(
    input.bodyType === 'text',
    `outputSchema.input.bodyType is ${JSON.stringify(input.bodyType)}, expected "text"`
  );
  assert(output && typeof output === 'object', 'the envelope has no outputSchema.output');
  assert(
    output.type === 'string',
    `outputSchema.output.type is ${JSON.stringify(output.type)}, expected "string"`
  );
  assert(
    typeof output.description === 'string' && output.description.trim().length > 0,
    'outputSchema.output carries no description'
  );

  for (const text of everyDescription(offer)) {
    assert(
      text.length <= MAX_DESCRIPTION_CHARS,
      `a description is ${text.length} characters, over the facilitator's ${MAX_DESCRIPTION_CHARS}-character ` +
        `limit — the envelope is unpayable: "${text.slice(0, 60)}..."`
    );
  }

  return (
    `402 — ${offer.maxAmountRequired} atomic USDC to ${offer.payTo}, discoverable, ` +
    `${offer.description.length}-char description`
  );
}

/**
 * The x402 v2 envelope, which lives in a HEADER rather than in the body.
 *
 * This is the half a v2 buyer actually reads — it checks `PAYMENT-REQUIRED`
 * first and falls back to the body only when the body says `x402Version: 1`,
 * which ours does say, but only a v1 client is listening for it. So a missing
 * header is a seller that published no terms at all to every v2 buyer and to
 * Coinbase's Bazaar validator, which since 2026-08-19 refuses a v1-only
 * endpoint outright.
 *
 * Asserted LIVE rather than only locally because a response header is exactly
 * the thing an intermediary can drop: the suite proves the Worker sends it, and
 * only production proves it arrives.
 */
function assertEnvelopeV2(res, offer, tool) {
  const header = res.headers.get('payment-required');
  assert(header, 'the 402 carries no PAYMENT-REQUIRED header — a v2 buyer sees no envelope');
  assert(
    /^[A-Za-z0-9+/]*={0,2}$/.test(header),
    'PAYMENT-REQUIRED is not standard base64 — a client rejects it before decoding'
  );

  let env;
  try {
    env = JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
  } catch (err) {
    throw new Error(`PAYMENT-REQUIRED does not decode to JSON: ${err.message}`);
  }

  assert(env.x402Version === 2, `the v2 envelope says x402Version ${JSON.stringify(env.x402Version)}`);
  assert(Array.isArray(env.accepts) && env.accepts.length === 1, 'the v2 envelope has no single accepts entry');
  const v2 = env.accepts[0];

  // CAIP-2. "base" is the v1 spelling and makes a v2 envelope invalid — a
  // failure with no error message anywhere.
  assert(v2.network === 'eip155:8453', `v2 network is ${JSON.stringify(v2.network)}, expected "eip155:8453"`);
  assert(v2.maxAmountRequired === undefined, 'the v2 accepts entry still carries the v1 maxAmountRequired');
  assert(v2.resource === undefined, 'the v2 accepts entry still carries the v1 resource');

  // THE AGREEMENT — one offer, two spellings. Each envelope is independently
  // valid, so a disagreement is felt only by the buyer that read the other one.
  assert(v2.amount === offer.maxAmountRequired, `v2 amount ${v2.amount} != v1 ${offer.maxAmountRequired}`);
  assert(v2.payTo === offer.payTo, 'the two envelopes name different payees');
  assert(v2.asset === offer.asset, 'the two envelopes name different assets');
  assert(v2.scheme === offer.scheme, 'the two envelopes name different schemes');
  assert(canonical(v2.extra) === canonical(offer.extra), 'the two envelopes sign over different EIP-712 domains');
  assert(env.resource?.url === offer.resource, 'the two envelopes name different resources');
  assert(env.resource?.mimeType === offer.mimeType, 'the two envelopes name different mimeTypes');
  assert(
    typeof env.resource?.url === 'string' && env.resource.url.endsWith(`/convert/${tool.id}`),
    `the v2 resource is ${env.resource?.url}, expected it to end /convert/${tool.id}`
  );

  // v1's outputSchema lives here now. No bazaar block, no listing.
  const bazaar = env.extensions?.bazaar;
  assert(bazaar?.info?.input, 'no extensions.bazaar.info.input — this tool cannot be indexed');
  assert(bazaar.schema, 'no extensions.bazaar.schema — a facilitator cannot validate the info against anything');
  assert(bazaar.info.input.method === 'POST', `bazaar input.method is ${JSON.stringify(bazaar.info.input.method)}`);
  assert(
    bazaar.info.input.bodyType === 'text',
    `bazaar input.bodyType is ${JSON.stringify(bazaar.info.input.bodyType)}, expected "text"`
  );
  assert(
    typeof bazaar.info.input.body === 'string' && bazaar.info.input.body.trim().length > 0,
    'bazaar input.body publishes no example request'
  );

  for (const text of everyDescription(env)) {
    assert(
      text.length <= MAX_DESCRIPTION_CHARS,
      `a v2 description is ${text.length} characters, over the facilitator's ` +
        `${MAX_DESCRIPTION_CHARS}-character limit — the listing is rejected`
    );
  }

  return `v2 — ${v2.amount} atomic USDC on ${v2.network}, bazaar block present, ${header.length}-byte header`;
}

/**
 * What a caller that presented no payment is allowed to get back, and what each
 * answer means. Exactly one of these is the production contract (402); the other
 * two are real deployment states that must be reported rather than mislabelled.
 */
async function probeGate(res, tool) {
  const text = await res.text();

  if (res.status === 402) {
    const body = parseJson(text, 'the 402 body');
    assert(body.x402Version === 1, `x402Version is ${JSON.stringify(body.x402Version)}, expected 1`);
    assert(Array.isArray(body.accepts), 'accepts is not an array');
    assert(
      body.accepts.length === 1,
      `accepts has ${body.accepts.length} entries, expected exactly 1`
    );
    const v1 = assertEnvelope(body.accepts[0], tool);
    // Dual-stack: the same 402 has to satisfy a v2 buyer too, and that half
    // travels in a header this function is the only live reader of.
    return `${v1}; ${assertEnvelopeV2(res, body.accepts[0], tool)}`;
  }

  if (res.status === 429) {
    // The only 429 a first, unpaid call can legitimately get: a deployment with
    // no receiving address, so there is nowhere to pay and no envelope to build.
    // Nothing resets at midnight — a misconfiguration is not a quota — so this
    // form deliberately carries no Retry-After.
    const body = parseJson(text, 'the 429 body');
    assert(
      body.free_tier_daily === 0,
      `429 body says free_tier_daily ${JSON.stringify(body.free_tier_daily)}, expected 0`
    );
    assert(
      typeof body.retry === 'string' && body.retry.trim().length > 0,
      'the 429 body does not say what has to change'
    );
    assert(
      res.headers.get('retry-after') === null,
      'the misconfiguration 429 carries a Retry-After — nothing about it resets on a clock'
    );
    loud(
      `${tool.id}: this deployment has NO RECEIVING ADDRESS CONFIGURED, so it cannot sell anything. ` +
        `The Worker said: ${String(body.retry).slice(0, 120)}`
    );
    return {
      name: `POST /convert/${tool.id} with no payment — NO RECEIVING ADDRESS, no envelope to check`,
      detail: `429 — ${String(body.error).slice(0, 70)}`,
    };
  }

  if (res.status === 200) {
    // Only reachable with FREE_TIER_DAILY set. Against production that is a
    // contradiction with what /check just published, and a red row.
    assert(
      runtimeFreeTier === null || runtimeFreeTier > 0,
      `served an unpaid conversion, but GET /check publishes free_tier_daily ${runtimeFreeTier} — ` +
        'the paywall is not being applied'
    );
    const out = text;
    assert(out.includes(tool.expect), `output did not contain ${JSON.stringify(tool.expect)}`);
    served += 1;
    loud(
      `${tool.id}: this deployment HAS A FREE TIER ENABLED (FREE_TIER_DAILY=${runtimeFreeTier}) and served ` +
        'the call. No 402 envelope was checked for it, and this run is no longer free of served conversions.'
    );
    return {
      name: `POST /convert/${tool.id} with no payment — FREE TIER ENABLED, converted instead of charging`,
      detail: `200 — no envelope checked; output: ${out.replace(/\s+/g, ' ').trim().slice(0, 40)}`,
    };
  }

  throw new Error(`expected 402, got ${res.status}: ${text.replace(/\s+/g, ' ').slice(0, 160)}`);
}

// ---------------------------------------------------------------- tests

console.log(`Toolshed live test — ${BASE}`);
console.log(
  'This run serves NO conversions and spends NOTHING: it never sends an X-PAYMENT header, so every\n' +
    '/convert probe stops at the 402 paywall and is checked as an envelope, not as a conversion.\n' +
    'Converter coverage: `npm test` (local, free). Paid-path coverage: scripts/pay-test.mjs (owner only,\n' +
    `real USDC).${PACE_MS ? ` Requests paced ${PACE_MS} ms for the 5 req / 10 s edge rule.` : ''}\n`
);

// ------------------------------------------------------------ 1. /check

await test('GET /check with no parameters lists every hosted tool', async () => {
  const res = await get('/check');
  assert(res.status === 200, `expected 200, got ${res.status}`);
  const body = await res.json();
  assert(Array.isArray(body.matches), 'matches is not an array');
  assert(
    body.matches.length === HOSTED_EXPECTED,
    `expected ${HOSTED_EXPECTED} hosted tools, got ${body.matches.length}`
  );
  assert(
    body.matches.every((m) => m.hosted),
    'a match came back with no hosted block'
  );
  for (const m of body.matches) {
    assert(m.hosted.path === `/convert/${m.id}`, `${m.id}: path and id disagree`);
    assert(
      Number.isInteger(m.hosted.free_tier_daily),
      `${m.id} publishes no free_tier_daily — /check is meant to report the RUNTIME value the Worker enforces`
    );
  }

  const published = [...new Set(body.matches.map((m) => m.hosted.free_tier_daily))];
  assert(published.length === 1, `the tools disagree about free_tier_daily: ${published.join(', ')}`);
  runtimeFreeTier = published[0];
  hostedMatches = body.matches;

  // 0 is the production contract. Anything else is a deployment with the
  // FREE_TIER_DAILY env var set — legal, and loudly reported, not a failure.
  if (runtimeFreeTier > 0) {
    loud(
      `GET /check publishes free_tier_daily ${runtimeFreeTier} — THIS DEPLOYMENT HAS A FREE TIER ENABLED. ` +
        'Production runs with FREE_TIER_DAILY unset and publishes 0.'
    );
  }
  return `${body.matches.length} hosted: ${body.matches.map((m) => m.id).join(', ')} — free_tier_daily ${runtimeFreeTier}`;
});

await test('GET /check entries publish their alias lists', async () => {
  assert(hostedMatches, 'the /check row above did not complete, so there is nothing to read');
  for (const m of hostedMatches) {
    assert(Array.isArray(m.x_aliases), `${m.id} publishes no x_aliases array`);
    assert(Array.isArray(m.y_aliases), `${m.id} publishes no y_aliases array`);
  }
  const md = hostedMatches.find((m) => m.id === 'md-html');
  assert(md, 'md-html is not in the hosted list');
  return `md-html: x_aliases [${md.x_aliases.join(', ')}] y_aliases [${md.y_aliases.join(', ')}]`;
});

await test('GET /check?from=markdown&to=html returns exactly md-html', async () => {
  const res = await get('/check?from=markdown&to=html');
  assert(res.status === 200, `expected 200, got ${res.status}`);
  const ids = (await res.json()).matches.map((m) => m.id);
  assert(ids.length === 1 && ids[0] === 'md-html', `expected [md-html], got [${ids.join(', ')}]`);
  return 'md-html';
});

// Alias resolution is a MEMBERSHIP claim, not an exclusivity one: the catalog
// carries plenty of non-hosted markdown-input entries, and an alias query is
// supposed to find them too. What matters is that the alias resolves at all —
// `from=md` finding nothing is the bug this row exists to catch.
const ALIAS_QUERIES = [
  { query: 'from=md&to=html', want: 'md-html' },
  { query: 'from=.md&to=html', want: 'md-html' },
  { query: 'from=text/markdown&to=text/html', want: 'md-html' },
  { query: 'from=yaml&to=json', want: 'yaml-json' },
  { query: 'from=.yml&to=application/json', want: 'yaml-json' },
];

for (const { query, want } of ALIAS_QUERIES) {
  await test(`GET /check?${query} resolves to ${want}`, async () => {
    const res = await get(`/check?${query}`);
    assert(res.status === 200, `expected 200, got ${res.status}`);
    const ids = (await res.json()).matches.map((m) => m.id);
    assert(ids.includes(want), `expected ${want} among the matches, got [${ids.join(', ')}]`);
    return ids.length === 1 ? `exactly ${want}` : `${want} + ${ids.length - 1} other catalog entries`;
  });
}

await test('GET /check with an unknown format is an empty answer, not an error', async () => {
  const res = await get('/check?from=zzzznotathing');
  assert(res.status === 200, `expected 200, got ${res.status}`);
  const body = await res.json();
  assert(body.matches.length === 0, `expected no matches, got ${body.matches.length}`);
  return '0 matches';
});

// ------------------------------------------------------------ 2. machine surfaces
//
// Static files at the origin. Unmetered, and the only thing most agents will
// ever read: if these are stale or missing, the API is undiscoverable however
// well the Worker behaves.

let apiBase = null;

await test('GET /catalog.json parses and publishes the runtime free tier', async () => {
  const res = await get('/catalog.json');
  assert(res.status === 200, `expected 200, got ${res.status}`);
  const doc = parseJson(await res.text(), 'catalog.json');
  assert(Array.isArray(doc.entries) && doc.entries.length > 0, 'catalog.json has no entries');
  assert(doc.api && typeof doc.api === 'object', 'catalog.json has no api block');
  assert(
    doc.api.free_tier_daily === 0,
    `catalog.json publishes api.free_tier_daily ${JSON.stringify(doc.api.free_tier_daily)}, expected 0`
  );
  assert(typeof doc.api.base === 'string' && doc.api.base, 'catalog.json names no api base');
  apiBase = doc.api.base;

  const hosted = doc.entries.filter((e) => e.hosted);
  assert(hosted.length > 0, 'catalog.json publishes no hosted entries');
  if (hostedMatches) {
    const published = hosted.map((e) => e.id).sort();
    const live = hostedMatches.map((m) => m.id).sort();
    assert(
      JSON.stringify(published) === JSON.stringify(live),
      `catalog.json lists [${published}] but /check answers [${live}]`
    );
  }
  return `${doc.entries.length} entries, ${hosted.length} hosted, api base ${apiBase}`;
});

for (const path of ['/llms.txt', '/llms-full.txt']) {
  await test(`GET ${path} is served and names the API base`, async () => {
    const res = await get(path);
    assert(res.status === 200, `expected 200, got ${res.status}`);
    const text = await res.text();
    assert(text.trim().length > 0, `${path} is empty`);
    assert(/\/convert\//.test(text), `${path} names no conversion endpoint`);
    if (apiBase) {
      assert(text.includes(apiBase), `${path} never names the API base (${apiBase})`);
    }
    return `${text.length} bytes`;
  });
}

await test('GET /openapi.json is a 3.1 document describing /check and /convert', async () => {
  const res = await get('/openapi.json');
  assert(res.status === 200, `expected 200, got ${res.status}`);
  const doc = parseJson(await res.text(), 'openapi.json');
  assert(
    typeof doc.openapi === 'string' && doc.openapi.startsWith('3.1'),
    `openapi is ${JSON.stringify(doc.openapi)}, expected a 3.1.x document`
  );
  assert(doc.paths && typeof doc.paths === 'object', 'openapi.json has no paths object');
  assert(doc.paths['/check'], 'openapi.json describes no /check path');
  assert(doc.paths['/check'].get, '/check is described with no GET operation');

  // Either the templated form or one literal path per tool is a fair rendering
  // of the same endpoint, so both are accepted and the detail says which.
  const convertPaths = Object.keys(doc.paths).filter((p) => /^\/convert\/(\{[^}]+\}|[\w.-]+)$/.test(p));
  assert(convertPaths.length > 0, 'openapi.json describes no /convert/{id}-shaped path');
  assert(
    convertPaths.every((p) => doc.paths[p].post),
    `a convert path is described with no POST operation: ${convertPaths.join(', ')}`
  );
  return `${Object.keys(doc.paths).length} paths, convert as ${convertPaths.join(', ')}`;
});

await test('GET /robots.txt is served', async () => {
  const res = await get('/robots.txt');
  assert(res.status === 200, `expected 200, got ${res.status}`);
  const text = await res.text();
  assert(text.trim().length > 0, 'robots.txt is empty');
  return `${text.length} bytes, ${res.headers.get('content-type') || 'no content-type'}`;
});

// ------------------------------------------------------------ 3. the paywall
//
// The core of the run: one unpaid probe per hosted tool. No X-PAYMENT header is
// sent, so the correct answer is 402 with a spec-valid x402 v1 envelope naming
// that tool. Nothing is converted and nothing is charged — an unpaid 402 does not
// even touch D1.

for (const tool of CONVERSIONS) {
  await test(`POST /convert/${tool.id} with no payment offers a payable, discoverable envelope`, async () => {
    const res = await post(`/convert/${tool.id}`, tool.input);
    return probeGate(res, tool);
  });
}

// ------------------------------------------------------------ 4. cheap guards

await test(`POST /convert/md-html rejects ${BIG_INPUT_BYTES / 1024} KB with 413`, async () => {
  // The size check runs BEFORE the envelope is built, so an oversize body is an
  // unpaid, unmetered refusal: it never reaches a paywall or a converter.
  const res = await post('/convert/md-html', 'a'.repeat(BIG_INPUT_BYTES));
  assert(res.status === 413, `expected 413, got ${res.status}`);
  const body = await res.json();
  assert(typeof body.error === 'string' && body.error.length > 0, 'no error message in the 413 body');
  return body.error.slice(0, 60);
});

await test('POST /b accepts a visit beacon with 204', async () => {
  const res = await post('/b', JSON.stringify({ t: 'visit' }), { 'content-type': 'text/plain' });
  assert(res.status === 204, `expected 204, got ${res.status}`);
  return 'no content';
});

// ---------------------------------------------------------------- table

const failed = printTable();

// ---------------------------------------------------------------- cost
//
// List prices as of 2026-08-18, allowances first. These are constants, not a
// lookup: if Cloudflare repricing happens, this block is what needs editing.

const PRICES = {
  label: 'list prices as of 2026-08-18, allowances first',
  requestsIncluded: 10_000_000, // per month, Workers Paid
  requestsPerMillion: 0.3, // USD per million above the allowance
  cpuMsIncluded: 30_000_000, // ms per month
  cpuPerMillionMs: 0.02, // USD per million ms above the allowance
  d1RowsWrittenIncluded: 50_000_000, // rows per month
  d1PerMillionRowsWritten: 1.0, // USD per million above the allowance
  d1RowsReadIncluded: 25_000_000_000, // rows per month
  workersPaidBase: 5.0, // USD per month, flat — NOT in the totals below
};

// Assumptions, labelled because they are guesses rather than measurements. They
// all describe a SERVED call, which since the free tier was removed is always a
// PAID call: an unpaid request never gets that far.
const ASSUME = {
  cpuMsPerConvert: 2, // ms
  cpuMsPerOther: 0.5, // ms — /check, /b, a static file, a 402, a 413
  d1RowsWrittenPerConvert: 3, // the events insert + the counters upsert + the PAID_DAILY ceiling claim
  d1RowsReadPerConvert: 2, // the salt row + the rung-2 counter
  daysPerMonth: 30,
};

const usd = (n) => (n === 0 ? '$0.00' : `$${n.toFixed(2)}`);
const over = (used, included) => Math.max(0, used - included);

console.log('COST ESTIMATE');
console.log(`${PRICES.label}\n`);
console.log('Rates');
console.log(
  `  Workers requests   ${PRICES.requestsIncluded.toLocaleString()}/mo included, then ${usd(PRICES.requestsPerMillion)}/M`
);
console.log(
  `  Workers CPU        ${PRICES.cpuMsIncluded.toLocaleString()} ms/mo included, then ${usd(PRICES.cpuPerMillionMs)}/M ms`
);
console.log(
  `  D1 rows written    ${PRICES.d1RowsWrittenIncluded.toLocaleString()}/mo included, then ${usd(PRICES.d1PerMillionRowsWritten)}/M`
);
console.log(`  D1 rows read       ${PRICES.d1RowsReadIncluded.toLocaleString()}/mo included`);
console.log(`  (Workers Paid base ${usd(PRICES.workersPaidBase)}/mo flat — excluded from the totals below)\n`);
console.log('Assumptions (labelled: estimates, not measurements)');
console.log(`  ${ASSUME.cpuMsPerConvert} ms CPU per SERVED /convert, ${ASSUME.cpuMsPerOther} ms per unpaid or static request`);
console.log(
  `  ${ASSUME.d1RowsWrittenPerConvert} D1 rows written per SERVED /convert (events insert + counters upsert + ` +
    `the PAID_DAILY runaway-ceiling claim), ${ASSUME.d1RowsReadPerConvert} read`
);
console.log(
  '  An UNPAID 402 writes nothing to D1 at all — no salt read, no quota claim, no events row — and a 413 is'
);
console.log('  refused on the declared size before any of that. Both are free to the operator as well as the caller.');
console.log(`  ${ASSUME.daysPerMonth}-day month; one "call" below = one SERVED /convert, which is always a paid one\n`);

// --- this run -----------------------------------------------------------

const runOther = requestCount - convertRequestCount;
// Only SERVED conversions cost a converter's worth of CPU and D1 rows, and this
// run serves none: it sends no X-PAYMENT header, so every /convert probe stops
// at the paywall. The beacon writes its own two rows, and nothing else writes.
const runCpuMs = served * ASSUME.cpuMsPerConvert + (requestCount - served) * ASSUME.cpuMsPerOther;
const runRowsWritten = served * ASSUME.d1RowsWrittenPerConvert + 2;

console.log('This test run');
console.log(
  `  ${requestCount} requests (${convertRequestCount} to /convert, ${runOther} other) = ` +
    `${requestCount} / ${PRICES.requestsIncluded.toLocaleString()} of the monthly request allowance`
);
console.log(
  served === 0
    ? '  0 conversions served — every /convert probe stopped at the 402 paywall, so no converter ran'
    : `  ${served} conversions served — this deployment has a free tier enabled, so probes that should have ` +
      'stopped at the paywall ran the converter instead'
);
console.log(`  ${usd(0)} spent in USDC — no X-PAYMENT header was ever sent, so nothing could be charged`);
console.log(
  `  ~${runCpuMs} ms CPU (${served}x${ASSUME.cpuMsPerConvert} served + ${requestCount - served}x${ASSUME.cpuMsPerOther} unpaid or static) = ` +
    `${runCpuMs} / ${PRICES.cpuMsIncluded.toLocaleString()} ms`
);
console.log(
  `  ~${runRowsWritten} D1 rows written (the beacon's two; the 402s and the 413 write none) = ` +
    `${runRowsWritten} / ${PRICES.d1RowsWrittenIncluded.toLocaleString()}`
);
console.log(`  Cost of this run: ${usd(0)} in USDC and ${usd(0)} in Cloudflare metering.\n`);

// --- monthly scaling ----------------------------------------------------

function monthly(callsPerDay) {
  const calls = callsPerDay * ASSUME.daysPerMonth;
  const requests = calls;
  const cpuMs = calls * ASSUME.cpuMsPerConvert;
  const rowsWritten = calls * ASSUME.d1RowsWrittenPerConvert;

  const reqCost = (over(requests, PRICES.requestsIncluded) / 1_000_000) * PRICES.requestsPerMillion;
  const cpuCost = (over(cpuMs, PRICES.cpuMsIncluded) / 1_000_000) * PRICES.cpuPerMillionMs;
  const d1Cost =
    (over(rowsWritten, PRICES.d1RowsWrittenIncluded) / 1_000_000) * PRICES.d1PerMillionRowsWritten;

  return { callsPerDay, calls, requests, cpuMs, rowsWritten, reqCost, cpuCost, d1Cost, total: reqCost + cpuCost + d1Cost };
}

const ROWS = [1_000, 10_000, 100_000, 1_000_000].map(monthly);
const COLS = [
  ['calls/day', (r) => r.callsPerDay.toLocaleString()],
  ['req/mo', (r) => r.requests.toLocaleString()],
  ['CPU ms/mo', (r) => r.cpuMs.toLocaleString()],
  ['D1 writes/mo', (r) => r.rowsWritten.toLocaleString()],
  ['requests $', (r) => usd(r.reqCost)],
  ['CPU $', (r) => usd(r.cpuCost)],
  ['D1 $', (r) => usd(r.d1Cost)],
  ['TOTAL/mo', (r) => usd(r.total)],
];

const widths = COLS.map(([head], i) =>
  Math.max(head.length, ...ROWS.map((r) => COLS[i][1](r).length))
);
const line = (cells) => cells.map((c, i) => String(c).padStart(widths[i])).join('  ');

console.log('Monthly cost by volume (metered charges only; every call below is a SERVED, PAID call)');
console.log(line(COLS.map(([head]) => head)));
console.log(widths.map((w) => '-'.repeat(w)).join('  '));
for (const r of ROWS) console.log(line(COLS.map(([, get_]) => get_(r))));
console.log('');

// --- where each allowance cracks ---------------------------------------

const crackRequests = PRICES.requestsIncluded / ASSUME.daysPerMonth;
const crackCpu = PRICES.cpuMsIncluded / ASSUME.cpuMsPerConvert / ASSUME.daysPerMonth;
const crackD1 = PRICES.d1RowsWrittenIncluded / ASSUME.d1RowsWrittenPerConvert / ASSUME.daysPerMonth;

console.log('Where each allowance cracks (served calls/day at which the first paid unit appears)');
console.log(
  `  requests    ${PRICES.requestsIncluded.toLocaleString()}/mo / ${ASSUME.daysPerMonth} d = ${Math.round(crackRequests).toLocaleString()}/day   <- first`
);
console.log(
  `  CPU         ${PRICES.cpuMsIncluded.toLocaleString()} ms / ${ASSUME.cpuMsPerConvert} ms / ${ASSUME.daysPerMonth} d = ${Math.round(crackCpu).toLocaleString()}/day`
);
console.log(
  `  D1 writes   ${PRICES.d1RowsWrittenIncluded.toLocaleString()} / ${ASSUME.d1RowsWrittenPerConvert} / ${ASSUME.daysPerMonth} d = ${Math.round(crackD1).toLocaleString()}/day`
);
console.log(
  `\nThe first paid dollar arrives on REQUESTS, above ${PRICES.requestsIncluded.toLocaleString()} req/mo — about ${Math.round(crackRequests).toLocaleString()} served calls/day.`
);
console.log('Everything below that volume is allowance, and costs nothing beyond the flat plan fee.');
console.log('Unpaid traffic — 402s, 413s, /check, the static files — only counts against requests and CPU.\n');

process.exit(failed ? 1 : 0);
