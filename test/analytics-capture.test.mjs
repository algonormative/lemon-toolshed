// The PostHog funnel, seen from OUTSIDE a running Worker.
//
// test/analytics.test.mjs already owns worker/analytics.js itself: it imports
// the module in process, stubs `fetch`, and proves everything that is true of a
// send regardless of which route produced it. What it cannot see is the WIRING —
// whether handleConvert actually calls quoteIssued on the 402, whether
// settleAndRecord actually calls paymentSettled with the payer the facilitator
// recovered, whether the reason a call site passes survives as a
// closed-vocabulary value. Today a mistake there is caught only by wrangler's
// bundler (every phase boots the Worker, so an import typo fails loudly) and by
// a source scrape. Neither notices an event that is simply never emitted, or one
// emitted with the wrong distinct_id.
//
// So this suite boots real workers with POSTHOG_PROJECT_TOKEN set to a fake and
// POSTHOG_HOST pointed at a local http.createServer, drives one call per event
// name, and asserts on the JSON that actually came out over the wire.
//
// Four things are worth knowing before reading further.
//
// 1. THE MOCK RECORDS EVERY HIT, which is what makes "exactly one" real: the
//    count assertions are over the mock's own list, not over a header. Each test
//    resets it first, so a count is about the call that test made.
//
// 2. CAPTURES FIRE IN ctx.waitUntil, AFTER the response — so every positive
//    assertion polls (`awaitCapture`) and every count waits (`settleFor`) before
//    it is taken. Reading once, immediately, would also pass against a Worker
//    that captured the same event four more times a moment later.
//
// 3. THE DISTINCT ID IS RECOMPUTED HERE, not pattern-matched. analytics.js
//    derives `edge-<16 hex>` as SHA-256(`${token}:${ip}`) truncated to 8 bytes,
//    and this file does the same sum with node:crypto — so a build that changed
//    the salt, the truncation or the input would fail rather than still look
//    like an edge id. Where a payment was presented the id is the PAYER address
//    instead, and that half is asserted exactly too.
//
// 4. OFFLINE. The mock PostHog and the mock facilitator are the only hosts
//    reached; both listen on 127.0.0.1 on an ephemeral port, and the harness
//    boots every worker with an empty --env-file so no real credential exists to
//    leak. The last test asserts the first half of that over every request the
//    mock saw across the whole file. (AF-06: nothing here reaches PostHog, CDP,
//    or any billed service.)

import test, { before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import {
  bootWorker,
  client,
  fakeCdpCredentials,
  PAYTO_TEST,
  SITE_BASE,
  TIER_ON_VARS,
} from './harness.mjs';
import { startMockFacilitator, TX_HASH, VERIFIED_PAYER } from './mock-facilitator.mjs';
import { EVENTS, REFUSAL_REASONS } from '../worker/analytics.js';

// A project token shaped like PostHog's and worth nothing. It is also the SALT
// in the caller-id derivation, so it has to be the same string on both sides.
const TOKEN = 'phc_test_token_not_a_real_project';

// The ingest path analytics.js posts to, spelled out rather than imported: a
// build that moved it should fail here, not silently follow.
const INGEST_PATH = '/i/v0/e/';

// The house's own wallet, so one settlement can be flagged `house: true` against
// a stranger's `false`. The stranger is the mock facilitator's own VERIFIED_PAYER.
const HOUSE_PAYER = '0x632Ff2f904Cc6Ab6D741A42014c4C483F328E92F';

const UA = 'analytics-capture-suite/1';

// LITERAL ADDRESSES, in an octet SUITE_OCTET (harness.mjs) does not register —
// it stops at 38. This suite boots its OWN workers on their own fresh D1, so a
// convert_quota row here cannot collide with any other suite's; registering the
// octet is a follow-up, as harness.mjs is in flight in another PR.
const ip = (n) => `198.18.39.${n}`;

let posthog;
let facilitator;
let paidWorker; // production shape: no free tier, PAYTO set, mock facilitator
let freeWorker; // free tier on, so a conversion can be SERVED without a payment
let paid;
let free;

// ------------------------------------------------------------------ the mock

/** A stand-in for https://us.i.posthog.com that records every capture. */
async function startMockPostHog() {
  // `hits` is what a test asserts on and is cleared between tests; `all` is
  // never cleared, so the closing offline assertion can look at every request
  // this mock saw across the whole file.
  const state = { hits: [], all: [] };

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      let body = null;
      try {
        body = JSON.parse(raw);
      } catch {
        /* recorded as null — a malformed body is itself a finding */
      }
      const hit = {
        method: req.method,
        path: new URL(req.url, 'http://mock').pathname,
        host: req.headers.host || null,
        contentType: req.headers['content-type'] || null,
        body,
        event: body?.event ?? null,
      };
      state.hits.push(hit);
      state.all.push(hit);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"status":1}');
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    state,
    url: `http://127.0.0.1:${server.address().port}`,
    get hits() {
      return state.hits;
    },
    of: (event) => state.hits.filter((h) => h.event === event),
    reset: () => {
      state.hits.length = 0;
    },
    stop: () => new Promise((resolve) => server.close(resolve)),
  };
}

