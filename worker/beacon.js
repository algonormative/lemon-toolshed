// Toolshed API Worker.
//
// Three routes, and they are metered very differently:
//
//   POST /b            the beacon. Two event types, rows ~200 bytes. Unchanged
//                      from the beacon-only Worker this file grew out of — same
//                      rungs, same salt, same writes.
//   GET  /check        availability lookup over the catalog compiled into this
//                      bundle at build time (worker/catalog.generated.js). No
//                      fetch, no KV, no D1 — so it is cheap, and it is exempt
//                      from the rungs below.
//   POST /convert/<id> the hosted conversions. Metered on their OWN budget — the
//                      free tier below — with rung 2 as the outer bound.
//
// The file keeps its name because the beacon is still the thing that has to keep
// working byte-for-byte; the conversions grew around it.
//
// Rungs (dossier § Limits):
//   0  edge rate-limiting rule, 5 req / 10 s per IP, action block  [dashboard, not here]
//      NOTE: the rule's expression must cover /b AND /convert/* — see README § Deploy.
//   1  per-identifier token count, 100 events / identifier / UTC day   [below]
//      /b ONLY. Convert rows are excluded from the count, so a busy converting
//      caller no longer spends the beacon's budget, and vice versa.
//   1c the conversion free tier, FREE_TIER_DAILY calls / caller / UTC day  [below]
//      Its caller key is hash(daily salt + IP) with NO user-agent, on purpose:
//      rotating a UA string must not mint a fresh allowance. A second identity
//      costs a second IP, which is the cheapest spoof-resistance available here.
//   2  global fail-closed, 200,000 events / UTC day                    [below]
//   3  the residual — priced, not bounded by mechanism; detective controls
//      are the $25 billing alert plus the route-disable runbook in README.md
//
// CPU is metered separately from requests, so every reject path stays
// CPU-minimal: method, path and size are checked before any body read, any
// crypto, any D1, and before any conversion runs.
//
// Where /b and /convert differ on failure: /b drops silently (metrics loss is
// the acceptable failure), /convert fails CLOSED with a 503 when the rate-limit
// store is unreachable. Failing open on a metered endpoint is the runaway-cost
// scenario rung 3 has no mechanism for, so an unavailable limiter means no
// conversions rather than unlimited conversions.
//
// No `scheduled` handler by design — zero crons. The salt rotates lazily on the
// first request of a new UTC day; blocklist expiry and the 90-day events prune
// are operator queries, documented in README.md.

import { marked } from 'marked';
import yaml from 'js-yaml';
import TurndownService from 'turndown';
import domino from '@mixmark-io/domino';
// FREE_TIER_DAILY is generated, not typed here: it lives in build.mjs and is
// compiled into catalog.generated.js, so the number the page advertises, the
// number catalog.json publishes and the number enforced below cannot drift
// apart. OWNER-TUNABLE — edit build.mjs and rebuild.
import { CATALOG, SITE_BASE, FREE_TIER_DAILY } from './catalog.generated.js';

const MAX_BODY = 1024; // bytes; a legitimate beacon body is ~40
const MAX_ENTRY_ID = 64;
const RUNG1_PER_ID_PER_DAY = 100;
const RUNG2_GLOBAL_PER_DAY = 200_000;

// The paid ceiling. A runaway bound, NOT a quota to advertise: it is deliberately
// absent from the catalog, the page and the machine files, because publishing it
// would read as a promise. OWNER-TUNABLE.
const PAID_DAILY = 5000;

const SECONDS_PER_DAY = 86_400;

const MAX_CONVERT_BODY = 256 * 1024; // 256 KB
const MAX_QUERY_LEN = 64;

// USDC on Base, 6 decimals. $0.001 is therefore "1000" atomic units.
const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const USDC_DECIMALS = 6;
const X402_TIMEOUT_SECONDS = 60;

// The EIP-712 domain of that contract, carried in the envelope's `extra`.
//
// This is NOT decoration, and getting it wrong is silent: the client signs the
// TransferWithAuthorization typed-data over a domain built from `extra.name`
// and `extra.version`, and the facilitator recomputes that domain to recover
// the signer. x402's own client reads `paymentRequirements.extra?.name` with NO
// fallback, while the verifier falls back to its per-chain table — so an
// envelope that omits `extra` makes the client sign over `name: undefined`, the
// verifier check against "USD Coin", and EVERY real payment come back
// `invalid_exact_evm_payload_signature`. The values are the ones x402's
// getDefaultAsset() emits for chain 8453.
//
// "USD Coin", not "USDC": the token's on-chain name() differs from its ticker,
// and the EIP-712 domain uses the name.
const USDC_BASE_EIP712 = { name: 'USD Coin', version: '2' };

// The CDP x402 facilitator. Overridable so the suite can point it at a mock;
// the default is the documented production endpoint (README § Settlement).
const DEFAULT_FACILITATOR_URL = 'https://api.cdp.coinbase.com/platform/v2/x402';

// Verify is on the critical path — the caller is waiting — so it gets a hard
// 2 s cap and an unreachable facilitator costs availability, not the request.
// Settle runs after the response in ctx.waitUntil, so it can afford to wait for
// a Base confirmation (~2 s typical) without anyone noticing.
const VERIFY_TIMEOUT_MS = 2_000;
const SETTLE_TIMEOUT_MS = 20_000;

