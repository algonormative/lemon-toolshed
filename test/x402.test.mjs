// The 402 envelope, and the paid tier with NO facilitator configured.
//
// PHASE: the production configuration — PAYTO set, free tier off — and
// deliberately no CDP credentials. This file needs a worker with PAYTO=<test
// address>, because the unpaid answer is a 402 envelope only when there is
// somewhere to pay; with PAYTO unset it is a 429 (quota.test.mjs, and the
// no-address case in tier-off.test.mjs). Verification against a real (mock)
// facilitator is x402-settlement.test.mjs; what is pinned HERE is the envelope
// itself, and the half-configured deployment — an address to pay to, but no way
// to check a payment — which is a state a real deploy can be in.
//
// The thing most worth guarding is still the negative: NOTHING IS EVER
// FAKE-VERIFIED. With no facilitator reachable, `x-payment-verified` must never
// be `true`, whatever the caller presents. A regression that started reporting
// `true` here would look like a feature and be a lie.
//
// WHAT CHANGED when the facilitator landed (2026-08-18), and why these
// assertions moved with it:
//
//   - The paid ceiling keys on a VERIFIED payment. Presenting the header used
//     to buy PAID_DAILY (5,000) outright; that was a pre-facilitator
//     placeholder, and it let an unverified claim buy a 500x ceiling for free.
//   - An X-PAYMENT that is not base64 JSON is now a 402, not a served call.
//     There is nothing to verify in it, and that is the caller's bug.
//   - Calls with a payment are served with `x-payment-error` when the
//     facilitator cannot be asked — availability-first, and honest about it.
//
// WHAT CHANGED AGAIN when the free tier was retired (2026-08-19): there is no
// allowance to spend before any of this. The FIRST unauthenticated call is the
// 402, so every test below that used to open with `await exhaust(ip)` simply
// makes its call. The assertions are unchanged; only the setup went away.
//
// AND AGAIN, the same day, when the payment surface went DUAL-STACK: the same
// 402 now also carries the x402 v2 envelope, base64, in a PAYMENT-REQUIRED
// response header. The v1 assertions below are untouched on purpose — one real
// v1 payment has settled on this rail, and the body it was signed against must
// stay byte-for-byte what it was. The v2 assertions are a separate describe at
// the bottom, and the one that matters most is that the two AGREE: the header
// is a projection of the body, not a second envelope written by hand.

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
  secondsToUtcMidnight,
} from './harness.mjs';

let worker;
let api;
const ips = callers('x402');

const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

