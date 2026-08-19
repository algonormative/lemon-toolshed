#!/usr/bin/env node
// Live smoke test for the Toolshed API, plus a cost estimate.
//
//   node scripts/test-live.mjs                          # production
//   node scripts/test-live.mjs http://localhost:8787    # wrangler dev --local
//   TOOLSHED_URL=... node scripts/test-live.mjs
//   node scripts/test-live.mjs --tools=csv-json,md-html # spend the free slots here
//   node scripts/test-live.mjs --quota                  # the free-tier probe, opt-in
//
// Zero dependencies — Node 18+ for global fetch, and nothing else. This is the
// smoke test README.md § Maintenance says is missing: it posts a known payload
// to every hosted endpoint and checks a distinctive substring came back, so a
// rotted converter shows up as a red row rather than as a broken product.
//
// IT SPENDS THE WHOLE DAY'S FREE TIER, AND THE DEFAULT RUN IS DELIBERATELY WIDER
// THAN IT. The free tier is 3 conversions per caller per UTC day and there are 5
// converters, so a run cannot check them all for nothing. What it does instead:
//
//   calls 1..FREE_TIER_EXPECT   served and fully checked — the converter ran, and
//                               x-free-tier-remaining counted down exactly
//   every /convert call after   OVER THE TIER, where the paywall is the correct
//                               answer. The run asserts that transition at exactly
//                               the call the tier runs out on: a 402 carrying a
//                               spec-shaped x402 envelope (what the hosted service
//                               answers), or a 429 where no receiving address is
//                               configured. Those rows are green because the GATE
//                               is right, and they say the converter behind them
//                               was not exercised — they are not converter passes.
//
// So one default run costs FREE_TIER_EXPECT conversions: the whole allowance for
// the IP it runs from. A SECOND RUN IN THE SAME UTC DAY FROM THE SAME IP fails on
// its first conversion, saying the tier was already spent rather than blaming a
// converter. Only the first FREE_TIER_EXPECT converters in the list get live
// coverage on a given day — use --tools=<id,...> to aim the free slots elsewhere.
//
// --quota is the free-tier probe and is NOT part of the default run, because it
// deliberately burns the whole day's allowance plus one. See quotaProbe().

const ARGS = process.argv.slice(2);
const QUOTA = ARGS.includes('--quota');
const TOOLS_ARG = (ARGS.find((a) => a.startsWith('--tools=')) || '').slice('--tools='.length);
const BASE = (
  ARGS.find((a) => !a.startsWith('--')) ||
  process.env.TOOLSHED_URL ||
  'https://toolshed.lemon-agent.dev'
).replace(/\/+$/, '');

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

const sleep = (ms) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

// Rung 0 — the edge rate-limiting rule, 5 requests / 10 s per IP — will block a
// tight loop before the free tier ever bites, so the probe paces itself. There is
// no edge in front of `wrangler dev`, so a local run does not wait.
const LOCAL = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(BASE);
const PACE_MS = LOCAL ? 0 : 2500;

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
  },
];

const HOSTED_EXPECTED = 5;
const BIG_INPUT_BYTES = 300 * 1024;

// Must match FREE_TIER_DAILY in build.mjs. Asserted against the live service by
// the quota probe, and published in catalog.json — so a drift shows up as a red
// row rather than as a surprise.
const FREE_TIER_EXPECT = 3;

// Which converters get the free slots. Default is every one, in order, which
// means the first FREE_TIER_EXPECT of them are checked and the rest land on the
// paywall. --tools=<id,...> re-points the scarce slots at whatever you changed.
const SELECTED_CONVERSIONS = (() => {
  if (!TOOLS_ARG) return CONVERSIONS;
  const wanted = TOOLS_ARG.split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const unknown = wanted.filter((id) => !CONVERSIONS.some((c) => c.id === id));
  if (unknown.length) {
    console.error(
      `--tools names ${unknown.join(', ')}, which this file has no fixture for. ` +
        `Known: ${CONVERSIONS.map((c) => c.id).join(', ')}`
    );
    process.exit(2);
  }
  return wanted.map((id) => CONVERSIONS.find((c) => c.id === id));
})();