// CDP bearer tokens are minted per call and live 120 s, matching @coinbase/cdp-sdk.
const CDP_JWT_TTL_SECONDS = 120;

// Self-declared bots only. No claim to perfect human detection is made.
const BOT_UA = /bot|crawl|spider|slurp|headless/i;

const CORS = { 'access-control-allow-origin': '*' };

// Every outcome on the /b path answers 204 — accepted, rate-limited, bot-dropped
// and malformed are indistinguishable from outside, so the response leaks no state.
const noContent = () => new Response(null, { status: 204, headers: CORS });

const json = (body, status = 200, headers = {}) =>
  new Response(`${JSON.stringify(body)}\n`, {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });

export default {
  // `ctx` is threaded through for exactly one thing: ctx.waitUntil, which lets
  // /convert answer the caller and settle the payment afterwards. Nothing on
  // the /b path uses it.
  async fetch(request, env, ctx) {
    const path = new URL(request.url).pathname;
    if (path === '/check') return handleCheck(request);
    if (path.startsWith('/convert/')) return handleConvert(request, env, path, ctx);
    return handleBeacon(request, env, path);
  },
};

// ------------------------------------------------------------------ /b
//
// Unchanged. The guards, the order of the rung checks, the salt handling and the
// two writes are the same as they were when this was the only route.

async function handleBeacon(request, env, path) {
  // --- reject path: no body read, no crypto, no D1 -----------------------
  if (request.method !== 'POST') return new Response(null, { status: 405 });
  if (path !== '/b') return new Response(null, { status: 404 });

  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_BODY) return noContent();

  const ua = request.headers.get('user-agent') || '';
  if (BOT_UA.test(ua)) return noContent();

  // --- parse -------------------------------------------------------------
  let body;
  try {
    const raw = await request.text();
    if (raw.length > MAX_BODY) return noContent();
    body = JSON.parse(raw);
  } catch {
    return noContent();
  }
  if (!body || typeof body !== 'object') return noContent();

  const type = body.t;
  if (type !== 'visit' && type !== 'click') return noContent();

  let entry = null;
  if (body.e != null) {
    if (typeof body.e !== 'string' || body.e.length > MAX_ENTRY_ID) return noContent();
    entry = body.e;
  }

  const db = env.DB;
  if (!db) return noContent();

  const now = Math.floor(Date.now() / 1000);
  const day = new Date(now * 1000).toISOString().slice(0, 10); // UTC
  const dayStart = Math.floor(Date.parse(`${day}T00:00:00Z`) / 1000);

  try {
    // --- identity: day-scoped, unlinkable once the salt is overwritten ----
    const salt = await currentSalt(db, day);
    const ip = request.headers.get('cf-connecting-ip') || '';
    const idHash = await truncatedHash(salt + ip + ua);

    // --- rungs 1 and 2 -----------------------------------------------------
    if (await rungsExceeded(db, idHash, day, dayStart)) return noContent();

    // --- write ------------------------------------------------------------
    // Coarse referrer class only. The raw referrer is never stored.
    await recordEvent(db, { now, day, type, idHash, entry, refClass: classifyReferer(request) });
  } catch {
    // Metrics loss is the acceptable failure. Never surface store state.
    return noContent();
  }

  return noContent();
}

// ------------------------------------------------------------------ /check
//
// A pure in-memory filter over the compiled catalog. No D1, so no rungs.
// Matching is field-BOUND: `from` is tested against the have side only, `to`
// against the need side only, both as case-insensitive substrings. With no
// parameters at all, the answer is every hosted entry.

function handleCheck(request) {
  if (request.method !== 'GET') {
    return json({ error: 'GET only' }, 405, { ...CORS, allow: 'GET' });
  }

  const params = new URL(request.url).searchParams;
  const from = params.get('from');
  const to = params.get('to');
  if ((from && from.length > MAX_QUERY_LEN) || (to && to.length > MAX_QUERY_LEN)) {
    return json({ error: `from and to are limited to ${MAX_QUERY_LEN} characters` }, 400, CORS);
  }

  const f = from ? from.trim().toLowerCase() : '';
  const t = to ? to.trim().toLowerCase() : '';

  const matches =
    !f && !t
      ? CATALOG.filter((e) => e.hosted)
      : CATALOG.filter(
          (e) => (!f || e.x.toLowerCase().includes(f)) && (!t || e.y.toLowerCase().includes(t))
        );

  return json(
    {
      query: { from: from ?? null, to: to ?? null },
      matches: matches.map((e) => ({
        id: e.id,
        x: e.x,
        y: e.y,
        hosted: e.hosted,
        local: e.local,
        url: e.url,
      })),
    },
    200,
    CORS
  );
}

// ------------------------------------------------------------------ /convert
//
// Order of checks is the reject discipline: method, then whether the id exists,
// then the declared size — all before the rate-limit round trip, the body read
// and the conversion itself.

