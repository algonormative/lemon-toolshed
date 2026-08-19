#!/usr/bin/env node
//
//  ┌──────────────────────────────────────────────────────────────────────┐
//  │  THIS SCRIPT SPENDS REAL MONEY.                                      │
//  │                                                                      │
//  │  It makes one paid call to the live Toolshed: $0.001 in USDC on      │
//  │  Base, signed with the key in .buyer.env and settled on chain by     │
//  │  the CDP facilitator. There is no free tier to burn through first —  │
//  │  the paywall answers on the very first call — so the run spends      │
//  │  exactly one price, once.                                            │
//  │                                                                      │
//  │  It then signs ONE more call with malformed input, to prove the      │
//  │  "you are only charged for served conversions" claim. A correct      │
//  │  Worker answers 400 and settles nothing, so that probe costs $0.000. │
//  │  If it costs $0.001, it has just found the bug it went looking for.  │
//  │  Skip it with --skip-400-check. Worst case for a whole run: $0.002.  │
//  │                                                                      │
//  │  FOR THE OWNER TO RUN, DELIBERATELY, ONCE. Not part of `npm test`,   │
//  │  not for CI, not for an agent to run on its own initiative. It       │
//  │  refuses to do anything without --yes.                               │
//  └──────────────────────────────────────────────────────────────────────┘
//
// It is the end-to-end proof that the paid path works: a real signature, a real
// facilitator verify, a real on-chain settlement. Nothing else exercises that —
// the test suite proves the Worker's half against a mock, and a mock cannot
// tell you whether the envelope you publish is one a real client can pay.
// (scripts/test-live.mjs reads the same envelope against production, but never
// signs anything, so it cannot tell you that either.)
//
//   node scripts/create-test-buyer.mjs      # once: make a key
//   # …fund the printed address with ~$1 USDC on Base…
//   node scripts/pay-test.mjs --yes         # the real thing
//
//   node scripts/pay-test.mjs --dry-run     # safe: shows the plan, spends nothing
//
// Flags:
//   --yes               required to spend anything
//   --dry-run           print the plan and the 402 envelope, then stop
//   --tool <id>         which conversion to buy (default: md-html)
//   --url <base>        override the API base (default: the production host)
//   --skip-400-check    do not sign the malformed-input probe
//
// Note on gas: the `exact` scheme pays with an EIP-3009 signed authorization,
// and the FACILITATOR submits the transaction. The buyer key needs USDC and no
// ETH at all.

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const ENV_PATH = join(ROOT, '.buyer.env');
const DEFAULT_BASE = 'https://toolshed.lemon-agent.dev';

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const value = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const DRY_RUN = flag('dry-run');
const CONFIRMED = flag('yes');
const SKIP_400 = flag('skip-400-check');
const TOOL = value('tool', 'md-html');
const BASE = value('url', DEFAULT_BASE).replace(/\/+$/, '');
const ENDPOINT = `${BASE}/convert/${TOOL}`;

// USDC on Base and the EIP-712 domain the client signs the transfer
// authorization over. Checked against the envelope before anything is signed: a
// mismatch here is a payment that will verify as invalid, and there is no reason
// to spend a signature discovering that.
const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const USDC_EXTRA = { name: 'USD Coin', version: '2' };
const MAX_DESCRIPTION_CHARS = 500; // the facilitator rejects longer ones

// Small inputs on purpose: the call should be about the payment, not the work.
const INPUTS = {
  'md-html': '# x402\n',
  'json-yaml': '{"x402":true}',
  'yaml-json': 'x402: true\n',
  'csv-json': 'a\n1\n',
  'html-markdown': '<p>x402</p>',
};
const INPUT = INPUTS[TOOL] ?? '# x402\n';

// The malformed-input probe always uses json-yaml, whatever --tool says: it
// needs a converter that can actually reject its input, and md-html accepts
// anything you give it.
const MALFORMED_TOOL = 'json-yaml';
const MALFORMED_INPUT = '{not json';

// ------------------------------------------------------------------ the gate

if (!CONFIRMED && !DRY_RUN) {
  console.error(`
  REFUSING TO RUN.

  This script spends real USDC. Re-run with --yes once you actually mean
  it, or with --dry-run to see exactly what it would do — including the
  live 402 envelope — without spending anything:

    node scripts/pay-test.mjs --dry-run
    node scripts/pay-test.mjs --yes
`);
  process.exit(1);
}

// ------------------------------------------------------------------ the key

if (!existsSync(ENV_PATH)) {
  console.error(`No .buyer.env found.\n\n  node scripts/create-test-buyer.mjs\n\nthen fund the address it prints with ~$1 USDC on Base.`);
  process.exit(1);
}