// Per-tool facts the envelope has to carry — its own resource, its own
// description, its own mimeType, its OWN PRICE. One shared envelope for every
// tool would be the regression this catches, and since 2026-08-30 the price is
// part of that: the tools are no longer uniformly priced, so an envelope built
// from a constant instead of from the entry would pass every other assertion
// here and quote the wrong figure.
//
// `amount` is the atomic USDC (6 decimals) for that tool's amount_usd in
// entries.yaml: $0.005 is "5000", $0.01 is "10000". The descriptions are
// asserted verbatim rather than derived — the string is published in the
// envelope and in the Bazaar listing, so a silent edit to one is worth failing on.
const TOOLS = {
  'md-html': { input: '# hi\n', amount: '5000', description: 'Markdown to HTML conversion', mimeType: 'text/html', from: 'Markdown', to: 'HTML' },
  'csv-json': { input: 'a\n1\n', amount: '5000', description: 'CSV to JSON conversion', mimeType: 'application/json', from: 'CSV', to: 'JSON' },
  'json-yaml': { input: '{"a":1}', amount: '5000', description: 'JSON to YAML conversion', mimeType: 'application/yaml', from: 'JSON', to: 'YAML' },
  'yaml-json': { input: 'a: 1\n', amount: '5000', description: 'YAML to JSON conversion', mimeType: 'application/json', from: 'YAML', to: 'JSON' },
  'html-markdown': { input: '<p>hi</p>', amount: '10000', description: 'HTML to Markdown conversion', mimeType: 'text/markdown', from: 'HTML', to: 'Markdown' },
  'json-csv': { input: '[{"a":1}]', amount: '5000', mimeType: 'text/csv', from: 'JSON', to: 'CSV' },
  'csv-yaml': { input: 'a\n1\n', amount: '5000', mimeType: 'application/yaml', from: 'CSV', to: 'YAML' },
  'yaml-csv': { input: '- a: 1\n', amount: '5000', mimeType: 'text/csv', from: 'YAML', to: 'CSV' },
  'json-ndjson': { input: '[{"a":1}]', amount: '5000', mimeType: 'application/x-ndjson', from: 'JSON', to: 'NDJSON' },
  'ndjson-json': { input: '{"a":1}\n', amount: '5000', mimeType: 'application/json', from: 'NDJSON', to: 'JSON' },
  'frontmatter-json': { input: '---\ntitle: hi\n---\nbody\n', amount: '5000', mimeType: 'application/json', from: 'Markdown with YAML frontmatter', to: 'JSON' },
  'markdown-json': { input: '# hi\n', amount: '5000', mimeType: 'application/json', from: 'Markdown', to: 'JSON' },
  'srt-vtt': { input: '1\n00:00:01,000 --> 00:00:02,000\nhi\n', amount: '5000', mimeType: 'text/vtt', from: 'SubRip', to: 'WebVTT' },
  'vtt-srt': { input: 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nhi\n', amount: '5000', mimeType: 'application/x-subrip', from: 'WebVTT', to: 'SubRip' },
  'toml-json': { input: 'a = 1\n', amount: '5000', mimeType: 'application/json', from: 'TOML', to: 'JSON' },
  'json-toml': { input: '{"a":1}', amount: '5000', mimeType: 'application/toml', from: 'JSON', to: 'TOML' },
  'xml-json': { input: '<r><a>1</a></r>', amount: '10000', mimeType: 'application/json', from: 'XML', to: 'JSON' },
  'html-text': { input: '<p>hi</p>', amount: '10000', mimeType: 'text/plain', from: 'HTML', to: 'plain text' },
  'html-json': { input: '<table><tr><th>a</th></tr><tr><td>1</td></tr></table>', amount: '10000', mimeType: 'application/json', from: 'HTML', to: 'JSON' },
};

/** The outputSchema the envelope must carry for one tool. See §Bazaar in README. */
const outputSchemaFor = (tool) => ({
  input: {
    type: 'http',
    method: 'POST',
    discoverable: true,
    bodyType: 'text',
    description: `the raw ${tool.from} file as the request body, up to 256 KB`,
  },
  output: {
    type: 'string',
    description: `the converted ${tool.to} file as the response body (${tool.mimeType})`,
  },
});

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
          // The md-html price, which is the tool every test in this file pays for.
          value: TOOLS['md-html'].amount,
          validAfter: String(now - 600),
          validBefore: String(now + 60),
          nonce: `0x${'cd'.repeat(32)}`,
        },
      },
    })
  ).toString('base64');
}

describe('the paid front door', () => {
  test('the FIRST call from a caller that has never called is the 402', async () => {
    // The whole 2026-08-19 change, in one assertion. This used to be a 200 with
    // an allowance countdown, and that 200 is exactly what fails Coinbase's
    // Bazaar `returns_402` preflight — which is re-probed on an interval, so a
    // regression here would not merely block listing, it would delist.
    const res = await api.convert('md-html', '# hi\n', { ip: ips.pinned(1), ua: 'x402-suite/1' });
    assert.equal(res.status, 402, `a fresh caller was served instead of charged: ${res.status} ${res.text}`);
    assert.equal(res.headers.get('x-free-tier-remaining'), null, 'a free-tier allowance was reported');
    assert.ok(!res.text.includes('<h1>'), 'the 402 returned the conversion anyway');
  });

  test('there is no allowance to find: repeated calls stay 402', async () => {
    // A tier of 0 must be 0, not "one if you ask twice" — an off-by-one in the
    // claim guard would show up here and nowhere else.
    const ip = ips.pinned(2);
    for (let call = 1; call <= 5; call++) {
      const res = await api.convert('md-html', '# hi\n', { ip, ua: 'x402-suite/1' });
      assert.equal(res.status, 402, `call ${call} was served free`);
    }
  });
});

