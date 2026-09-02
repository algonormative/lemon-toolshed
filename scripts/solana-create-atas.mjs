#!/usr/bin/env node
//
//  ┌──────────────────────────────────────────────────────────────────────┐
//  │  THIS SCRIPT SPENDS REAL SOL — rent-exemption deposits for at most   │
//  │  three USDC token accounts (~0.00204 SOL each) plus one transaction  │
//  │  fee (0.000005 SOL). Ceiling ~0.007 SOL total. Nothing else moves:   │
//  │  no USDC, no transfers, no account funded beyond rent.               │
//  │                                                                      │
//  │  It refuses to do anything without --yes. --dry-run needs no wallet  │
//  │  secret at all and stops before any signature exists.                │
//  │                                                                      │
//  │  FOR THE OWNER TO RUN, ONCE, DELIBERATELY. Not for CI, not for a     │
//  │  routine, not for an agent on its own initiative.                    │
//  └──────────────────────────────────────────────────────────────────────┘
//
// WHY THIS EXISTS. scripts/solana-buyer-pay.mjs asked the ATA question and
// the chain answered it: NO. The first live Solana x402 smoke payment was
// refused by the CDP facilitator with `preflight_validation_failed` — the
// facilitator simulates the transfer before submitting it, the SVM exact
// scheme pins the destination to the payTo's canonical USDC associated token
// account, and a TransferChecked into an account that does not exist fails
// simulation. The facilitator does not create missing ATAs. So every payTo
// the house advertises needs its USDC ATA created once, rent paid by us.
//
// This is that one-time setup, for the three estate payTo wallets. It is the
// unblocking step for the Solana rail across all three properties.
//
// WHY ONE TRANSACTION, NOT THREE. Three reasons, in order of weight:
//
//   1. The instruction is CreateAssociatedTokenAccountIdempotent, which
//      succeeds as a no-op on an account that already exists. That removes
//      the usual argument for splitting — partial progress is not a hazard
//      when a re-run is safe, so there is nothing to salvage by isolating
//      the instructions from each other.
//   2. All three instructions share every realistic failure mode (stale
//      blockhash, insufficient rent, bad signature). Splitting would not
//      convert a batch failure into two successes and one failure; it would
//      convert one failure into three.
//   3. One signature instead of three: one 5000-lamport fee, one blockhash,
//      one confirmation to poll, one signature to report. Cheaper and with a
//      smaller surface to get wrong.
//
// The per-ATA "created / already existed" verdict does not come from having
// three signatures — it comes from reading each account before and after,
// which is a stronger witness than a transaction receipt anyway.
//
// KEY HANDLING is not reimplemented here. `svmSignerFromExportedKey` is
// imported from solana-buyer-pay.mjs rather than copied, because it has a
// property worth preserving exactly: @solana/codecs interpolates its INPUT
// into the error message on an invalid base58 character, and that input is
// the private key — so the decode failure is swallowed and replaced with a
// message carrying only a length. A copy of that function is a copy that can
// drift away from the safe behaviour. `deriveAta`, `redactUrl` and
// `loadRepoEnv` are imported for the same reason: the two scripts must not be
// able to disagree about what an ATA is or where credentials come from.
//
// RUN IT (owner, with 1Password injecting the wallet secret):
//
//   node scripts/solana-create-atas.mjs --dry-run    # free: derive + read on-chain
//
//   CDP_WALLET_SECRET="$(op read 'op://Private/Coinbase/Wallet secret')" \
//     node scripts/solana-create-atas.mjs --yes      # spends ~0.0062 SOL, once
//
// CDP_API_KEY_ID and CDP_API_KEY_SECRET are read from the repo-root .env;
// real env vars win. CDP_WALLET_SECRET is deliberately NOT in .env.
//
// EXIT CODES:  0 all three ATAs exist · 1 refused, nothing spent · 3 the
// transaction was sent and something went wrong (read the diagnostics).

import { fileURLToPath } from 'node:url';

import {
  address,
  appendTransactionMessageInstructions,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
} from '@solana/kit';

import {
  TOKEN_PROGRAM_ADDRESS,
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstruction,
} from '@solana-program/token';

import {
  assertAtaSelfTest,
  deriveAta,
  loadRepoEnv,
  redactUrl,
  svmSignerFromExportedKey,
} from './solana-buyer-pay.mjs';