const env = Object.fromEntries(
  readFileSync(ENV_PATH, 'utf8')
    .split('\n')
    .filter((line) => line.trim() && !line.trim().startsWith('#'))
    .map((line) => {
      const at = line.indexOf('=');
      return [line.slice(0, at).trim(), line.slice(at + 1).trim()];
    })
);

if (!env.BUYER_PRIVATE_KEY) {
  console.error('.buyer.env has no BUYER_PRIVATE_KEY — regenerate it with scripts/create-test-buyer.mjs');
  process.exit(1);
}

let createWalletClient;
let http;
let base;
let privateKeyToAccount;
let wrapFetchWithPayment;
try {
  ({ createWalletClient, http } = await import('viem'));
  ({ base } = await import('viem/chains'));
  ({ privateKeyToAccount } = await import('viem/accounts'));
  ({ wrapFetchWithPayment } = await import('x402-fetch'));
} catch (err) {
  console.error(
    `Missing a client dependency (${err.message}).\n\n` +
      'viem and x402-fetch are devDependencies of this repo:\n\n  npm install\n'
  );
  process.exit(1);
}

const account = privateKeyToAccount(env.BUYER_PRIVATE_KEY);

const plannedProbe = SKIP_400
  ? 'skipped (--skip-400-check)'
  : `1 signed call to /convert/${MALFORMED_TOOL} with bad input — $0.000 if the Worker is correct`;

console.log(`
  Toolshed paid-call test
  ───────────────────────────────────────────────────────────
  endpoint     ${ENDPOINT}
  buyer        ${account.address}
  price        $0.001 USDC on Base (1000 atomic units)
  paid calls   1 served conversion — there is no free tier, so the first call is the paid one
  400 probe    ${plannedProbe}
  mode         ${DRY_RUN ? 'DRY RUN — nothing will be spent' : 'LIVE — this spends real USDC'}
`);

// ------------------------------------------------------------------ 1. the paywall
//
// One unpaid call. It costs nothing and it is the whole reason a paid run can be
// trusted: the envelope that comes back is what the client will sign against, so
// it is checked BEFORE any signature exists. A bad envelope stops the run here,
// with nothing spent.

console.log('  1. The paywall — one unpaid call, free, to read the envelope.\n');

const probe = await fetch(ENDPOINT, { method: 'POST', body: INPUT });
const probeText = await probe.text();

if (probe.status === 429) {
  console.error(`
     429 — this deployment has no receiving address configured (PAYTO is
     unset), so there is nowhere to pay and no envelope to sign against.
     Nothing was spent. Stopping.

     body: ${probeText.slice(0, 200)}
`);
  process.exit(1);
}

if (probe.status === 200) {
  console.error(`
     200 — this deployment served the call WITHOUT a payment, which means it
     is running with FREE_TIER_DAILY set. The paid path is not reachable
     until that caller's free tier is spent, and this script will not burn
     through a free tier to get at it. Nothing was spent. Stopping.

     Run this against production, where FREE_TIER_DAILY is unset and the
     first call answers 402.
`);
  process.exit(1);
}

if (probe.status !== 402) {
  console.error(`
     Expected 402 on the first unpaid call, got ${probe.status}. Nothing was
     spent. Stopping.

     body: ${probeText.slice(0, 300)}
`);
  process.exit(1);
}

let envelope;
try {
  envelope = JSON.parse(probeText);
} catch {
  console.error(`     The 402 body is not JSON, so there is no envelope to pay against:\n\n${probeText.slice(0, 300)}\n`);
  process.exit(1);
}

const offer = envelope.accepts?.[0];

// Every problem is collected and printed together: an owner fixing a deployment
// wants the whole list, not one item per redeploy.
const problems = [];
const need = (cond, message) => {
  if (!cond) problems.push(message);
};

need(envelope.x402Version === 1, `x402Version is ${JSON.stringify(envelope.x402Version)}, expected 1`);
need(Array.isArray(envelope.accepts) && envelope.accepts.length === 1, 'accepts is not a one-element array');
need(!!offer, 'the envelope offers nothing to pay');