// The ledger the whole run is metered against: how many conversions this caller
// has actually had SERVED so far. A refused over-tier call claims nothing, so it
// does not move this — which is what makes the next prediction exact.
let spent = 0;
const insideTier = () => spent < FREE_TIER_EXPECT;

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
  return failed;
}

// ---------------------------------------------------------------- quota probe
//
// Opt-in, because it spends the day: FREE_TIER_EXPECT accepted conversions, one
// refusal, and three more refusals under rotated user-agents. What it proves:
//
//   1. beacons are on a separate budget — 5 /b events first, and the free tier
//      is still whole afterwards;
//   2. x-free-tier-remaining counts down FREE_TIER_EXPECT - 1 -> 0 across them;
//   3. call FREE_TIER_EXPECT + 1 is refused — 429 with the free-tier body and a
//      sane Retry-After, or 402 with an x402 envelope once PAYTO is set;
//   4. rotating the user-agent from the same IP does NOT mint a fresh allowance.
//
// It needs a caller whose allowance is untouched today. A 429 on the first call
// means this IP has already converted today; wait for midnight UTC.

const UAS = [
  'toolshed-quota-probe/1.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/131.0 Safari/537.36',
  'curl/8.7.1',
  'python-requests/2.32.3',
];

function assertRefusal(res, body) {
  if (res.status === 402) {
    const env = JSON.parse(body);
    const offer = (env.accepts && env.accepts[0]) || {};
    assert(env.x402Version === 1, 'the 402 body is not an x402 v1 envelope');
    assert(!!offer.payTo, 'the x402 envelope names no payTo address');
    return `402 — ${offer.maxAmountRequired} atomic to ${offer.payTo}`;
  }
  assert(res.status === 429, `expected 429 or 402, got ${res.status}`);
  const seen = JSON.parse(body);
  assert(
    seen.free_tier_daily === FREE_TIER_EXPECT,
    `free_tier_daily is ${seen.free_tier_daily}, expected ${FREE_TIER_EXPECT}`
  );
  assert(/free tier/.test(String(seen.error)), `unexpected error text: ${seen.error}`);
  assert(!!seen.paid_tier, 'the 429 body does not name the paid tier');
  assert(seen.retry === 'tomorrow UTC', `retry is ${JSON.stringify(seen.retry)}`);

  const retryAfter = Number(res.headers.get('retry-after'));
  assert(Number.isFinite(retryAfter), 'no numeric Retry-After header');
  assert(retryAfter > 0 && retryAfter <= 86400, `Retry-After ${retryAfter} is not within one day`);
  return `429 — ${seen.error}, Retry-After ${retryAfter}s`;
}

