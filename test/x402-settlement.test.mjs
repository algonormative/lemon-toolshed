// Real payment verification and settlement, against a mock CDP facilitator.
//
// This suite is the one that proves the paid path is a PAYMENT path rather than
// a header check. It boots its own Worker — PAYTO set, structurally real (and
// worthless) CDP credentials, FACILITATOR_URL pointing at an http server this
// file runs — so every assertion is about what the Worker actually sent and what
// it did with the answer.
//
// Three things are worth knowing before reading further.
//
// 1. THE MOCK IS IN-PROCESS. It is programmable per test (`mock.verify = …`)
//    and it records every hit, which is what makes the negative assertions
//    possible: "the facilitator was not called" is `mock.hits.length === 0`,
//    not an inference from a header.
//
// 2. THE JWT IS REAL. The Worker signs an Ed25519 CDP bearer token with
//    WebCrypto inside workerd; the mock structure-checks the header and claims.
//    It deliberately does NOT verify the signature — that would be testing
//    Ed25519, not the Worker — but a Worker that failed to sign would produce no
//    Authorization header at all, and these assertions would catch it.
//
// 3. SETTLEMENT IS ASYNCHRONOUS. It runs in ctx.waitUntil AFTER the response, so
//    the ledger assertions poll (`awaitSettlement`) instead of reading once.
//
// 4. THE MOCK IS STRICT ABOUT VERSION SHAPE (added 2026-08-19 with dual-stack).
//    v1 and v2 send the same three-field body to the same endpoint and differ
//    entirely in the shapes inside it, so a Worker that shipped a v1 envelope
//    alongside a v2 payload — or the reverse — would look completely healthy
//    here against a mock that only echoes canned answers, and would verify as
//    invalid against the real facilitator, which recovers the signature from
//    what it is handed. So every hit is shape-checked against its own declared
//    version and a mismatch answers 400, which surfaces as an unverified serve
//    and fails whatever test made the call. Drift is meant to be loud.
//
//    The mock itself moved to test/mock-facilitator.mjs on 2026-08-31, unchanged,
//    so the Solana suite can drive the same upstream with the same strictness.

import test, { before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  bootWorker,
  client,
  callers,
  fakeCdpCredentials,
  isSqlNull,
  PAYTO_TEST,
  PAID_DAILY,
  SITE_BASE,
} from './harness.mjs';
import { startMockFacilitator, shapeProblem, VERIFIED_PAYER, TX_HASH } from './mock-facilitator.mjs';

const ips = callers('settlement');

// The payer a caller CLAIMS in its payload, as opposed to the one the
// facilitator reports back. Keeping them different is what lets the ledger
// assertions prove which of the two was recorded.
const CLAIMED_PAYER = '0x000000000000000000000000000000000000Bad1';

let worker;
let api;
let mock;

// USDC on Base — the asset both envelopes name, in the one spelling it has.
const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

// ------------------------------------------------------------------ helpers

/**
 * A well-formed x402 v1 `exact` payment payload, base64-encoded as X-PAYMENT.
 *
 * The signature is nonsense — the mock decides valid from invalid, so a real one
 * would prove nothing and would need a funded key. The SHAPE is real, because
 * the Worker reads `payload.authorization.from` out of it.
 */
// The default `value` is md-html's $0.004; the mocked facilitator never cross-checks it
// carries. It is typed rather than read off the envelope because these payloads
// are deliberately hand-built — see paymentHeaderV2 for the version that is not.
function paymentHeader({ from = CLAIMED_PAYER, value = '4000' } = {}) { // default matches md-html; $0.002 tools under a mock facilitator are not cross-checked
  const now = Math.floor(Date.now() / 1000);
  return Buffer.from(
    JSON.stringify({
      x402Version: 1,
      scheme: 'exact',
      network: 'base',
      payload: {
        signature: `0x${'ab'.repeat(65)}`,
        authorization: {
          from,
          to: PAYTO_TEST,
          value,
          validAfter: String(now - 600),
          validBefore: String(now + 60),
          nonce: `0x${'cd'.repeat(32)}`,
        },
      },
    })
  ).toString('base64');
}

/** The v2 envelope this Worker publishes for a tool, read off its own 402. */
async function v2EnvelopeFor(apiClient, tool, ip) {
  const probe = await apiClient.convert(tool, 'probe', { ip, ua: 'settlement-suite/1' });
  assert.equal(probe.status, 402, `${tool} did not answer the 402 front door: ${probe.status} ${probe.text}`);
  const header = probe.headers.get('payment-required');
  assert.ok(header, `${tool} published no v2 envelope`);
  return JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
}

/**
 * A well-formed x402 v2 payment, base64-encoded as PAYMENT-SIGNATURE.
 *
 * Built FROM the Worker's own 402 rather than typed out here, which is what a
 * real client does and is the only version that stays true: `accepted` has to
 * be the accepts entry we advertised, byte for byte, or the signature was made
 * over something else. The signature itself is nonsense — the mock decides
 * valid from invalid — but the shape around it is the client's.
 */
async function paymentHeaderV2(apiClient, tool, { ip, from = CLAIMED_PAYER } = {}) {
  const env = await v2EnvelopeFor(apiClient, tool, ip);
  const accepted = env.accepts[0];
  const now = Math.floor(Date.now() / 1000);
  return Buffer.from(
    JSON.stringify({
      x402Version: 2,
      resource: env.resource,
      accepted,
      payload: {
        signature: `0x${'ab'.repeat(65)}`,
        authorization: {
          from,
          to: accepted.payTo,
          value: accepted.amount,
          validAfter: String(now - 600),
          validBefore: String(now + accepted.maxTimeoutSeconds),
          nonce: `0x${'cd'.repeat(32)}`,
        },
      },
      // A v2 client echoes the server's extensions back, and the bazaar spec
      // says cataloguing never happens if it does not.
      extensions: env.extensions,
    })
  ).toString('base64');
}

