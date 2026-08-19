#!/usr/bin/env node
// `npm run test:live` — the SAFE production smoke.
//
//   npm run test:live
//   TOOLSHED_URL=http://localhost:8787 npm run test:live
//   node test/live.smoke.mjs https://toolshed.lemon-agent.dev
//
// The budget is the whole design of this file: it spends AT MOST ONE free-tier
// conversion, and it never depends on how much allowance is left. Everything
// else it touches — GET /check, catalog.json, llms.txt, llms-full.txt — is
// unmetered static or the in-memory catalog filter, so a run costs one
// conversion whatever else it asserts.
//
// The one conversion accepts 200, 402 and 429 as PASSES, labelled differently:
//
//   200  the converter ran
//   402  the paid gate is live and this caller's free tier is spent — correct
//   429  the free tier is spent on a deployment with no receiving address, or the
//        paid ceiling is reached — also correct
//
// Only a 5xx, a wrong content-type, or output that does not look like the
// conversion is a failure. That is what "never depends on quota state" means
// here: the run can be repeated on a spent day and still tell the truth.
//
// The deep behavioural coverage is the LOCAL suite (`npm test`), which runs
// against a throwaway `wrangler dev --local` and can burn as much allowance as
// it likes. This file only checks that what is deployed is the same product.
//
// Zero dependencies. Node 18+ for global fetch.
//
// (`npm run test:live:full` runs scripts/test-live.mjs, the older and much
// hungrier probe: it spends the caller's WHOLE daily allowance — all three free
// conversions — plus a cost estimate, and its remaining convert calls land on
// the paywall by design. Use it deliberately, once a day, not in a loop.)

const ARG = process.argv.slice(2).find((a) => !a.startsWith('--'));
const BASE = (ARG || process.env.TOOLSHED_URL || 'https://toolshed.lemon-agent.dev').replace(/\/+$/, '');

const results = [];
const assert = (cond, message) => {
  if (!cond) throw new Error(message);
};

async function check(name, fn) {
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail });
    process.stdout.write(`  ok   ${name}${detail ? ` — ${detail}` : ''}\n`);
  } catch (err) {
    results.push({ name, ok: false, detail: String(err?.message || err) });
    process.stdout.write(` FAIL  ${name} — ${String(err?.message || err).replace(/\s+/g, ' ').slice(0, 200)}\n`);
  }
}

console.log(`Toolshed live smoke — ${BASE}`);
console.log('Budget: at most ONE free-tier conversion. Nothing else here is metered.\n');

// ------------------------------------------------------------------ /check

let hostedIds = [];
let freeTierDaily = null;

await check('GET /check lists the hosted tools with prices and free tiers', async () => {
  const res = await fetch(`${BASE}/check`);
  assert(res.status === 200, `expected 200, got ${res.status}`);
  assert(/application\/json/.test(res.headers.get('content-type') || ''), 'not a JSON answer');
  assert(res.headers.get('access-control-allow-origin') === '*', 'no open CORS header on /check');

  const body = await res.json();
  assert(Array.isArray(body.matches), 'matches is not an array');
  assert(body.matches.length > 0, 'no hosted tools at all');

  for (const match of body.matches) {
    assert(typeof match.id === 'string' && match.id, 'a match has no id');
    assert(match.hosted, `${match.id} came back with no hosted block`);
    assert(match.hosted.path === `/convert/${match.id}`, `${match.id}: path and id disagree`);
    assert(match.hosted.status === 'live', `${match.id} is listed but not live`);
    assert(Number.isInteger(match.hosted.free_tier_daily), `${match.id} publishes no free_tier_daily`);
    assert(
      match.hosted.price === 'free' || match.hosted.price?.amount_usd > 0,
      `${match.id} publishes no usable price`
    );
  }

  hostedIds = body.matches.map((m) => m.id);
  freeTierDaily = body.matches[0].hosted.free_tier_daily;
  return `${hostedIds.length} hosted (${hostedIds.join(', ')}), free tier ${freeTierDaily}/day`;
});

await check('GET /check matching is field-bound', async () => {
  const res = await fetch(`${BASE}/check?from=markdown&to=html`);
  assert(res.status === 200, `expected 200, got ${res.status}`);
  const ids = (await res.json()).matches.map((m) => m.id);
  assert(ids.length === 1 && ids[0] === 'md-html', `expected [md-html], got [${ids.join(', ')}]`);
  return 'from=markdown&to=html -> md-html';
});

await check('GET /check with an unknown format is an empty answer, not an error', async () => {
  const res = await fetch(`${BASE}/check?from=zzzznotathing`);
  assert(res.status === 200, `expected 200, got ${res.status}`);
  const body = await res.json();
  assert(body.matches.length === 0, `expected no matches, got ${body.matches.length}`);
  return '0 matches';
});

// ------------------------------------------------------------------ the machine files

