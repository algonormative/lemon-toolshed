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

import test, { before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
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
  FREE_TIER_DAILY,
} from './harness.mjs';

const ips = callers('settlement');

// A payer address and a settlement hash the mock hands back, so the ledger
// assertions can prove the values came from the FACILITATOR rather than from
// the payload the caller sent.
const VERIFIED_PAYER = '0x00000000000000000000000000000000000Fa11e5';
const CLAIMED_PAYER = '0x000000000000000000000000000000000000Bad1';
const TX_HASH = '0xfeedfacefeedfacefeedfacefeedfacefeedfacefeedfacefeedfacefeedface';

let worker;
let api;
let mock;

// ------------------------------------------------------------------ the mock

/** A programmable stand-in for https://api.cdp.coinbase.com/platform/v2/x402. */
async function startMockFacilitator() {
  const state = {
    hits: [],
    // Defaults: everything works. Individual tests overwrite these.
    verify: { status: 200, body: { isValid: true, payer: VERIFIED_PAYER } },
    settle: {
      status: 200,
      body: { success: true, transaction: TX_HASH, network: 'base', payer: VERIFIED_PAYER },
    },
    delayMs: { verify: 0, settle: 0 },
  };

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', async () => {
      const endpoint = new URL(req.url, 'http://mock').pathname.split('/').pop();
      let body = null;
      try {
        body = JSON.parse(raw);
      } catch {
        /* recorded as null — a malformed body is itself a finding */
      }
      state.hits.push({
        endpoint,
        method: req.method,
        url: req.url,
        authorization: req.headers.authorization || null,
        contentType: req.headers['content-type'] || null,
        body,
      });

      const delay = state.delayMs[endpoint] || 0;
      if (delay) await new Promise((r) => setTimeout(r, delay));

      const canned = state[endpoint];
      if (!canned) {
        res.writeHead(404, { 'content-type': 'application/json' });
        return res.end('{"error":"no such endpoint"}');
      }
      res.writeHead(canned.status, { 'content-type': 'application/json' });
      res.end(typeof canned.body === 'string' ? canned.body : JSON.stringify(canned.body));
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  return {
    state,
    url: `http://127.0.0.1:${port}/platform/v2/x402`,
    get hits() {
      return state.hits;
    },
    hitsOn: (endpoint) => state.hits.filter((h) => h.endpoint === endpoint),
    reset: () => {
      state.hits.length = 0;
      state.verify = { status: 200, body: { isValid: true, payer: VERIFIED_PAYER } };
      state.settle = {
        status: 200,
        body: { success: true, transaction: TX_HASH, network: 'base', payer: VERIFIED_PAYER },
      };
      state.delayMs = { verify: 0, settle: 0 };
    },
    stop: () => new Promise((resolve) => server.close(resolve)),
  };
}

// ------------------------------------------------------------------ helpers

/**
 * A well-formed x402 v1 `exact` payment payload, base64-encoded as X-PAYMENT.
 *
 * The signature is nonsense — the mock decides valid from invalid, so a real one
 * would prove nothing and would need a funded key. The SHAPE is real, because
 * the Worker reads `payload.authorization.from` out of it.
 */
