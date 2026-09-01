#!/usr/bin/env node
//
//  ┌──────────────────────────────────────────────────────────────────────┐
//  │  THIS SCRIPT SPENDS REAL MONEY — ONE payment of ~$0.002 USDC on      │
//  │  Solana mainnet, and nothing else. No SOL is spent (the facilitator  │
//  │  is the fee payer), no account is funded, no second call is made.    │
//  │                                                                      │
//  │  It refuses to do anything without --yes. --dry-run needs no wallet  │
//  │  secret at all and stops before any signature exists.                │
//  │                                                                      │
//  │  FOR THE OWNER TO RUN, ONCE, DELIBERATELY. Not for CI, not for a     │
//  │  routine, not for an agent on its own initiative.                    │
//  └──────────────────────────────────────────────────────────────────────┘
//
// WHY THIS EXISTS. Two things, one payment.
//
//   1. PROVE THE RAIL. The toolshed Worker advertises a Solana `accepts`
//      entry alongside the Base one (env-gated on PAYTO_SOLANA). An
//      advertised rail that has never settled is a claim, not a fact. One
//      real buy end to end — sign, verify, settle, arrive — turns it into a
//      fact, the same way the Base rail was proven.
//
//   2. ANSWER THE ATA QUESTION, which scripts/solana-payto-setup.mjs left
//      open. The SVM exact scheme pins the transfer destination to the
//      payTo's canonical USDC associated token account, and the client-built
//      transaction contains a TransferChecked and NOTHING ELSE — no
//      CreateAssociatedTokenAccount instruction (verified by reading
//      @x402/svm 2.23.0's ExactSvmScheme.createPaymentPayload). So if the
//      payTo's ATA does not exist, either the facilitator creates it or the
//      payment cannot land. Nobody's docs say which.
//
//      This script measures it: it reads the payTo's ATA BEFORE paying and
//      again AFTER, and reports the transition. Pre-existing ATA → the
//      question is untested and the script says so. Absent ATA + payment
//      arrives → the facilitator creates it. Absent ATA + payment fails →
//      it does not, and every payTo needs its USDC ATA created once
//      (~0.002 SOL rent each, owner-funded).
//
// WHAT IT COSTS. One call to POST /convert/json-yaml, published at $0.002 =
// 2000 atomic USDC. The client refuses to sign anything above 10000 atomic
// ($0.01) — belt (an explicit pre-signature check on the parsed envelope),
// braces (a registered PaymentPolicy), and suspenders (@x402/core spend
// controls). A hijacked or mispriced envelope is refused before a signature
// exists, not after.
//
// THE PAYMENT PATH, and why this one. Protocol v2 via the official packages:
// @x402/fetch 2.23.0 + @x402/svm 2.23.0's ExactSvmScheme, over an
// @solana/kit TransactionSigner. @x402/fetch reads the v2 `PAYMENT-REQUIRED`
// header first, which is exactly the half of the Worker's dual stack this
// pays on. Only Solana schemes are registered, so the Base entry sitting in
// the same `accepts` array is filtered out by the client before any selector
// runs: this script cannot accidentally pay on Base.
//
// V2 ONLY, DELIBERATELY, and it is not a preference — @x402/svm 2.23.0
// CANNOT pay a v1 envelope, measured here rather than assumed. Registering
// the scheme under the v1 network name and driving it from a v1-only 402
// fails twice: @x402/core hands the scheme the v1 requirements object
// unchanged (client/index.mjs createPaymentPayload), so ExactSvmScheme's
// `BigInt(paymentRequirements.amount)` reads undefined on a v1 entry whose
// field is `maxAmountRequired`; and the payload it returns is
// `{ x402Version, payload }` with no top-level `scheme`/`network`, which is
// not a well-formed v1 payload. Rather than guess a wire format inside a
// script that spends money, this refuses a v1-only Solana offer and says so.
// The Worker emits both envelopes from one `requirements` object, so a
// Solana entry in the body implies one in the header; if that ever stops
// being true, the refusal below is the thing that catches it.
//
// RUN IT (owner, with 1Password injecting the wallet secret):
//
//   node scripts/solana-buyer-pay.mjs --dry-run     # free: probe + parse + ATA read
//
//   CDP_WALLET_SECRET="$(op read 'op://Private/Coinbase/Wallet secret')" \
//     node scripts/solana-buyer-pay.mjs --yes       # spends ~$0.002, once
//
// CDP_API_KEY_ID and CDP_API_KEY_SECRET are read from the repo-root .env
// (the same loader scripts/solana-payto-setup.mjs uses); real env vars win.
// CDP_WALLET_SECRET is deliberately NOT in .env — inject it per run.
//
// THE BUYER KEY NEVER TOUCHES DISK. It is exported from CDP in memory via
// cdp.solana.exportAccount({ name }), decoded, handed to @solana/kit, and
// then both the string and its decoded bytes are zeroed. It is never logged,
// never written, never passed to anything but the signer constructor.
//
// EXIT CODES:  0 paid and arrived · 1 refused, nothing spent · 3 paid and
// something went wrong (read the diagnostics — that is what they are for).

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  address,
  createKeyPairSignerFromBytes,
  createKeyPairSignerFromPrivateKeyBytes,
  getAddressEncoder,
  getBase58Encoder,
  getCompiledTransactionMessageDecoder,
  getProgramDerivedAddress,
} from '@solana/kit';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