// ------------------------------------------------------------------ helpers

/** The `edge-<16 hex>` id analytics.js derives, recomputed independently. */
const edgeId = (address) =>
  `edge-${createHash('sha256').update(`${TOKEN}:${address}`).digest('hex').slice(0, 16)}`;

/** A well-formed x402 v1 payment. The signature is nonsense; the nonce is fresh. */
function paymentHeader({ from = VERIFIED_PAYER } = {}) {
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
          value: '4000',
          validAfter: String(now - 600),
          validBefore: String(now + 60),
          nonce: `0x${randomBytes(32).toString('hex')}`,
        },
      },
    })
  ).toString('base64');
}

/** Poll for a capture of `event` — the send trails the response. */
async function awaitCapture(mock, event, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const [hit] = mock.of(event);
    if (hit) return hit;
    if (Date.now() > deadline) {
      throw new Error(
        `no capture of ${JSON.stringify(event)} within ${timeoutMs} ms; saw ${JSON.stringify(mock.hits.map((h) => h.event))}`
      );
    }
    await new Promise((r) => setTimeout(r, 200));
  }
}

/** Long enough for a wrongly-queued second capture to arrive before it is counted. */
const settleFor = (ms = 1_500) => new Promise((r) => setTimeout(r, ms));

/** The envelope every capture carries, whatever produced it. */
function assertEnvelope(hit, { distinctId, house, ua = UA }) {
  assert.equal(hit.method, 'POST');
  assert.equal(hit.path, INGEST_PATH, 'the capture went to the wrong path');
  assert.match(hit.contentType, /application\/json/);
  assert.equal(hit.body.api_key, TOKEN, 'the capture carries the wrong project token');
  assert.equal(hit.body.distinct_id, distinctId, 'the caller id is not the one analytics.js documents');

  const props = hit.body.properties;
  assert.equal(typeof props.house, 'boolean', '`house` must be a boolean, never absent or a string');
  assert.equal(props.house, house);
  assert.equal(props.$raw_user_agent, ua, 'the user agent did not survive to the capture');
  assert.equal(props.$host, new URL(SITE_BASE).host, 'the capture does not name this property');
  assert.equal(props.$process_person_profile, false, 'events must stay anonymous');
}

// ------------------------------------------------------------------ lifecycle

before(async () => {
  posthog = await startMockPostHog();
  facilitator = await startMockFacilitator();

  const analytics = { POSTHOG_PROJECT_TOKEN: TOKEN, POSTHOG_HOST: posthog.url };

  paidWorker = await bootWorker({
    vars: {
      PAYTO: PAYTO_TEST,
      FACILITATOR_URL: facilitator.url,
      ...fakeCdpCredentials(),
      HOUSE_PAYERS: HOUSE_PAYER,
      ...analytics,
    },
  });
  // A SECOND WORKER, because the tier is fixed for the life of a `wrangler dev`
  // process: a free serve and an unpaid 402 cannot come out of the same one.
  freeWorker = await bootWorker({ vars: { ...TIER_ON_VARS, ...analytics } });

  paid = client(paidWorker);
  free = client(freeWorker);
});

