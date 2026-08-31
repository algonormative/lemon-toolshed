#!/usr/bin/env node
//
//  ┌──────────────────────────────────────────────────────────────────────┐
//  │  OWNER-RUN ONLY. This script creates CDP Solana accounts (one payTo  │
//  │  per property) and reads the facilitator's authenticated /supported  │
//  │  to capture CDP's Solana feePayer — the two owner steps gating       │
//  │  vault-36oue (dual-rail Solana accepts).                             │
//  │                                                                      │
//  │  It reads credentials from env vars only and never prints secrets.   │
//  │  It spends nothing and funds nothing: created accounts are empty     │
//  │  receive addresses.                                                  │
//  └──────────────────────────────────────────────────────────────────────┘
//
//  Setup (once):   npm i -D @coinbase/cdp-sdk
//
//  Run (owner, with 1Password injecting the wallet secret):
//
//    CDP_API_KEY_ID=<id> \
//    CDP_API_KEY_SECRET=<secret> \
//    CDP_WALLET_SECRET="$(op read 'op://Private/Coinbase/Wallet secret')" \
//    node scripts/solana-payto-setup.mjs
//
//  All three must belong to the SAME CDP project. Accounts are
//  project-scoped; per-property separation = three distinct named
//  accounts below, not three keys.
//
//  Output: the CDP Solana feePayer (paste into the chassis work), and one
//  base58 address per property (set as each repo's Solana PAYTO).

const PROPERTIES = ['lemon-toolshed', 'tenx402', 'kino402'];
const FACILITATOR_HOST = 'api.cdp.coinbase.com';
const SUPPORTED_PATH = '/platform/v2/x402/supported';

for (const name of ['CDP_API_KEY_ID', 'CDP_API_KEY_SECRET', 'CDP_WALLET_SECRET']) {
  if (!process.env[name]) {
    console.error(`Missing env var ${name}. See the header comment for the op-injected run command.`);
    process.exit(1);
  }
}

let CdpClient, generateJwt;
try {
  ({ CdpClient } = await import('@coinbase/cdp-sdk'));
  ({ generateJwt } = await import('@coinbase/cdp-sdk/auth'));
} catch (err) {
  console.error(`@coinbase/cdp-sdk is not installed (${err.message}).\n\n  npm i -D @coinbase/cdp-sdk\n`);
  process.exit(1);
}

// ── 1. The authenticated /supported read: is Solana live on OUR account,
//       and what feePayer does CDP use? (The docs table says mainnet
//       exact-scheme is supported; this is the first-party confirmation.)
const jwt = await generateJwt({
  apiKeyId: process.env.CDP_API_KEY_ID,
  apiKeySecret: process.env.CDP_API_KEY_SECRET,
  requestMethod: 'GET',
  requestHost: FACILITATOR_HOST,
  requestPath: SUPPORTED_PATH,
});
const supportedRes = await fetch(`https://${FACILITATOR_HOST}${SUPPORTED_PATH}`, {
  headers: { authorization: `Bearer ${jwt}` },
});
if (!supportedRes.ok) {
  console.error(`GET /supported answered ${supportedRes.status} — check the API key pair. Stopping before creating anything.`);
  process.exit(1);
}
const supported = await supportedRes.json();
const entries = supported.kinds ?? supported.accepts ?? supported.supported ?? supported;
const flat = JSON.stringify(entries);
const solanaEntries = (Array.isArray(entries) ? entries : []).filter(
  (e) => JSON.stringify(e).toLowerCase().includes('solana')
);
console.log('\n── facilitator /supported ─────────────────────────────');
if (solanaEntries.length) {
  for (const e of solanaEntries) console.log(JSON.stringify(e, null, 2));
} else if (flat.toLowerCase().includes('solana')) {
  console.log('Solana present but in an unexpected shape — raw response:');
  console.log(JSON.stringify(supported, null, 2));
} else {
  console.log('⚠ NO Solana entry in /supported for this account. Raw response:');
  console.log(JSON.stringify(supported, null, 2));
  console.log('\nStopping: creating payTo accounts is pointless if the facilitator');
  console.log('will not settle the rail. Check the CDP project/plan first.');
  process.exit(1);
}
const feePayerMatch = flat.match(/"feePayer"\s*:\s*"([1-9A-HJ-NP-Za-km-z]{32,44})"/);
if (feePayerMatch) {
  console.log(`\nCDP Solana feePayer: ${feePayerMatch[1]}`);
  console.log('(goes into the chassis accepts entry as extra.feePayer)');
} else {
  console.log('\n⚠ No feePayer field found in /supported — capture it from a live');
  console.log('  402 once the chassis is up, or ask CDP support which address to pin.');
}

// ── 2. One named Solana account per property. getOrCreateAccount is
//       idempotent: re-running prints the same addresses.
const cdp = new CdpClient();
console.log('\n── per-property Solana payTo accounts ─────────────────');
for (const prop of PROPERTIES) {
  const account = await cdp.solana.getOrCreateAccount({ name: `${prop}-solana-payto` });
  console.log(`${prop.padEnd(16)} ${account.address}`);
}

console.log(`
── next steps ─────────────────────────────────────────
1. Hand each address to the corresponding repo (wrangler var, e.g.
   PAYTO_SOLANA) — the Worker stores the ADDRESS only; the wallet
   secret never becomes a Worker secret.
2. HOUSE_PAYERS stays unchanged — that list is for BUYER wallets, and
   these are receive-only payTo addresses. (If a house Solana BUYER
   wallet is created later for the test kit, THAT one goes in.)
3. ATA check (open question from the spike): the SVM exact scheme pins
   the transfer destination to the payTo's canonical USDC ATA. Confirm
   during the buyer-kit smoke test whether the facilitator handles a
   missing ATA; if not, each payTo needs its USDC ATA created once
   (~0.002 SOL rent each, owner-funded).
4. Then vault-36oue (chassis dual-rail) is unblocked.
`);
