// The failure disclosure, on all three surfaces, saying the same thing.
//
// A buyer can read a price anywhere. What they cannot usually read is what
// happens when the call degrades — whether the authorization they signed is
// spent or released when the conversion 4xxs, what a replay of it gets, whether
// anything is held, whether a refund exists. Toolshed publishes those five terms
// with the price, in three places: `x-billing-terms` per paid operation in
// openapi.json, `billing_terms` per resource in /.well-known/x402, and the
// README section a human reads.
//
// THREE COPIES IS THREE CHANCES TO DRIFT, so this file removes them. All three
// are rendered from — or quoted verbatim out of — worker/billing-terms.js, and
// every assertion below is that they still are. A disclosure that has gone
// stale on one surface is worse than none: it is a wrong answer to the one
// question a buyer asked before spending.
//
// PURE, so it boots nothing. The two machine documents under test are the
// committed worker/surfaces.generated.js — the exact bytes the zone Worker
// serves — and test/surfaces.test.mjs separately proves that module is
// byte-identical to a fresh `node build.mjs`.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

import { CATALOG } from '../worker/catalog.generated.js';
import {
  BILLING_TERMS,
  BILLING_TERMS_FIELDS,
  PAYMENT_HEADER_V1,
  PAYMENT_HEADER_V2,
  SUPPORT_EMAIL,
  atomicAmount,
  billingTerms,
  usdDecimal,
} from '../worker/billing-terms.js';
import SURFACES from '../worker/surfaces.generated.js';

// Resolved here rather than imported from the harness: this file runs in a pure
// phase, which boots nothing, and it should not pull the worker harness in to
// read one path.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const openapi = JSON.parse(SURFACES['/openapi.json'].body);
const wellKnown = JSON.parse(SURFACES['/.well-known/x402'].body);
const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');

/** Markdown wraps its lines; the prose is the same prose either way. */
const flat = (text) => text.replace(/\s+/g, ' ').trim();
const flatReadme = flat(readme);

/** Every PAID tool: hosted, live, and not a `price: free` entry. */
const paidEntries = CATALOG.filter((e) => e.hosted && e.hosted.status === 'live' && e.hosted.price !== 'free');

/** The paid operations, identified by the 402 that makes them paid. */
const paidOperations = Object.entries(openapi.paths).flatMap(([path, item]) =>
  Object.entries(item)
    .filter(([, operation]) => operation.responses?.['402'])
    .map(([, operation]) => [path, operation])
);

describe('the five fields exist, everywhere, in one order', () => {
  test('the definition itself is exactly the five the ticket names', () => {
    assert.deepEqual(BILLING_TERMS_FIELDS, [
      'billable_unit',
      'hold',
      'idempotency',
      'post_payment_error',
      'refund',
    ]);
  });

  test('every paid catalogue entry has an operation and a resource', () => {
    assert.ok(paidEntries.length >= 1, 'no paid entries found — the fixture is wrong, not the surfaces');
    assert.equal(paidOperations.length, paidEntries.length);
    assert.deepEqual(
      paidOperations.map(([path]) => path).sort(),
      paidEntries.map((e) => e.hosted.path).sort()
    );

    const resourcePaths = wellKnown.resources.map((r) => new URL(r.url).pathname);
    assert.deepEqual(resourcePaths.sort(), paidEntries.map((e) => e.hosted.path).sort());
  });

  for (const entry of paidEntries) {
    describe(`POST ${entry.hosted.path}`, () => {
      const operation = paidOperations.find(([path]) => path === entry.hosted.path)?.[1];
      const resource = wellKnown.resources.find((r) => new URL(r.url).pathname === entry.hosted.path);

      test('openapi.json carries x-billing-terms with the five fields in order', () => {
        const terms = operation?.['x-billing-terms'];
        assert.ok(terms, `${entry.hosted.path} is paid and has no x-billing-terms`);
        assert.deepEqual(Object.keys(terms), BILLING_TERMS_FIELDS);
      });

      test('/.well-known/x402 carries billing_terms with the five fields in order', () => {
        const terms = resource?.billing_terms;
        assert.ok(terms, `${entry.hosted.path} is a published resource and has no billing_terms`);
        assert.deepEqual(Object.keys(terms), BILLING_TERMS_FIELDS);
      });

      test('the two machine surfaces agree, and both are what the module renders', () => {
        const expected = billingTerms(entry.hosted);
        assert.deepEqual(operation['x-billing-terms'], expected);
        assert.deepEqual(resource.billing_terms, expected);
        // Not merely equal to each other: equal to the renderer, so a hand-edit
        // of the generated module fails here rather than agreeing with itself.
        assert.deepEqual(operation['x-billing-terms'], resource.billing_terms);
      });

      test('the price in the terms is the catalogue price, in both forms', () => {
        const unit = operation['x-billing-terms'].billable_unit;
        assert.equal(unit.price_usd, usdDecimal(entry.hosted.price.amount_usd));
        assert.equal(unit.amount_atomic, atomicAmount(entry.hosted.price.amount_usd));
        assert.equal(Number(unit.price_usd), entry.hosted.price.amount_usd);
        // The same atomic figure the 402 envelope quotes for this route, on
        // EVERY rail it offers — so a buyer budgeting off the disclosure and one
        // paying the live 402 are looking at one number.
        assert.ok(resource.accepts.length >= 1, `${entry.id}: the resource quotes no rail`);
        for (const a of resource.accepts) assert.equal(unit.amount_atomic, a.amount);
        // And the same figure openapi.json's AgentCash block quotes.
        assert.equal(operation['x-payment-info'].price.amount, unit.price_usd);
      });
    });
  }
});

