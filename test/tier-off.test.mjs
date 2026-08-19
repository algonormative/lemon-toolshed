// The production configuration: no free tier, and the 402 as the front door.
//
// PHASE: PAYTO set, FREE_TIER_DAILY unset. This is what toolshed.lemon-agent.dev
// actually runs, and this file is the suite that says so.
//
// WHY THE TIER WENT AWAY (2026-08-19). Coinbase's Bazaar discovery index
// requires that an unauthenticated request answer 402. A free tier hands any
// fresh IP a 200, which fails that preflight — and the index re-probes on an
// interval, so a free tier does not merely block a listing, it drops one that
// already exists. The owner chose discoverability over the trial allowance.
//
// Three claims are worth more than the rest, because each fails silently:
//
//   1. THE FIRST CALL IS THE 402. Not the fourth. A regression here looks like
//      generosity and reads, to a health probe, as a dead endpoint.
//   2. THE 402 TOUCHES NO STORE. No salt read, no quota claim, no events row.
//      It is the cheapest answer this Worker gives, which is what makes it safe
//      to serve to an indexer that will ask forever, for free.
//   3. THE ENV VAR IS THE ONLY AUTHORITY. /check must report what the Worker
//      enforces right now, not what was compiled into the catalog, or flipping
//      the var in a dashboard silently desynchronises the advertisement from
//      the behaviour.
//
// The other half — that the mechanism still works when the var IS set — lives
// in quota.test.mjs and protocol.test.mjs, which boot a worker with it on.

import test, { before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  useWorker,
  bootWorker,
  client,
  callers,
  ROOT,
  CATALOG,
  SITE_BASE,
  FREE_TIER_DAILY,
  PAYTO_TEST,
} from './harness.mjs';

let worker;
let api;
const ips = callers('tier-off');

const HOSTED_IDS = CATALOG.filter((e) => e.hosted && e.hosted.status === 'live').map((e) => e.id);

const INPUTS = {
  'md-html': '# hi\n',
  'json-yaml': '{"a":1}',
  'yaml-json': 'a: 1\n',
  'csv-json': 'a\n1\n',
  'html-markdown': '<p>hi</p>',
};

before(async () => {
  worker = await useWorker({ payTo: PAYTO_TEST });
  api = client(worker);
});
after(async () => {
  await worker.stop();
});