async function handleConvert(request, env, path, ctx) {
  if (request.method !== 'POST') {
    return json({ error: 'POST the input as the request body' }, 405, { allow: 'POST' });
  }

  const id = path.slice('/convert/'.length);
  const entry = HOSTED.get(id);
  if (!entry) return json({ error: `no hosted conversion with id "${id}" — see GET /check` }, 404);

  const conv = CONVERTERS[id];
  if (!conv) return json({ error: `conversion "${id}" is listed but not implemented` }, 501);

  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_CONVERT_BODY) return tooLarge();

  // --- the conversion budget ---------------------------------------------
  const db = env.DB;
  if (!db) return json({ error: 'conversion is unavailable' }, 503);

  const now = Math.floor(Date.now() / 1000);
  const day = new Date(now * 1000).toISOString().slice(0, 10); // UTC
  const dayStart = Math.floor(Date.parse(`${day}T00:00:00Z`) / 1000);

  // The paid tier needs BOTH halves: an address to pay to, and a payment
  // presented. Either alone leaves the caller on the free tier.
  const payTo = env.PAYTO || '';
  const presented = !!request.headers.get('x-payment');

  // What the response will say about payment, decided below and rendered by
  // servedHeaders(). `settle` is the deferred half of a verified payment.
  let tier = { kind: 'free', remaining: 0, presented };
  let settle = null;

  try {
    const salt = await currentSalt(db, day);
    const ip = request.headers.get('cf-connecting-ip') || '';
    const ua = request.headers.get('user-agent') || '';

    // TWO identities, and the difference is the whole spoof-resistance argument:
    //   ipHash  the quota key — salt + IP, NO user-agent. A rotated UA string
    //           must not mint a fresh free allowance; a fresh identity has to
    //           cost a fresh IP.
    //   idHash  the measurement identity written to `events` — salt + IP + UA,
    //           unchanged, so that column keeps the meaning schema.sql documents
    //           and the beacon's rung-1 identifier space is untouched.
    const ipHash = await truncatedHash(salt + ip);
    const idHash = await truncatedHash(salt + ip + ua);

    // Rung 2 is still the outer bound over every route, and it is read first:
    // a doomsday day should not spend anyone's daily allowance.
    if (await globalExceeded(db, day)) {
      return json({ error: 'daily call limit reached' }, 429);
    }

    // THE FREE TIER IS CLAIMED FIRST, ALWAYS — and that ordering is the whole
    // "never bill inside the free tier" rule, expressed as control flow rather
    // than as a promise. A caller with allowance left takes this branch and the
    // facilitator is never reached, whatever it presented; the payment path
    // below is only reachable once the free claim has actually failed.
    //
    // It also fixes what the ceiling keys on. It used to key on the PRESENCE of
    // an X-PAYMENT header, so any caller that sent one got PAID_DAILY (5,000)
    // instead of 10 — a pre-facilitator placeholder that let an unverified
    // claim buy a 500x higher ceiling for free. Now the higher ceiling is
    // claimed only after the facilitator says isValid, further down.
    const free = await claimConvertQuota(db, day, ipHash, FREE_TIER_DAILY);

    if (free !== null) {
      tier = { kind: 'free', remaining: FREE_TIER_DAILY - free, presented };
    } else {
      // OVER THE FREE TIER. Without somewhere to pay, or without a payment,
      // there is nothing to verify and the answer is the 402/429 as before.
      if (!payTo || !presented) return overQuota(entry, conv, { payTo, now, dayStart });

      const price = entry.hosted.price;
      const requirements = paymentRequirements(entry, conv, price, payTo);
      const verdict = await verifyPayment(request, env, requirements);

      // REJECTED. No conversion is served, so no quota is claimed and no event
      // is written — and the 402 names why, so the caller can fix it.
      if (verdict.rejected) {
        await recordSettlementSafely(db, {
          now,
          tool: id,
          payer: verdict.payer,
          amount: requirements.maxAmountRequired,
          verifyOk: 0,
          settleOk: 0,
          txHash: null,
          error: verdict.reason,
        });
        return paymentRequired(requirements, {
          error: 'the payment presented was not accepted',
          invalidReason: verdict.reason,
          invalidMessage: verdict.message ?? null,
        });
      }

      // Past this point the conversion WILL be served, so claim against the
      // runaway bound. That is the outer limit on both remaining branches.
      const paidUsed = await claimConvertQuota(db, day, ipHash, PAID_DAILY);
      if (paidUsed === null) return paidCeilingReached({ now, dayStart });

      if (verdict.verified) {
        tier = { kind: 'paid', presented };
        settle = { requirements, payload: verdict.payload, payer: verdict.payer, tool: id };
      } else {
        // UNREACHABLE / UNCONFIGURED. Availability-first: the price is a signal
        // until the payment infrastructure is reliable, so the caller is served
        // rather than turned away for our dependency's outage — and the
        // response says plainly that nothing was checked.
        tier = { kind: 'unverified', presented, error: publicReason(verdict.unavailable) };
        await recordSettlementSafely(db, {
          now,
          tool: id,
          payer: verdict.payer,
          amount: requirements.maxAmountRequired,
          verifyOk: 0,
          settleOk: 0,
          txHash: null,
          error: verdict.unavailable,
        });
      }
    }

    // One row per accepted call: that a call happened, and which tool. The input
    // is never written. These rows are MEASUREMENT now — convert_quota is what
    // rate-limits conversions — so they no longer spend the beacon's rung-1
    // budget, and beacon events no longer spend conversions. Separate budgets.
    await recordEvent(db, {
      now,
      day,
      type: 'convert',
      idHash,
      entry: id,
      refClass: classifyReferer(request),
    });
  } catch {
    // Fail closed: an unreachable limiter means no conversions, not unlimited ones.
    return json({ error: 'conversion is unavailable' }, 503);
  }

  // --- read, convert -----------------------------------------------------
  let input;
  try {
    const buf = await request.arrayBuffer();
    if (buf.byteLength > MAX_CONVERT_BODY) return tooLarge();
    input = new TextDecoder().decode(buf);
  } catch {
    return json({ error: 'could not read the request body' }, 400);
  }
  if (!input.trim()) return json({ error: 'the request body is empty' }, 400);

  let output;
  try {
    output = conv.run(input);
  } catch (err) {
    if (err instanceof ConvertError) return json({ error: err.message }, 400);
    // Never surface a stack trace. Anything unexpected is still the input's
    // most likely cause, so it is reported as a bad request, not as a crash.
    return json({ error: `could not convert the input: ${oneLineMessage(err)}` }, 400);
  }

  // SETTLE AFTER RESPONDING, never before. The caller has paid for a
  // conversion, not for a chain confirmation, so the ~2 s settlement runs in
  // ctx.waitUntil and its outcome lands in `settlements` rather than in this
  // response. A settlement that fails here is the accepted exposure: one
  // conversion served for $0.001 that never arrived, recorded as settle_ok = 0.
  if (settle) {
    const work = settleAndRecord(env, db, settle);
    if (ctx?.waitUntil) ctx.waitUntil(work);
    else await work; // no ctx (direct invocation): correctness over latency
  }

  return new Response(output, {
    status: 200,
    headers: { 'content-type': conv.contentType, ...servedHeaders(tier) },
  });
}