if (offer) {
  need(offer.scheme === 'exact', `scheme is ${JSON.stringify(offer.scheme)}, expected "exact"`);
  need(offer.network === 'base', `network is ${JSON.stringify(offer.network)}, expected "base"`);
  need(
    typeof offer.resource === 'string' && offer.resource.endsWith(`/convert/${TOOL}`),
    `resource is ${JSON.stringify(offer.resource)}, expected it to end /convert/${TOOL}`
  );
  need(/^0x[0-9a-fA-F]{40}$/.test(String(offer.payTo)), `payTo ${JSON.stringify(offer.payTo)} is not an address`);
  need(
    /^[0-9]+$/.test(String(offer.maxAmountRequired)) && Number(offer.maxAmountRequired) > 0,
    `maxAmountRequired ${JSON.stringify(offer.maxAmountRequired)} is not a positive numeric string`
  );
  need(
    String(offer.asset).toLowerCase() === USDC_BASE.toLowerCase(),
    `asset is ${offer.asset}, expected USDC on Base (${USDC_BASE})`
  );
  need(
    JSON.stringify(offer.extra) === JSON.stringify(USDC_EXTRA),
    `extra is ${JSON.stringify(offer.extra)}, expected ${JSON.stringify(USDC_EXTRA)} — the signature would be ` +
      'computed over the wrong EIP-712 domain'
  );

  // The Bazaar-facing half. A payable envelope that is not discoverable is a
  // tool nobody finds, so a paid run proves this shape too.
  const input = offer.outputSchema?.input;
  const output = offer.outputSchema?.output;
  need(!!input, 'the envelope has no outputSchema.input');
  need(
    input?.discoverable === true,
    `outputSchema.input.discoverable is ${JSON.stringify(input?.discoverable)} — Coinbase's Bazaar index reads ` +
      'this field, and will not list the tool without it'
  );
  need(input?.type === 'http', `outputSchema.input.type is ${JSON.stringify(input?.type)}, expected "http"`);
  need(input?.method === 'POST', `outputSchema.input.method is ${JSON.stringify(input?.method)}, expected "POST"`);
  need(
    typeof output?.description === 'string' && output.description.trim().length > 0,
    'outputSchema.output carries no description'
  );

  for (const [where, text] of [
    ['description', offer.description],
    ['outputSchema.input.description', input?.description],
    ['outputSchema.output.description', output?.description],
  ]) {
    if (typeof text === 'string') {
      need(
        text.length <= MAX_DESCRIPTION_CHARS,
        `${where} is ${text.length} characters, over the facilitator's ${MAX_DESCRIPTION_CHARS}-character limit`
      );
    }
  }
}

if (problems.length) {
  console.error(`     The 402 envelope is not one this script will pay against:\n`);
  for (const p of problems) console.error(`       - ${p}`);
  console.error(`\n     Nothing was spent. Fix the Worker, redeploy, and re-run.\n`);
  process.exit(1);
}

console.log(`     402 with a valid envelope: ${offer.maxAmountRequired} atomic USDC to ${offer.payTo}`);
console.log(`     outputSchema.input.discoverable: true — Bazaar can index this endpoint\n`);

if (DRY_RUN) {
  console.log(`${JSON.stringify(envelope, null, 2)}\n`.replace(/^/gm, '       '));
  console.log(`
     DRY RUN — stopping here. Nothing was spent, and nothing could have been:
     the call above carried no X-PAYMENT header.

     A live run would sign an EIP-3009 authorization for ${offer.maxAmountRequired} atomic
     USDC, retry this call with an X-PAYMENT header, and expect a 200 with
     x-payment-verified: true${SKIP_400 ? '.' : `, then sign one more call to /convert/${MALFORMED_TOOL}
     with malformed input and expect a 400 that settles nothing.`}

     Re-run with --yes to actually do it.
`);
  process.exit(0);
}

// ------------------------------------------------------------------ 2. the paid call

console.log('  2. Paid call — signing an EIP-3009 authorization and retrying.\n');

const wallet = createWalletClient({ account, chain: base, transport: http() });
// wrapFetchWithPayment retries a 402 once: it reads `accepts[0]`, signs the
// transfer authorization, and re-sends with the X-PAYMENT header. maxValue is a
// client-side ceiling in atomic units — 10,000 is $0.01, ten times the price, so
// a Worker that suddenly asked for more would be refused here rather than paid.
// It applies per call, and this run makes at most two.
const fetchWithPayment = wrapFetchWithPayment(fetch, wallet, BigInt(10_000));

let res;
try {
  res = await fetchWithPayment(ENDPOINT, { method: 'POST', body: INPUT });
} catch (err) {
  console.error(`
     The payment attempt failed before a response came back:

       ${err?.message || err}

     Common causes, in order of likelihood:
       - the buyer address holds no USDC on Base (fund it, then retry)
       - it was funded on the wrong chain (must be Base, not Ethereum mainnet)
       - the 402 envelope is missing 'extra' (name/version), so the signature
         is computed over the wrong EIP-712 domain
`);
  process.exit(1);
}

const body = await res.text();
const verified = res.headers.get('x-payment-verified');
const paymentError = res.headers.get('x-payment-error');