const MACHINE_FILES = [
  {
    path: '/catalog.json',
    type: /application\/json/,
    sanity: (text) => {
      const doc = JSON.parse(text);
      assert(Array.isArray(doc.entries), 'catalog.json has no entries array');
      assert(doc.entries.length > 0, 'catalog.json is empty');
      const hosted = doc.entries.filter((e) => e.hosted);
      assert(hosted.length > 0, 'catalog.json publishes no hosted entries');
      for (const entry of hosted) {
        assert(entry.hosted.path === `/convert/${entry.id}`, `${entry.id}: path and id disagree in catalog.json`);
        assert(
          Number.isInteger(entry.hosted.free_tier_daily),
          `${entry.id} publishes no free_tier_daily in catalog.json`
        );
      }
      // The catalog and /check must agree about what is hosted; if they drift,
      // the page is advertising something the Worker will not route.
      const published = hosted.map((e) => e.id).sort();
      if (hostedIds.length) {
        assert(
          JSON.stringify(published) === JSON.stringify([...hostedIds].sort()),
          `catalog.json lists [${published}] but /check answers [${[...hostedIds].sort()}]`
        );
      }
      return `${doc.entries.length} entries, ${hosted.length} hosted`;
    },
  },
  {
    path: '/llms.txt',
    type: /text\/plain/,
    sanity: (text) => {
      assert(text.length > 500, 'llms.txt is suspiciously short');
      assert(/\/convert\//.test(text), 'llms.txt names no conversion endpoint');
      assert(/\/check/.test(text), 'llms.txt does not mention GET /check');
      return `${text.length} bytes`;
    },
  },
  {
    path: '/llms-full.txt',
    type: /text\/plain/,
    sanity: (text) => {
      assert(text.length > 2000, 'llms-full.txt is suspiciously short');
      assert(/\/convert\//.test(text), 'llms-full.txt names no conversion endpoint');
      return `${text.length} bytes`;
    },
  },
];

for (const file of MACHINE_FILES) {
  await check(`GET ${file.path} is served and parses`, async () => {
    const res = await fetch(`${BASE}${file.path}`);
    assert(res.status === 200, `expected 200, got ${res.status}`);
    const type = res.headers.get('content-type') || '';
    assert(file.type.test(type), `unexpected content-type ${type}`);
    return file.sanity(await res.text());
  });
}

// ------------------------------------------------------------------ ONE conversion

await check('POST /convert/md-html answers correctly for whatever tier this caller is on', async () => {
  const res = await fetch(`${BASE}/convert/md-html`, {
    method: 'POST',
    body: '# Toolshed\n\nhello **world**.\n',
    headers: { 'user-agent': 'toolshed-live-smoke/1.0' },
  });
  const text = await res.text();

  if (res.status === 402) {
    const offer = JSON.parse(text).accepts?.[0] || {};
    assert(JSON.parse(text).x402Version === 1, 'the 402 body is not an x402 v1 envelope');
    assert(!!offer.payTo, 'the x402 envelope names no payTo address');
    assert(offer.resource?.endsWith('/convert/md-html'), `envelope resource is ${offer.resource}`);
    return `402 — paid gate live, ${offer.maxAmountRequired} atomic to ${offer.payTo} (free tier spent for this caller)`;
  }

  if (res.status === 429) {
    const body = JSON.parse(text);
    assert(/free tier|ceiling/.test(String(body.error)), `unexpected 429 body: ${text.slice(0, 120)}`);
    const retryAfter = Number(res.headers.get('retry-after'));
    assert(Number.isFinite(retryAfter) && retryAfter > 0 && retryAfter <= 86_400, 'no sane Retry-After');
    return `429 — free tier spent for this caller, resets in ${retryAfter}s (correct, not a fault)`;
  }

  assert(res.status === 200, `expected 200, 402 or 429, got ${res.status}: ${text.slice(0, 160)}`);
  assert(/text\/html/.test(res.headers.get('content-type') || ''), 'md-html did not answer as HTML');
  assert(text.includes('<h1>Toolshed</h1>'), 'the heading did not convert');
  assert(text.includes('<strong>world</strong>'), 'the emphasis did not convert');
  const left = res.headers.get('x-free-tier-remaining');
  return `200 — converted${left !== null ? `, ${left} free calls left for this caller` : ''}`;
});

// ------------------------------------------------------------------ cheap guards
//
// Refusals, not conversions: none of these reaches the free-tier counter.

await check('POST /check is a 405 and GET /convert/md-html is a 405', async () => {
  const post = await fetch(`${BASE}/check`, { method: 'POST' });
  assert(post.status === 405, `POST /check answered ${post.status}`);
  const get = await fetch(`${BASE}/convert/md-html`);
  assert(get.status === 405, `GET /convert/md-html answered ${get.status}`);
  assert(get.headers.get('allow') === 'POST', 'the 405 does not say which method to use');
  return 'both refused, with Allow headers';
});

await check('POST /convert/<unknown> is a 404 (no quota spent)', async () => {
  const res = await fetch(`${BASE}/convert/not-a-real-tool`, { method: 'POST', body: 'x' });
  assert(res.status === 404, `expected 404, got ${res.status}`);
  assert(/\/check/.test((await res.json()).error || ''), 'the 404 does not point at /check');
  return '404, pointing at /check';
});

// ------------------------------------------------------------------ table

const passed = results.filter((r) => r.ok).length;
const failedCount = results.length - passed;
const width = Math.max(...results.map((r) => r.name.length));

console.log(`\n${'='.repeat(width + 10)}`);
console.log(`${'CHECK'.padEnd(width)}  RESULT`);
console.log('-'.repeat(width + 10));
for (const r of results) console.log(`${r.name.padEnd(width)}  ${r.ok ? 'PASS' : 'FAIL'}`);
console.log('-'.repeat(width + 10));
console.log(`${`${passed} passed, ${failedCount} failed`.padEnd(width)}  ${failedCount ? 'FAIL' : 'PASS'}`);
console.log(`${'='.repeat(width + 10)}`);
console.log(`Free-tier conversions spent by this run: 1 of ${freeTierDaily ?? '?'}\n`);

process.exit(failedCount ? 1 : 0);
