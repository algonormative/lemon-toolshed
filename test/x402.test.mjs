// The paid tier, as far as it is actually built.
//
// PHASE: PAYTO set. This file needs its own worker instance with
// PAYTO=<test address>, because the over-tier answer is a 402 envelope only
// when there is somewhere to pay; with PAYTO unset it is a 429 (quota.test.mjs).
//
// The thing most worth guarding here is the negative: NOTHING IS EVER
// FAKE-VERIFIED. There is no facilitator wired up, so an X-PAYMENT header buys
// a higher ceiling and nothing else, and every response that so much as sees
// one must say `x-payment-verified: false`. A regression that started reporting
// `true` would look like a feature and be a lie.

import test, { before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  useWorker,
  bootWorker,
  client,
  callers,
  PAYTO_TEST,
  PAID_DAILY,
  SITE_BASE,
  FREE_TIER_DAILY,
  secondsToUtcMidnight,
} from './harness.mjs';

let worker;
let api;
const ips = callers('x402');

const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

// Per-tool facts the envelope has to carry — its own resource, its own
// description, its own mimeType. One shared envelope for every tool would be
// the regression this catches.
const TOOLS = {
  'md-html': { input: '# hi\n', description: 'Markdown to HTML conversion', mimeType: 'text/html' },
  'csv-json': { input: 'a\n1\n', description: 'CSV to JSON conversion', mimeType: 'application/json' },
  'json-yaml': { input: '{"a":1}', description: 'JSON to YAML conversion', mimeType: 'application/yaml' },
  'yaml-json': { input: 'a: 1\n', description: 'YAML to JSON conversion', mimeType: 'application/json' },
  'html-markdown': { input: '<p>hi</p>', description: 'HTML to Markdown conversion', mimeType: 'text/markdown' },
};

before(async () => {
  worker = await useWorker({ payTo: PAYTO_TEST });
  api = client(worker);
});
after(async () => {
  await worker.stop();
});

/** Spend the whole free tier for one caller, asserting it was actually free. */
async function exhaust(ip) {
  for (let call = 1; call <= FREE_TIER_DAILY; call++) {
    const res = await api.convert('md-html', '# hi\n', { ip, ua: 'x402-suite/1' });
    assert.equal(res.status, 200, `call ${call} answered ${res.status} while spending the free tier`);
  }
}

describe('a receiving address does not cancel the free tier', () => {
  test('the first call is still free and still reports what is left', async () => {
    const res = await api.convert('md-html', '# hi\n', { ip: ips.pinned(1) });
    assert.equal(res.status, 200, res.text);
    assert.equal(res.headers.get('x-free-tier-remaining'), String(FREE_TIER_DAILY - 1));
    assert.equal(res.headers.get('x-payment-verified'), null, 'a verification claim on a call that saw no payment');
    assert.equal(res.headers.get('x-pricing'), null, 'a free-tier call was labelled as pricing-pending');
    assert.ok(res.text.includes('<h1>hi</h1>'), 'the conversion did not run');
  });

  test('presenting X-PAYMENT inside the free tier is answered, and says it was not checked', async () => {
    const res = await api.convert('md-html', '# hi\n', {
      ip: ips.pinned(2),
      headers: { 'x-payment': 'eyJ1bnZlcmlmaWVkIjp0cnVlfQ==' },
    });
    assert.equal(res.status, 200, res.text);
    assert.equal(res.headers.get('x-payment-verified'), 'false', 'a presented payment was implied to be verified');
    // PAYTO is set and a payment was presented, so this call is on the paid
    // ceiling — which means no free-tier header, and a pricing-pending label.
    assert.equal(res.headers.get('x-pricing'), 'pending');
    assert.equal(res.headers.get('x-free-tier-remaining'), null);
  });
});

describe('the 402 envelope', () => {
  test('an over-tier call with no payment is a spec-shaped x402 v1 envelope', async () => {
    const ip = ips.pinned(3);
    await exhaust(ip);

    const res = await api.convert('md-html', '# hi\n', { ip, ua: 'x402-suite/1' });
    assert.equal(res.status, 402, `expected 402, got ${res.status}: ${res.text}`);
    assert.match(res.contentType, /application\/json/);

    const body = res.json();
    assert.deepEqual(Object.keys(body).sort(), ['accepts', 'error', 'x402Version']);
    assert.equal(body.x402Version, 1);
    assert.equal(body.error, 'X-PAYMENT header is required');
    assert.equal(body.accepts.length, 1);

    assert.deepEqual(body.accepts[0], {
      scheme: 'exact',
      network: 'base',
      maxAmountRequired: '1000', // $0.001 in USDC atomic units, 6 decimals
      resource: `${SITE_BASE}/convert/md-html`,
      description: TOOLS['md-html'].description,
      mimeType: TOOLS['md-html'].mimeType,
      payTo: PAYTO_TEST,
      maxTimeoutSeconds: 60,
      asset: USDC_BASE,
    });
  });

  test('the envelope names the tool that was actually asked for', async () => {
    // Probing several tools from the SAME exhausted caller: the free tier is
    // per caller, not per tool, so one exhaustion covers all of them.
    const ip = ips.pinned(4);
    await exhaust(ip);

    for (const [id, tool] of Object.entries(TOOLS)) {
      const res = await api.convert(id, tool.input, { ip, ua: 'x402-suite/1' });
      assert.equal(res.status, 402, `${id} answered ${res.status}: ${res.text}`);
      const offer = res.json().accepts[0];
      assert.equal(offer.resource, `${SITE_BASE}/convert/${id}`, `${id} names the wrong resource`);
      assert.equal(offer.description, tool.description, `${id} carries the wrong description`);
      assert.equal(offer.mimeType, tool.mimeType, `${id} carries the wrong mimeType`);
      assert.equal(offer.payTo, PAYTO_TEST);
      assert.equal(offer.maxAmountRequired, '1000');
      assert.equal(offer.asset, USDC_BASE);
      // The resource must be the PRODUCTION URL, not the local dev origin: it
      // is what an x402 client signs over.
      assert.ok(offer.resource.startsWith('https://'), `resource is not an https URL: ${offer.resource}`);
      assert.ok(!offer.resource.includes('127.0.0.1'), `a demo build leaked into the envelope: ${offer.resource}`);
    }
  });

  test('the 402 serves no conversion', async () => {
    const ip = ips.pinned(5);
    await exhaust(ip);
    const res = await api.convert('md-html', '# hi\n', { ip });
    assert.equal(res.status, 402);
    assert.ok(!res.text.includes('<h1>'), 'a 402 returned the conversion anyway');
  });
});