console.log(`     status                ${res.status}`);
console.log(`     x-payment-verified    ${verified ?? '(absent)'}`);
if (paymentError) console.log(`     x-payment-error       ${paymentError}`);
console.log(`     x-payment-response    ${res.headers.get('x-payment-response') ?? '(absent)'}`);
console.log(`\n     body: ${JSON.stringify(body.slice(0, 200))}\n`);

// ------------------------------------------------------------------ 3. paid, but not served
//
// The product's claim is that you are charged for CONVERSIONS, not for calls:
// settlement is queued only on a 2xx, so a payment that verifies and then hits a
// 400 costs the buyer nothing. This is the only place that claim can be checked
// against the real facilitator, and it is cheap — one more signature, and if the
// Worker is right, no money moves.

async function malformedInputProbe() {
  const endpoint = `${BASE}/convert/${MALFORMED_TOOL}`;
  console.log(`  3. Paid but not served — ${endpoint} with malformed input.\n`);

  let probeRes;
  try {
    probeRes = await fetchWithPayment(endpoint, { method: 'POST', body: MALFORMED_INPUT });
  } catch (err) {
    return `could not be run: ${err?.message || err}`;
  }

  const text = await probeRes.text();
  const probeVerified = probeRes.headers.get('x-payment-verified');
  const settleHeader = probeRes.headers.get('x-payment-response');

  console.log(`     status                ${probeRes.status}`);
  console.log(`     x-payment-verified    ${probeVerified ?? '(absent)'}`);
  console.log(`     x-payment-response    ${settleHeader ?? '(absent)'}`);
  console.log(`\n     body: ${JSON.stringify(text.slice(0, 200))}\n`);

  if (probeRes.status === 400) {
    return 'PASS — 400 on malformed input after a verified payment; no conversion was served, so nothing should settle';
  }
  if (probeRes.status === 200) {
    return `FAIL — the Worker served ${MALFORMED_TOOL} on input that is not valid JSON, and charged for it`;
  }
  return `INCONCLUSIVE — expected 400, got ${probeRes.status}`;
}

// ------------------------------------------------------------------ 4. the verdict

if (res.status === 200 && verified === 'true') {
  const probeVerdict = SKIP_400 ? 'skipped (--skip-400-check)' : await malformedInputProbe();

  console.log(`
  VERIFIED. The facilitator accepted the payment and the conversion was
     served. Settlement runs after the response, so it is NOT reflected in
     what you just saw.

     Malformed-input probe: ${probeVerdict}

     Confirm the money actually moved — and, if the probe ran, that it did
     NOT move a second time:
       - the CDP x402 chart in the Coinbase Developer Platform dashboard
       - the receiving wallet (PAYTO) — the $0.001 should land within seconds,
         and there should be exactly ONE of them
       - the Worker's ledger:
           npx wrangler d1 execute DB --remote \\
             --command "SELECT * FROM settlements ORDER BY ts DESC LIMIT 5;"

     A row with settle_ok = 1 and a tx_hash is the end-to-end proof. There
     should be one such row per SERVED conversion and none for the 400. Once
     you have it, flip the site status box — README § Settlement (live) has
     the exact sentence.
`);
  process.exit(0);
}

if (res.status === 200 && paymentError) {
  console.log(`
  SERVED, BUT NOT VERIFIED (${paymentError}).

     The Worker could not reach the facilitator and served the conversion
     anyway — availability-first, by design. NO MONEY MOVED. Check the
     Worker's CDP_API_KEY_ID / CDP_API_KEY_SECRET secrets and FACILITATOR_URL,
     then look at:
       npx wrangler d1 execute DB --remote \\
         --command "SELECT * FROM settlements ORDER BY ts DESC LIMIT 5;"
`);
  process.exit(1);
}

if (res.status === 402) {
  let reason = '(none given)';
  try {
    reason = JSON.parse(body).invalidReason ?? reason;
  } catch {
    /* body was not JSON */
  }
  console.log(`
  REJECTED — the facilitator refused the payment: ${reason}

     'insufficient_funds'                      → fund the buyer with USDC on Base
     'invalid_exact_evm_payload_signature'     → the envelope's EIP-712 domain
                                                 ('extra': name/version) does not
                                                 match what the client signed
     'invalid_exact_evm_payload_recipient_mismatch'
                                               → PAYTO does not match the payload
`);
  process.exit(1);
}

if (res.status === 429) {
  console.log(`
  CEILING — the Worker answered 429: this caller has hit the daily
     conversion ceiling, the runaway bound on paid calls. Nothing was
     charged for this call. Retry tomorrow UTC, or from another caller.
`);
  process.exit(1);
}

console.log(`  Unexpected outcome — ${res.status}. Nothing above applies; read the body.\n`);
process.exit(1);