describe('the 402 envelope', () => {
  test('an unpaid call is a spec-shaped x402 v1 envelope', async () => {
    const ip = ips.pinned(3);

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
      maxAmountRequired: TOOLS['md-html'].amount, // $0.005 in USDC atomic units, 6 decimals
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
      // ADDED 2026-08-19 for Bazaar discovery. `discoverable` sits INSIDE
      // `outputSchema.input`, not at the top level — an envelope that hoists it
      // is spec-shaped and still not indexed, which is a failure with no error
      // message anywhere.
      outputSchema: outputSchemaFor(TOOLS['md-html']),
    });
  });

  test('every tool advertises itself as discoverable, honestly described', async () => {
    for (const [id, tool] of Object.entries(TOOLS)) {
      const res = await api.convert(id, tool.input, { ip: ips.next(), ua: 'x402-suite/1' });
      assert.equal(res.status, 402, `${id} answered ${res.status}: ${res.text}`);
      const schema = res.json().accepts[0].outputSchema;

      assert.ok(schema, `${id} carries no outputSchema — it cannot be indexed`);
      assert.equal(schema.input.discoverable, true, `${id} is not marked discoverable`);
      assert.equal(schema.input.type, 'http');
      assert.equal(schema.input.method, 'POST');
      // These tools take a raw file body, not JSON fields. Saying so is the
      // difference between a listing an agent can call and one it cannot.
      assert.equal(schema.input.bodyType, 'text');
      assert.match(schema.input.description, new RegExp(`raw ${tool.from} file`));
      assert.match(schema.output.description, new RegExp(`converted ${tool.to} file`));
      assert.ok(schema.output.description.includes(tool.mimeType), `${id} output omits its mimeType`);

      // The facilitator rejects a description past 500 characters, and it does
      // so at listing time rather than at call time — so a too-long string is
      // invisible until discovery silently stops working.
      for (const [where, text] of [
        ['description', res.json().accepts[0].description],
        ['outputSchema.input.description', schema.input.description],
        ['outputSchema.output.description', schema.output.description],
      ]) {
        assert.ok(text.length <= 500, `${id} ${where} is ${text.length} chars, over the 500 limit`);
      }
    }
  });

  test('the envelope names the tool that was actually asked for', async () => {
    // Probing several tools from the same caller. Nothing to set up any more:
    // with no free tier, every one of these is a 402 on its first call.
    const ip = ips.pinned(4);

    for (const [id, tool] of Object.entries(TOOLS)) {
      const res = await api.convert(id, tool.input, { ip, ua: 'x402-suite/1' });
      assert.equal(res.status, 402, `${id} answered ${res.status}: ${res.text}`);
      const offer = res.json().accepts[0];
      assert.equal(offer.resource, `${SITE_BASE}/convert/${id}`, `${id} names the wrong resource`);
      if (tool.description) {
        assert.equal(offer.description, tool.description, `${id} carries the wrong description`);
      }
      assert.equal(offer.mimeType, tool.mimeType, `${id} carries the wrong mimeType`);
      assert.equal(offer.payTo, PAYTO_TEST);
      assert.equal(offer.maxAmountRequired, tool.amount, `${id} quotes the wrong price`);
      assert.equal(offer.asset, USDC_BASE);
      // The resource must be the PRODUCTION URL, not the local dev origin: it
      // is what an x402 client signs over.
      assert.ok(offer.resource.startsWith('https://'), `resource is not an https URL: ${offer.resource}`);
      assert.ok(!offer.resource.includes('127.0.0.1'), `a demo build leaked into the envelope: ${offer.resource}`);
    }
  });

  test('the 402 serves no conversion', async () => {
    const ip = ips.pinned(5);
    const res = await api.convert('md-html', '# hi\n', { ip });
    assert.equal(res.status, 402);
    assert.ok(!res.text.includes('<h1>'), 'a 402 returned the conversion anyway');
  });
});