const settlements = () =>
  worker.d1('SELECT ts, tool, payer, amount, verify_ok, settle_ok, tx_hash, error FROM settlements ORDER BY ts, rowid;');

/** Settlement runs in ctx.waitUntil, so the ledger is polled rather than read. */
async function awaitSettlement(predicate, what, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let rows = [];
  for (;;) {
    rows = await settlements();
    const hit = rows.find(predicate);
    if (hit) return hit;
    if (Date.now() > deadline) {
      throw new Error(`no settlements row matching ${what} within ${timeoutMs} ms; saw ${JSON.stringify(rows)}`);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

/**
 * Conversions claimed today by ONE caller.
 *
 * The quota row is keyed on `hash(daily salt + ip)`, and the test can rebuild
 * that key exactly — read the day's salt out of D1 and hash it the same way the
 * Worker does. That makes the ceiling assertions about a specific caller rather
 * than about whichever row happens to be largest.
 */
async function usedBy(ip) {
  const [salt] = await worker.d1("SELECT value FROM salt WHERE key = 'current';");
  const ipHash = createHash('sha256')
    .update(`${salt.value}${ip}`)
    .digest('hex')
    .slice(0, 16);
  const rows = await worker.d1(`SELECT used FROM convert_quota WHERE ip_hash = '${ipHash}';`);
  return rows.length ? rows[0].used : 0;
}

// ------------------------------------------------------------------ lifecycle

before(async () => {
  mock = await startMockFacilitator();
  worker = await bootWorker({
    vars: { PAYTO: PAYTO_TEST, FACILITATOR_URL: mock.url, ...fakeCdpCredentials() },
  });
  api = client(worker);
});

after(async () => {
  await worker?.stop();
  await mock?.stop();
});

// ------------------------------------------------------------------ tests

describe('an unpaid call never reaches the facilitator', () => {
  // This describe used to prove "the free tier is not a payment path". The tier
  // is gone; the negative it was really protecting is not, and it is cheaper to
  // state now: with no X-PAYMENT there is nothing to verify, so the facilitator
  // must not be called AT ALL. Zero hits is the assertion — not a header.
  test('no X-PAYMENT means no verify, no settle, and no ledger row', async () => {
    mock.reset();
    const ip = ips.pinned(1);

    const res = await api.convert('md-html', '# hi\n', { ip, ua: 'settlement-suite/1' });

    assert.equal(res.status, 402, `expected the 402 front door, got ${res.status}: ${res.text}`);
    assert.ok(!res.text.includes('<h1>'), 'a 402 returned the conversion anyway');
    assert.equal(mock.hits.length, 0, `the facilitator was called with no payment: ${JSON.stringify(mock.hits)}`);

    const rows = await settlements();
    assert.equal(rows.length, 0, `an unpaid call wrote a settlements row: ${JSON.stringify(rows)}`);
  });
});

describe('verify says yes', () => {
  test('the conversion is served, marked verified, and settles afterwards', async () => {
    mock.reset();
    const ip = ips.pinned(2);

    const res = await api.convert('md-html', '# hi\n', {
      ip,
      ua: 'settlement-suite/1',
      headers: { 'x-payment': paymentHeader() },
    });

    assert.equal(res.status, 200, `expected 200 for a verified payment, got ${res.status}: ${res.text}`);
    assert.ok(res.text.includes('<h1>hi</h1>'), 'the conversion did not run');
    assert.equal(res.headers.get('x-payment-verified'), 'true');
    assert.equal(res.headers.get('x-payment-error'), null, 'a verified call reported a payment error');
    assert.equal(res.headers.get('x-pricing'), null, 'a verified call was still labelled pricing-pending');
    assert.equal(res.headers.get('x-free-tier-remaining'), null, 'a paid call reported free-tier remaining');

    const verified = await awaitSettlement((r) => r.verify_ok === 1 && r.settle_ok === 1, 'a settled payment');
    assert.equal(verified.tool, 'md-html');
    assert.equal(verified.amount, '4000', '$0.005 in USDC atomic units');
    assert.equal(verified.tx_hash, TX_HASH, 'the settlement hash did not come from the facilitator');
    // The FACILITATOR's payer, not the one the caller claimed in its payload.
    assert.equal(verified.payer, VERIFIED_PAYER);
    assert.ok(isSqlNull(verified.error), `a clean settlement recorded an error: ${verified.error}`);
  });

  test('verify and settle are both called, with our envelope as paymentRequirements', async () => {
    mock.reset();
    const ip = ips.pinned(3);
    const res = await api.convert('csv-json', 'a\n1\n', {
      ip,
      ua: 'settlement-suite/1',
      headers: { 'x-payment': paymentHeader() },
    });
    assert.equal(res.status, 200, res.text);
    await awaitSettlement((r) => r.tool === 'csv-json' && r.settle_ok === 1, 'the csv-json settlement');

    const verify = mock.hitsOn('verify');
    const settle = mock.hitsOn('settle');
    assert.equal(verify.length, 1, `expected exactly one verify, saw ${verify.length}`);
    assert.equal(settle.length, 1, `expected exactly one settle, saw ${settle.length}`);

    for (const hit of [verify[0], settle[0]]) {
      assert.equal(hit.method, 'POST');
      assert.match(hit.contentType, /application\/json/);
      assert.equal(hit.body.x402Version, 1);
      assert.equal(hit.body.paymentPayload.scheme, 'exact');
      assert.equal(hit.body.paymentPayload.payload.authorization.from, CLAIMED_PAYER);

      // The requirements sent to the facilitator MUST be the envelope the
      // client signed against. Any drift here verifies as invalid in
      // production, so it is asserted field for field.
      assert.deepEqual(hit.body.paymentRequirements, {
        scheme: 'exact',
        network: 'base',
        maxAmountRequired: '2000',
        resource: `${SITE_BASE}/convert/csv-json`,
        description: 'CSV to JSON conversion',
        mimeType: 'application/json',
        payTo: PAYTO_TEST,
        maxTimeoutSeconds: 60,
        asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        // USDC on Base names itself "USD Coin"; omitting this makes every real
        // payment fail signature verification.
        extra: { name: 'USD Coin', version: '2' },
        // The Bazaar-facing half. It travels to the facilitator too, because
        // the envelope is built once and used for both — which is the invariant
        // this deepEqual exists to hold.
        outputSchema: {
          input: {
            type: 'http',
            method: 'POST',
            discoverable: true,
            bodyType: 'text',
            description: 'the raw CSV file as the request body, up to 256 KB',
          },
          output: {
            type: 'string',
            description: 'the converted JSON file as the response body (application/json)',
          },
        },
      });
    }
  });

  test('the request carries a CDP bearer JWT bound to the endpoint it calls', async () => {
    mock.reset();
    const ip = ips.pinned(4);
    const res = await api.convert('md-html', '# hi\n', {
      ip,
      ua: 'settlement-suite/1',
      headers: { 'x-payment': paymentHeader() },
    });
    assert.equal(res.status, 200, res.text);
    await awaitSettlement((r) => r.settle_ok === 1, 'a settled payment');

    for (const hit of [mock.hitsOn('verify')[0], mock.hitsOn('settle')[0]]) {
      assert.ok(hit.authorization, `${hit.endpoint} was called with no Authorization header`);
      assert.match(hit.authorization, /^Bearer /, `${hit.endpoint} did not send a Bearer token`);

      const token = hit.authorization.slice('Bearer '.length);
      const parts = token.split('.');
      assert.equal(parts.length, 3, `${hit.endpoint} token is not a three-part JWS: ${token.slice(0, 40)}…`);

      const b64url = (s) => JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));
      const header = b64url(parts[0]);
      const claims = b64url(parts[1]);

      // Structure only. The signature is NOT validated here — that would be a
      // test of Ed25519 rather than of this Worker — but it must be present and
      // the right length for an EdDSA JWS.
      assert.equal(header.alg, 'EdDSA', `${hit.endpoint} signed with ${header.alg}, not EdDSA`);
      assert.equal(header.typ, 'JWT');
      assert.ok(header.kid, 'no kid in the JWT header');
      assert.match(header.nonce, /^[0-9a-f]{32}$/, 'no 16-byte hex nonce in the JWT header');
      assert.equal(Buffer.from(parts[2], 'base64url').length, 64, 'not a 64-byte Ed25519 signature');

      assert.equal(claims.iss, 'cdp');
      assert.equal(claims.sub, header.kid);
      // The token is scoped to one call: a /verify token cannot be replayed at
      // /settle, which is why `uris` is asserted per endpoint.
      assert.deepEqual(claims.uris, [`POST ${new URL(mock.url).host}/platform/v2/x402/${hit.endpoint}`]);
      assert.ok(claims.exp > claims.nbf, 'the JWT does not expire after it starts');
      assert.equal(claims.exp - claims.nbf, 120, 'CDP bearer tokens are 120 s');
    }
  });
});

describe('the buyer is charged only for a conversion that was served', () => {
  // THE PAYMENT-FAIRNESS REGRESSION. With a free tier, most malformed input was
  // absorbed for nothing; with every call paid, a 400 that also billed would be
  // the worst thing this service could do. The protection is ORDERING — settle
  // is queued only after the conversion succeeds — and ordering is exactly what
  // a later refactor breaks silently, because the response looks identical
  // either way. So the assertion is on the FACILITATOR, not on the response:
  // verify called, settle not.
  // The ledger is append-only and shared by every test in this file, so these
  // two measure the DELTA they caused rather than scanning the whole table.
  // Written as a delta on purpose: a whole-table assertion here passed or failed
  // on which tests ran first, which is the kind of green that means nothing.
  const ledgerSize = async () => (await settlements()).length;

  test('malformed input with a valid payment is a 400, verified but never settled', async () => {
    mock.reset();
    const ip = ips.pinned(14);
    const before = await ledgerSize();

    const res = await api.convert('csv-json', 'a,b\n"unterminated', {
      ip,
      ua: 'settlement-suite/1',
      headers: { 'x-payment': paymentHeader() },
    });

    assert.equal(res.status, 400, `expected 400 for malformed input, got ${res.status}: ${res.text}`);
    assert.match(res.json().error, /unterminated quoted field/, 'the 400 does not say what was wrong');

    // The payment WAS checked — it had to be, to get this far.
    assert.equal(mock.hitsOn('verify').length, 1, 'the payment was not verified before the attempt');
    // …and it was never settled. A verified-but-unsettled EIP-3009
    // authorization moves nothing: nobody submits it, so no transfer happens
    // and the buyer keeps its money. THIS is the assertion that matters.
    assert.equal(mock.hitsOn('settle').length, 0, 'THE BUYER WAS CHARGED FOR A 400');

    // Settlement is asynchronous, so give a queued settle time to be WRONG
    // before believing it was right. Reading once, immediately, would also pass
    // against a Worker that settles in ctx.waitUntil after sending the 400.
    await new Promise((r) => setTimeout(r, 1_500));
    assert.equal(mock.hitsOn('settle').length, 0, 'a settle was queued after the 400 response');
    assert.equal(await ledgerSize(), before, 'a 400 wrote a settlements row');
  });

  test('the same tool settles once the input is valid', async () => {
    // The positive control for the test above. Without it, "settle was not
    // called" would also pass against a Worker where settlement had stopped
    // working altogether — a green test proving the opposite of what it claims.
    mock.reset();
    const ip = ips.pinned(15);
    const before = await ledgerSize();

    const res = await api.convert('csv-json', 'a\n1\n', {
      ip,
      ua: 'settlement-suite/1',
      headers: { 'x-payment': paymentHeader() },
    });

    assert.equal(res.status, 200, res.text);
    assert.equal(res.headers.get('x-payment-verified'), 'true');
    assert.equal(mock.hitsOn('settle').length, 1, 'a served conversion did not settle');

    // Poll for the row this call added, by count: predicating on tool alone
    // would match a row an earlier test wrote and prove nothing about this one.
    const deadline = Date.now() + 15_000;
    let size = await ledgerSize();
    while (size === before && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 250));
      size = await ledgerSize();
    }
    assert.equal(size, before + 1, 'the served conversion wrote no settlements row');
  });
});