function paymentHeader({ from = CLAIMED_PAYER, value = '1000' } = {}) {
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

/** Spend the whole free tier for one caller, asserting it was actually free. */
async function exhaust(ip) {
  for (let call = 1; call <= FREE_TIER_DAILY; call++) {
    const res = await api.convert('md-html', '# hi\n', { ip, ua: 'settlement-suite/1' });
    assert.equal(res.status, 200, `call ${call} answered ${res.status} while spending the free tier`);
  }
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

describe('the free tier is not a payment path', () => {
  test('a within-tier call presenting X-PAYMENT never reaches the facilitator', async () => {
    mock.reset();
    const ip = ips.pinned(1);

    const res = await api.convert('md-html', '# hi\n', { ip, headers: { 'x-payment': paymentHeader() } });

    assert.equal(res.status, 200, res.text);
    assert.ok(res.text.includes('<h1>hi</h1>'), 'the conversion did not run');
    // The whole point: a caller inside the free tier is never billed, so it is
    // never verified either. Zero hits is the assertion — not a header.
    assert.equal(mock.hits.length, 0, `the facilitator was called inside the free tier: ${JSON.stringify(mock.hits)}`);
    assert.equal(res.headers.get('x-payment-verified'), 'false', 'an unchecked payment was implied to be verified');
    assert.equal(res.headers.get('x-free-tier-remaining'), String(FREE_TIER_DAILY - 1));

    const rows = await settlements();
    assert.equal(rows.length, 0, `a free-tier call wrote a settlements row: ${JSON.stringify(rows)}`);
  });
});

describe('verify says yes', () => {
  test('the conversion is served, marked verified, and settles afterwards', async () => {
    mock.reset();
    const ip = ips.pinned(2);
    await exhaust(ip);
    assert.equal(mock.hits.length, 0, 'spending the free tier called the facilitator');

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
    assert.equal(verified.amount, '1000', '$0.001 in USDC atomic units');
    assert.equal(verified.tx_hash, TX_HASH, 'the settlement hash did not come from the facilitator');
    // The FACILITATOR's payer, not the one the caller claimed in its payload.
    assert.equal(verified.payer, VERIFIED_PAYER);
    assert.ok(isSqlNull(verified.error), `a clean settlement recorded an error: ${verified.error}`);
  });

  test('verify and settle are both called, with our envelope as paymentRequirements', async () => {
    mock.reset();
    const ip = ips.pinned(3);
    await exhaust(ip);

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
        maxAmountRequired: '1000',
        resource: `${SITE_BASE}/convert/csv-json`,
        description: 'CSV to JSON conversion',
        mimeType: 'application/json',
        payTo: PAYTO_TEST,
        maxTimeoutSeconds: 60,
        asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        // USDC on Base names itself "USD Coin"; omitting this makes every real
        // payment fail signature verification.
        extra: { name: 'USD Coin', version: '2' },
      });
    }
  });

  test('the request carries a CDP bearer JWT bound to the endpoint it calls', async () => {
    mock.reset();
    const ip = ips.pinned(4);
    await exhaust(ip);
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
    await exhaust(ip);

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
    assert.equal(body.accepts[0].maxAmountRequired, '1000');
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
    // This is the behaviour change. Presenting a payment header used to buy
    // PAID_DAILY (5,000) outright; now the higher ceiling is claimed only after
    // verify returns isValid, so a rejected payment leaves the counter exactly
    // where the free tier left it.
    mock.reset();
    mock.state.verify = { status: 200, body: { isValid: false, invalidReason: 'invalid_exact_evm_payload_signature' } };

    const ip = ips.pinned(6);
    await exhaust(ip);
    const before = await usedBy(ip);
    assert.equal(before, FREE_TIER_DAILY, `the free tier did not land on ${FREE_TIER_DAILY}`);

    for (let i = 0; i < 3; i++) {
      const res = await api.convert('md-html', '# hi\n', {
        ip,
        ua: 'settlement-suite/1',
        headers: { 'x-payment': paymentHeader() },
      });
      assert.equal(res.status, 402, `rejected payment ${i + 1} answered ${res.status}`);
    }

    assert.equal(
      await usedBy(ip),
      FREE_TIER_DAILY,
      'a rejected payment claimed quota against the paid ceiling'
    );
  });

  test('an X-PAYMENT that is not base64 JSON is rejected without calling the facilitator', async () => {
    mock.reset();
    const ip = ips.pinned(7);
    await exhaust(ip);

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
    await exhaust(ip);

    const res = await api.convert('md-html', '# hi\n', {
      ip,
      ua: 'settlement-suite/1',
      headers: { 'x-payment': paymentHeader() },
    });

    // Availability-first: at $0.001 the price is a signal, so OUR dependency's
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
    await exhaust(ip);

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
    await exhaust(ip);

    const res = await api.convert('json-yaml', '{"a":1}', {
      ip,
      ua: 'settlement-suite/1',
      headers: { 'x-payment': paymentHeader() },
    });

    // Verify passed, so the caller got what it paid for. Settlement is after
    // the fact by design; this is the accepted $0.001 exposure.
    assert.equal(res.status, 200, res.text);
    assert.equal(res.headers.get('x-payment-verified'), 'true');
    assert.ok(res.text.includes('a: 1'), 'the conversion did not run');

    const row = await awaitSettlement((r) => r.tool === 'json-yaml' && r.verify_ok === 1, 'the json-yaml row');
    assert.equal(row.settle_ok, 0, 'a failed settlement was recorded as successful');
    assert.equal(row.error, 'unexpected_settle_error');
    assert.ok(isSqlNull(row.tx_hash), 'a failed settlement recorded a transaction hash');
    assert.equal(row.amount, '1000');
  });

  test('an unreachable facilitator at settle time is recorded too', async () => {
    mock.reset();
    mock.state.settle = { status: 503, body: { error: 'unavailable' } };

    const ip = ips.pinned(11);
    await exhaust(ip);

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
      const scratchApi = client(scratch);
      const url = `${scratch.baseUrl}/convert/md-html`;
      const ip = ips.pinned(13);

      for (let i = 0; i < FREE_TIER_DAILY; i++) {
        const r = await scratchApi.convert('md-html', '# x402\n', { ip });
        assert.equal(r.status, 200, `burn ${i + 1} answered ${r.status}`);
      }

      const account = deps.accounts.privateKeyToAccount(deps.accounts.generatePrivateKey());
      const wallet = deps.viem.createWalletClient({
        account,
        chain: deps.chains.base,
        transport: deps.viem.http(),
      });
      // maxValue 10,000 atomic units = $0.01, ten times the price.
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
      assert.equal(sent.body.paymentPayload.payload.authorization.value, '1000');
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