// ─────────────────────────────────────────────────────────── constants

const BUYER_NAME = 'house-solana-buyer';
const BUYER_ADDRESS = 'D7f9EifwoMdfwozWDNLFhBGwecVhryc5fs2SxLK93M45';

const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const DEFAULT_RPC_URL = 'https://api.mainnet-beta.solana.com';

/** The estate payTo wallets, each of which advertises a Solana x402
 *  rail and none of which can receive on it until its USDC ATA exists. */
const PAYTOS = [
  { label: 'lemon-toolshed', owner: '7zXRc8sYkhjezbwXQw43beBrKDmhTMA7mkNfqRjdZ6gw' },
  { label: 'tenx402', owner: '6Cg4g7rXQApimMc9wVJGLLZfHsvbwGpGrUpGDgyJ2RaP' },
  { label: 'kino402', owner: 'FZFwXPrnGUKZ9YzgfgXbmbaDzAS8dNEjcrBXkXoKbX9A' },
  { label: 'parallax', owner: 'DMrJUdvmorbEXx8pA4R8yZ9kPfH3pUanCGxoG5AoPuTC' }, // 2026-09-02, parallax402.com
];

const LAMPORTS_PER_SOL = 1_000_000_000n;
const TOKEN_ACCOUNT_BYTES = 165; // classic SPL token account, fixed size
const FEE_LAMPORTS = 5_000n; // one signature, one transaction

// A ceiling on the whole run, checked against the number the RPC reports for
// rent exemption. A compromised or simply wrong RPC that answers with an
// enormous rent figure must not be able to talk this script into draining the
// wallet: three token accounts cannot legitimately cost anything near this.
const HARD_CAP_LAMPORTS = 10_000_000n; // 0.01 SOL

const sol = (lamports) => `${(Number(lamports) / Number(LAMPORTS_PER_SOL)).toFixed(9)} SOL`;

const flag = (argv, name) => argv.includes(`--${name}`);
const value = (argv, name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};

// ─────────────────────────────────────────────────────────── rpc

/** One Solana JSON-RPC call. Throws on transport and on protocol errors alike. */
async function rpc(rpcUrl, method, params) {
  const res = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  if (!res.ok) throw new Error(`RPC ${method}: HTTP ${res.status}`);
  const body = await res.json();
  if (body.error) throw new Error(`RPC ${method}: ${body.error.message ?? JSON.stringify(body.error)}`);
  return body.result;
}

/** Does this token account exist, and what does it hold? `exists: false` is
 *  the state this whole script is here to change. */
async function readAta(rpcUrl, ata) {
  const result = await rpc(rpcUrl, 'getAccountInfo', [ata, { encoding: 'jsonParsed', commitment: 'confirmed' }]);
  const value = result?.value;
  if (!value) return { exists: false, ui: null };
  return { exists: true, ui: value?.data?.parsed?.info?.tokenAmount?.uiAmountString ?? null };
}

// ─────────────────────────────────────────────────────────── derivation

/**
 * The canonical USDC ATA for an owner, derived TWICE and required to agree.
 *
 * Primary: `findAssociatedTokenPda` from @solana-program/token, the same
 * library whose instruction this script builds — so the address created is
 * derived by the code that defines what "associated" means here.
 *
 * Cross-check: `deriveAta` from solana-buyer-pay.mjs, the derivation the
 * payment script uses to decide whether money arrived. If the two ever
 * disagree, this script would be paying rent to create an account the payment
 * script would never look at, which is a silent wrong answer rather than an
 * error. So it is made into an error.
 */
async function ataFor(owner) {
  const [primary] = await findAssociatedTokenPda({
    owner: address(owner),
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
    mint: address(USDC_MINT),
  });
  const crossCheck = await deriveAta(owner);
  if (primary !== crossCheck) {
    throw new Error(
      `ATA derivation disagreement for ${owner}: @solana-program/token says ${primary}, ` +
        `solana-buyer-pay.mjs says ${crossCheck}. Refusing to spend rent on an ambiguous address.`
    );
  }
  return primary;
}

// ─────────────────────────────────────────────────────────── transaction