after(async () => {
  await paidWorker?.stop();
  await freeWorker?.stop();
  await facilitator?.stop();
  await posthog?.stop();
});

// ------------------------------------------------------------------ the funnel

describe('every event in the funnel reaches PostHog from a booted worker', () => {
  test('an unpaid 402 captures one quote issued', async () => {
    posthog.reset();
    facilitator.reset();
    const caller = ip(1);

    const res = await paid.convert('md-html', '# hi\n', { ip: caller, ua: UA });
    assert.equal(res.status, 402, res.text);

    const hit = await awaitCapture(posthog, EVENTS.quoteIssued);
    // No payment was presented, so the id is the hashed-edge form — recomputed,
    // not pattern-matched.
    assertEnvelope(hit, { distinctId: edgeId(caller), house: false });
    assert.match(hit.body.distinct_id, /^edge-[0-9a-f]{16}$/, 'the unpaid id is not the documented shape');

    const props = hit.body.properties;
    assert.equal(props.endpoint, '/convert/:id');
    assert.equal(props.path, '/convert/md-html');
    assert.equal(props.tool, 'md-html');
    assert.equal(props.price_usd, 0.004, 'the quote does not carry the catalog price');

    await settleFor();
    assert.equal(posthog.hits.length, 1, `expected one capture, saw ${JSON.stringify(posthog.hits.map((h) => h.event))}`);
  });

  test('a refusal captures one call refused, with a closed-vocabulary reason', async () => {
    posthog.reset();
    facilitator.reset();
    const caller = ip(2);

    const res = await paid.convert('does-not-exist', '# hi\n', { ip: caller, ua: UA });
    assert.equal(res.status, 404, res.text);

    const hit = await awaitCapture(posthog, EVENTS.callRefused);
    assertEnvelope(hit, { distinctId: edgeId(caller), house: false });

    const props = hit.body.properties;
    assert.equal(props.reason, 'unknown-tool', 'the refusal is not named as the branch that produced it');
    assert.ok(
      REFUSAL_REASONS.includes(props.reason),
      `a reason outside the closed vocabulary reached PostHog: ${props.reason}`
    );
    assert.equal(props.status, 404);
    assert.equal(props.tool, 'does-not-exist');
    // Refused before an entry was found, so there is genuinely no price — and
    // `null` rather than absent is the contract the shared dashboards read.
    assert.equal(props.price_usd, null);

    await settleFor();
    assert.equal(posthog.hits.length, 1, `expected one capture, saw ${JSON.stringify(posthog.hits.map((h) => h.event))}`);
  });

  test('a free-tier serve captures one tool served, under the free tier', async () => {
    posthog.reset();
    const caller = ip(3);

    const res = await free.convert('md-html', '# hi\n', { ip: caller, ua: UA });
    assert.equal(res.status, 200, res.text);
    assert.ok(res.text.includes('<h1>hi</h1>'), 'the conversion did not run');

    const hit = await awaitCapture(posthog, EVENTS.toolServed);
    assertEnvelope(hit, { distinctId: edgeId(caller), house: false });

    const props = hit.body.properties;
    assert.equal(props.paid, 'free', 'a free conversion did not report the tier it went out under');
    assert.equal(props.tool, 'md-html');
    assert.equal(props.price_usd, 0.004);

    await settleFor();
    assert.equal(posthog.hits.length, 1, `expected one capture, saw ${JSON.stringify(posthog.hits.map((h) => h.event))}`);
  });

  test('a settled payment captures the served call and the settlement, keyed on the payer', async () => {
    posthog.reset();
    facilitator.reset();

    const res = await paid.convert('md-html', '# hi\n', {
      ip: ip(4),
      ua: UA,
      headers: { 'x-payment': paymentHeader() },
    });
    assert.equal(res.status, 200, res.text);
    assert.equal(res.headers.get('x-payment-verified'), 'true');
    assert.equal(facilitator.problems(), '', 'the facilitator was sent a malformed call');

    // THE PAYER ADDRESS WINS OVER THE HASHED EDGE ID whenever a payment was
    // presented — that is what joins this buyer to the rest of the estate, so
    // both events are asserted against the address the FACILITATOR recovered
    // rather than against anything the caller sent.
    const served = await awaitCapture(posthog, EVENTS.toolServed);
    assertEnvelope(served, { distinctId: VERIFIED_PAYER, house: false });
    assert.equal(served.body.properties.paid, 'paid', 'a paid conversion did not report the paid tier');

    const settled = await awaitCapture(posthog, EVENTS.paymentSettled);
    assertEnvelope(settled, { distinctId: VERIFIED_PAYER, house: false });

    const props = settled.body.properties;
    assert.equal(props.payer, VERIFIED_PAYER);
    assert.equal(props.rail, 'base', 'the settlement does not say which rail it landed on');
    assert.equal(props.tx_hash, TX_HASH, 'the settlement does not carry the facilitator transaction');
    assert.equal(props.settle_ok, true);
    assert.equal(props.tool, 'md-html');
    assert.equal(props.price_usd, 0.004);

    await settleFor();
    assert.equal(posthog.of(EVENTS.toolServed).length, 1, 'the served event was captured more than once');
    assert.equal(posthog.of(EVENTS.paymentSettled).length, 1, 'the settlement was captured more than once');
    assert.equal(posthog.hits.length, 2, `expected two captures, saw ${JSON.stringify(posthog.hits.map((h) => h.event))}`);
  });

  test("the house's own wallet settles as house: true", async () => {
    // The same path as above with one thing changed — who paid. `house` is
    // derived inside analytics.js from HOUSE_PAYERS, and it decides whether a
    // point lands in the revenue graph or in the drill bucket, so the flag has
    // to move when the payer does.
    posthog.reset();
    facilitator.reset();
    facilitator.state.verify = { status: 200, body: { isValid: true, payer: HOUSE_PAYER } };

    const res = await paid.convert('csv-json', 'a\n1\n', {
      ip: ip(5),
      ua: UA,
      headers: { 'x-payment': paymentHeader({ from: HOUSE_PAYER }) },
    });
    assert.equal(res.status, 200, res.text);
    assert.equal(res.headers.get('x-payment-verified'), 'true');

    const settled = await awaitCapture(posthog, EVENTS.paymentSettled);
    assertEnvelope(settled, { distinctId: HOUSE_PAYER, house: true });
    assert.equal(settled.body.properties.payer, HOUSE_PAYER);
    assert.equal(settled.body.properties.tool, 'csv-json');
  });
});