describe('the settle body carries the resource a listing is attached by', () => {
  test('resource is present even when the client payload omits it', async () => {
    mock.reset();
    const ip = ips.pinned(16);

    // The premise, asserted rather than assumed: x402-fetch does not echo
    // `resource` back in its payment payload, and neither does this fixture. If
    // it did, the test below would pass without the Worker doing anything.
    const sent = JSON.parse(Buffer.from(paymentHeader(), 'base64').toString('utf8'));
    assert.equal(sent.resource, undefined, 'the fixture already carries a resource — it would prove nothing');

    const res = await api.convert('md-html', '# hi\n', {
      ip,
      ua: 'settlement-suite/1',
      headers: { 'x-payment': paymentHeader() },
    });
    assert.equal(res.status, 200, res.text);
    await awaitSettlement((r) => r.settle_ok === 1, 'the settled call');

    const settle = mock.hitsOn('settle')[0];
    assert.equal(
      settle.body.paymentPayload.resource,
      `${SITE_BASE}/convert/md-html`,
      'the settle body names no resource — the Bazaar has nothing to attach the settlement to'
    );

    // VERIFY is deliberately left alone: it is the signature check, and the
    // payload it sees stays byte-for-byte what the client sent.
    const verify = mock.hitsOn('verify')[0];
    assert.equal(verify.body.paymentPayload.resource, undefined, 'the verify payload was rewritten');
  });
});