describe('the README says the same thing, word for word', () => {
  test('the section exists and names all three surfaces', () => {
    assert.match(readme, /^## Billing terms$/m);
    assert.ok(flatReadme.includes('`x-billing-terms` on every paid operation in `/openapi.json`'));
    assert.ok(flatReadme.includes('`billing_terms` on every resource in `/.well-known/x402`'));
    assert.ok(flatReadme.includes('worker/billing-terms.js'));
  });

  for (const field of BILLING_TERMS_FIELDS) {
    test(`\`${field}\` is named, and its prose is quoted verbatim`, () => {
      assert.ok(flatReadme.includes(`**\`${field}\`**`), `README does not name the ${field} term`);
      assert.ok(
        flatReadme.includes(flat(BILLING_TERMS[field])),
        `README's ${field} prose has drifted from worker/billing-terms.js`
      );
    });
  }
});

describe('the terms describe shipped behaviour, not intentions', () => {
  const terms = billingTerms(paidEntries[0].hosted);

  test('"none" where no path exists, said as a value and not by omission', () => {
    // There is no refund endpoint, no credit and no dispute process in
    // worker/beacon.js. The honest field is the string, present.
    assert.equal(terms.refund.path, 'none');
    assert.equal(terms.refund.dispute, 'none');
    assert.equal(terms.refund.contact, SUPPORT_EMAIL);
    // And no hold, because verify is a read: nothing is reserved anywhere.
    assert.equal(terms.hold.held, false);
  });

  test('the support address is the one the rest of the document publishes', () => {
    assert.equal(openapi.info.contact.email, SUPPORT_EMAIL);
    assert.equal(wellKnown.service.contact, SUPPORT_EMAIL);
  });

  test('the replay answer is the status and code the Worker actually sends', () => {
    // paymentAlreadyUsed() in worker/beacon.js builds a 402 whose invalidReason
    // and v2 error are both `payment_already_used`.
    assert.deepEqual(terms.idempotency.replay, { status: 402, error: 'payment_already_used' });
    // There is no idempotency-key header on this service; the claim is keyed on
    // the payment header itself (claimPaymentOnce, keyed on its SHA-256).
    assert.equal(terms.idempotency.idempotency_key_header, null);
    assert.equal(terms.idempotency.key, 'sha256(payment header, as presented)');
  });

  test('the payment headers named are the two the request path actually reads', () => {
    // presentedPayment() reads PAYMENT-SIGNATURE first, then X-PAYMENT
    // (worker/beacon.js) — so a v2 buyer is hashed on a header the disclosure
    // has to name, and the order it is named in is the precedence.
    assert.deepEqual(terms.idempotency.headers, [
      PAYMENT_HEADER_V2.toUpperCase(),
      PAYMENT_HEADER_V1.toUpperCase(),
    ]);
    for (const header of terms.idempotency.headers) {
      assert.ok(
        BILLING_TERMS.idempotency.includes(header),
        `the idempotency prose does not name ${header}, which the Worker reads`
      );
    }
  });

  test('a post-payment failure never settles, and both classes release the claim', () => {
    // `abandon` in handleConvert wraps EVERY exit between the claim and the
    // served conversion — the 4xx returns and the fail-closed 503 in the same
    // try/catch — so on this service the 5xx answer is not the 4xx answer by
    // omission: it is the same answer, and it is stated rather than implied.
    assert.equal(terms.post_payment_error.settles, false);
    assert.equal(terms.post_payment_error.on_4xx, 'authorization released');
    assert.equal(terms.post_payment_error.on_5xx, 'authorization released');
  });

  test('the prose promises nothing it cannot keep', () => {
    for (const [field, note] of Object.entries(BILLING_TERMS)) {
      assert.ok(note.length >= 120, `the ${field} note is ${note.length} chars — too thin to act on`);
      // No forward-looking language: this is a disclosure of what the Worker
      // does today, and a "will" or a "soon" in it is a promise nobody signed.
      // ("not a guaranteed remedy" is the opposite of a promise and is fine —
      // what is barred is the future tense, not the word.)
      assert.doesNotMatch(
        note,
        /\b(we will|will be|coming soon|planned|roadmap|in future|we intend)\b/i,
        `the ${field} note makes a forward-looking claim`
      );
    }
  });
});

// ------------------------------------------------------------------ header drift guard
//
// worker/billing-terms.js is imported by build.mjs, which CANNOT import
// worker/beacon.js (it pulls in the workerd built-in `cloudflare:email`, which
// Node's ESM loader refuses), so the two payment header names the disclosure
// quotes are duplicated there. Same cheap guard test/surfaces.test.mjs uses for
// the rail constants: if a header name moves in beacon.js and not here, the
// idempotency term would name a header the request path no longer reads.

describe('billing-terms header constants mirror worker/beacon.js', () => {
  const beacon = readFileSync(join(ROOT, 'worker', 'beacon.js'), 'utf8');

  for (const [name, literal] of [
    ['PAYMENT_HEADER_V1', PAYMENT_HEADER_V1],
    ['PAYMENT_HEADER_V2', PAYMENT_HEADER_V2],
  ]) {
    test(`${name} is still '${literal}' in worker/beacon.js`, () => {
      assert.ok(
        beacon.includes(`const ${name} = '${literal}';`),
        `worker/beacon.js no longer declares ${name} as '${literal}'`
      );
    });
  }

  test('presentedPayment still reads the v2 header first', () => {
    assert.ok(
      beacon.includes('request.headers.get(PAYMENT_HEADER_V2) || request.headers.get(PAYMENT_HEADER_V1)'),
      'the header precedence the idempotency term states is no longer what presentedPayment does'
    );
  });
});