describe('the 402 is the front door', () => {
  test('every live tool answers a fresh caller with a 402, not a conversion', async () => {
    for (const id of HOSTED_IDS) {
      const res = await api.convert(id, INPUTS[id], { ip: ips.next(), ua: 'tier-off-suite/1' });
      assert.equal(res.status, 402, `${id} served a fresh caller for nothing: ${res.status} ${res.text}`);
      assert.equal(res.json().x402Version, 1, `${id} did not answer an x402 v1 envelope`);
      assert.equal(res.headers.get('x-free-tier-remaining'), null, `${id} reported a free-tier allowance`);
    }
  });

  test('the envelope carries outputSchema with discoverable inside input', async () => {
    // The exact shape Coinbase's validator reads. `discoverable` lives INSIDE
    // outputSchema.input — an envelope that hoists it to the top level is
    // spec-shaped, passes every other assertion, and is never indexed.
    const res = await api.convert('md-html', INPUTS['md-html'], { ip: ips.next() });
    assert.equal(res.status, 402);

    const offer = res.json().accepts[0];
    assert.equal(offer.resource, `${SITE_BASE}/convert/md-html`);
    assert.ok(offer.outputSchema, 'no outputSchema — this resource cannot be listed');
    assert.equal(offer.outputSchema.input.discoverable, true, 'discoverable is not true inside input');
    assert.equal(offer.discoverable, undefined, 'discoverable was hoisted out of outputSchema.input');
    assert.equal(offer.outputSchema.input.type, 'http');
    assert.equal(offer.outputSchema.input.method, 'POST');
    assert.equal(offer.outputSchema.input.bodyType, 'text');
    assert.equal(offer.outputSchema.output.type, 'string');
  });

  test('the 402 writes nothing at all to the store', async () => {
    // The reject-ordering claim, measured rather than asserted from the code.
    // An indexer probes this endpoint on an interval forever; if the probe read
    // the salt and tried a quota claim, discovery would carry a permanent D1
    // bill and could exhaust a caller's ceiling by health-checking it.
    const count = async (table) =>
      Number((await worker.d1(`SELECT COUNT(*) AS n FROM ${table};`))[0].n);
    const quota = async () =>
      Number((await worker.d1('SELECT COALESCE(SUM(used), 0) AS n FROM convert_quota;'))[0].n);

    const before = { events: await count('events'), quota: await quota(), settlements: await count('settlements') };

    for (let i = 0; i < 5; i++) {
      const res = await api.convert('md-html', '# hi\n', { ip: ips.next(), ua: 'tier-off-suite/1' });
      assert.equal(res.status, 402);
    }

    assert.equal(await count('events'), before.events, 'a 402 wrote an events row');
    assert.equal(await quota(), before.quota, 'a 402 claimed quota');
    assert.equal(await count('settlements'), before.settlements, 'a 402 wrote a settlements row');
  });

  test('an oversize body is 413, checked before the envelope is built', async () => {
    // Ordering: rejecting on the DECLARED content-length is cheaper than
    // constructing an envelope, so the 413 stays in front of the 402. A caller
    // sending 300 KB is told the size is the problem, not asked to pay for a
    // call that could never have run.
    const res = await api.convert('md-html', 'a'.repeat(300 * 1024), { ip: ips.next() });
    assert.equal(res.status, 413, `expected 413, got ${res.status}: ${res.text}`);
    assert.match(res.json().error, /256 KB limit/);
    assert.ok(!('accepts' in res.json()), 'an oversize body was offered a payment envelope');
  });

  test('the routing guards still answer before the paywall', async () => {
    // A 404 or a 405 must not become "pay me first" — an unknown id is the
    // caller's mistake and telling it to pay would be actively misleading.
    const unknown = await api.convert('not-a-real-tool', 'x', { ip: ips.next() });
    assert.equal(unknown.status, 404);
    assert.match(unknown.json().error, /\/check/);

    const wrongMethod = await api.request('/convert/md-html', { method: 'GET' });
    assert.equal(wrongMethod.status, 405);
  });
});

describe('what /check publishes about the tier', () => {
  test('every hosted match reports free_tier_daily 0 — present, not absent', async () => {
    const res = await api.get('/check');
    const body = await res.json();
    assert.ok(body.matches.length > 0);
    for (const match of body.matches) {
      assert.equal(
        match.hosted.free_tier_daily,
        0,
        `${match.id} advertises a free tier this Worker does not enforce`
      );
      assert.ok('free_tier_daily' in match.hosted, `${match.id} dropped the field instead of reporting 0`);
    }
  });

  test('the reported number is the runtime one, not the compiled one', async () => {
    // Both are 0 today, so this test is only meaningful as a guard: if the
    // build constant is ever raised without the env var, /check must keep
    // reporting what is enforced. Stated as an explicit relationship so the
    // failure names the confusion rather than showing two numbers.
    const res = await api.get('/check');
    const [first] = (await res.json()).matches;
    assert.equal(first.hosted.free_tier_daily, 0, 'the runtime value is not 0 on a worker with the var unset');
    assert.equal(
      FREE_TIER_DAILY,
      0,
      'the BUILD constant is no longer 0 — the static site now advertises a tier; set the env var too, ' +
        'or the page and the API disagree'
    );
  });

  test('/check publishes the alias sets it matches on', async () => {
    const body = await (await api.get('/check?from=markdown&to=html')).json();
    assert.deepEqual(body.matches.map((m) => m.id), ['md-html']);
    const [match] = body.matches;
    assert.ok(match.x_aliases.includes('md'), 'md is not published as a from-side alias');
    assert.ok(match.x_aliases.includes('text/markdown'), 'text/markdown is not published');
    assert.ok(match.y_aliases.includes('htm'), 'htm is not published as a to-side alias');
  });
});