describe('verify says no', () => {
  test('a rejected payment is 402 with the envelope and the facilitator reason', async () => {
    mock.reset();
    mock.state.verify = {
      status: 200,
      body: {
        isValid: false,
        invalidReason: 'insufficient_funds',
        invalidMessage: 'payer balance is below the required amount',
        payer: VERIFIED_PAYER,
      },
    };

    const ip = ips.pinned(5);
    const res = await api.convert('md-html', '# hi\n', {
      ip,
      ua: 'settlement-suite/1',
      headers: { 'x-payment': paymentHeader() },
    });

    assert.equal(res.status, 402, `expected 402 for a rejected payment, got ${res.status}: ${res.text}`);
    assert.ok(!res.text.includes('<h1>'), 'a rejected payment was served the conversion anyway');

    const body = res.json();
    assert.equal(body.x402Version, 1);
    // The reason is the POINT of this response: without it a client retries the
    // same broken payment forever.
    assert.equal(body.invalidReason, 'insufficient_funds');
    assert.equal(body.invalidMessage, 'payer balance is below the required amount');
    assert.equal(body.error, 'the payment presented was not accepted');
    // …and the envelope is still there, so a client can just pay again.
    assert.equal(body.accepts.length, 1);
    assert.equal(body.accepts[0].payTo, PAYTO_TEST);
    assert.equal(body.accepts[0].maxAmountRequired, '4000');
    assert.deepEqual(body.accepts[0].extra, { name: 'USD Coin', version: '2' });

    // Rejected means not settled: verify was called, settle was not.
    assert.equal(mock.hitsOn('verify').length, 1);
    assert.equal(mock.hitsOn('settle').length, 0, 'a rejected payment was settled anyway');

    const row = await awaitSettlement((r) => r.error === 'insufficient_funds', 'the rejection row');
    assert.equal(row.verify_ok, 0);
    assert.equal(row.settle_ok, 0);
    assert.ok(isSqlNull(row.tx_hash), 'a rejected payment recorded a settlement hash');
    assert.equal(row.tool, 'md-html');
  });

  test('an unverified X-PAYMENT does not unlock the paid ceiling', async () => {
    // Presenting a payment header used to buy PAID_DAILY (5,000) outright; the
    // ceiling is now claimed only after verify returns isValid, so a rejected
    // payment leaves the counter untouched — at zero, with no free tier to have
    // moved it first.
    mock.reset();
    mock.state.verify = { status: 200, body: { isValid: false, invalidReason: 'invalid_exact_evm_payload_signature' } };

    const ip = ips.pinned(6);
    const before = await usedBy(ip);
    assert.equal(before, 0, 'a caller that has never been served already holds quota');

    for (let i = 0; i < 3; i++) {
      const res = await api.convert('md-html', '# hi\n', {
        ip,
        ua: 'settlement-suite/1',
        headers: { 'x-payment': paymentHeader() },
      });
      assert.equal(res.status, 402, `rejected payment ${i + 1} answered ${res.status}`);
    }

    assert.equal(await usedBy(ip), 0, 'a rejected payment claimed quota against the paid ceiling');
  });

  test('an X-PAYMENT that is not base64 JSON is rejected without calling the facilitator', async () => {
    mock.reset();
    const ip = ips.pinned(7);
    for (const value of ['x', 'not-base64-!!', Buffer.from('[1,2,3]').toString('base64')]) {
      const res = await api.convert('md-html', '# hi\n', {
        ip,
        ua: 'settlement-suite/1',
        headers: { 'x-payment': value },
      });
      assert.equal(res.status, 402, `X-PAYMENT ${JSON.stringify(value.slice(0, 16))} answered ${res.status}`);
      assert.equal(res.json().invalidReason, 'malformed_payment_header');
    }
    // Nothing decodable to send, so nothing was sent.
    assert.equal(mock.hits.length, 0, 'a garbage header was forwarded to the facilitator');
  });
});