async function quotaProbe() {
  console.log(`Toolshed free-tier probe — ${BASE}`);
  console.log(
    `${FREE_TIER_EXPECT} free calls, then one over, then ${UAS.length - 1} rotated user-agents.` +
      ` Spends this IP's whole allowance for the UTC day.${PACE_MS ? ` Paced ${PACE_MS} ms.` : ''}\n`
  );

  // (1) Beacons must not touch the conversion budget.
  await test('5 /b beacons are accepted', async () => {
    for (let i = 0; i < 5; i++) {
      const res = await post('/b', JSON.stringify({ t: 'visit' }), { 'content-type': 'text/plain' });
      assert(res.status === 204, `beacon ${i + 1} answered ${res.status}, expected 204`);
      await sleep(PACE_MS);
    }
    return '5 accepted — the conversion budget should still be whole';
  });

  // (2) The free tier, counted down.
  for (let i = 1; i <= FREE_TIER_EXPECT; i++) {
    await test(`convert ${i}/${FREE_TIER_EXPECT} is served free`, async () => {
      const res = await post('/convert/md-html', '# hi\n', { 'user-agent': UAS[0] });
      if (res.status === 429 || res.status === 402) {
        throw new Error(
          `refused with ${res.status} on call ${i} — this IP had already spent part of today's free tier` +
            (i === 1 ? ' (beacons did NOT do it; they are on a separate budget)' : '')
        );
      }
      assert(res.status === 200, `expected 200, got ${res.status}`);
      const remaining = res.headers.get('x-free-tier-remaining');
      assert(remaining !== null, 'no x-free-tier-remaining header on a free-tier answer');
      const want = FREE_TIER_EXPECT - i;
      assert(Number(remaining) === want, `x-free-tier-remaining is ${remaining}, expected ${want}`);
      return `x-free-tier-remaining: ${remaining}`;
    });
    await sleep(PACE_MS);
  }

  // (3) One over.
  await test(`convert ${FREE_TIER_EXPECT + 1} is refused`, async () => {
    const res = await post('/convert/md-html', '# hi\n', { 'user-agent': UAS[0] });
    return assertRefusal(res, await res.text());
  });
  await sleep(PACE_MS);

  // (4) The spoof-resistance claim: same IP, different user-agent, same refusal.
  for (const ua of UAS.slice(1)) {
    await test(`rotated user-agent is still refused — ${ua.slice(0, 28)}`, async () => {
      const res = await post('/convert/md-html', '# hi\n', { 'user-agent': ua });
      return assertRefusal(res, await res.text());
    });
    await sleep(PACE_MS);
  }
}

if (QUOTA) {
  await quotaProbe();
  process.exit(printTable() ? 1 : 0);
}

// ---------------------------------------------------------------- tests

// Every queued call that reaches the converter claims an allowance: the selected
// happy paths plus the malformed-input case. The 413 is refused on the declared
// size before any of that, so it is free.
const QUEUED_METERED = SELECTED_CONVERSIONS.length + 1;

console.log(`Toolshed live test — ${BASE}`);
console.log(
  `Budget: ${FREE_TIER_EXPECT} free conversions — this IP's whole allowance for the UTC day. ` +
    `${QUEUED_METERED} calls queued that spend it; the first ${Math.min(FREE_TIER_EXPECT, QUEUED_METERED)} ` +
    (QUEUED_METERED > FREE_TIER_EXPECT ? 'are checked, the rest land on the paywall.\n' : 'are checked.\n')
);

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

// Set when a call this run expected to be free came back refused, which means
// the allowance was already gone before the run started. It is diagnosed ONCE,
// as a red row; after that the remaining rows say the same thing the calmer way
// rather than repeating the same failure six times over one root cause.
let tierSpentEarly = false;

// A conversion the tier could not pay for. The refusal is the RIGHT answer, and
// it is asserted as one — but it is not evidence that the converter behind it
// still works, so the row says so out loud.
const notExercised = async (res, what) => {
  const detail = assertRefusal(res, await res.text());
  const why = tierSpentEarly ? 'tier was already spent before this run' : 'over tier';
  return `${why} — ${detail} — ${what} NOT exercised this run`;
};

// A call that was predicted free and was refused means one thing only: this IP
// had already converted today. It is a red row, because the run proved nothing.
function assertTierWasWhole(res, callNumber) {
  if (res.status !== 402 && res.status !== 429) return;
  tierSpentEarly = true;
  throw new Error(
    `refused with ${res.status} on free call ${callNumber}/${FREE_TIER_EXPECT} — this IP had already ` +
      `spent today's ${FREE_TIER_EXPECT}/day free tier before this run. Nothing after this row ` +
      'exercises a converter. Re-run after midnight UTC (beacons did NOT do it; they are on a ' +
      'separate budget).'
  );
}