/**
 * Build and sign the one transaction: a CreateAssociatedTokenAccountIdempotent
 * per target, all paid for and signed by `signer`.
 *
 * Passing the SIGNER OBJECT (not its address) as `payer` is what makes this
 * work: @solana-program/token's account-meta factory upgrades that account's
 * role to signer and attaches the signer itself to the instruction, which is
 * how signTransactionMessageWithSigners finds anything to sign with. Passing
 * a bare address would produce a transaction nobody signs.
 *
 * Exported, and taking its signer and blockhash as arguments, so the whole
 * assembly can be exercised offline against a throwaway keypair — the owner's
 * single --yes run must not be the first time this code executes.
 *
 * @param {object} args
 * @param {import('@solana/kit').TransactionSigner} args.signer - fee payer and sole signer
 * @param {{ owner: string, ata: string }[]} args.targets - the ATAs to create
 * @param {{ blockhash: string, lastValidBlockHeight: string|number|bigint }} args.blockhash
 * @returns {Promise<{ signed: object, signature: string, wire: string }>}
 */
export async function buildCreateAtaTransaction({ signer, targets, blockhash }) {
  const instructions = targets.map((t) =>
    getCreateAssociatedTokenIdempotentInstruction({
      payer: signer,
      ata: address(t.ata),
      owner: address(t.owner),
      mint: address(USDC_MINT),
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    })
  );

  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(signer, m),
    (m) =>
      setTransactionMessageLifetimeUsingBlockhash(
        { blockhash: blockhash.blockhash, lastValidBlockHeight: BigInt(blockhash.lastValidBlockHeight) },
        m
      ),
    (m) => appendTransactionMessageInstructions(instructions, m)
  );

  const signed = await signTransactionMessageWithSigners(message);
  return {
    signed,
    signature: getSignatureFromTransaction(signed),
    wire: getBase64EncodedWireTransaction(signed),
    instructionCount: instructions.length,
  };
}

// ─────────────────────────────────────────────────────────── main