// ─────────────────────────────────────────────────────────── constants
//
// Addresses are constants because getting one wrong is a silent wrong
// answer, not an error. USDC mint and the two program ids below are the same
// on every Solana cluster; the CAIP-2 id is mainnet's genesis hash and is
// what @x402/svm 2.23.0 calls SOLANA_MAINNET_CAIP2.

const TARGET_URL = 'https://toolshed.lemon-agent.dev/convert/json-yaml';
const PUBLISHED_ATOMIC = 2000n; // $0.002, from entries.yaml → json-yaml
const MAX_ATOMIC = 10000n; // $0.01 — the client's own hard ceiling

/** A URL safe to print: origin + path, no query string, no userinfo —
 *  a custom SOLANA_RPC_URL often carries a provider API key in either. */
export function redactUrl(raw) {
  try {
    const u = new URL(raw);
    const creds = u.username ? '<redacted>@' : '';
    const q = u.search ? '?<redacted>' : '';
    return `${u.protocol}//${creds}${u.host}${u.pathname}${q}`;
  } catch {
    return '<unparseable rpc url>';
  }
}

const BUYER_NAME = 'house-solana-buyer';
const BUYER_ADDRESS = 'D7f9EifwoMdfwozWDNLFhBGwecVhryc5fs2SxLK93M45';

const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const ATA_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';

const SOLANA_MAINNET_CAIP2 = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
const SOLANA_V1_NETWORK = 'solana';
const DEFAULT_RPC_URL = 'https://api.mainnet-beta.solana.com';

// A derivation the script proves it can do before it trusts itself with it.
// Owner → ATA, for USDC under the SPL Token program. Vector captured from a
// known-good pair; if this ever stops matching, every ATA this script prints
// is suspect and it must not spend.
const ATA_SELF_TEST = {
  owner: 'J7ZvJEspvwP1oRxQZ7mYmNmT22NTm3GWq3t7HEbvPZYx',
  ata: 'iNm7WqUuTmLzWgSgpcCt4ymewQgth13FAjCpk4Mj2JD',
};

// ─────────────────────────────────────────────────────────── helpers

/**
 * The canonical associated token account for (owner, mint) under a token
 * program: a PDA of [owner, tokenProgram, mint] under the ATA program. This
 * is the address the SVM exact scheme pins the transfer destination to, so
 * it is also the only address on which "did the money arrive?" is a
 * meaningful question.
 */
export async function deriveAta(owner, { mint = USDC_MINT, tokenProgram = TOKEN_PROGRAM } = {}) {
  const enc = getAddressEncoder();
  const [ata] = await getProgramDerivedAddress({
    programAddress: address(ATA_PROGRAM),
    seeds: [enc.encode(address(owner)), enc.encode(address(tokenProgram)), enc.encode(address(mint))],
  });
  return ata;
}

/**
 * Run the ATA derivation against the known-good vector. Called on EVERY
 * invocation, before anything else — a derivation that has drifted would
 * make the arrival check quietly meaningless, which is worse than loud.
 */
export async function assertAtaSelfTest() {
  const got = await deriveAta(ATA_SELF_TEST.owner);
  if (got !== ATA_SELF_TEST.ata) {
    throw new Error(
      `ATA self-test FAILED: ${ATA_SELF_TEST.owner} derived ${got}, expected ${ATA_SELF_TEST.ata}.\n` +
        'The derivation is wrong, so the arrival check would be meaningless. Refusing to run.'
    );
  }
  return got;
}

/**
 * Turn whatever cdp.solana.exportAccount() hands back into an @solana/kit
 * TransactionSigner, without ever letting the material land anywhere but
 * these locals.
 *
 * CDP 1.55.0 documents and implements "the full 64-byte private key as a
 * base58 encoded string" (utils/export.js concatenates the 32-byte seed and
 * the derived 32-byte public key, then bs58-encodes). This accepts that AND
 * the three other shapes the same 32/64 bytes could plausibly arrive in,
 * because a wrong guess here is a confusing crash at spend time.
 *
 * The material is zeroed before returning; the caller still gets only a
 * signer. Whether the right key was loaded is settled by comparing
 * signer.address to the expected buyer address — not by trusting the format
 * sniff.
 */
