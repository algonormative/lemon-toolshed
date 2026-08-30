#!/usr/bin/env node
// Create a throwaway buyer wallet for testing the paid path end to end.
//
// This makes a key. It does NOT move any money, talk to any chain, or call the
// Toolshed — it writes a fresh private key to `.buyer.env` and tells you the
// address to send a dollar of USDC to. `scripts/pay-test.mjs` is the half that
// spends it.
//
// WHY A THROWAWAY KEY AND NOT YOUR WALLET: the key written here sits in a
// plaintext file on disk so a script can sign with it unattended. That is fine
// for a key holding $1 and catastrophic for one holding anything else. Fund it
// with the smallest amount that proves the path works, and treat the file as
// burnable — if it leaks, you lose the dollar and nothing else.
//
//   node scripts/create-test-buyer.mjs           # refuses if .buyer.env exists
//   node scripts/create-test-buyer.mjs --force   # overwrite (the old key is gone)

import { writeFileSync, existsSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const ENV_PATH = join(ROOT, '.buyer.env');

let generatePrivateKey;
let privateKeyToAccount;
try {
  ({ generatePrivateKey, privateKeyToAccount } = await import('viem/accounts'));
} catch {
  console.error(
    'viem is not installed. It is a devDependency, so:\n' +
      '\n  npm install\n\n' +
      'then run this again.'
  );
  process.exit(1);
}

const force = process.argv.includes('--force');
if (existsSync(ENV_PATH) && !force) {
  console.error(
    `${ENV_PATH} already exists.\n\n` +
      'Refusing to overwrite it: if that key holds USDC, replacing it strands\n' +
      'the funds at an address whose key no longer exists anywhere. Pass\n' +
      '--force if you are sure, or delete the file yourself.'
  );
  process.exit(1);
}

// viem's generatePrivateKey uses the platform CSPRNG.
const privateKey = generatePrivateKey();
const account = privateKeyToAccount(privateKey);

const body = `# Throwaway test buyer for the Toolshed paid path.
#
# Generated ${new Date().toISOString()} by scripts/create-test-buyer.mjs.
# GITIGNORED, and chmod 600. Do not commit, do not reuse, do not fund with
# more than about a dollar. See README § Settlement (live).
BUYER_ADDRESS=${account.address}
BUYER_PRIVATE_KEY=${privateKey}
`;

writeFileSync(ENV_PATH, body, { mode: 0o600 });
chmodSync(ENV_PATH, 0o600); // explicit: writeFileSync's mode is umask-masked

console.log(`
  Test buyer created.  Key written to .buyer.env (chmod 600, gitignored).

  ADDRESS:  ${account.address}

  NEXT — fund this address with about $1 of USDC on Base:

    1. Open your Coinbase account (or any wallet holding USDC on Base).
    2. Send ~$1 USDC to the address above.
       NETWORK MUST BE **Base**. USDC sent on Ethereum mainnet, Polygon or
       any other chain will not be visible to this key on Base, and getting
       it back is a bridging chore at best.
    3. Wait for the transfer to confirm (seconds on Base).
    4. Run the paid call:

         node scripts/pay-test.mjs

  A paid conversion costs $0.005-$0.01 (per tool), so $1 is 100-200 of them.
  You need far less than that; $1 is just the smallest amount that is not
  annoying to send.
`);