for (const c of SELECTED_CONVERSIONS) {
  await test(`POST /convert/${c.id} converts and returns its own output`, async () => {
    const free = insideTier() && !tierSpentEarly;
    const res = await post(`/convert/${c.id}`, c.input);

    if (!free) return notExercised(res, c.id);

    assertTierWasWhole(res, spent + 1);
    assert(res.status === 200, `expected 200, got ${res.status}`);
    const out = await res.text();
    assert(out.includes(c.expect), `output did not contain ${JSON.stringify(c.expect)}`);

    // Served, so the allowance moved — and the header has to agree, exactly.
    spent += 1;
    const left = res.headers.get('x-free-tier-remaining');
    assert(
      Number(left) === FREE_TIER_EXPECT - spent,
      `x-free-tier-remaining is ${left}, expected ${FREE_TIER_EXPECT - spent}`
    );
    return `${out.replace(/\s+/g, ' ').trim().slice(0, 48)} [free tier: ${left} left]`;
  });
}

// A malformed body is rejected AFTER the free-tier call is claimed, so this case
// costs an allowance like any other — which at 3/day means it usually lands past
// the tier and cannot run. The local suite (`npm test`) is where it is covered
// unconditionally; here it is opportunistic and honest about it.
await test('POST /convert/json-yaml rejects malformed input with 400', async () => {
  const free = insideTier() && !tierSpentEarly;
  const res = await post('/convert/json-yaml', '{not json');

  if (!free) return notExercised(res, 'the malformed-input 400');

  assertTierWasWhole(res, spent + 1);
  assert(res.status === 400, `expected 400, got ${res.status}`);
  spent += 1; // a rejected conversion still spends its free-tier call
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

// Assumptions, labelled because they are guesses rather than measurements.
const ASSUME = {
  cpuMsPerConvert: 2, // ms
  cpuMsPerOther: 0.5, // ms — /check, /b
  d1RowsWrittenPerConvert: 3, // the events insert + the counters upsert + the quota claim
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
console.log(`  ${ASSUME.cpuMsPerConvert} ms CPU per /convert, ${ASSUME.cpuMsPerOther} ms per /check or /b`);
console.log(
  `  ${ASSUME.d1RowsWrittenPerConvert} D1 rows written per /convert (events insert + counters upsert + free-tier claim), ${ASSUME.d1RowsReadPerConvert} read`
);
console.log(`  ${ASSUME.daysPerMonth}-day month; one "call" below = one /convert request\n`);

// --- this run -----------------------------------------------------------

const runConverts = SELECTED_CONVERSIONS.length + 2; // the happy paths + the 400 + the 413
const runOther = results.length - runConverts;
const runRequests = results.length;
// Only the SERVED conversions cost a converter's worth of CPU and rows — `spent`
// of them. A refusal past the free tier reads the salt and the global counter and
// tries the quota claim, but runs no converter, writes no events row and moves no
// counter; the 413 is rejected on the declared size before any D1 work at all;
// the beacon writes its own two rows.
const runRefused = runRequests - spent;
const runCpuMs = spent * ASSUME.cpuMsPerConvert + runRefused * ASSUME.cpuMsPerOther;
const runRowsWritten = spent * ASSUME.d1RowsWrittenPerConvert + 2;

console.log('This test run');
console.log(
  `  ${runRequests} requests (${runConverts} convert, ${runOther} other) = ${runRequests} / ${PRICES.requestsIncluded.toLocaleString()} of the monthly request allowance`
);
console.log(
  `  ${spent} of ${FREE_TIER_EXPECT} free-tier conversions spent — the rest of the convert calls were over the tier`
);
console.log(
  `  ${runCpuMs} ms CPU (${spent}x${ASSUME.cpuMsPerConvert} served + ${runRefused}x${ASSUME.cpuMsPerOther} refused or unmetered) = ${runCpuMs} / ${PRICES.cpuMsIncluded.toLocaleString()} ms`
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
