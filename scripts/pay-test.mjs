#!/usr/bin/env node
//
//  ┌──────────────────────────────────────────────────────────────────────┐
//  │  THIS SCRIPT SPENDS REAL MONEY.                                      │
//  │                                                                      │
//  │  It makes one paid call to the live Toolshed: $0.001 in USDC on      │
//  │  Base, signed with the key in .buyer.env and settled on chain by     │
//  │  the CDP facilitator. It ALSO burns today's free tier for whatever   │
//  │  IP address you run it from — up to 10 throwaway conversions —       │
//  │  because the paid path is only reachable past the free tier.         │
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
//
//   node scripts/create-test-buyer.mjs      # once: make a key
//   # …fund the printed address with ~$1 USDC on Base…
//   node scripts/pay-test.mjs --yes         # the real thing
//
//   node scripts/pay-test.mjs --dry-run     # safe: shows the plan, spends nothing
//
// Flags:
//   --yes           required to spend anything
//   --dry-run       print the plan and the 402 envelope, then stop
//   --tool <id>     which conversion to buy (default: md-html)
//   --url <base>    override the API base (default: the production host)
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
const TOOL = value('tool', 'md-html');
const BASE = value('url', DEFAULT_BASE).replace(/\/+$/, '');
const ENDPOINT = `${BASE}/convert/${TOOL}`;

// Small inputs on purpose: the free-tier burn should cost the Worker as little
// CPU as possible, and the paid call should be about the payment, not the work.
const INPUTS = {
  'md-html': '# x402\n',
  'json-yaml': '{"x402":true}',
  'yaml-json': 'x402: true\n',
  'csv-json': 'a\n1\n',
  'html-markdown': '<p>x402</p>',
};
const INPUT = INPUTS[TOOL] ?? '# x402\n';

// ------------------------------------------------------------------ the gate

if (!CONFIRMED && !DRY_RUN) {
  console.error(`
  REFUSING TO RUN.

  This script spends real USDC and burns today's free tier for this IP.
  Re-run with --yes once you actually mean it, or with --dry-run to see
  exactly what it would do without spending anything:

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

console.log(`
  Toolshed paid-call test
  ───────────────────────────────────────────────────────────
  endpoint   ${ENDPOINT}
  buyer      ${account.address}
  price      $0.001 USDC on Base (1000 atomic units)
  mode       ${DRY_RUN ? 'DRY RUN — nothing will be spent' : 'LIVE — this spends real USDC'}
`);

// ------------------------------------------------------------------ 1. the free tier
//
// The paid path is only reachable past the free tier, and the Worker ignores
// X-PAYMENT inside it (deliberately — the free tier is not a payment path). So
// today's allowance for this IP has to be spent before a payment means anything.
// Every call below is a real conversion; they are just tiny ones.

console.log('  1. Free tier — the paid path is unreachable until it is gone.\n');

let burned = 0;
let sawPaywall = false;
const MAX_BURN = 24; // FREE_TIER_DAILY is 10; this is a safety stop, not a target

for (let i = 0; i < MAX_BURN; i++) {
  const res = await fetch(ENDPOINT, { method: 'POST', body: INPUT });

  if (res.status === 402) {
    sawPaywall = true;
    if (DRY_RUN) {
      console.log('     free tier already spent — here is the 402 envelope:\n');
      console.log(`${JSON.stringify(await res.json(), null, 2)}\n`.replace(/^/gm, '       '));
    } else {
      await res.arrayBuffer();
    }
    break;
  }

  if (res.status === 429) {
    await res.arrayBuffer();
    console.error(
      '     429 — this caller is rate-limited, or PAYTO is unset on the Worker\n' +
        '     so there is nowhere to pay. Nothing was spent. Stopping.'
    );
    process.exit(1);
  }

  if (!res.ok) {
    console.error(`     unexpected ${res.status} from the free tier: ${(await res.text()).slice(0, 300)}`);
    process.exit(1);
  }

  await res.arrayBuffer();
  burned++;
  const remaining = res.headers.get('x-free-tier-remaining');
  console.log(`     burned ${burned} free conversion(s); x-free-tier-remaining: ${remaining}`);

  if (DRY_RUN && burned >= 1) {
    console.log(`
     DRY RUN — stopping here.

     A live run would keep going until the free tier answers 402, then sign
     an EIP-3009 authorization for 1000 atomic USDC and retry the call with
     an X-PAYMENT header. Re-run with --yes to actually do it.
`);
    process.exit(0);
  }
}

if (!sawPaywall) {
  console.error(`
     Made ${burned} calls without reaching a 402. Either the free tier is
     larger than expected, or PAYTO is unset on the Worker. Nothing was
     paid. Stopping rather than looping.
`);
  process.exit(1);
}

console.log(`\n     free tier spent (${burned} call(s) burned). The next call must be paid.\n`);

// ------------------------------------------------------------------ 2. the paid call

console.log('  2. Paid call — signing an EIP-3009 authorization and retrying.\n');

const wallet = createWalletClient({ account, chain: base, transport: http() });
// wrapFetchWithPayment retries a 402 once: it reads `accepts[0]`, signs the
// transfer authorization, and re-sends with the X-PAYMENT header. maxValue is a
// client-side ceiling in atomic units — 10,000 is $0.01, ten times the price, so
// a Worker that suddenly asked for more would be refused here rather than paid.
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

// ------------------------------------------------------------------ 3. the verdict

if (res.status === 200 && verified === 'true') {
  console.log(`
  ✅ VERIFIED. The facilitator accepted the payment and the conversion was
     served. Settlement runs after the response, so it is NOT reflected in
     what you just saw.

     Confirm the money actually moved:
       - the CDP x402 chart in the Coinbase Developer Platform dashboard
       - the receiving wallet (PAYTO) — the $0.001 should land within seconds
       - the Worker's ledger:
           npx wrangler d1 execute DB --remote \\
             --command "SELECT * FROM settlements ORDER BY ts DESC LIMIT 5;"

     A row with settle_ok = 1 and a tx_hash is the end-to-end proof. Once you
     have it, flip the site status box — README § Settlement (live) has the
     exact sentence.
`);
  process.exit(0);
}

if (res.status === 200 && paymentError) {
  console.log(`
  ⚠️  SERVED, BUT NOT VERIFIED (${paymentError}).

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
  ❌ REJECTED — the facilitator refused the payment: ${reason}

     'insufficient_funds'                      → fund the buyer with USDC on Base
     'invalid_exact_evm_payload_signature'     → the envelope's EIP-712 domain
                                                 ('extra': name/version) does not
                                                 match what the client signed
     'invalid_exact_evm_payload_recipient_mismatch'
                                               → PAYTO does not match the payload
`);
  process.exit(1);
}

console.log(`  ❌ Unexpected outcome — ${res.status}. Nothing above applies; read the body.\n`);
process.exit(1);
