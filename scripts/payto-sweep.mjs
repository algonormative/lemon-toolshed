#!/usr/bin/env node
//
//  OWNER-RUN. Move the USDC a property's Base payTo has collected to an
//  address the owner names (e.g. their Coinbase USDC deposit address, Base
//  network). Interactive by default: it finds the payTo among this CDP
//  project's server accounts, prints its USDC and ETH balances, asks for the
//  recipient, and sends only after the owner types SEND.
//
//    node scripts/payto-sweep.mjs                      # kino402's payTo, interactive
//    node scripts/payto-sweep.mjs 0x…payTo             # another payTo, interactive
//    node scripts/payto-sweep.mjs 0x…payTo --to 0x… --keep 1 --yes   # scripted
//
//  Same credential contract as payto-setup.mjs: CDP_API_KEY_ID /
//  CDP_API_KEY_SECRET from env or the repo-root .env, CDP_WALLET_SECRET
//  from env only:
//
//    CDP_WALLET_SECRET="$(op read 'op://Private/Coinbase/Wallet secret')" \
//    node scripts/payto-sweep.mjs
//
//  GAS. A CDP server account is an EOA, and CDP ignores gas sponsorship for
//  EOAs, so the payTo must hold a little ETH on Base before the transfer can
//  land. Send ~0.0002 ETH (well under a dollar) to the payTo on the Base
//  network; the interactive run waits while you do and re-checks.
//
//  The script never prints a secret and never sends anywhere but the address
//  you gave it.

import { createInterface } from 'node:readline/promises';

const KINO402_PAYTO = '0x2A266c87F7b0D1F8A471D2d5234F5CF4FB62b206';

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};
const payTo = args[0] && !args[0].startsWith('--') ? args[0] : KINO402_PAYTO;
let to = flag('--to');
const keepFlag = flag('--keep');
const scripted = args.includes('--yes');
const isAddr = (a) => /^0x[0-9a-fA-F]{40}$/.test(a ?? '');

if (!isAddr(payTo) || (to !== undefined && !isAddr(to)) || (keepFlag !== undefined && !(Number(keepFlag) >= 0))) {
  console.error('usage: node scripts/payto-sweep.mjs [payTo 0x…] [--to 0x… --keep <usdc> --yes]');
  process.exit(2);
}
if (scripted && !to) {
  console.error('--yes needs --to: name the destination explicitly.');
  process.exit(2);
}
if (!scripted && !process.stdin.isTTY) {
  console.error('Not a terminal. Run it interactively, or pass --to <address> --yes.');
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

const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const RPC = 'https://mainnet.base.org';

async function rpc(method, params) {
  const res = await fetch(RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const body = await res.json();
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}
const usdcAtomic = async (a) =>
  BigInt(await rpc('eth_call', [{ to: USDC, data: '0x70a08231' + a.slice(2).toLowerCase().padStart(64, '0') }, 'latest']));
const ethWei = async (a) => BigInt(await rpc('eth_getBalance', [a, 'latest']));
const fmtUsdc = (atomic) => (Number(atomic) / 1e6).toFixed(6);

const { CdpClient } = await import('@coinbase/cdp-sdk');
const cdp = new CdpClient({
  apiKeyId: process.env.CDP_API_KEY_ID,
  apiKeySecret: process.env.CDP_API_KEY_SECRET,
  walletSecret: process.env.CDP_WALLET_SECRET,
});

// Match by address rather than by name: the earliest payTos predate the
// `<property>-evm-payto` naming in payto-setup.mjs.
let account;
let pageToken;
do {
  const page = await cdp.evm.listAccounts({ pageSize: 100, pageToken });
  account = page.accounts.find((a) => a.address.toLowerCase() === payTo.toLowerCase());
  pageToken = page.nextPageToken;
} while (!account && pageToken);

if (!account) {
  console.error(`${payTo} is not a server account in this CDP project. It was created elsewhere ` +
    '(another CDP project, or a non-CDP wallet) — sweep it from wherever its key lives.');
  process.exit(1);
}

let usdc = await usdcAtomic(account.address);
let eth = await ethWei(account.address);
console.log(`account  ${account.address}  (CDP name: ${account.name ?? '—'})`);
console.log(`USDC     ${fmtUsdc(usdc)}`);
console.log(`ETH      ${(Number(eth) / 1e18).toFixed(8)}`);

if (usdc === 0n) {
  console.log('nothing to sweep.');
  process.exit(0);
}

let amount;
if (scripted) {
  const keepAtomic = BigInt(Math.round(Number(keepFlag ?? 0) * 1e6));
  amount = usdc > keepAtomic ? usdc - keepAtomic : 0n;
  if (amount === 0n) { console.log('nothing to sweep after --keep.'); process.exit(0); }
  if (eth === 0n) {
    console.error('refusing: the payTo holds no ETH for gas. Send ~0.0002 ETH to it on Base first.');
    process.exit(1);
  }
} else {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => rl.question(q).then((s) => s.trim());

  while (!isAddr(to)) {
    to = await ask('\nPaste the recipient address (Coinbase → Receive → USDC → network Base): ');
    if (!isAddr(to)) console.log('That is not a 0x address with 40 hex characters. Try again.');
  }
  if (to.toLowerCase() === account.address.toLowerCase()) {
    console.error('That is the payTo itself. Nothing to do.');
    process.exit(1);
  }

  while (amount === undefined) {
    const raw = await ask(`Amount in USDC [all = ${fmtUsdc(usdc)}]: `);
    const n = Number(raw);
    const want = raw === '' || raw.toLowerCase() === 'all' ? usdc : Number.isFinite(n) ? BigInt(Math.round(n * 1e6)) : 0n;
    if (!(want > 0n) || want > usdc) console.log(`Enter a number between 0 and ${fmtUsdc(usdc)}, or press Enter for all.`);
    else amount = want;
  }

  while (eth === 0n) {
    console.log(`\nThe payTo has no ETH for gas. From Coinbase, send ~0.0002 ETH on the Base network to:\n  ${account.address}`);
    const r = await ask('Press Enter to re-check, or type q to quit: ');
    if (r.toLowerCase() === 'q') process.exit(0);
    eth = await ethWei(account.address);
    usdc = await usdcAtomic(account.address);
    console.log(`ETH      ${(Number(eth) / 1e18).toFixed(8)}`);
  }
  if (amount > usdc) amount = usdc;

  console.log(`\nAbout to send ${fmtUsdc(amount)} USDC on Base`);
  console.log(`  from ${account.address}`);
  console.log(`  to   ${to}`);
  console.log('Check the recipient against your Coinbase app character by character, including that the network is Base.');
  const ok = await ask('Type SEND to transfer, anything else to cancel: ');
  rl.close();
  if (ok !== 'SEND') {
    console.log('cancelled — nothing sent.');
    process.exit(0);
  }
}

const { transactionHash } = await account.transfer({ to, amount, token: 'usdc', network: 'base' });
console.log(`\nsent: https://basescan.org/tx/${transactionHash}`);
console.log(`payTo USDC left: ${fmtUsdc(await usdcAtomic(account.address))} (may lag a block)`);