const tooLarge = () =>
  json({ error: `input is larger than the ${MAX_CONVERT_BODY / 1024} KB limit` }, 413);

// ------------------------------------------------------------------ tiers & x402
//
// Every hosted tool is priced, and every hosted tool is free to try:
// FREE_TIER_DAILY calls per caller per UTC day, no login. What happens on call
// FREE_TIER_DAILY + 1 is the only question, and it has two answers:
//
//   PAYTO unset (today)  → HTTP 429. There is nowhere to pay yet, so the answer
//                          says exactly that instead of sending a 402 nobody can
//                          satisfy.
//   PAYTO set            → HTTP 402 with a spec-valid x402 v1 envelope: pay to
//                          continue.
//
// Inside the free tier the conversion is simply served, with the count that is
// left in `x-free-tier-remaining`.
//
// Settlement IS implemented now, against the CDP facilitator, and the three
// outcomes past the free tier are distinct:
//
//   verified            → the conversion, `x-payment-verified: true`, and the
//                         on-chain settlement runs after the response
//   rejected            → 402 with the envelope AND the facilitator's
//                         invalidReason, so the caller can see what to fix
//   facilitator down    → the conversion, `x-payment-verified: false` and
//                         `x-payment-error`. Availability-first, on purpose:
//                         at $0.001 a call the price is a signal, and turning
//                         paying callers away because OUR dependency is down is
//                         the worse failure. Every one of these is recorded.
//
// The rule that has not changed, and is the one worth protecting: NOTHING IS
// EVER FAKE-VERIFIED. `x-payment-verified: true` appears only after a
// facilitator round trip that returned isValid.

function servedHeaders({ kind, presented, remaining, error }) {
  const headers = {};
  if (kind === 'free') {
    // The free tier's promise, made checkable on every call.
    headers['x-free-tier-remaining'] = String(Math.max(0, remaining));
    // The free tier is not a payment path: a payment presented inside it is
    // neither checked nor charged, and the response says so rather than
    // implying the header did something.
    if (presented) headers['x-payment-verified'] = 'false';
  } else if (kind === 'paid') {
    headers['x-payment-verified'] = 'true';
  } else {
    // Served, over the tier, unverified.
    headers['x-payment-verified'] = 'false';
    headers['x-payment-error'] = error;
    headers['x-pricing'] = 'pending';
  }
  return headers;
}

function overQuota(entry, conv, { payTo, now, dayStart }) {
  // Seconds to the next UTC midnight, which is when every counter resets.
  const retryAfter = String(Math.max(1, dayStart + SECONDS_PER_DAY - now));

  const price = entry.hosted.price;
  if (payTo && price !== 'free') {
    return paymentRequired(paymentRequirements(entry, conv, price, payTo), {
      error: 'X-PAYMENT header is required',
    });
  }

  return json(
    {
      error: `free tier is ${FREE_TIER_DAILY} conversions per day per caller`,
      free_tier_daily: FREE_TIER_DAILY,
      paid_tier: 'per-call USDC via x402 — activating soon',
      retry: 'tomorrow UTC',
    },
    429,
    { 'retry-after': retryAfter }
  );
}