describe('the facilitator is unavailable', () => {
  test('a 500 on verify serves the conversion free and says it was not checked', async () => {
    mock.reset();
    mock.state.verify = { status: 500, body: { error: 'internal' } };

    const ip = ips.pinned(8);
    const res = await api.convert('md-html', '# hi\n', {
      ip,
      ua: 'settlement-suite/1',
      headers: { 'x-payment': paymentHeader() },
    });

    // Availability-first: at these prices the price is a signal, so OUR dependency's
    // outage must not turn a paying caller away.
    assert.equal(res.status, 200, `expected the conversion to be served, got ${res.status}: ${res.text}`);
    assert.ok(res.text.includes('<h1>hi</h1>'), 'the conversion did not run');
    assert.equal(res.headers.get('x-payment-verified'), 'false', 'an unchecked payment was implied to be verified');
    assert.equal(res.headers.get('x-payment-error'), 'facilitator-unreachable');
    assert.equal(res.headers.get('x-pricing'), 'pending');
    assert.equal(mock.hitsOn('settle').length, 0, 'an unverified payment was settled');

    // Recorded — an unreachable facilitator has to be visible after the fact.
    // The LEDGER keeps the precise reason; the header keeps a stable vocabulary.
    const row = await awaitSettlement((r) => r.error === 'facilitator-http-500', 'the outage row');
    assert.equal(row.verify_ok, 0);
    assert.equal(row.settle_ok, 0);
    assert.equal(row.payer, CLAIMED_PAYER, 'the claimed payer should still be recorded');
  });

  test('a verify that outruns the 2 s cap is aborted and serves free', async () => {
    mock.reset();
    mock.state.delayMs.verify = 6_000; // well past VERIFY_TIMEOUT_MS

    const ip = ips.pinned(9);
    const started = Date.now();
    const res = await api.convert('md-html', '# hi\n', {
      ip,
      ua: 'settlement-suite/1',
      headers: { 'x-payment': paymentHeader() },
    });
    const elapsed = Date.now() - started;

    assert.equal(res.status, 200, `expected the conversion to be served, got ${res.status}: ${res.text}`);
    assert.equal(res.headers.get('x-payment-verified'), 'false');
    assert.equal(res.headers.get('x-payment-error'), 'facilitator-unreachable');
    // The cap has to actually cap: the caller must not wait out the mock's 6 s.
    assert.ok(elapsed < 5_000, `the 2 s verify cap did not fire — the call took ${elapsed} ms`);

    const row = await awaitSettlement((r) => r.error === 'facilitator-timeout', 'the timeout row');
    assert.equal(row.verify_ok, 0);
    assert.equal(row.settle_ok, 0);
  });
});

describe('settlement fails after a good verify', () => {
  test('the response was already sent, and the loss is recorded as settle_ok = 0', async () => {
    mock.reset();
    mock.state.settle = {
      status: 200,
      body: { success: false, errorReason: 'unexpected_settle_error', payer: VERIFIED_PAYER },
    };

    const ip = ips.pinned(10);
    const res = await api.convert('json-yaml', '{"a":1}', {
      ip,
      ua: 'settlement-suite/1',
      headers: { 'x-payment': paymentHeader() },
    });

    // Verify passed, so the caller got what it paid for. Settlement is after
    // the fact by design; this is the accepted $0.002 exposure.
    assert.equal(res.status, 200, res.text);
    assert.equal(res.headers.get('x-payment-verified'), 'true');
    assert.ok(res.text.includes('a: 1'), 'the conversion did not run');

    const row = await awaitSettlement((r) => r.tool === 'json-yaml' && r.verify_ok === 1, 'the json-yaml row');
    assert.equal(row.settle_ok, 0, 'a failed settlement was recorded as successful');
    assert.equal(row.error, 'unexpected_settle_error');
    assert.ok(isSqlNull(row.tx_hash), 'a failed settlement recorded a transaction hash');
    assert.equal(row.amount, '2000');
  });

  test('an unreachable facilitator at settle time is recorded too', async () => {
    mock.reset();
    mock.state.settle = { status: 503, body: { error: 'unavailable' } };

    const ip = ips.pinned(11);
    const res = await api.convert('yaml-json', 'a: 1\n', {
      ip,
      ua: 'settlement-suite/1',
      headers: { 'x-payment': paymentHeader() },
    });
    assert.equal(res.status, 200, res.text);
    assert.equal(res.headers.get('x-payment-verified'), 'true');

    const row = await awaitSettlement((r) => r.tool === 'yaml-json', 'the yaml-json row');
    assert.equal(row.verify_ok, 1);
    assert.equal(row.settle_ok, 0);
    assert.equal(row.error, 'facilitator-http-503');
  });
});