export async function svmSignerFromExportedKey(exported) {
  if (typeof exported !== 'string' || !exported.length) {
    throw new Error(`exportAccount returned ${typeof exported}, expected a non-empty string.`);
  }
  const trimmed = exported.trim();
  const hexBody = trimmed.startsWith('0x') ? trimmed.slice(2) : trimmed;
  // Base58 has no '0', so a 64/128-char all-hex string is hex, not base58.
  const looksHex = /^[0-9a-fA-F]+$/.test(hexBody) && (hexBody.length === 64 || hexBody.length === 128);

  let bytes;
  if (looksHex) {
    bytes = Uint8Array.from(hexBody.match(/../g).map((b) => parseInt(b, 16)));
  } else {
    // @solana/codecs throws a SolanaError that interpolates the INPUT STRING
    // into err.message on any invalid base58 character. The input here is the
    // private key, and the top-level handler prints err.message — so a decode
    // failure must be swallowed and replaced with a message that carries only
    // the length, never the content.
    try {
      bytes = Uint8Array.from(getBase58Encoder().encode(trimmed));
    } catch {
      throw new Error(
        `exported key (${trimmed.length} chars) is neither 64/128-char hex nor valid base58; refusing. ` +
          'The key material was NOT printed.'
      );
    }
  }

  try {
    if (bytes.length === 64) return await createKeyPairSignerFromBytes(bytes);
    if (bytes.length === 32) return await createKeyPairSignerFromPrivateKeyBytes(bytes);
    throw new Error(`exported key decoded to ${bytes.length} bytes; expected 32 or 64.`);
  } finally {
    bytes.fill(0);
  }
}

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

/**
 * The state of one token account: does it exist, and what does it hold?
 * `exists: false` is the interesting answer — it is half of the ATA question.
 */
async function readAta(rpcUrl, ata) {
  const result = await rpc(rpcUrl, 'getAccountInfo', [ata, { encoding: 'jsonParsed', commitment: 'confirmed' }]);
  const value = result?.value;
  if (!value) return { exists: false, atomic: null, ui: null };
  const amount = value?.data?.parsed?.info?.tokenAmount;
  return {
    exists: true,
    atomic: amount?.amount != null ? BigInt(amount.amount) : null,
    ui: amount?.uiAmountString ?? null,
  };
}

const describeAta = (state) =>
  state.exists ? `exists, holds ${state.ui ?? '?'} USDC (${state.atomic ?? '?'} atomic)` : 'DOES NOT EXIST';