async function main(argv) {
  // Before the banner, before argument parsing matters, before any network
  // call: prove the derivation still lands on an address whose answer is
  // known. Every address this script prints or funds depends on it.
  await assertAtaSelfTest();

  const DRY_RUN = flag(argv, 'dry-run');
  const YES = flag(argv, 'yes');
  const rpcUrl = value(argv, 'rpc', process.env.SOLANA_RPC_URL || DEFAULT_RPC_URL);

  if (!DRY_RUN && !YES) {
    console.error(`
  This script spends real SOL — rent for up to three USDC token accounts
  (~0.00204 SOL each) plus one transaction fee, from the house buyer wallet.
  It creates the payTo ATAs the Solana x402 rail needs in order to settle.

    node scripts/solana-create-atas.mjs --dry-run   # derive + read, spend nothing
    node scripts/solana-create-atas.mjs --yes       # do it, once

  Owner-only. See the header comment for the op-injected run command.
`);
    return 1;
  }

  console.log(`
  ── Solana payTo ATA creation ──────────────────────────────
  mode     ${DRY_RUN ? 'DRY RUN — nothing will be spent' : 'LIVE — this spends real SOL, once'}
  payer    ${BUYER_ADDRESS}  (CDP account "${BUYER_NAME}")
  mint     ${USDC_MINT}  (USDC, classic SPL token program)
  rpc      ${redactUrl(rpcUrl)}
  ata      self-test ✓ (derivation matches the known vector)
`);

  // ── 1. Derive all three, and read each one on-chain. This is the whole of
  //       the dry run and the baseline for the live run.
  const targets = [];
  for (const { label, owner } of PAYTOS) {
    const ata = await ataFor(owner);
    const state = await readAta(rpcUrl, ata);
    targets.push({ label, owner, ata, existedBefore: state.exists, uiBefore: state.ui });
  }

  console.log(`  ── current state ──────────────────────────────────────────`);
  for (const t of targets) {
    const state = t.existedBefore
      ? `EXISTS, holds ${t.uiBefore ?? '?'} USDC — nothing to do`
      : 'DOES NOT EXIST — will be created';
    console.log(`  ${t.label.padEnd(15)} owner ${t.owner}`);
    console.log(`  ${''.padEnd(15)} ata   ${t.ata}`);
    console.log(`  ${''.padEnd(15)}       ${state}`);
  }
  console.log('');

  const missing = targets.filter((t) => !t.existedBefore);
  if (!missing.length) {
    console.log(`  All three USDC ATAs already exist. Nothing to create, nothing spent.
  The Solana rail's ATA precondition is satisfied for every estate payTo.
`);
    return 0;
  }

  // ── 2. What it costs, from the chain rather than from a constant. The
  //       rent-exemption minimum is a cluster parameter and hardcoding it
  //       would be a guess; asking is cheap. The hard cap below is what makes
  //       asking safe.
  const rentPerAta = BigInt(await rpc(rpcUrl, 'getMinimumBalanceForRentExemption', [TOKEN_ACCOUNT_BYTES]));
  const required = rentPerAta * BigInt(missing.length) + FEE_LAMPORTS;

  if (required > HARD_CAP_LAMPORTS) {
    console.error(`
  SPEND CAP. Creating ${missing.length} token account(s) would cost ${sol(required)}
  (rent ${sol(rentPerAta)} each + ${sol(FEE_LAMPORTS)} fee), above this script's
  ${sol(HARD_CAP_LAMPORTS)} ceiling. Three SPL token accounts cannot legitimately
  cost that much — suspect the RPC (${redactUrl(rpcUrl)}) before raising the
  cap. Nothing spent.
`);
    return 1;
  }

  const balance = BigInt((await rpc(rpcUrl, 'getBalance', [BUYER_ADDRESS, { commitment: 'confirmed' }]))?.value ?? 0);

  console.log(`  ── cost ───────────────────────────────────────────────────
  to create      ${missing.length} of ${targets.length}  (${missing.map((t) => t.label).join(', ')})
  rent each      ${sol(rentPerAta)}  (rent-exempt minimum for ${TOKEN_ACCOUNT_BYTES} bytes, from the chain)
  tx fee         ${sol(FEE_LAMPORTS)}  (one signature, one transaction)
  TOTAL          ${sol(required)}
  payer balance  ${sol(balance)}
  ceiling        ${sol(HARD_CAP_LAMPORTS)}
`);

  if (balance < required) {
    console.error(`
  INSUFFICIENT SOL. The payer holds ${sol(balance)} and needs ${sol(required)}.
  Fund ${BUYER_ADDRESS} with SOL (withdraw from Coinbase choosing the SOLANA
  network) and re-run. Nothing spent.
`);
    return 1;
  }

  if (DRY_RUN) {
    console.log(`  Dry run complete. ${missing.length} ATA(s) would be created in ONE transaction
  of ${missing.length} idempotent instruction(s), costing ${sol(required)}; the payer is
  funded. Nothing was signed and nothing was spent.

  Re-run with --yes (and CDP_WALLET_SECRET injected) to create them.
`);
    return 0;
  }

  // ── 3. Credentials, then the key — in that order, so a missing env var is
  //       a clean refusal rather than a half-opened wallet.
  loadRepoEnv();
  for (const name of ['CDP_API_KEY_ID', 'CDP_API_KEY_SECRET', 'CDP_WALLET_SECRET']) {
    if (!process.env[name]) {
      console.error(`  Missing env var ${name}. See the header comment for the op-injected run command. Nothing spent.`);
      return 1;
    }
  }

  let CdpClient;
  try {
    ({ CdpClient } = await import('@coinbase/cdp-sdk'));
  } catch (err) {
    console.error(`  Missing a client dependency (${err.message}).\n\n  npm install\n\nNothing spent.`);
    return 1;
  }

  // THE ONLY MOMENT THE KEY EXISTS. Exported in memory, decoded, handed to
  // the signer constructor, then the string is dropped (the bytes are zeroed
  // inside svmSignerFromExportedKey). Nothing here logs, writes, or returns
  // the material.
  let signer;
  {
    const cdp = new CdpClient();
    let exported = await cdp.solana.exportAccount({ name: BUYER_NAME });
    try {
      signer = await svmSignerFromExportedKey(exported);
    } finally {
      exported = null;
    }
  }

  // The definitive check that the right key was loaded — not a format sniff,
  // this. Paying rent from an unexpected wallet is exactly the thing not to do.
  if (signer.address !== BUYER_ADDRESS) {
    const got = signer.address; // a public key, not a secret — safe to print
    signer = null;
    console.error(`
  The CDP account named "${BUYER_NAME}" exported a key for ${got}, not the
  expected payer ${BUYER_ADDRESS}. Refusing to spend from an unexpected
  wallet. Nothing spent.
`);
    return 1;
  }
  console.log(`  wallet   unlocked in memory, address matches ✓ (key never touched disk)`);

  // ── 4. One transaction, one instruction per missing ATA. See the header
  //       comment for why this is one transaction and not three.
  const { value: blockhash } = await rpc(rpcUrl, 'getLatestBlockhash', [{ commitment: 'confirmed' }]);
  const { signature, wire, instructionCount } = await buildCreateAtaTransaction({
    signer,
    targets: missing,
    blockhash,
  });

  console.log(`
  ── sending ────────────────────────────────────────────────
  instructions  ${instructionCount} × CreateAssociatedTokenAccountIdempotent
  signature     ${signature}
`);

  // preflight left ON deliberately: a simulation failure here costs nothing,
  // whereas a submitted-and-failed transaction costs the fee and teaches less.
  let sent;
  try {
    sent = await rpc(rpcUrl, 'sendTransaction', [
      wire,
      { encoding: 'base64', skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: 5 },
    ]);
  } catch (err) {
    console.error(`
  SEND FAILED: ${err.message}

  If this names a simulation or preflight failure, the transaction was never
  submitted and nothing was spent — not even the fee. Re-read the ATAs by
  hand if in doubt; the chain is the only witness.
`);
    return 3;
  }
  console.log(`  accepted by the RPC as ${sent}`);

  // ── 5. Confirmation by polling, not by websocket subscription — one less
  //       transport to depend on, and the signature status is the same fact.
  let status = null;
  for (const wait of [2, 3, 4, 5, 6, 8, 10]) {
    await new Promise((r) => setTimeout(r, wait * 1000));
    try {
      const res = await rpc(rpcUrl, 'getSignatureStatuses', [[signature], { searchTransactionHistory: true }]);
      status = res?.value?.[0] ?? null;
    } catch (err) {
      console.log(`  +${wait}s  RPC error: ${err.message}`);
      continue;
    }
    const level = status?.confirmationStatus ?? 'pending';
    console.log(`  +${wait}s  ${level}${status?.err ? `  ERR ${JSON.stringify(status.err)}` : ''}`);
    if (status?.err) break;
    if (level === 'confirmed' || level === 'finalized') break;
  }

  if (status?.err) {
    console.error(`
  THE TRANSACTION FAILED ON-CHAIN: ${JSON.stringify(status.err)}
  The fee was charged; no account was created. Nothing else moved.
`);
    return 3;
  }

  // ── 6. The verdict, read off the chain rather than off the receipt. A
  //       confirmed signature says the transaction landed; only these reads
  //       say the accounts are there.
  console.log(`
  ── verifying on-chain ─────────────────────────────────────`);
  let allExist = true;
  for (const t of targets) {
    let after;
    try {
      after = await readAta(rpcUrl, t.ata);
    } catch (err) {
      console.log(`  ${t.label.padEnd(15)} ${t.ata}  READ FAILED (${err.message})`);
      allExist = false;
      continue;
    }
    const verdict = !after.exists
      ? 'STILL MISSING'
      : t.existedBefore
        ? 'already existed (no-op)'
        : 'CREATED';
    if (!after.exists) allExist = false;
    console.log(`  ${t.label.padEnd(15)} ${t.ata}  ${verdict}`);
  }

  console.log(`
  ── verdict ────────────────────────────────────────────────`);
  if (allExist) {
    console.log(`  ALL THREE USDC ATAs EXIST. tx ${signature}

  The precondition that blocked the first Solana x402 smoke payment
  (preflight_validation_failed on a missing destination ATA) is cleared for
  every estate payTo. Re-run scripts/solana-buyer-pay.mjs --yes to prove the
  rail settles.
`);
    return 0;
  }
  console.log(`  NOT ALL ATAs EXIST after a confirmed transaction — read them by hand
  before re-running. tx ${signature}
`);
  return 3;
}

// Run only when invoked directly, so the helpers above can be imported and
// exercised offline without the banner, the network, or the wallet.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  let code;
  try {
    code = await main(process.argv.slice(2));
  } catch (err) {
    console.error(`\n  ${err.message}

  If the run had not reached the "sending" banner, nothing was signed and
  nothing was spent. If it had, read the three ATAs before assuming either
  way — the chain is the only witness.
`);
    code = 1;
  }
  process.exit(code);
}