describe('a real x402 client can pay the envelope we publish', () => {
  // THE POSITIVE CONTROL, and the only test here that is not talking to itself.
  //
  // Everything above builds its own X-PAYMENT header, which means it proves the
  // Worker handles the payload THIS FILE writes — not that a real client can
  // produce one. Those are different claims, and the gap between them is where
  // the `extra` bug lived: the envelope was spec-shaped, every envelope
  // assertion passed, and no genuine payment could ever have verified, because
  // x402's client reads `extra.name`/`extra.version` with no fallback and would
  // have signed over an EIP-712 domain of `undefined`.
  //
  // So this drives the actual `x402-fetch` client against the actual envelope:
  // it parses our 402, signs a real EIP-3009 authorization with a real key, and
  // we assert the Worker takes it. No funds are involved — the key is generated
  // here and the mock does not look at the chain — but the SIGNING is real, and
  // that is the half a mock cannot fake.
  test('x402-fetch parses the 402, signs, and the payment verifies', async (t) => {
    let deps;
    try {
      deps = {
        viem: await import('viem'),
        chains: await import('viem/chains'),
        accounts: await import('viem/accounts'),
        fetchWrapper: await import('x402-fetch'),
      };
    } catch {
      // devDependencies only; never fail the suite over a missing client.
      return t.skip('viem / x402-fetch not installed (npm install)');
    }

    const clientMock = await startMockFacilitator();
    // A REAL EVM address, not PAYTO_TEST: the client validates the envelope
    // with zod, and '0xTEST…' is not a 20-byte hex address. Worth knowing —
    // the shared test address is fine for shape assertions and unusable by an
    // actual client.
    const payTo = '0x1234567890123456789012345678901234567890';
    const scratch = await bootWorker({
      vars: { PAYTO: payTo, FACILITATOR_URL: clientMock.url, ...fakeCdpCredentials() },
    });

    try {
      const url = `${scratch.baseUrl}/convert/md-html`;
      const ip = ips.pinned(13);

      // Nothing to burn through: the first call this client makes is the 402
      // it has to parse, which is the point of the exercise.
      const account = deps.accounts.privateKeyToAccount(deps.accounts.generatePrivateKey());
      const wallet = deps.viem.createWalletClient({
        account,
        chain: deps.chains.base,
        transport: deps.viem.http(),
      });
      // maxValue 10,000 atomic units = $0.01, above every tool price.
      const payingFetch = deps.fetchWrapper.wrapFetchWithPayment(fetch, wallet, BigInt(10_000));

      const res = await payingFetch(url, {
        method: 'POST',
        body: '# x402\n',
        headers: { 'cf-connecting-ip': ip },
      });
      const text = await res.text();

      assert.equal(res.status, 200, `a real x402 client could not pay: ${res.status} ${text}`);
      assert.equal(res.headers.get('x-payment-verified'), 'true');
      assert.ok(text.includes('<h1>x402</h1>'), 'the conversion did not run');

      // What the client actually signed, as the facilitator saw it.
      const sent = clientMock.hitsOn('verify')[0];
      assert.ok(sent, 'the client paid but the facilitator was never asked');
      assert.equal(sent.body.paymentPayload.x402Version, 1);
      assert.equal(sent.body.paymentPayload.scheme, 'exact');
      assert.equal(sent.body.paymentPayload.payload.authorization.from, account.address);
      assert.equal(sent.body.paymentPayload.payload.authorization.to, payTo);
      assert.equal(sent.body.paymentPayload.payload.authorization.value, '4000');
      // A real 65-byte secp256k1 signature: 0x + 130 hex chars.
      assert.match(sent.body.paymentPayload.payload.signature, /^0x[0-9a-f]{130}$/i);
      // …and it was signed against OUR domain, unchanged in transit.
      assert.deepEqual(sent.body.paymentRequirements.extra, { name: 'USD Coin', version: '2' });
    } finally {
      await scratch.stop();
      await clientMock.stop();
    }
  });
});

// ------------------------------------------------------------------ x402 v2
//
// Same facilitator, same two endpoints, same three-field body — and entirely
// different shapes inside it. The mock's strictness (note 4 at the top) is what
// turns that into a testable claim rather than a hope: these tests would pass
// against a Worker that sent v1 requirements with a v2 payload, if nobody
// looked.