/** Decode the v2 `PAYMENT-REQUIRED` header. Returns null rather than throwing. */
function decodePaymentRequiredHeader(raw) {
  if (!raw) return null;
  try {
    return JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

/** v1 calls it maxAmountRequired, v2 calls it amount. Same number. */
const entryAmount = (entry) => entry?.amount ?? entry?.maxAmountRequired ?? null;

const isSolanaV1 = (entry) => entry?.network === SOLANA_V1_NETWORK;
const isSolanaV2 = (entry) => typeof entry?.network === 'string' && entry.network.startsWith('solana:');

const flag = (argv, name) => argv.includes(`--${name}`);
const value = (argv, name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};

/**
 * Fill missing credentials from the repo-root .env (gitignored, owner-written).
 * Real env vars win; values are never logged. Copied verbatim in behaviour
 * from scripts/solana-payto-setup.mjs so the two scripts cannot disagree
 * about where credentials come from.
 */
export function loadRepoEnv() {
  try {
    const envPath = join(ROOT, '.env');
    for (const line of readFileSync(envPath, 'utf8').split('\n')) {
      const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch {
    /* no .env — env vars must carry everything */
  }
}

/**
 * The paying client, and the one place the spend rules live.
 *
 * ONLY THE SOLANA MAINNET SCHEME IS REGISTERED, and only for v2, so the Base
 * entry sitting in the same `accepts` array is filtered out by @x402/core
 * before any selector runs. This client is structurally incapable of paying
 * on Base, which is a stronger guarantee than a policy saying it should not.
 * See the header comment for why there is no registerV1 here.
 *
 * The ceiling appears three times on purpose: the caller checks the parsed
 * envelope before this is even built (belt), `registerPolicy` filters the
 * list the selector sees (braces), and `onBeforePaymentCreation` aborts on
 * the finally-selected requirement (suspenders). @x402/core's own spend
 * controls sit under all three, with their $1 default tightened to $0.01.
 *
 * Exported, and taking its signer as an argument, so the whole wiring can be
 * exercised offline against a throwaway keypair and a local mock without any
 * of it being reachable from a run that has a real wallet open. `state` is
 * the hooks' scratch space: the diagnostics need to know what was selected
 * and what was signed, and only the hooks are told.
 *
 * @param {object} args
 * @param {import('@solana/kit').TransactionSigner} args.signer - the buyer
 * @param {string} args.rpcUrl - Solana RPC the scheme builds against
 * @param {Function} args.x402Client - the @x402/fetch export (injected so this file has no import-time dependency on it)
 * @param {Function} args.ExactSvmScheme - the @x402/svm export, likewise
 * @param {(line: string) => void} [args.log] - where the running commentary goes
 * @returns {{ client: object, state: { selected: object|null, payload: object|null } }}
 */
export function buildPaymentClient({ signer, rpcUrl, x402Client, ExactSvmScheme, log = console.log }) {
  const scheme = new ExactSvmScheme(signer, { rpcUrl });
  const state = { selected: null, payload: null };

  const withinCeiling = (entry) => {
    const amount = entryAmount(entry);
    return amount != null && /^\d+$/.test(String(amount)) && BigInt(amount) <= MAX_ATOMIC;
  };

  const client = new x402Client((_version, reqs) => {
    // Cheapest first, deterministically. By this point the list is already
    // Solana-only and already under the ceiling.
    const sorted = [...reqs].sort((a, b) => (BigInt(entryAmount(a)) < BigInt(entryAmount(b)) ? -1 : 1));
    return sorted[0];
  })
    .register(SOLANA_MAINNET_CAIP2, scheme)
    .registerPolicy((_version, reqs) => reqs.filter(withinCeiling))
    .setSpendControls({ maxAmountPerPayment: '$0.01' })
    .onBeforePaymentCreation(async (ctx) => {
      state.selected = ctx.selectedRequirements;
      const amount = entryAmount(state.selected);
      if (BigInt(amount) > MAX_ATOMIC) {
        return { abort: true, reason: `selected requirement asks ${amount} atomic, above the ${MAX_ATOMIC} ceiling` };
      }
      log(`
  ── signing ────────────────────────────────────────────────
  network  ${state.selected.network}
  amount   ${amount} atomic USDC
  payTo    ${state.selected.payTo}
  feePayer ${state.selected.extra?.feePayer ?? '(none)'}
`);
    })
    .onAfterPaymentCreation(async (ctx) => {
      state.payload = ctx.paymentPayload;
      log(`  signed   x402Version ${state.payload.x402Version}, scheme ${state.selected?.scheme ?? '?'} — sending`);
    })
    .onPaymentCreationFailure(async (ctx) => {
      console.error(`  SIGNING FAILED before anything left this machine: ${ctx.error?.message ?? ctx.error}`);
    })
    .onPaymentResponse(async (ctx) => {
      // The richest diagnostic surface in the whole run. Discriminated the
      // way @x402/core documents it: a settleResponse (success true or
      // false), or a paymentRequired with no settleResponse meaning verify
      // failed, or a transport error.
      if (ctx.settleResponse) {
        log(`  settle   success=${ctx.settleResponse.success} tx=${ctx.settleResponse.transaction ?? '(none)'} network=${ctx.settleResponse.network ?? '?'}`);
        if (ctx.settleResponse.errorReason) log(`  settle   errorReason: ${ctx.settleResponse.errorReason}`);
      }
      if (ctx.paymentRequired && !ctx.settleResponse) {
        console.error(`  VERIFY FAILED — the facilitator refused the payment.`);
        console.error(`  v2 error code (verbatim): ${JSON.stringify(ctx.paymentRequired.error)}`);
      }
      if (ctx.error) console.error(`  transport/parse error: ${ctx.error.message}`);
    });

  return { client, state };
}

// ─────────────────────────────────────────────────────────── main

async function main(argv) {
  // The self-test runs before the banner, before argument parsing does
  // anything consequential, and before any network call. If the tool cannot
  // derive an address it knows the answer to, nothing else it says is worth
  // reading.
  await assertAtaSelfTest();

  const DRY_RUN = flag(argv, 'dry-run');
  const YES = flag(argv, 'yes');
  const url = value(argv, 'url', TARGET_URL);
  const rpcUrl = value(argv, 'rpc', process.env.SOLANA_RPC_URL || DEFAULT_RPC_URL);
  const EXPECTED_ATOMIC = BigInt(value(argv, 'expect-atomic', String(PUBLISHED_ATOMIC)));

  if (!DRY_RUN && !YES) {
    console.error(`
  This script spends real USDC — ONE payment of ~$0.002 on Solana mainnet,
  from the house buyer wallet, to prove the Solana rail settles end to end.

    node scripts/solana-buyer-pay.mjs --dry-run   # probe + parse, spend nothing
    node scripts/solana-buyer-pay.mjs --yes       # do it, once

  Owner-only. See the header comment for the op-injected run command.
`);
    return 1;
  }

  console.log(`
  ── Solana x402 smoke payment ──────────────────────────────
  mode     ${DRY_RUN ? 'DRY RUN — nothing will be spent' : 'LIVE — this spends ~$0.002 of real USDC, once'}
  target   POST ${url}
  buyer    ${BUYER_ADDRESS}  (CDP account "${BUYER_NAME}")
  ceiling  ${MAX_ATOMIC} atomic ($0.01) — will not sign above this
  rpc      ${redactUrl(rpcUrl)}
  ata      self-test ✓ (${ATA_SELF_TEST.owner.slice(0, 8)}… → ${ATA_SELF_TEST.ata.slice(0, 8)}…)
`);

  // ── 1. The free look. Every time, before anything else, and the whole
  //       envelope is parsed from it — both versions. A 402 here proves the
  //       paywall is up; anything else is a state a smoke test must refuse to
  //       touch (429 = no payTo configured, 200 = a free tier is on).
  const probe = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{"probe":true}',
  });
  const probeHeader = decodePaymentRequiredHeader(probe.headers.get('payment-required'));
  let probeBody = null;
  try {
    probeBody = JSON.parse(await probe.text());
  } catch {
    /* a non-JSON 402 body is itself reportable below */
  }

  if (probe.status !== 402) {
    console.error(`  Unpaid probe answered ${probe.status}, expected 402.
  429 means no payTo is configured on the deployment; 200 means a free tier
  is on. Either way there is nothing to prove here. Nothing spent.`);
    return 1;
  }
  console.log(`  probe    402 ✓ paywall up (v1 body ${probeBody ? 'parsed' : 'UNPARSEABLE'}, v2 header ${probeHeader ? 'parsed' : 'absent'})`);

  // ── 2. REQUIRE a Solana entry. This is the gate the whole run hangs on: a
  //       Base-only envelope means PAYTO_SOLANA is unset on the deployment and
  //       there is nothing to test yet.
  const v1Solana = (probeBody?.accepts ?? []).filter(isSolanaV1);
  const v2Solana = (probeHeader?.accepts ?? []).filter(isSolanaV2);
  const allSolana = [...v1Solana, ...v2Solana];

  if (!allSolana.length) {
    const seen = [
      ...(probeBody?.accepts ?? []).map((e) => `v1:${e.network}`),
      ...(probeHeader?.accepts ?? []).map((e) => `v2:${e.network}`),
    ];
    console.error(`
  Solana entry not advertised (PAYTO_SOLANA unset?) — nothing spent.

  The envelope offers: ${seen.length ? seen.join(', ') : '(no accepts entries at all)'}
  Expected a v1 entry with network "solana" or a v2 entry with network
  "${SOLANA_MAINNET_CAIP2}".

  Two causes, and they look identical from out here. Either PAYTO_SOLANA is
  unset on the deployment, or it is set and the Worker's authenticated
  /supported read failed — it fails CLOSED, publishing a Base-only envelope
  rather than an entry with no feePayer. If PAYTO_SOLANA is set, check the
  Worker's CDP credentials and its facilitator reachability before assuming
  the var is the problem.
`);
    return 1;
  }

  for (const e of v1Solana) console.log(`  offer    v1  network=${e.network}  amount=${entryAmount(e)}  payTo=${e.payTo}  asset=${e.asset}`);
  for (const e of v2Solana) console.log(`  offer    v2  network=${e.network}  amount=${entryAmount(e)}  payTo=${e.payTo}  asset=${e.asset}`);

  // The payment rides on v2 and only v2 — see the header comment. A v1-only
  // Solana offer is a real state to refuse loudly rather than to work around
  // by guessing a wire format @x402/svm 2.23.0 does not implement.
  if (!v2Solana.length) {
    console.error(`
  A Solana entry is advertised in the v1 body but NOT in the v2
  PAYMENT-REQUIRED header — nothing spent.

  @x402/svm 2.23.0's client scheme cannot build a v1 payment payload (it
  reads paymentRequirements.amount, which v1 calls maxAmountRequired, and it
  returns a payload with no top-level scheme/network). Paying this would mean
  hand-rolling a wire format inside a script that spends money.

  Fix the Worker so requirementsV2() projects the Solana entry too, then
  re-run. The two envelopes are meant to be one object seen twice.
`);
    return 1;
  }

  // ── 3. Refuse, before a signature can exist, anything the sheet does not
  //       say. Every Solana entry is checked, not just the one that will be
  //       selected, because which one @x402/fetch selects depends on which
  //       envelope the Worker served and this check must not depend on that.
  for (const entry of allSolana) {
    const amount = entryAmount(entry);
    if (amount == null || !/^\d+$/.test(String(amount))) {
      console.error(`  Solana entry has a non-integer amount (${JSON.stringify(amount)}). Refusing. Nothing spent.`);
      return 1;
    }
    if (BigInt(amount) > MAX_ATOMIC) {
      console.error(`
  CEILING. A Solana entry asks ${amount} atomic; this script will not sign
  above ${MAX_ATOMIC} ($0.01). The published price is ${PUBLISHED_ATOMIC}.
  Nothing spent — check the catalogue, or the envelope's provenance.
`);
      return 1;
    }
    if (BigInt(amount) !== PUBLISHED_ATOMIC) {
      // The banner promises "~$0.002 and nothing else" — a differing quote is
      // a refusal, not a note, even under the ceiling. Override deliberately
      // with --expect-atomic <n> after reading the envelope yourself.
      if (BigInt(amount) === EXPECTED_ATOMIC) {
        console.log(`  note     entry asks ${amount} atomic (accepted via --expect-atomic).`);
      } else {
        console.error(`
  PRICE MISMATCH. The entry asks ${amount} atomic; entries.yaml publishes
  ${PUBLISHED_ATOMIC}. Nothing spent. If the quote is legitimate (mid-reprice),
  rerun with --expect-atomic ${amount}.
`);
        return 1;
      }
    }
    if (entry.asset !== USDC_MINT) {
      console.error(`  Solana entry names asset ${entry.asset}, not USDC (${USDC_MINT}). Refusing. Nothing spent.`);
      return 1;
    }
    if (isSolanaV2(entry) && entry.network !== SOLANA_MAINNET_CAIP2) {
      console.error(`  Solana entry names ${entry.network}, not mainnet (${SOLANA_MAINNET_CAIP2}). Refusing. Nothing spent.`);
      return 1;
    }
    if (!entry.extra?.feePayer) {
      console.error(`
  Solana entry carries no extra.feePayer. The SVM exact scheme cannot build a
  transaction without one (@x402/svm ExactSvmScheme.createPaymentPayload
  throws), so this would fail after the wallet was unlocked. Refusing here
  instead. Nothing spent.
`);
      return 1;
    }
  }
  for (const fp of [...new Set(allSolana.map((e) => e.extra.feePayer))]) {
    console.log(`  feePayer ${fp}  (facilitator pays the SOL; the buyer needs none)`);
  }

  // A single payTo across both envelopes is an invariant of the Worker (one
  // `requirements` object projected two ways). If it ever is not, the ATA
  // check would be measuring the wrong account.
  const payTos = [...new Set(allSolana.map((e) => e.payTo))];
  if (payTos.length !== 1) {
    console.error(`  The Solana entries disagree about payTo (${payTos.join(', ')}). Refusing. Nothing spent.`);
    return 1;
  }
  const payTo = payTos[0];

  // ── 4. THE BASELINE, and half the answer to the ATA question. Read before
  //       anything is signed, so the "after" number has something to be
  //       compared against.
  const payToAta = await deriveAta(payTo);
  const buyerAta = await deriveAta(BUYER_ADDRESS);
  const before = await readAta(rpcUrl, payToAta);
  const buyerBefore = await readAta(rpcUrl, buyerAta);

  console.log(`
  ── ATA baseline (before) ──────────────────────────────────
  payTo    ${payTo}
    ata    ${payToAta}
           ${describeAta(before)}
  buyer    ${BUYER_ADDRESS}
    ata    ${buyerAta}
           ${describeAta(buyerBefore)}
`);

  if (!before.exists) {
    console.log(`  ⚑ The payTo's USDC ATA DOES NOT EXIST. This run is the experiment:
    if the payment lands, the CDP facilitator creates missing ATAs; if it
    fails, every payTo needs its ATA created once (~0.002 SOL rent).
`);
  } else {
    console.log(`  ⚑ The payTo's ATA already exists, so this run CANNOT answer the
    "does the facilitator create a missing ATA?" question. It still proves
    the rail settles. (To test the ATA question, point a run at a payTo
    that has never received USDC.)
`);
  }

  // The dearest offer, not the first: the funding check should be the
  // conservative one whichever entry the client ends up selecting.
  const needed = allSolana.map((e) => BigInt(entryAmount(e))).reduce((a, b) => (a > b ? a : b));
  if (!buyerBefore.exists || (buyerBefore.atomic ?? 0n) < needed) {
    console.error(`
  The buyer has no USDC to spend (${buyerBefore.exists ? `${buyerBefore.atomic} atomic` : 'no ATA at all'}),
  and needs ${needed}. Fund ${BUYER_ADDRESS} by withdrawing USDC from
  Coinbase choosing the SOLANA network (~$1 is plenty; the withdrawal
  creates the ATA). No SOL is needed. Nothing spent.
`);
    return 1;
  }

  if (DRY_RUN) {
    console.log(`  Dry run complete. The Solana entry is advertised, priced under the
  ceiling, denominated in USDC, and carries a feePayer; the buyer is funded
  and both ATAs are resolved. Nothing was signed and nothing was spent.

  Re-run with --yes (and CDP_WALLET_SECRET injected) to make the payment.
`);
    return 0;
  }

  // ── 5. Credentials, then the key — in that order, so a missing env var is
  //       a clean refusal rather than a half-opened wallet.
  loadRepoEnv();
  for (const name of ['CDP_API_KEY_ID', 'CDP_API_KEY_SECRET', 'CDP_WALLET_SECRET']) {
    if (!process.env[name]) {
      console.error(`  Missing env var ${name}. See the header comment for the op-injected run command. Nothing spent.`);
      return 1;
    }
  }

  let CdpClient, wrapFetchWithPayment, x402Client, ExactSvmScheme, decodeTransactionFromPayload;
  try {
    ({ CdpClient } = await import('@coinbase/cdp-sdk'));
    ({ wrapFetchWithPayment, x402Client } = await import('@x402/fetch'));
    ({ ExactSvmScheme, decodeTransactionFromPayload } = await import('@x402/svm'));
  } catch (err) {
    console.error(`  Missing a client dependency (${err.message}).\n\n  npm install\n\nNothing spent.`);
    return 1;
  }

  // THE ONLY MOMENT THE KEY EXISTS. Exported in memory, decoded, handed to
  // the signer constructor, then both the string and its bytes are dropped.
  // Nothing here logs, writes, or returns the material.
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

  // The definitive check that the right key was loaded — not the format
  // sniff above, this. A mismatch means the CDP account named
  // "house-solana-buyer" is not the wallet this script is written for, and
  // paying from an unexpected wallet is exactly the thing not to do.
  if (signer.address !== BUYER_ADDRESS) {
    const got = signer.address; // a public key, not a secret — safe to print
    signer = null;
    console.error(`
  The CDP account named "${BUYER_NAME}" exported a key for ${got}, not the
  expected buyer ${BUYER_ADDRESS}. Refusing to pay from an unexpected
  wallet. Nothing spent.
`);
    return 1;
  }
  console.log(`  wallet   unlocked in memory, address matches ✓ (key never touched disk)`);

  // ── 6. The client.
  const { client, state } = buildPaymentClient({ signer, rpcUrl, x402Client, ExactSvmScheme });

  // ── 7. The payment. One request, with a body the endpoint actually
  //       converts — taken from the envelope's own bazaar sample, so this is
  //       a real servable call and never a 400 (which settles nothing).
  // Two estate conventions: toolshed/10x402 publish `bodyType: 'text'` with a
  // JSON *string*; kino402 publishes `bodyType: 'json'` with a JSON *object*.
  // Passing an object to fetch() serializes as "[object Object]" and buys a
  // 400 — stringify it, use a string as-is.
  const rawSample =
    probeHeader?.extensions?.bazaar?.info?.input?.body ?? '{"name":"toolshed","tags":["x402"]}';
  const sampleBody = typeof rawSample === 'string' ? rawSample : JSON.stringify(rawSample);
  console.log(`  body     ${JSON.stringify(sampleBody)}  (from the envelope's bazaar sample)`);

  // TOCTOU guard: wrapFetchWithPayment issues its OWN unpaid probe and signs
  // against THAT 402, not the one validated above. This fetch wrapper re-runs
  // the load-bearing checks on any 402 the client is about to sign against —
  // same asset, mainnet network, a feePayer present, and the exact expected
  // amount — throwing (nothing signed) on any violation.
  const guardedFetch = async (input, init) => {
    const res = await fetch(input, init);
    if (res.status !== 402) return res;
    const hdr = res.headers.get('payment-required');
    if (hdr) {
      try {
        const env2 = JSON.parse(Buffer.from(hdr, 'base64').toString('utf8'));
        const sol2 = (env2.accepts ?? []).filter((e) => isSolanaV2(e));
        for (const e of sol2) {
          if (e.asset !== USDC_MINT) throw new Error(`re-probe 402 names asset ${e.asset}, not USDC`);
          if (e.network !== SOLANA_MAINNET_CAIP2) throw new Error(`re-probe 402 names ${e.network}, not mainnet`);
          if (!e.extra?.feePayer) throw new Error('re-probe 402 lost its feePayer');
          if (BigInt(entryAmount(e)) !== EXPECTED_ATOMIC && BigInt(entryAmount(e)) !== PUBLISHED_ATOMIC) {
            throw new Error(`re-probe 402 asks ${entryAmount(e)} atomic, expected ${EXPECTED_ATOMIC}`);
          }
        }
      } catch (err) {
        if (err instanceof SyntaxError) return res; // undecodable header: let the client refuse it
        throw err;
      }
    }
    return res;
  };

  const payFetch = wrapFetchWithPayment(guardedFetch, client);
  let paid;
  try {
    paid = await payFetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: sampleBody,
    });
  } catch (err) {
    console.error(`
  The paid request threw before or during payment: ${err.message}

  If this says "Failed to create payment payload", nothing was signed and
  nothing was spent. If it says anything about the second request, a
  signature exists but was never accepted — an SVM exact payment moves
  nothing until the facilitator submits it, so an unsubmitted transaction
  costs nothing.
`);
    return 3;
  }

  const verified = paid.headers.get('x-payment-verified');
  const text = await paid.text();

  console.log(`
  ── response ───────────────────────────────────────────────
  status              ${paid.status}
  x-payment-verified  ${verified ?? '(absent)'}
  x-payment-error     ${paid.headers.get('x-payment-error') ?? '(absent)'}
  payment-response    ${paid.headers.get('payment-response') ?? paid.headers.get('x-payment-response') ?? '(absent — expected: this Worker settles AFTER responding and deliberately emits no receipt header)'}
  body                ${JSON.stringify(text.slice(0, 300))}
`);

  // ── 8. Failure diagnostics. These matter more than the success path: this
  //       is the debugging surface for the entire rail, and the facilitator's
  //       own words are the only thing worth printing.
  if (paid.status !== 200 || verified !== 'true') {
    let failBody = null;
    try {
      failBody = JSON.parse(text);
    } catch {
      /* the raw body above is what there is */
    }
    const failHeader = decodePaymentRequiredHeader(paid.headers.get('payment-required'));

    console.error(`  ── FAILURE DIAGNOSTICS ────────────────────────────────────`);
    console.error(`  invalidReason (v1, verbatim):  ${JSON.stringify(failBody?.invalidReason ?? null)}`);
    console.error(`  invalidMessage (v1, verbatim): ${JSON.stringify(failBody?.invalidMessage ?? null)}`);
    console.error(`  error (v1):                    ${JSON.stringify(failBody?.error ?? null)}`);
    console.error(`  error code (v2 header):        ${JSON.stringify(failHeader?.error ?? null)}`);
    console.error(`  network the client used:       ${state.selected?.network ?? '(never selected one)'}`);
    console.error(`  feePayer the client used:      ${state.selected?.extra?.feePayer ?? '(none)'}`);
    console.error(`  payTo the client paid:         ${state.selected?.payTo ?? '(none)'}`);
    console.error(`  amount signed:                 ${state.selected ? entryAmount(state.selected) : '(none)'} atomic`);
    console.error(`  buyer:                         ${BUYER_ADDRESS}`);

    // The on-wire fee payer, read back out of the transaction that was
    // actually signed — which is the one number that can disagree with the
    // envelope and explain a facilitator rejection.
    try {
      if (state.payload?.payload?.transaction) {
        const tx = decodeTransactionFromPayload(state.payload.payload);
        const message = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
        console.error(`  fee payer ON THE WIRE:         ${message.staticAccounts?.[0] ?? '(undecodable)'}`);
        console.error(`  signatures present for:        ${Object.keys(tx.signatures ?? {}).join(', ') || '(none)'}`);
      }
    } catch (err) {
      console.error(`  (could not decode the signed transaction for diagnostics: ${err.message})`);
    }

    console.error(`
  NOTE ON EXPOSURE: an SVM exact payment is a partially-signed transaction
  that moves nothing until the facilitator submits it. A verify failure or a
  non-200 means it was never submitted — at most one price is in flight, and
  the ATA poll below says definitively whether anything moved.
`);
  } else {
    console.log(`  PAID ✓ 200, x-payment-verified: true — the conversion was served.`);
  }

  // ── 9. Did the money actually arrive? The Worker settles in
  //       ctx.waitUntil AFTER responding (~2 s), so a 200 is a verify
  //       receipt, not a settlement receipt. The chain is the only witness.
  console.log(`
  ── polling the payTo ATA for arrival ──────────────────────
  ${payToAta}`);
  const backoff = [2, 3, 4, 5, 6, 8, 10, 12];
  let after = before;
  let arrived = false;
  for (const wait of backoff) {
    await new Promise((r) => setTimeout(r, wait * 1000));
    try {
      after = await readAta(rpcUrl, payToAta);
    } catch (err) {
      console.log(`  +${wait}s  RPC error: ${err.message}`);
      continue;
    }
    // Strict balance growth — an ATA that newly exists with a ZERO balance is
    // NOT arrival (that would be a verified-but-unsettled edge, and reporting
    // it as success would falsify the one question this script answers).
    const grew = after.exists && (after.atomic ?? 0n) > (before.exists ? (before.atomic ?? 0n) : 0n);
    console.log(`  +${wait}s  ${describeAta(after)}${grew ? '  ← ARRIVED' : ''}`);
    if (grew) {
      arrived = true;
      break;
    }
  }

  // ── 10. The verdict, including the answer to the ATA question this run
  //        was designed to settle.
  const delta = after.exists && before.exists ? (after.atomic ?? 0n) - (before.atomic ?? 0n) : after.atomic ?? 0n;

  console.log(`
  ── verdict ────────────────────────────────────────────────`);
  if (arrived) {
    console.log(`  RAIL PROVEN. ${delta} atomic USDC arrived at the payTo's ATA.
  The Solana rail verifies and settles end to end.`);
  } else {
    console.log(`  NOTHING ARRIVED within ${backoff.reduce((a, b) => a + b, 0)}s.
  If the response above was a 200 with x-payment-verified: true, settlement
  runs behind the response and may simply be slower than this poll — re-read
  the ATA by hand before concluding it failed:
    ${payToAta}`);
  }

  console.log(`
  ── the ATA question ───────────────────────────────────────`);
  if (before.exists) {
    console.log(`  UNANSWERED by this run: the payTo's ATA already existed before the
  payment, so nothing here shows whether the facilitator would have created
  a missing one. Run this against a never-funded payTo to settle it.`);
  } else if (arrived) {
    console.log(`  ANSWERED — YES. The payTo's ATA did not exist before the payment and
  holds ${after.ui ?? '?'} USDC after it. The CDP facilitator creates a
  missing associated token account. payTo accounts need no pre-funding.`);
  } else {
    console.log(`  ANSWERED — NO (pending the caveat above). The payTo's ATA did not exist
  before the payment and ${after.exists ? 'still holds nothing' : 'still does not exist'} after it. The facilitator does
  NOT create a missing associated token account: every payTo needs its USDC
  ATA created once (~0.002 SOL rent each, owner-funded) before it can be
  advertised. Re-check by hand before acting on this if the failure
  diagnostics above name a different cause.`);
  }
  console.log('');

  return paid.status === 200 && verified === 'true' && arrived ? 0 : 3;
}

// Run only when invoked directly, so the helpers above can be imported and
// exercised offline without the banner, the network, or the wallet.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  let code;
  try {
    code = await main(process.argv.slice(2));
  } catch (err) {
    // The paid request has its own try/catch, so an escape from here is
    // almost always a pre-payment failure — but "almost" is not a thing to
    // assert about money. Print the message rather than a stack trace, and
    // name the one address that settles the question either way.
    console.error(`\n  ${err.message}

  If the run had not reached the "signing" banner, nothing was signed and
  nothing was spent. If it had, check the payTo's USDC ATA before assuming
  either way — the chain is the only witness.
`);
    code = 1;
  }
  process.exit(code);
}