describe('a payment that cannot be checked is never treated as checked', () => {
  test('a call presenting X-PAYMENT is served, and says nothing was verified', async () => {
    const ip = ips.pinned(6);

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
    assert.equal(res.headers.get('x-free-tier-remaining'), null, 'a paid call reported a free-tier allowance');
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
    for (const value of ['x', 'null', '{}', 'Bearer nope', '0'.repeat(500)]) {
      const res = await api.convert('md-html', '# hi\n', { ip, headers: { 'x-payment': value } });
      assert.equal(res.status, 402, `X-PAYMENT ${JSON.stringify(value.slice(0, 12))} answered ${res.status}`);
      assert.equal(res.json().invalidReason, 'malformed_payment_header');
      assert.notEqual(res.headers.get('x-payment-verified'), 'true');
    }
  });

  test('an empty X-PAYMENT header does NOT raise the ceiling', async () => {
    // `!!request.headers.get('x-payment')` — an empty value is falsy, so the
    // caller counts as having presented nothing and gets the 402 on the
    // no-store fast path. Recorded because it is the boundary of "presented".
    const ip = ips.pinned(8);
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

// ------------------------------------------------------------------ x402 v2
//
// The dual-stack half. A v2 client never reads the 402's body — it reads the
// PAYMENT-REQUIRED header and stops (x402HTTPClient.getPaymentRequiredResponse
// in @x402/core: header first, body only when x402Version === 1) — so a missing
// or malformed header is, from a v2 client's side, a seller that published no
// terms at all. Which is also what Coinbase's Bazaar validator now says: a
// v1-only endpoint is told to "upgrade to x402 v2 to be discoverable".

/** The v2 envelope carried by a 402, decoded. Throws if it is not there. */
function v2Envelope(res) {
  const header = res.headers.get('payment-required');
  assert.ok(header, 'the 402 carries no PAYMENT-REQUIRED header — a v2 client sees no envelope');
  // The client validates the header against /^[A-Za-z0-9+/]*={0,2}$/ BEFORE
  // decoding it, so url-safe base64 is thrown out unread. Asserted here because
  // the failure is silent everywhere else.
  assert.match(header, /^[A-Za-z0-9+/]*={0,2}$/, 'the envelope is not standard base64');
  return JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
}

describe('the v2 envelope in the PAYMENT-REQUIRED header', () => {
  test('an unpaid call carries a spec-shaped x402 v2 envelope', async () => {
    const res = await api.convert('md-html', '# hi\n', { ip: ips.pinned(10), ua: 'x402-suite/1' });
    assert.equal(res.status, 402, `expected 402, got ${res.status}: ${res.text}`);

    const env = v2Envelope(res);
    assert.deepEqual(Object.keys(env).sort(), ['accepts', 'error', 'extensions', 'resource', 'x402Version']);
    assert.equal(env.x402Version, 2);
    // v2's `error` is a CODE a client branches on, not the v1 sentence.
    assert.equal(env.error, 'Payment required');

    // `resource` is an OBJECT in v2 — the thing being sold, split out from the
    // terms it is sold on.
    assert.deepEqual(env.resource, {
      url: `${SITE_BASE}/convert/md-html`,
      method: 'POST',
      description: TOOLS['md-html'].description,
      mimeType: TOOLS['md-html'].mimeType,
      tags: ['x402', 'conversion'],
      serviceName: 'Toolshed',
    });

    // …and `accepts[0]` is SEVEN fields, no more: everything v1 kept here that
    // v2 moved out must be gone, or the facilitator is handed a shape it did
    // not ask for.
    assert.equal(env.accepts.length, 1);
    assert.deepEqual(env.accepts[0], {
      scheme: 'exact',
      network: 'eip155:8453', // CAIP-2. "base" is a v1 spelling and invalid here.
      amount: TOOLS['md-html'].amount, // renamed from maxAmountRequired
      asset: USDC_BASE,
      payTo: PAYTO_TEST,
      maxTimeoutSeconds: 60,
      // Same EIP-712 domain as v1, and load-bearing for the same reason: the
      // client signs over `extra.name`/`extra.version` with no fallback.
      extra: { name: 'USD Coin', version: '2' },
    });
  });

  test('the v2 header and the v1 body are the same offer', async () => {
    // THE INVARIANT THIS WHOLE DESIGN RESTS ON. The two envelopes are built
    // from one object — the v2 view is a projection of the v1 one — so a
    // disagreement here is not a copy error, it is a broken projection. And it
    // would be invisible: each envelope is independently valid, and only the
    // client that reads the OTHER one pays the wrong price.
    for (const [id, tool] of Object.entries(TOOLS)) {
      const res = await api.convert(id, tool.input, { ip: ips.next(), ua: 'x402-suite/1' });
      assert.equal(res.status, 402, `${id} answered ${res.status}: ${res.text}`);

      const v1 = res.json().accepts[0];
      const env = v2Envelope(res);
      const v2 = env.accepts[0];

      assert.equal(v2.amount, v1.maxAmountRequired, `${id}: the two envelopes name different prices`);
      assert.equal(v2.payTo, v1.payTo, `${id}: the two envelopes name different payees`);
      assert.equal(v2.asset, v1.asset, `${id}: the two envelopes name different assets`);
      assert.equal(v2.scheme, v1.scheme, `${id}: the two envelopes name different schemes`);
      assert.equal(v2.maxTimeoutSeconds, v1.maxTimeoutSeconds, `${id}: different timeouts`);
      assert.deepEqual(v2.extra, v1.extra, `${id}: different EIP-712 domains`);
      assert.equal(env.resource.url, v1.resource, `${id}: the two envelopes name different resources`);
      assert.equal(env.resource.description, v1.description, `${id}: different descriptions`);
      assert.equal(env.resource.mimeType, v1.mimeType, `${id}: different mimeTypes`);
    }
  });

  test('every tool carries an extensions.bazaar block that describes its own call', async () => {
    for (const [id, tool] of Object.entries(TOOLS)) {
      const res = await api.convert(id, tool.input, { ip: ips.next(), ua: 'x402-suite/1' });
      assert.equal(res.status, 402, `${id} answered ${res.status}: ${res.text}`);
      const env = v2Envelope(res);

      // v1's outputSchema moved here wholesale. No bazaar block, no listing.
      const bazaar = env.extensions?.bazaar;
      assert.ok(bazaar, `${id} carries no extensions.bazaar — it cannot be indexed`);
      assert.deepEqual(Object.keys(bazaar).sort(), ['info', 'schema'], `${id} bazaar has the wrong halves`);

      // POST is a BODY method, so the input union is { type, method, bodyType,
      // body } — `body` an example request, not a description of one.
      assert.deepEqual(bazaar.info.input, {
        type: 'http',
        method: 'POST',
        bodyType: 'text',
        body: bazaar.info.input.body,
      });
      assert.equal(typeof bazaar.info.input.body, 'string');
      assert.ok(bazaar.info.input.body.trim().length > 0, `${id} publishes an empty example body`);
      // `discoverable` was v1's opt-in flag. In v2 the extension IS the opt-in,
      // and the field is not in the union — it would fail the schema below.
      assert.equal(bazaar.info.input.discoverable, undefined, `${id} leaks the v1 discoverable flag`);

      // `example` is the sample body run through the converter itself (computed
      // in the Worker, not typed — it cannot drift from what the tool returns;
      // the converter suites pin the real outputs). Closes the validator's
      // last advisory (bazaar.info.output.example). Here: shape + a per-tool
      // marker proving the example is genuinely converted output, not input.
      assert.deepEqual(Object.keys(bazaar.info.output).sort(), ['example', 'format', 'type']);
      assert.equal(bazaar.info.output.type, 'text');
      assert.equal(bazaar.info.output.format, tool.mimeType);
      // A per-tool marker chosen so it can ONLY appear in converted output, not
      // in that tool's sample input — which is what makes this an assertion that
      // the example was run rather than echoed.
      const EXAMPLE_MARK = {
        'md-html': '<h1>',
        'json-yaml': 'name: toolshed',
        'yaml-json': '"name"',
        'csv-json': '"toolshed"',
        'html-markdown': '# Title',
        'json-csv': 'name,qty\nlemon,3',
        'csv-yaml': '- name: lemon',
        'yaml-csv': 'name,qty\nlemon,3',
        'json-ndjson': '{"a":1}\n{"a":2}',
        'ndjson-json': '"a": 1',
        'frontmatter-json': '"content"',
        'markdown-json': '"toc"',
        'srt-vtt': 'WEBVTT',
        // The comma is the whole conversion: the sample went in with a dot.
        'vtt-srt': '00:00:01,000',
        'toml-json': '"title": "toolshed"',
        'json-toml': '[owner]',
        'xml-json': '"@_id"',
        'html-text': 'Title\n\nSome text.',
        'html-json': '"columns"',
      };
      assert.ok(EXAMPLE_MARK[id], `${id} has no EXAMPLE_MARK — add one rather than passing vacuously`);
      assert.equal(typeof bazaar.info.output.example, 'string');
      assert.ok(
        bazaar.info.output.example.includes(EXAMPLE_MARK[id]),
        `${id} output example does not look converted: ${JSON.stringify(bazaar.info.output.example.slice(0, 60))}`
      );

      // The facilitator rejects a description past 500 characters at LISTING
      // time, not at call time, so a long string is invisible until discovery
      // silently stops working.
      for (const [where, text] of [
        ['resource.description', env.resource.description],
        ['bazaar.schema input.body.description', bazaar.schema.properties.input.properties.body.description],
        ['bazaar.schema output.format.description', bazaar.schema.properties.output.properties.format.description],
      ]) {
        assert.ok(text.length <= 500, `${id} ${where} is ${text.length} chars, over the 500 limit`);
      }
    }
  });

  test('the bazaar schema actually validates the bazaar info it is published with', async (t) => {
    // The bazaar spec makes this a facilitator's job: it MUST validate `info`
    // against `schema` before cataloguing. A schema that does not admit its own
    // info is therefore a silent delisting — everything looks right, nothing
    // gets indexed, and no error is reported anywhere. So it is checked here
    // with a real JSON Schema validator rather than by reading the two.
    let Ajv2020;
    try {
      ({ default: Ajv2020 } = await import('ajv/dist/2020.js'));
    } catch {
      return t.skip('ajv not installed (npm install)');
    }
    const ajv = new Ajv2020({ strict: false });

    for (const [id, tool] of Object.entries(TOOLS)) {
      const res = await api.convert(id, tool.input, { ip: ips.next(), ua: 'x402-suite/1' });
      assert.equal(res.status, 402, `${id} answered ${res.status}: ${res.text}`);
      const { info, schema } = v2Envelope(res).extensions.bazaar;

      const validate = ajv.compile(schema);
      assert.ok(validate(info), `${id}: info fails its own schema — ${ajv.errorsText(validate.errors)}`);

      // …and the schema has to have teeth. A permissive one would pass the
      // line above while proving nothing, so a deliberately wrong info must
      // fail it.
      const wrong = { ...info, input: { ...info.input, method: 'GET' } };
      assert.equal(validate(wrong), false, `${id}: the schema accepts a GET input — it is not constraining`);
    }
  });

  test('a rejected payment answers with the v2 error code as well as the v1 reason', async () => {
    // No facilitator in this phase, so the reachable rejection is the one that
    // never gets that far: an undecodable payment header.
    const ip = ips.pinned(11);
    const res = await api.convert('md-html', '# hi\n', { ip, headers: { 'x-payment': 'not-base64-!!' } });
    assert.equal(res.status, 402);
    assert.equal(res.json().invalidReason, 'malformed_payment_header');
    // v2 has one error field and it carries the code, so a v2 client sees the
    // same fact the v1 body's invalidReason carries.
    assert.equal(v2Envelope(res).error, 'malformed_payment_header');
  });

  test('a v2 payment header is recognised as a payment', async () => {
    // PAYMENT-SIGNATURE is v2's X-PAYMENT. A worker that only looks at the old
    // name answers 402 to a paying v2 client forever, which is the exact
    // failure this dual-stack change exists to prevent — and it looks identical
    // to "the client did not pay".
    const ip = ips.pinned(12);
    const res = await api.convert('md-html', '# hi\n', {
      ip,
      headers: { 'payment-signature': Buffer.from(JSON.stringify({ x402Version: 2 })).toString('base64') },
    });
    // This phase has no CDP credentials, so the honest answer to a payment we
    // cannot check is the conversion plus `facilitator-unconfigured` — the same
    // availability-first answer a v1 payment gets above. What matters is that
    // it is NOT the 402: the header was seen.
    assert.equal(res.status, 200, `a v2 payment header was ignored: ${res.status} ${res.text}`);
    assert.equal(res.headers.get('x-payment-verified'), 'false');
    assert.equal(res.headers.get('x-payment-error'), 'facilitator-unconfigured');
  });

  test('the 402 is not cacheable — an envelope is per-request', async () => {
    const res = await api.convert('md-html', '# hi\n', { ip: ips.pinned(13), ua: 'x402-suite/1' });
    assert.equal(res.status, 402);
    assert.equal(res.headers.get('cache-control'), 'no-store');
  });
});