describe('a deployment with nowhere to take money', () => {
  test('answers 429 naming the misconfiguration, with no Retry-After', async () => {
    // The PAYTO-less fallback, which has to survive the tier being removed:
    // offering a 402 that names no address would be an envelope nobody can pay.
    //
    // And it deliberately carries NO Retry-After. Waiting does not fix a missing
    // receiving address, so a header telling a client to come back at midnight
    // would be a lie the client would obey — it would retry, forever, nightly.
    const scratch = await bootWorker({ vars: {} });
    try {
      const scratchApi = client(scratch);
      const res = await scratchApi.convert('md-html', '# hi\n', { ip: ips.next() });

      assert.equal(res.status, 429, `expected 429 with no PAYTO, got ${res.status}: ${res.text}`);
      const body = res.json();
      assert.match(body.error, /no receiving address/);
      assert.equal(body.free_tier_daily, 0);
      assert.ok(!('accepts' in body), 'an envelope was offered with no address to pay to');
      assert.equal(
        res.headers.get('retry-after'),
        null,
        'a misconfiguration promised that waiting would fix it'
      );
    } finally {
      await scratch.stop();
    }
  });
});

describe('a misconfigured FREE_TIER_DAILY fails towards charging', () => {
  test('a negative value reads as no tier, not as an unbounded one', async () => {
    // The failure direction that matters. A typo in a dashboard field must not
    // become a free service — `Number('-5')` is a perfectly good number, and a
    // ceiling comparison against it would have let every call through.
    const scratch = await bootWorker({ vars: { PAYTO: PAYTO_TEST, FREE_TIER_DAILY: '-5' } });
    try {
      const scratchApi = client(scratch);
      const ip = ips.next();

      const res = await scratchApi.convert('md-html', '# hi\n', { ip });
      assert.equal(res.status, 402, `a negative tier served a call: ${res.status} ${res.text}`);

      const [match] = (await (await scratchApi.get('/check')).json()).matches;
      assert.equal(match.hosted.free_tier_daily, 0, 'a negative tier was published as-is');
    } finally {
      await scratch.stop();
    }
  });

  test('an unparseable value reads as no tier', async () => {
    const scratch = await bootWorker({ vars: { PAYTO: PAYTO_TEST, FREE_TIER_DAILY: 'three' } });
    try {
      const scratchApi = client(scratch);
      const res = await scratchApi.convert('md-html', '# hi\n', { ip: ips.next() });
      assert.equal(res.status, 402, `an unparseable tier served a call: ${res.status} ${res.text}`);
    } finally {
      await scratch.stop();
    }
  });
});

describe('the published OpenAPI agrees with the envelope', () => {
  // dist/openapi.json is written by build.mjs and served at the origin, while
  // the envelope is built in the Worker. They describe the same thing from two
  // files, so they can drift — and a machine that reads the document and gets a
  // different content type from the call has no way to tell which is wrong.
  const openapi = JSON.parse(readFileSync(join(ROOT, 'dist', 'openapi.json'), 'utf8'));

  test('it is OpenAPI 3.1 and names every live convert path plus /check', () => {
    assert.match(openapi.openapi, /^3\.1/);
    assert.ok(openapi.paths['/check'].get, 'no GET /check');
    assert.equal(openapi.servers[0].url, SITE_BASE, 'the server url is not the production origin');
    for (const id of HOSTED_IDS) {
      const path = openapi.paths[`/convert/${id}`];
      assert.ok(path?.post, `openapi.json does not describe POST /convert/${id}`);
      assert.ok(path.post.responses[402], `openapi.json omits the 402 for ${id} — the interesting response`);
      assert.ok(path.post.responses[413], `openapi.json omits the 413 for ${id}`);
      assert.ok(path.post.responses[400], `openapi.json omits the 400 for ${id}`);
    }
  });

  test('the 200 content type matches the mimeType the envelope advertises', async () => {
    for (const id of HOSTED_IDS) {
      const res = await api.convert(id, INPUTS[id], { ip: ips.next(), ua: 'tier-off-suite/1' });
      assert.equal(res.status, 402);
      const { mimeType } = res.json().accepts[0];
      const documented = Object.keys(openapi.paths[`/convert/${id}`].post.responses[200].content);
      assert.deepEqual(
        documented,
        [mimeType],
        `${id}: openapi.json documents ${documented} but the envelope advertises ${mimeType}`
      );
    }
  });
});