describe('a v2 payment is verified and settled in v2 shape', () => {
  test('PAYMENT-SIGNATURE is accepted, and both facilitator calls declare v2', async () => {
    mock.reset();
    const ip = ips.pinned(17);
    const header = await paymentHeaderV2(api, 'md-html', { ip });

    const res = await api.convert('md-html', '# hi\n', {
      ip,
      ua: 'settlement-suite/1',
      headers: { 'payment-signature': header },
    });

    assert.equal(res.status, 200, `a v2 payment was not accepted: ${res.status} ${res.text}`);
    assert.ok(res.text.includes('<h1>hi</h1>'), 'the conversion did not run');
    assert.equal(res.headers.get('x-payment-verified'), 'true');

    await awaitSettlement((r) => r.verify_ok === 1 && r.settle_ok === 1, 'the v2 settlement');

    const verify = mock.hitsOn('verify');
    const settle = mock.hitsOn('settle');
    assert.equal(verify.length, 1, `expected exactly one verify, saw ${verify.length}`);
    assert.equal(settle.length, 1, `expected exactly one settle, saw ${settle.length}`);
    assert.equal(mock.problems(), '', 'the facilitator was sent a mixed-version body');

    for (const hit of [verify[0], settle[0]]) {
      assert.equal(hit.body.x402Version, 2, `${hit.endpoint} declared the wrong version`);
      assert.equal(hit.body.paymentPayload.x402Version, 2);

      // The v2 requirements: renamed, re-networked, and stripped of everything
      // v2 moved onto the resource object.
      assert.deepEqual(hit.body.paymentRequirements, {
        scheme: 'exact',
        network: 'eip155:8453',
        amount: '4000',
        asset: USDC_BASE,
        payTo: PAYTO_TEST,
        maxTimeoutSeconds: 60,
        extra: { name: 'USD Coin', version: '2' },
      });
    }

    // …and the settle body still names the resource a Bazaar listing attaches
    // to — as the v2 OBJECT, not the v1 URL string.
    const resource = settle[0].body.paymentPayload.resource;
    assert.equal(resource.url, `${SITE_BASE}/convert/md-html`);
    assert.equal(resource.serviceName, 'Toolshed');
  });

  test('a v2 settle body gets our resource even when the client omits it', async () => {
    // The v2 twin of the v1 test above. @x402/core's client does echo
    // `resource`, but a hand-rolled one need not, and a settlement with nothing
    // to attach to is a settlement the index cannot see.
    mock.reset();
    const ip = ips.pinned(18);
    const full = JSON.parse(Buffer.from(await paymentHeaderV2(api, 'csv-json', { ip }), 'base64').toString('utf8'));
    const { resource, ...stripped } = full;
    assert.ok(resource, 'the fixture never carried a resource — this would prove nothing');

    const res = await api.convert('csv-json', 'a\n1\n', {
      ip,
      ua: 'settlement-suite/1',
      headers: { 'payment-signature': Buffer.from(JSON.stringify(stripped)).toString('base64') },
    });
    assert.equal(res.status, 200, res.text);
    await awaitSettlement((r) => r.tool === 'csv-json' && r.settle_ok === 1, 'the csv-json v2 settlement');

    assert.equal(mock.problems(), '');
    assert.deepEqual(
      mock.hitsOn('settle')[0].body.paymentPayload.resource,
      resource,
      'the settle body names no resource — the Bazaar has nothing to attach the settlement to'
    );
    // VERIFY stays byte-for-byte what arrived: it is the signature check.
    assert.equal(mock.hitsOn('verify')[0].body.paymentPayload.resource, undefined);
  });

  test('the version comes from the payload, not from the header it arrived in', async () => {
    // Both directions, because both are real: a v2 payload can turn up under
    // the old header name, and a v1 client is never going to learn the new one.
    // Routing on the header would send the facilitator the wrong shape in
    // exactly the case where a payment is otherwise good.
    mock.reset();
    const ip = ips.pinned(19);

    const res = await api.convert('md-html', '# hi\n', {
      ip,
      ua: 'settlement-suite/1',
      headers: { 'x-payment': await paymentHeaderV2(api, 'md-html', { ip }) },
    });
    assert.equal(res.status, 200, res.text);
    assert.equal(res.headers.get('x-payment-verified'), 'true');
    assert.equal(mock.hitsOn('verify')[0].body.x402Version, 2, 'a v2 payload under X-PAYMENT was sent as v1');
    assert.equal(mock.problems(), '');

    // …and the converse: a v1 payload is still v1, whatever else changed.
    mock.reset();
    const v1 = await api.convert('md-html', '# hi\n', {
      ip: ips.pinned(20),
      ua: 'settlement-suite/1',
      headers: { 'x-payment': paymentHeader() },
    });
    assert.equal(v1.status, 200, v1.text);
    assert.equal(mock.hitsOn('verify')[0].body.x402Version, 1);
    assert.equal(mock.problems(), '');
  });

  test('the mixed-version check has teeth', async () => {
    // A strictness nothing ever trips is indistinguishable from none, so the
    // guard is tripped on purpose: a v2 payload presented with the v1
    // requirements it did NOT sign against must be caught, not waved through.
    mock.reset();
    mock.state.strict = false; // record the complaint, do not answer 400
    const ip = ips.pinned(21);
    const v2 = JSON.parse(Buffer.from(await paymentHeaderV2(api, 'md-html', { ip }), 'base64').toString('utf8'));

    assert.ok(
      shapeProblem({ x402Version: 2, paymentPayload: v2, paymentRequirements: { ...v2.accepted, amount: '9999' } }),
      'requirements that name a different price passed the shape check'
    );
    assert.ok(
      shapeProblem({
        x402Version: 2,
        paymentPayload: v2,
        paymentRequirements: { ...v2.accepted, maxAmountRequired: '4000' },
      }),
      'a v1 field smuggled into v2 requirements passed the shape check'
    );
    assert.ok(
      shapeProblem({ x402Version: 1, paymentPayload: v2, paymentRequirements: v2.accepted }),
      'a v2 payload declared as v1 passed the shape check'
    );
    // …and the shape the Worker actually sends passes it.
    assert.equal(
      shapeProblem({ x402Version: 2, paymentPayload: v2, paymentRequirements: v2.accepted }),
      null,
      'the check rejects the very shape this Worker sends'
    );
  });

  test('every tool advertises an example body that actually converts', async () => {
    // extensions.bazaar.info.input.body is published as a WORKED EXAMPLE of the
    // call — the one thing in the envelope an agent is most likely to copy
    // verbatim. So it is copied verbatim here, paid for, and required to come
    // back 200. An example that 400s is worse than no example.
    mock.reset();
    for (const tool of ['md-html', 'json-yaml', 'yaml-json', 'csv-json', 'html-markdown']) {
      const ip = ips.next();
      const env = await v2EnvelopeFor(api, tool, ip);
      const sample = env.extensions.bazaar.info.input.body;

      const res = await api.convert(tool, sample, {
        ip,
        ua: 'settlement-suite/1',
        headers: { 'payment-signature': await paymentHeaderV2(api, tool, { ip }) },
      });
      assert.equal(res.status, 200, `${tool} cannot convert its own published example: ${res.status} ${res.text}`);
      assert.ok(res.text.trim().length > 0, `${tool} converted its example to nothing`);
    }
    assert.equal(mock.problems(), '');
  });
});