// The paid ceiling is a runaway bound, not a price gate. A caller that already
// paid cannot buy its way past it, so answering 402 "pay to continue" would be a
// lie; it gets the plain rate-limit answer instead.
function paidCeilingReached({ now, dayStart }) {
  return json(
    { error: 'the daily conversion ceiling for this caller is reached', retry: 'tomorrow UTC' },
    429,
    {
      'retry-after': String(Math.max(1, dayStart + SECONDS_PER_DAY - now)),
      'x-payment-verified': 'false',
    }
  );
}

/**
 * The x402 paymentRequirements for one tool — ONE definition, used by both the
 * 402 envelope and the facilitator calls.
 *
 * They have to be the same object down to the last field. The client signs a
 * payment against what the envelope advertised, and the facilitator recovers
 * that signature against what we send it; any field that differs between the
 * two makes a perfectly good payment verify as invalid. Building them in one
 * place is the only way that drift cannot happen.
 */
function paymentRequirements(entry, conv, price, payTo) {
  return {
    scheme: price.scheme || 'exact',
    network: 'base',
    maxAmountRequired: atomicAmount(price.amount_usd),
    resource: `${SITE_BASE}${entry.hosted.path}`,
    description: conv.description,
    mimeType: conv.mimeType,
    payTo,
    maxTimeoutSeconds: X402_TIMEOUT_SECONDS,
    asset: USDC_BASE,
    // The EIP-712 domain the client must sign over — see USDC_BASE_EIP712.
    extra: USDC_BASE_EIP712,
  };
}

/** 402, carrying the envelope plus whatever we can say about why. */
function paymentRequired(requirements, fields) {
  return json({ x402Version: 1, ...fields, accepts: [requirements] }, 402);
}

const atomicAmount = (usd) => String(Math.round(usd * 10 ** USDC_DECIMALS));

// ------------------------------------------------------------------ facilitator
//
// The CDP x402 facilitator does the two things this Worker cannot: it checks
// that a signed payment is good (verify) and it puts the transfer on chain
// (settle). Both are one POST with the same body — `{ x402Version,
// paymentPayload, paymentRequirements }` — and both are authenticated with a
// short-lived CDP bearer JWT.
//
// WHY THE JWT IS BUILT HERE rather than by @coinbase/x402: that package exists,
// and it is 40 lines of glue over `generateJwt` from @coinbase/cdp-sdk, which
// drags in viem, zod and the whole CDP SDK for one Ed25519 signature. Those are
// production dependencies in a Worker bundle. What follows is the same JWT —
// same header, same claims, same key handling as cdp-sdk's buildEdwardsJWT —
// using WebCrypto, which workerd has natively. It adds no dependency at all.
// Verified against the SDK source and the CDP auth docs; see README § Settlement.

/**
 * Ask the facilitator whether a presented payment is good.
 *
 * NEVER THROWS — every failure is a verdict, because the caller is mid-request
 * and an exception here would become a 503 for something that should be served.
 * Returns exactly one of:
 *   { verified: true, payload, payer }   isValid — serve, then settle
 *   { rejected: true, reason, message }  the facilitator said no — 402
 *   { unavailable: '<reason>' }          we could not ask — serve, unverified
 */
async function verifyPayment(request, env, requirements) {
  const decoded = decodePaymentHeader(request.headers.get('x-payment'));
  // A header we cannot even decode is the caller's bug, not an outage: there is
  // nothing to send the facilitator, so it is a rejection rather than a serve.
  if (!decoded) {
    return {
      rejected: true,
      reason: 'malformed_payment_header',
      message: 'X-PAYMENT must be base64-encoded JSON — an x402 payment payload',
      payer: null,
    };
  }

  const payer = payerOf(decoded);
  if (!env.CDP_API_KEY_ID || !env.CDP_API_KEY_SECRET) {
    // Operator error, not a caller error, and distinct from a network failure
    // so the settlements table says which one to go fix.
    return { unavailable: 'facilitator-unconfigured', payer };
  }

  const call = await facilitatorCall(env, 'verify', decoded, requirements, VERIFY_TIMEOUT_MS);
  if (!call.ok) return { unavailable: call.reason, payer };

  const data = call.data;
  if (data?.isValid === true) return { verified: true, payload: decoded, payer: data.payer || payer };
  if (data?.isValid === false) {
    return {
      rejected: true,
      reason: data.invalidReason || 'unspecified',
      message: data.invalidMessage || null,
      payer: data.payer || payer,
    };
  }

  // A 200 that is not a VerifyResponse means the facilitator is broken, which is
  // an outage — not evidence against the payment. Serve, and record it.
  return { unavailable: 'facilitator-error', payer };
}

/**
 * Settle a verified payment and write the ledger row. Runs after the response.
 *
 * Never throws, for the same reason as above and one more: it runs inside
 * ctx.waitUntil, where an exception is invisible.
 */
async function settleAndRecord(env, db, { requirements, payload, payer, tool }) {
  let settleOk = 0;
  let txHash = null;
  let error = null;

  try {
    const call = await facilitatorCall(env, 'settle', payload, requirements, SETTLE_TIMEOUT_MS);
    if (!call.ok) {
      error = call.reason;
    } else if (call.data?.success === true) {
      settleOk = 1;
      txHash = call.data.transaction || null;
    } else {
      error = call.data?.errorReason || 'settle_failed';
    }
  } catch (err) {
    error = oneLineMessage(err);
  }

  try {
    await recordSettlement(db, {
      now: Math.floor(Date.now() / 1000),
      tool,
      payer,
      amount: requirements.maxAmountRequired,
      verifyOk: 1, // it got here, so verify said yes
      settleOk,
      txHash,
      error,
    });
  } catch {
    // The response shipped a long time ago. A lost ledger row is bad, but
    // throwing into waitUntil helps nobody.
  }
}