describe('X-PAYMENT raises the ceiling and nothing else', () => {
  test('an over-tier call presenting X-PAYMENT is served, unverified', async () => {
    const ip = ips.pinned(6);
    await exhaust(ip);

    // Without the header: 402.
    assert.equal((await api.convert('md-html', '# hi\n', { ip })).status, 402);

    // With it: served, on the paid ceiling.
    const res = await api.convert('md-html', '# hi\n', {
      ip,
      headers: { 'x-payment': 'eyJ0ZXN0Ijoic3R1YiJ9' },
    });
    assert.equal(res.status, 200, `expected 200 with X-PAYMENT, got ${res.status}: ${res.text}`);
    assert.ok(res.text.includes('<h1>hi</h1>'), 'the conversion did not run');
    assert.equal(res.headers.get('x-payment-verified'), 'false', 'settlement was implied to be verified');
    assert.equal(res.headers.get('x-pricing'), 'pending');
    assert.equal(res.headers.get('x-free-tier-remaining'), null, 'a paid-ceiling call reported free-tier remaining');
  });

  test('an arbitrary X-PAYMENT value is never treated as valid', async () => {
    // Nothing verifies settlement, so the header's CONTENT cannot matter — and
    // the response must keep saying so whatever is in it.
    const ip = ips.pinned(7);
    await exhaust(ip);
    for (const value of ['x', 'null', '{}', 'Bearer nope', '0'.repeat(500)]) {
      const res = await api.convert('md-html', '# hi\n', { ip, headers: { 'x-payment': value } });
      assert.equal(res.status, 200, `X-PAYMENT ${JSON.stringify(value.slice(0, 12))} answered ${res.status}`);
      assert.equal(res.headers.get('x-payment-verified'), 'false');
    }
  });

  test('an empty X-PAYMENT header does NOT raise the ceiling', async () => {
    // `!!request.headers.get('x-payment')` — an empty value is falsy, so the
    // caller stays on the free tier and gets the 402. Recorded because it is
    // the boundary of "presented".
    const ip = ips.pinned(8);
    await exhaust(ip);
    const res = await api.convert('md-html', '# hi\n', { ip, headers: { 'x-payment': '' } });
    assert.equal(res.status, 402, `an empty X-PAYMENT bought a higher ceiling: ${res.status}`);
  });

  test('the paid ceiling answers 429, not 402 — it is a runaway bound, not a price gate', async () => {
    // PAID_DAILY is 5,000, and making 5,000 requests to reach it would be a
    // load test rather than a contract test. So the counter is parked AT the
    // ceiling by writing to the store, and the answer is read from there.
    //
    // That write clears every caller's counter, so this test gets its own
    // throwaway worker rather than mutating the phase's shared one — otherwise
    // it would silently depend on being the last test to run.
    const scratch = await bootWorker({ vars: { PAYTO: PAYTO_TEST } });
    try {
      const scratchApi = client(scratch);
      const ip = ips.pinned(9);
      const paid = { 'x-payment': 'stub' };

      const first = await scratchApi.convert('md-html', '# hi\n', { ip, headers: paid });
      assert.equal(first.status, 200, first.text);

      await scratch.d1(`UPDATE convert_quota SET used = ${PAID_DAILY};`);

      const res = await scratchApi.convert('md-html', '# hi\n', { ip, headers: paid });
      assert.equal(res.status, 429, `expected 429 at the paid ceiling, got ${res.status}: ${res.text}`);
      const body = res.json();
      assert.equal(body.error, 'the daily conversion ceiling for this caller is reached');
      assert.equal(body.retry, 'tomorrow UTC');
      assert.ok(!('x402Version' in body), 'a caller that already presented a payment was told to pay again');
      assert.ok(!('accepts' in body), 'a caller that already presented a payment was told to pay again');
      assert.equal(res.headers.get('x-payment-verified'), 'false');

      const retryAfter = Number(res.headers.get('retry-after'));
      assert.ok(
        Math.abs(retryAfter - secondsToUtcMidnight()) <= 120,
        `Retry-After ${retryAfter}s does not point at UTC midnight`
      );
    } finally {
      await scratch.stop();
    }
  });
});
