// The 402 envelope, and the paid tier with NO facilitator configured.
//
// PHASE: PAYTO set, and deliberately no CDP credentials. This file needs its own
// worker instance with PAYTO=<test address>, because the over-tier answer is a
// 402 envelope only when there is somewhere to pay; with PAYTO unset it is a 429
// (quota.test.mjs). Verification against a real (mock) facilitator is
// x402-settlement.test.mjs; what is pinned HERE is the envelope itself, and the
// half-configured deployment — an address to pay to, but no way to check a
// payment — which is a state a real deploy can be in.
//
// The thing most worth guarding is still the negative: NOTHING IS EVER
// FAKE-VERIFIED. With no facilitator reachable, `x-payment-verified` must never
// be `true`, whatever the caller presents. A regression that started reporting
// `true` here would look like a feature and be a lie.
//
// WHAT CHANGED when the facilitator landed (2026-08-18), and why these
// assertions moved with it:
//
//   - The free tier is claimed FIRST, always. An X-PAYMENT header presented
//     inside the free tier no longer moves the caller onto the paid ceiling —
//     it is a free call that happens to carry a header nobody looked at.
//   - The paid ceiling keys on a VERIFIED payment. Presenting the header used
//     to buy PAID_DAILY (5,000) outright; that was a pre-facilitator
//     placeholder, and it let an unverified claim buy a 500x ceiling for free.
//   - An X-PAYMENT that is not base64 JSON is now a 402, not a served call.
//     There is nothing to verify in it, and that is the caller's bug.
//   - Over-tier calls with a payment are served with `x-payment-error` when the
//     facilitator cannot be asked — availability-first, and honest about it.

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

/**
 * A well-formed x402 v1 `exact` payload, base64-encoded as X-PAYMENT.
 *
 * The Worker decodes this header before it does anything else with it, so a
 * test about the CEILING has to present something decodable — otherwise it is
 * really a test about malformed headers, which is separately covered below.
 * Nothing here is signed: this phase has no facilitator to check it.
 */
function paymentHeader() {
  const now = Math.floor(Date.now() / 1000);
  return Buffer.from(
    JSON.stringify({
      x402Version: 1,
      scheme: 'exact',
      network: 'base',
      payload: {
        signature: `0x${'ab'.repeat(65)}`,
        authorization: {
          from: '0x000000000000000000000000000000000000dEaD',
          to: PAYTO_TEST,
          value: '1000',
          validAfter: String(now - 600),
          validBefore: String(now + 60),
          nonce: `0x${'cd'.repeat(32)}`,
        },
      },
    })
  ).toString('base64');
}

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
    // CHANGED with the facilitator: this is a FREE-TIER call that happens to
    // carry a header. It used to be pushed onto the paid ceiling by the mere
    // presence of X-PAYMENT — no free-tier header, `x-pricing: pending` — which
    // meant the free tier could be skipped for free. The free tier is now
    // claimed first and unconditionally, so the call spends its allowance and
    // reports what is left, and nothing is charged or checked.
    assert.equal(res.headers.get('x-free-tier-remaining'), String(FREE_TIER_DAILY - 1));
    assert.equal(res.headers.get('x-pricing'), null, 'a free-tier call was labelled as pricing-pending');
    assert.equal(res.headers.get('x-payment-error'), null, 'the free tier tried to take a payment');
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
      // ADDED with the facilitator, and not cosmetic: the client builds its
      // EIP-712 signing domain from `extra`, with no fallback, while the
      // verifier falls back to USDC's real on-chain name. An envelope without
      // this field makes every genuine payment fail as
      // `invalid_exact_evm_payload_signature`. "USD Coin" is the token's name(),
      // which is not its ticker.
      extra: { name: 'USD Coin', version: '2' },
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

describe('a payment that cannot be checked is never treated as checked', () => {
  test('an over-tier call presenting X-PAYMENT is served, and says nothing was verified', async () => {
    const ip = ips.pinned(6);
    await exhaust(ip);

    // Without the header: 402.
    assert.equal((await api.convert('md-html', '# hi\n', { ip })).status, 402);

    // With it: served. CHANGED — this used to be "served because a header was
    // present". It is now "served because the facilitator could not be asked,
    // and turning a paying caller away for OUR missing configuration is the
    // worse failure". The new `x-payment-error` is what makes the difference
    // legible instead of silent.
    const res = await api.convert('md-html', '# hi\n', { ip, headers: { 'x-payment': paymentHeader() } });
    assert.equal(res.status, 200, `expected 200 with X-PAYMENT, got ${res.status}: ${res.text}`);
    assert.ok(res.text.includes('<h1>hi</h1>'), 'the conversion did not run');
    assert.equal(res.headers.get('x-payment-verified'), 'false', 'settlement was implied to be verified');
    // No CDP credentials in this phase, so the fault is ours and named as such
    // — distinct from a facilitator that exists and did not answer.
    assert.equal(res.headers.get('x-payment-error'), 'facilitator-unconfigured');
    assert.equal(res.headers.get('x-pricing'), 'pending');
    assert.equal(res.headers.get('x-free-tier-remaining'), null, 'a paid-ceiling call reported free-tier remaining');
  });

  test('an arbitrary X-PAYMENT value is never treated as valid', async () => {
    // CHANGED: these used to be served with `x-payment-verified: false`, because
    // nothing looked at the header at all. Now the header is DECODED before
    // anything else, and none of these is a base64-encoded JSON object — so
    // there is no payment here to verify, and the honest answer is the 402 with
    // the reason attached rather than a free conversion.
    //
    // Coverage is kept, not deleted: the property under test is still "an
    // arbitrary value never buys a verified call". Only the answer moved.
    const ip = ips.pinned(7);
    await exhaust(ip);
    for (const value of ['x', 'null', '{}', 'Bearer nope', '0'.repeat(500)]) {
      const res = await api.convert('md-html', '# hi\n', { ip, headers: { 'x-payment': value } });
      assert.equal(res.status, 402, `X-PAYMENT ${JSON.stringify(value.slice(0, 12))} answered ${res.status}`);
      assert.equal(res.json().invalidReason, 'malformed_payment_header');
      assert.notEqual(res.headers.get('x-payment-verified'), 'true');
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
      // A DECODABLE payload, which it now has to be: an undecodable header is
      // rejected as malformed before the ceiling is ever consulted, so `'stub'`
      // would have made this a test about parsing rather than about the bound.
      const paid = { 'x-payment': paymentHeader() };

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