/**
 * One POST to the facilitator. Returns { ok: true, data } or { ok: false, reason }.
 *
 * The body shape is the x402 spec's, and matches what `useFacilitator` in the
 * `x402` package sends, field for field.
 */
async function facilitatorCall(env, endpoint, payload, requirements, timeoutMs) {
  const base = (env.FACILITATOR_URL || DEFAULT_FACILITATOR_URL).replace(/\/+$/, '');
  const url = `${base}/${endpoint}`;

  let authorization;
  try {
    authorization = await cdpAuthHeader(env, 'POST', url);
  } catch {
    // A key that will not import is a configuration fault, not an outage, but
    // it fails the same way for the caller: we cannot ask.
    return { ok: false, reason: 'facilitator-unconfigured' };
  }

  // AbortController rather than AbortSignal.timeout so the timer is cleared on
  // the happy path instead of being left to fire into a finished request.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization },
      body: JSON.stringify({
        x402Version: payload.x402Version ?? 1,
        paymentPayload: payload,
        paymentRequirements: requirements,
      }),
      signal: controller.signal,
    });
    // Anything but a 200 is the facilitator's problem, including a 4xx that
    // says OUR request was wrong — which is why these are recorded rather than
    // silently swallowed. A run of them in `settlements` is the alarm.
    if (res.status !== 200) return { ok: false, reason: `facilitator-http-${res.status}` };
    return { ok: true, data: await res.json() };
  } catch (err) {
    // Abort, DNS, TLS, connection refused, unparseable JSON — one bucket, and
    // it is the one the availability-first rule is written for.
    return { ok: false, reason: err?.name === 'AbortError' ? 'facilitator-timeout' : 'facilitator-unreachable' };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * `Authorization: Bearer <CDP JWT>`, or undefined when no keys are configured.
 *
 * The JWT is bound to the exact call it authorises: the `uris` claim carries
 * "POST host/path", so a token minted for /verify cannot be replayed at /settle.
 */
async function cdpAuthHeader(env, method, url) {
  const keyId = env.CDP_API_KEY_ID;
  const secret = env.CDP_API_KEY_SECRET;
  if (!keyId || !secret) return undefined;

  const { host, pathname } = new URL(url);
  const raw = base64Bytes(secret);
  // A CDP Secret API Key is base64 of 64 bytes: a 32-byte Ed25519 seed followed
  // by its 32-byte public key. (The older EC/PEM key format is NOT supported
  // here — README § Settlement says so, and says how to tell.)
  if (raw.length !== 64) throw new Error('CDP_API_KEY_SECRET is not a 64-byte base64 Ed25519 key');

  const key = await crypto.subtle.importKey(
    'jwk',
    { kty: 'OKP', crv: 'Ed25519', d: base64url(raw.subarray(0, 32)), x: base64url(raw.subarray(32)) },
    { name: 'Ed25519' },
    false,
    ['sign']
  );

  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'EdDSA', kid: keyId, typ: 'JWT', nonce: randomHex(16) };
  const claims = {
    sub: keyId,
    iss: 'cdp',
    uris: [`${method} ${host}${pathname}`],
    iat: now,
    nbf: now,
    exp: now + CDP_JWT_TTL_SECONDS,
  };

  const signingInput = `${base64urlJson(header)}.${base64urlJson(claims)}`;
  const signature = await crypto.subtle.sign('Ed25519', key, new TextEncoder().encode(signingInput));
  return `Bearer ${signingInput}.${base64url(new Uint8Array(signature))}`;
}

