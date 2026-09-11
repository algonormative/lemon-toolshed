// `/.well-known/x402` carries the receiving address of each rail — and it is
// THE SAME ADDRESS the 402 envelope names.
//
// WHY THIS EXISTS. Found 2026-09-10 by the house's estate-watch collector:
// toolshed served a perfectly good v2 discovery document whose `accepts`
// entries carried no `payTo`, while kino402, penny402 and parallax all carried
// one. The live 402 was correct throughout — discovery simply said less than it
// could, and a buyer that reads discovery before it spends anything learned
// nothing about where its money would go. The addresses are runtime vars the
// build cannot read, so they are substituted at serve time
// (`discoveryBody()` in worker/beacon.js) rather than baked into the file.
//
// The claim worth testing is not "there is a payTo" — that is one grep. It is
// that the TWO DOCUMENTS AGREE, per rail, and that nothing else about the
// document moved. So every assertion below compares the served discovery
// document against the LIVE 402 ENVELOPE for the same resource on the same
// network, and the non-payTo half against the bytes the build actually wrote.
//
// PHASE: standalone, for the reason x402-solana.test.mjs is standalone — the
// Solana rail needs a FACILITATOR_URL naming a mock on a port only learned at
// startup (the feePayer read is fail-closed, so without it the envelope has no
// Solana entry to agree with), and the rails a worker offers are fixed by
// PAYTO_SOLANA for the life of its process. No network beyond localhost (AF-06).
//
// The Base-rail half and the unset-address case live in test/x402.test.mjs,
// which already boots the production configuration.

import test, { before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  bootWorker,
  client,
  callers,
  fakeCdpCredentials,
  PAYTO_TEST,
  PAYTO_SOLANA_TEST,
} from './harness.mjs';
import { startMockFacilitator } from './mock-facilitator.mjs';
import SURFACES from '../worker/surfaces.generated.js';

const ips = callers('wellknown-payto');

const NETWORK_BASE_V2 = 'eip155:8453';
const NETWORK_SOLANA_V2 = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';

// Which address each rail must be paid at, in this worker's configuration.
const EXPECTED = {
  [NETWORK_BASE_V2]: PAYTO_TEST,
  [NETWORK_SOLANA_V2]: PAYTO_SOLANA_TEST,
};

// What the BUILD wrote, read from the committed module rather than from dist/ —
// dist/ is gitignored and is only fresh if the machine-surfaces phase has run,
// and this file must also pass on its own (`node --test test/…`).
const TEMPLATE = JSON.parse(SURFACES['/.well-known/x402'].body);

let mock;
let worker;
let api;

before(async () => {
  mock = await startMockFacilitator();
  worker = await bootWorker({
    vars: {
      PAYTO: PAYTO_TEST,
      PAYTO_SOLANA: PAYTO_SOLANA_TEST,
      FACILITATOR_URL: mock.url,
      ...fakeCdpCredentials(),
    },
  });
  api = client(worker);
});

after(async () => {
  await worker?.stop();
  await mock?.stop();
});

// ------------------------------------------------------------------ helpers

/** The served discovery document, parsed. */
async function discovery() {
  const res = await api.get('/.well-known/x402');
  assert.equal(res.status, 200, 'the discovery document did not answer 200');
  assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8');
  return JSON.parse(await res.text());
}

/** The v2 `accepts` of the live 402 for one tool, keyed by network. */
async function envelopeAccepts(id) {
  const res = await api.convert(id, 'probe', { ip: ips.next(), ua: 'wellknown-payto/1' });
  assert.equal(res.status, 402, `${id} did not answer the 402 front door: ${res.status} ${res.text}`);
  const header = res.headers.get('payment-required');
  assert.ok(header, `${id} published no v2 envelope`);
  const env = JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
  return new Map(env.accepts.map((a) => [a.network, a]));
}

/** A resource's `/convert/<id>` tool id. */
const toolId = (resource) => resource.url.slice(resource.url.lastIndexOf('/') + 1);

/** The document with every `payTo` removed — what must not have moved. */
const withoutPayTo = (doc) => ({
  ...doc,
  resources: doc.resources.map((r) => ({
    ...r,
    accepts: r.accepts.map(({ payTo, ...rest }) => rest),
  })),
});