describe('a real x402 v2 client can pay the envelope we publish', () => {
  // THE V2 POSITIVE CONTROL, and it is the same argument as the v1 one below
  // it: every test above builds its own payload, so it proves the Worker
  // handles what THIS FILE writes. Only a real client proves the envelope is
  // payable — and the v2 envelope is the one with no track record at all, since
  // the payment that has actually settled on this rail was v1.
  //
  // This drives @x402/fetch 2.23.0 with @x402/evm's ExactEvmScheme, the same
  // pair that paid a live third-party v2 seller on 2026-08-19. It reads our
  // PAYMENT-REQUIRED header, picks our accepts entry, signs a real EIP-3009
  // authorization over the EIP-712 domain in `extra`, and sends it back as
  // PAYMENT-SIGNATURE. No funds move — the key is generated here and the mock
  // does not look at a chain — but the parsing and the signing are real, and
  // those are the halves a mock cannot fake.
  test('@x402/fetch reads PAYMENT-REQUIRED, signs, and the payment verifies', async (t) => {
    let deps;
    try {
      deps = {
        accounts: await import('viem/accounts'),
        fetchWrapper: await import('@x402/fetch'),
        evm: await import('@x402/evm'),
      };
    } catch {
      // devDependencies only; never fail the suite over a missing client.
      return t.skip('@x402/fetch / @x402/evm not installed (npm install)');
    }

    const clientMock = await startMockFacilitator();
    // A REAL EVM address: the client checks it, and PAYTO_TEST is not 20 bytes.
    const payTo = '0x1234567890123456789012345678901234567890';
    const scratch = await bootWorker({
      vars: { PAYTO: payTo, FACILITATOR_URL: clientMock.url, ...fakeCdpCredentials() },
    });

    try {
      const account = deps.accounts.privateKeyToAccount(deps.accounts.generatePrivateKey());
      const payingFetch = deps.fetchWrapper.wrapFetchWithPaymentFromConfig(fetch, {
        // CAIP-2 only. This client has no v1 scheme registered at all, so if it
        // fell back to the 402's v1 BODY it would throw "No client registered
        // for x402 version: 1" — which makes the run itself the proof that the
        // header is what it read.
        schemes: [{ network: 'eip155:8453', client: new deps.evm.ExactEvmScheme(account) }],
      });

      const res = await payingFetch(`${scratch.baseUrl}/convert/md-html`, {
        method: 'POST',
        body: '# x402 v2\n',
        headers: { 'cf-connecting-ip': ips.pinned(22) },
      });
      const text = await res.text();

      assert.equal(res.status, 200, `a real x402 v2 client could not pay: ${res.status} ${text}`);
      assert.equal(res.headers.get('x-payment-verified'), 'true');
      assert.ok(text.includes('<h1>x402 v2</h1>'), 'the conversion did not run');
      assert.equal(clientMock.problems(), '', 'the facilitator was sent a mixed-version body');

      const sent = clientMock.hitsOn('verify')[0];
      assert.ok(sent, 'the client paid but the facilitator was never asked');
      assert.equal(sent.body.x402Version, 2);
      assert.equal(sent.body.paymentPayload.x402Version, 2);
      // v2 payloads carry `accepted`, not a top-level scheme/network.
      assert.equal(sent.body.paymentPayload.scheme, undefined);
      assert.equal(sent.body.paymentPayload.accepted.network, 'eip155:8453');
      assert.equal(sent.body.paymentPayload.accepted.amount, '4000');
      assert.equal(sent.body.paymentPayload.payload.authorization.from, account.address);
      assert.equal(sent.body.paymentPayload.payload.authorization.to, payTo);
      assert.equal(sent.body.paymentPayload.payload.authorization.value, '4000');
      // A real 65-byte secp256k1 signature: 0x + 130 hex chars.
      assert.match(sent.body.paymentPayload.payload.signature, /^0x[0-9a-f]{130}$/i);
      // …signed over OUR EIP-712 domain, unchanged in transit.
      assert.deepEqual(sent.body.paymentRequirements.extra, { name: 'USD Coin', version: '2' });
      // …and it echoed our bazaar block back, without which nothing is catalogued.
      assert.ok(sent.body.paymentPayload.extensions?.bazaar?.info, 'the client dropped the bazaar extension');

      // NO PAYMENT-RESPONSE, and the client is fine with it. Settlement is
      // queued behind the response here, so there is no receipt to give at the
      // moment we answer, and inventing one would be the first fake thing this
      // service says. @x402/fetch reads the receipt inside a try/catch — this
      // run is the evidence that its absence costs a real client nothing.
      assert.equal(res.headers.get('payment-response'), null, 'a settlement receipt was emitted before settling');
    } finally {
      await scratch.stop();
      await clientMock.stop();
    }
  });
});

describe('the paid ceiling still bounds a verified caller', () => {
  test('past PAID_DAILY the answer is 429, not another paid call', async () => {
    // Parking the counter AT the ceiling rather than making 5,000 calls. The
    // write touches every row, so this test uses a throwaway worker — and its
    // own mock, so the shared one's hit log stays meaningful.
    const scratchMock = await startMockFacilitator();
    const scratch = await bootWorker({
      vars: { PAYTO: PAYTO_TEST, FACILITATOR_URL: scratchMock.url, ...fakeCdpCredentials() },
    });
    try {
      const scratchApi = client(scratch);
      const ip = ips.pinned(12);
      const paid = { 'x-payment': paymentHeader() };

      const first = await scratchApi.convert('md-html', '# hi\n', { ip, headers: paid });
      assert.equal(first.status, 200, first.text);

      await scratch.d1(`UPDATE convert_quota SET used = ${PAID_DAILY};`);

      const res = await scratchApi.convert('md-html', '# hi\n', { ip, headers: paid });
      assert.equal(res.status, 429, `expected 429 at the paid ceiling, got ${res.status}: ${res.text}`);
      assert.ok(!('accepts' in res.json()), 'a caller that already paid was told to pay again');
      assert.equal(res.headers.get('x-payment-verified'), 'false');
    } finally {
      await scratch.stop();
      await scratchMock.stop();
    }
  });
});
