#!/usr/bin/env node
//
//  OWNER-RUN. Create (or fetch) one receive-only CDP server account per rail
//  for ONE property, and print the two payTo addresses. Nothing else.
//
//    node scripts/payto-setup.mjs <property>          e.g. parallax
//
//  Companion to solana-payto-setup.mjs (which also captures the facilitator
//  feePayer for the three original properties). Same credential contract:
//  CDP_API_KEY_ID / CDP_API_KEY_SECRET from env or the repo-root .env, and
//  CDP_WALLET_SECRET from env only — inject it from 1Password:
//
//    CDP_WALLET_SECRET="$(op read 'op://Private/Coinbase/Wallet secret')" \
//    node scripts/payto-setup.mjs parallax
//
//  Keys never leave CDP: getOrCreateAccount returns an address, not a key.
//  The script spends nothing, funds nothing, and never prints a secret.

const property = process.argv[2];
if (!property || !/^[a-z0-9-]+$/.test(property)) {
  console.error('usage: node scripts/payto-setup.mjs <property-name>  (lowercase, digits, dashes)');
  process.exit(2);
}

try {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const { dirname, join } = await import('node:path');
  const envPath = join(dirname(dirname(fileURLToPath(import.meta.url))), '.env');
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch { /* no .env — env vars must carry everything */ }

for (const name of ['CDP_API_KEY_ID', 'CDP_API_KEY_SECRET', 'CDP_WALLET_SECRET']) {
  if (!process.env[name]) {
    console.error(`Missing env var ${name}. See the header comment.`);
    process.exit(1);
  }
}

const { CdpClient } = await import('@coinbase/cdp-sdk');
const cdp = new CdpClient({
  apiKeyId: process.env.CDP_API_KEY_ID,
  apiKeySecret: process.env.CDP_API_KEY_SECRET,
  walletSecret: process.env.CDP_WALLET_SECRET,
});

const evm = await cdp.evm.getOrCreateAccount({ name: `${property}-evm-payto` });
const sol = await cdp.solana.getOrCreateAccount({ name: `${property}-solana-payto` });

console.log(`${property} payTo (Base, USDC):   ${evm.address}`);
console.log(`${property} payTo (Solana, USDC): ${sol.address}`);
console.log('(receive-only CDP server accounts; keys custodied by CDP; nothing funded)');