// ------------------------------------------------------------------ the claims

describe('with both rails configured', () => {
  test('every accepts entry names the rail it is paid on', async () => {
    const doc = await discovery();
    assert.equal(doc.resources.length, 19);
    for (const resource of doc.resources) {
      assert.equal(resource.accepts.length, 2, `${resource.url}: expected a Base and a Solana entry`);
      for (const entry of resource.accepts) {
        const expected = EXPECTED[entry.network];
        assert.ok(expected, `${resource.url}: unknown network ${entry.network}`);
        assert.equal(entry.payTo, expected, `${resource.url}: wrong payTo on ${entry.network}`);
      }
    }
  });

  test('discovery agrees with the live 402 envelope, per resource per rail', async () => {
    // THE WHOLE POINT. Not "the address is the constant the harness set" —
    // that would pass against two documents built independently from the same
    // literal. The comparison is against what the ENVELOPE published for the
    // same resource on the same network, which is the document a buyer signs
    // against. The three terms beside payTo are compared in the same breath:
    // payTo is the only thing substitution may add, and a transform that also
    // re-derived the price would agree with itself and quote the wrong figure.
    const doc = await discovery();
    for (const resource of doc.resources) {
      const id = toolId(resource);
      const offered = await envelopeAccepts(id);
      // Both rails were offered, or the loop below compares fewer than two.
      assert.deepEqual([...offered.keys()].sort(), [NETWORK_BASE_V2, NETWORK_SOLANA_V2].sort());
      for (const entry of resource.accepts) {
        const live = offered.get(entry.network);
        assert.ok(live, `${id}: the 402 offers no ${entry.network} entry to compare against`);
        assert.equal(
          entry.payTo,
          live.payTo,
          `${id}: discovery and the 402 disagree about payTo on ${entry.network}`
        );
        assert.equal(entry.scheme, live.scheme, `${id}: scheme drift on ${entry.network}`);
        assert.equal(entry.amount, live.amount, `${id}: amount drift on ${entry.network}`);
        assert.equal(entry.asset, live.asset, `${id}: asset drift on ${entry.network}`);
      }
    }
  });

  test('nothing but payTo differs from the document the build wrote', async () => {
    const doc = await discovery();
    assert.deepEqual(withoutPayTo(doc), TEMPLATE);
  });

  test('payTo sits after asset, where the envelope puts it', async () => {
    // Key ORDER is not semantics, but this document is diffed by humans and by
    // the estate-watch collector, and the v2 accepts shape the envelope
    // publishes is scheme, network, amount, asset, payTo. Same order here.
    const doc = await discovery();
    for (const entry of doc.resources.flatMap((r) => r.accepts)) {
      assert.deepEqual(Object.keys(entry), ['scheme', 'network', 'amount', 'asset', 'payTo']);
    }
  });
});

describe('the Solana half of the substitution is gated on its own var', () => {
  // The Base rail is configured, Solana is not — the state a deployment is in
  // before the second rail is turned on. Base gains the key; Solana keeps none,
  // rather than inheriting Base's EVM address, which is the substitution bug
  // worth catching: an entry on the wrong chain naming a payable-looking
  // address is worse than an entry naming none.
  let baseOnly;
  let baseOnlyApi;

  before(async () => {
    baseOnly = await bootWorker({ vars: { PAYTO: PAYTO_TEST } });
    baseOnlyApi = client(baseOnly);
  });

  after(async () => {
    await baseOnly?.stop();
  });

  test('Base carries the address, Solana carries no key at all', async () => {
    const res = await baseOnlyApi.get('/.well-known/x402');
    assert.equal(res.status, 200);
    const doc = JSON.parse(await res.text());
    for (const resource of doc.resources) {
      const [base, solana] = resource.accepts;
      assert.equal(base.network, NETWORK_BASE_V2);
      assert.equal(base.payTo, PAYTO_TEST);
      assert.equal(solana.network, NETWORK_SOLANA_V2);
      assert.ok(!('payTo' in solana), `${resource.url}: the unconfigured Solana entry named a payTo`);
    }
  });
});