// ------------------------------------------------------------------ offline

describe('the local mock is the only analytics host reached', () => {
  test('every capture in this file arrived at the loopback mock, on the ingest path', async () => {
    // The mock is bound to 127.0.0.1 on an ephemeral port, so a capture that
    // reached it could not have gone anywhere else — and a build that ignored
    // POSTHOG_HOST would have produced no hits here at all, failing every test
    // above. What this adds is the shape: one path, one method, nothing else.
    assert.match(posthog.url, /^http:\/\/127\.0\.0\.1:\d+$/, 'the mock is not on loopback');
    assert.ok(posthog.state.all.length >= 6, `expected the whole file's captures, saw ${posthog.state.all.length}`);

    for (const hit of posthog.state.all) {
      assert.equal(hit.method, 'POST', `a capture used ${hit.method}`);
      assert.equal(hit.path, INGEST_PATH, `a capture went to ${hit.path}`);
      assert.match(hit.host, /^127\.0\.0\.1:\d+$/, `a capture addressed ${hit.host}`);
      assert.equal(hit.body?.api_key, TOKEN, 'a capture carried a token this suite did not configure');
      assert.ok(
        Object.values(EVENTS).includes(hit.body?.event),
        `a capture named an event outside the family: ${hit.body?.event}`
      );
    }
  });
});