/** The X-PAYMENT header is base64-encoded JSON. Returns null if it is not. */
function decodePaymentHeader(raw) {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(base64Text(raw));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// Best effort only: the payer is read straight out of the payload the caller
// sent, so before verify it is a CLAIM. The verified value replaces it when the
// facilitator returns one.
const payerOf = (payload) => payload?.payload?.authorization?.from ?? null;

// The two `x-payment-error` values a caller can see. The LEDGER keeps the
// precise reason (facilitator-timeout, facilitator-http-503, …) because that is
// what an operator debugs from; the header keeps a small stable vocabulary
// because that is what a client branches on. The one distinction worth exposing
// is "we could not reach it" vs "this seller has not finished configuring
// payments" — those want different reactions from whoever sees them.
const publicReason = (reason) =>
  reason === 'facilitator-unconfigured' ? 'facilitator-unconfigured' : 'facilitator-unreachable';

// Best-effort ledger write for the IN-REQUEST paths.
//
// The audit row must never decide the response. The unverified-serve path
// exists precisely to keep serving when payment infrastructure is failing, and
// turning that into a 503 because an INSERT failed would invert the rule it is
// there to implement. (The `settlements` table also has to be created by a
// migration on an existing database — README § Settlement — and a deploy that
// forgets it should degrade to "no ledger", not "no conversions".)
async function recordSettlementSafely(db, row) {
  try {
    await recordSettlement(db, row);
  } catch {
    /* see above */
  }
}

async function recordSettlement(db, { now, tool, payer, amount, verifyOk, settleOk, txHash, error }) {
  await db
    .prepare(
      'INSERT INTO settlements (ts, tool, payer, amount, verify_ok, settle_ok, tx_hash, error) ' +
        'VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)'
    )
    .bind(now, tool, payer ?? null, amount, verifyOk, settleOk, txHash ?? null, error ?? null)
    .run();
}

// --- base64 helpers ---------------------------------------------------------
// btoa/atob are byte-oriented, so text goes through TextEncoder/TextDecoder
// rather than being handed to btoa directly (which mangles anything non-ASCII).

function base64Bytes(b64) {
  const binary = atob(b64.replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

const base64Text = (b64) => new TextDecoder().decode(base64Bytes(b64));

function base64url(bytes) {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const base64urlJson = (value) => base64url(new TextEncoder().encode(JSON.stringify(value)));

// ------------------------------------------------------------------ converters

class ConvertError extends Error {}

function oneLineMessage(err) {
  const raw = String((err && err.message) || err || 'unknown error');
  return raw.replace(/\s+/g, ' ').trim().slice(0, 200);
}

const CONVERTERS = {
  'md-html': {
    description: 'Markdown to HTML conversion',
    mimeType: 'text/html',
    contentType: 'text/html; charset=utf-8',
    run: (input) => marked.parse(input),
  },

  'json-yaml': {
    description: 'JSON to YAML conversion',
    mimeType: 'application/yaml',
    contentType: 'application/yaml; charset=utf-8',
    run: (input) => {
      let parsed;
      try {
        parsed = JSON.parse(input);
      } catch (err) {
        throw new ConvertError(`input is not valid JSON: ${oneLineMessage(err)}`);
      }
      return yaml.dump(parsed);
    },
  },

  'yaml-json': {
    description: 'YAML to JSON conversion',
    mimeType: 'application/json',
    contentType: 'application/json; charset=utf-8',
    run: (input) => {
      let docs;
      try {
        // A stream converts as its first document; the caveat on the entry says so.
        docs = yaml.loadAll(input);
      } catch (err) {
        throw new ConvertError(`input is not valid YAML: ${oneLineMessage(err)}`);
      }
      if (!docs.length || docs[0] === undefined) throw new ConvertError('input has no YAML document');
      return `${JSON.stringify(docs[0], null, 2)}\n`;
    },
  },

  'csv-json': {
    description: 'CSV to JSON conversion',
    mimeType: 'application/json',
    contentType: 'application/json; charset=utf-8',
    run: (input) => `${JSON.stringify(csvToRecords(input), null, 2)}\n`,
  },

  'html-markdown': {
    description: 'HTML to Markdown conversion',
    mimeType: 'text/markdown',
    contentType: 'text/markdown; charset=utf-8',
    run: (input) => {
      // Turndown's browser build reaches for a global `document` that workerd
      // does not have, so the HTML is parsed with domino here and the resulting
      // element handed to Turndown, which skips its own parser entirely.
      const doc = domino.createDocument(input, true);
      return turndown.turndown(doc.body);
    },
  },
};

const turndown = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
  bulletListMarker: '-',
});

// Drop the non-prose elements and their CONTENT. Turndown's default rule emits
// the text of any element it has no rule for, so without this a saved page —
// which is exactly this entry's stated input — came back with its analytics
// snippet, its JSON-LD block and its inline CSS sitting in the prose:
//
//   "# Post\n\nText.\n\nwindow.ga=function(){};ga(\"send\");\n\nMore."
//
// It only ever showed up for tags INSIDE the body: a leading <script> is
// hoisted into <head> by the parser and never reaches doc.body, which is why a
// one-tag spot check looks clean. `remove` takes the node and its subtree.
turndown.remove(['script', 'style', 'noscript']);

// RFC 4180: quoted fields, doubled quotes inside them, commas and CRLF or LF
// line endings. A leading BOM is stripped. Values stay strings — guessing types
// is where leading zeros and long ids get destroyed.
function parseCsvRows(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (quoted) {
      if (ch !== '"') {
        field += ch;
      } else if (text[i + 1] === '"') {
        field += '"';
        i++;
      } else {
        quoted = false;
      }
      continue;
    }

    if (ch === '"' && field === '') {
      quoted = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += ch;
    }
  }

  if (quoted) throw new ConvertError('input has an unterminated quoted field');
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function csvToRecords(input) {
  const rows = parseCsvRows(input.replace(/^\uFEFF/, ''));
  if (!rows.length) throw new ConvertError('input has no rows');

  const header = rows[0].map((h) => h.trim());
  if (header.every((h) => h === '')) throw new ConvertError('the first row must be a non-empty header row');

  const records = [];
  for (let r = 1; r < rows.length; r++) {
    const cells = rows[r];
    if (cells.length === 1 && cells[0] === '') continue; // blank line
    if (cells.length > header.length) {
      throw new ConvertError(
        `row ${r + 1} has ${cells.length} fields but the header has ${header.length}`
      );
    }
    // Object.create(null), NOT {}. On a plain object, `record['__proto__'] = v`
    // hits Object.prototype's `__proto__` setter instead of creating an own
    // property, and for a string value that setter is a silent no-op — so a CSV
    // column headed `__proto__` used to vanish from a 200 response, value and
    // all. Losing a column outright is worse than any type-guessing mistake this
    // parser refuses to make. A null-prototype record inherits no such accessor,
    // so every header becomes an own property and JSON.stringify emits it.
    // (yaml-json never had the bug; js-yaml builds its own keys correctly.)
    const record = Object.create(null);
    for (let c = 0; c < header.length; c++) record[header[c]] = cells[c] ?? '';
    records.push(record);
  }
  return records;
}

// Live hosted entries, by id — the routing table for /convert.
const HOSTED = new Map(
  CATALOG.filter((e) => e.hosted && e.hosted.status === 'live').map((e) => [e.id, e])
);

// ------------------------------------------------------------------ store

// Rungs 1 and 2, in that order. Rung 1 is the BEACON's budget only.
//   1  per-identifier token count. Identifiers expire daily with the salt, so
//      today's rows are all this identifier has; the ts predicate is
//      belt-and-braces across a rotation. Convert rows are excluded — they are
//      metered by convert_quota, and a shared budget meant a caller that made
//      99 conversions could no longer be counted as a visitor.
//   2  global fail-closed, read before every insert.
async function rungsExceeded(db, idHash, day, dayStart) {
  const seen = await db
    .prepare("SELECT COUNT(*) AS n FROM events WHERE id_hash = ?1 AND ts >= ?2 AND type <> 'convert'")
    .bind(idHash, dayStart)
    .first();
  if ((seen?.n ?? 0) >= RUNG1_PER_ID_PER_DAY) return true;

  return await globalExceeded(db, day);
}

// Rung 2 on its own — /convert reads it without touching rung 1's identifier count.
async function globalExceeded(db, day) {
  const counter = await db.prepare('SELECT total FROM counters WHERE day = ?1').bind(day).first();
  return (counter?.total ?? 0) >= RUNG2_GLOBAL_PER_DAY;
}

// The conversion budget: claim one call, atomically.
//
// The guarded upsert IS the mechanism — the same idiom the salt rotation uses.
// The row is created at 1, and incremented only WHILE it is under the ceiling, so
// the "may I" read and the "spend one" write cannot race apart across isolates.
// No row comes back when the guard fails, and that is the over-quota signal.
//
// Keyed on (day, ip_hash) where ip_hash carries no user-agent: see handleConvert.
// Returns the new count, or null when the ceiling is already reached.
async function claimConvertQuota(db, day, ipHash, ceiling) {
  const row = await db
    .prepare(
      'INSERT INTO convert_quota (day, ip_hash, used) VALUES (?1, ?2, 1) ' +
        'ON CONFLICT(day, ip_hash) DO UPDATE SET used = convert_quota.used + 1 ' +
        'WHERE convert_quota.used < ?3 ' +
        'RETURNING used'
    )
    .bind(day, ipHash, ceiling)
    .first();
  return typeof row?.used === 'number' ? row.used : null;
}

async function recordEvent(db, { now, day, type, idHash, entry, refClass }) {
  await db.batch([
    db
      .prepare('INSERT INTO events (ts, type, id_hash, entry, ref_class) VALUES (?1, ?2, ?3, ?4, ?5)')
      .bind(now, type, idHash, entry, refClass),
    db
      .prepare('INSERT INTO counters (day, total) VALUES (?1, 1) ON CONFLICT(day) DO UPDATE SET total = total + 1')
      .bind(day),
  ]);
}

// The day's salt, rotated lazily. The overwrite IS the discard: no derived or
// HMAC salt, because a recomputable salt is the negation of discarded-at-rotation.
async function currentSalt(db, day) {
  const row = await db.prepare("SELECT day, value FROM salt WHERE key = 'current'").first();
  if (row && row.day === day && row.value) return row.value;

  const fresh = randomHex(32);
  // The guarded upsert makes rotation atomic: a racing isolate that finds the
  // day already rotated updates nothing and gets no row back, so it re-reads
  // the winner's salt rather than minting a second identity space for the day.
  const written = await db
    .prepare(
      "INSERT INTO salt (key, day, value) VALUES ('current', ?1, ?2) " +
        'ON CONFLICT(key) DO UPDATE SET day = excluded.day, value = excluded.value ' +
        'WHERE salt.day <> excluded.day ' +
        'RETURNING value'
    )
    .bind(day, fresh)
    .first();
  if (written?.value) return written.value;

  const after = await db.prepare("SELECT value FROM salt WHERE key = 'current'").first();
  return after?.value || fresh;
}

async function truncatedHash(input) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return hex(new Uint8Array(digest)).slice(0, 16);
}

function randomHex(bytes) {
  return hex(crypto.getRandomValues(new Uint8Array(bytes)));
}

function hex(bytes) {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

function classifyReferer(request) {
  const ref = request.headers.get('referer');
  if (!ref) return 'none';
  try {
    return new URL(ref).origin === new URL(request.url).origin ? 'internal' : 'external';
  } catch {
    return 'none';
  }
}
