#!/usr/bin/env node
// Live smoke test for the Toolshed API, plus a cost estimate.
//
//   node scripts/test-live.mjs                        # production
//   node scripts/test-live.mjs http://localhost:8787  # wrangler dev --local
//   TOOLSHED_URL=... node scripts/test-live.mjs
//
// Zero dependencies — Node 18+ for global fetch, and nothing else. This is the
// smoke test README.md § Maintenance says is missing: it posts a known payload
// to every hosted endpoint and checks a distinctive substring came back, so a
// rotted converter shows up as a red row rather than as a broken product.
//
// It exercises the real service, so it writes real rows: ~8 events against the
// caller's daily rung-1 budget of 100.

const BASE = (process.argv[2] || process.env.TOOLSHED_URL || 'https://toolshed.lemon-agent.dev').replace(
  /\/+$/,
  ''
);

// ---------------------------------------------------------------- harness

const results = [];

function record(name, ok, detail) {
  results.push({ name, ok, detail });
  process.stdout.write(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}\n`);
}

async function test(name, fn) {
  try {
    const detail = await fn();
    record(name, true, detail);
  } catch (err) {
    record(name, false, String((err && err.message) || err).replace(/\s+/g, ' ').slice(0, 160));
  }
}

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

const get = (path) => fetch(`${BASE}${path}`);
const post = (path, body, headers = {}) =>
  fetch(`${BASE}${path}`, { method: 'POST', body, headers });

// ---------------------------------------------------------------- fixtures
//
// Tiny on purpose: the point is that the converter ran and produced its own
// characteristic output, not that it handles a large document.

const CONVERSIONS = [
  {
    id: 'md-html',
    input: '# Hi\n\nHello **world**.\n',
    expect: '<strong>world</strong>',
  },
  {
    id: 'json-yaml',
    input: '{"lemon":"toolshed","n":42}',
    expect: 'lemon: toolshed',
  },
  {
    id: 'yaml-json',
    input: 'lemon: toolshed\nn: 42\n',
    expect: '"lemon": "toolshed"',
  },
  {
    id: 'csv-json',
    input: 'name,qty\nlemon,3\n',
    expect: '"name": "lemon"',
  },
  {
    id: 'html-markdown',
    input: '<h1>Toolshed</h1><p>hello</p>',
    expect: '# Toolshed',
    priced: true,
  },
];

const HOSTED_EXPECTED = 5;
const BIG_INPUT_BYTES = 300 * 1024;

// ---------------------------------------------------------------- tests

console.log(`Toolshed live test — ${BASE}\n`);

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
  return `${body.matches.length} hosted: ${body.matches.map((m) => m.id).join(', ')}`;
});

await test('GET /check?from=markdown&to=html returns exactly md-html', async () => {
  const res = await get('/check?from=markdown&to=html');
  assert(res.status === 200, `expected 200, got ${res.status}`);
  const body = await res.json();
  const ids = body.matches.map((m) => m.id);
  assert(ids.length === 1 && ids[0] === 'md-html', `expected [md-html], got [${ids.join(', ')}]`);
  return 'md-html';
});

for (const c of CONVERSIONS) {
  await test(`POST /convert/${c.id} converts and returns its own output`, async () => {
    const res = await post(`/convert/${c.id}`, c.input);

    // A priced tool answering 402 is CORRECT behaviour once PAYTO is set — the
    // envelope is the product, not a fault. Report it, do not fail on it.
    if (c.priced && res.status === 402) {
      const env = await res.json();
      const offer = (env.accepts && env.accepts[0]) || {};
      return `402 x402 envelope (priced gate live) — ${offer.maxAmountRequired} atomic to ${offer.payTo}`;
    }

    assert(res.status === 200, `expected 200, got ${res.status}`);
    const out = await res.text();
    assert(out.includes(c.expect), `output did not contain ${JSON.stringify(c.expect)}`);
    const pending = res.headers.get('x-pricing') === 'pending';
    return `${out.replace(/\s+/g, ' ').trim().slice(0, 48)}${pending ? ' [x-pricing: pending]' : ''}`;
  });
}

await test('POST /convert/json-yaml rejects malformed input with 400', async () => {
  const res = await post('/convert/json-yaml', '{not json');
  assert(res.status === 400, `expected 400, got ${res.status}`);
  const body = await res.json();
  assert(typeof body.error === 'string' && body.error.length > 0, 'no error message in the 400 body');
  return body.error.slice(0, 60);
});

await test(`POST /convert/md-html rejects ${BIG_INPUT_BYTES / 1024} KB with 413`, async () => {
  const res = await post('/convert/md-html', 'a'.repeat(BIG_INPUT_BYTES));
  assert(res.status === 413, `expected 413, got ${res.status}`);
  const body = await res.json();
  return body.error.slice(0, 60);
});

await test('POST /b accepts a visit beacon with 204', async () => {
  const res = await post('/b', JSON.stringify({ t: 'visit' }), { 'content-type': 'text/plain' });
  assert(res.status === 204, `expected 204, got ${res.status}`);
  return 'no content';
});

// ---------------------------------------------------------------- table

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

// Assumptions, labelled because they are guesses rather than measurements.
const ASSUME = {
  cpuMsPerConvert: 2, // ms
  cpuMsPerOther: 0.5, // ms — /check, /b
  d1RowsWrittenPerConvert: 2, // the events insert + the counters upsert
  d1RowsReadPerConvert: 2, // the rung-1 count + the rung-2 counter
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
console.log(`  ${ASSUME.cpuMsPerConvert} ms CPU per /convert, ${ASSUME.cpuMsPerOther} ms per /check or /b`);
console.log(
  `  ${ASSUME.d1RowsWrittenPerConvert} D1 rows written per /convert (events insert + counters upsert), ${ASSUME.d1RowsReadPerConvert} read`
);
console.log(`  ${ASSUME.daysPerMonth}-day month; one "call" below = one /convert request\n`);

// --- this run -----------------------------------------------------------

const runConverts = CONVERSIONS.length + 2; // the five happy paths + the 400 + the 413
const runOther = results.length - runConverts;
const runRequests = results.length;
const runCpuMs = runConverts * ASSUME.cpuMsPerConvert + runOther * ASSUME.cpuMsPerOther;
const runRowsWritten = CONVERSIONS.length * ASSUME.d1RowsWrittenPerConvert + 1 * ASSUME.d1RowsWrittenPerConvert;

console.log('This test run');
console.log(
  `  ${runRequests} requests (${runConverts} convert, ${runOther} other) = ${runRequests} / ${PRICES.requestsIncluded.toLocaleString()} of the monthly request allowance`
);
console.log(
  `  ${runCpuMs} ms CPU (${runConverts}x${ASSUME.cpuMsPerConvert} + ${runOther}x${ASSUME.cpuMsPerOther}) = ${runCpuMs} / ${PRICES.cpuMsIncluded.toLocaleString()} ms`
);
console.log(
  `  ~${runRowsWritten} D1 rows written = ${runRowsWritten} / ${PRICES.d1RowsWrittenIncluded.toLocaleString()}`
);
console.log(`  Cost of this run: ${usd(0)} — every meter is inside its allowance.\n`);

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

const widths = COLS.map(([head, get_], i) =>
  Math.max(head.length, ...ROWS.map((r) => COLS[i][1](r).length))
);
const line = (cells) => cells.map((c, i) => String(c).padStart(widths[i])).join('  ');

console.log('Monthly cost by volume (metered charges only)');
console.log(line(COLS.map(([head]) => head)));
console.log(widths.map((w) => '-'.repeat(w)).join('  '));
for (const r of ROWS) console.log(line(COLS.map(([, get_]) => get_(r))));
console.log('');

// --- where each allowance cracks ---------------------------------------

const crackRequests = PRICES.requestsIncluded / ASSUME.daysPerMonth;
const crackCpu = PRICES.cpuMsIncluded / ASSUME.cpuMsPerConvert / ASSUME.daysPerMonth;
const crackD1 = PRICES.d1RowsWrittenIncluded / ASSUME.d1RowsWrittenPerConvert / ASSUME.daysPerMonth;

console.log('Where each allowance cracks (calls/day at which the first paid unit appears)');
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
  `\nThe first paid dollar arrives on REQUESTS, above ${PRICES.requestsIncluded.toLocaleString()} req/mo — about ${Math.round(crackRequests).toLocaleString()} calls/day.`
);
console.log('Everything below that volume is allowance, and costs nothing beyond the flat plan fee.\n');

process.exit(failed ? 1 : 0);
