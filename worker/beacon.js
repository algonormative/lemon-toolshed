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
//   POST /convert/<id> the hosted conversions. Priced per call in USDC via x402,
//                      metered on their OWN budget — the paid ceiling below —
//                      with rung 2 as the outer bound. An unpaid call answers a
//                      402 envelope without touching any store.
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
//   1c the paid ceiling, PAID_DAILY served calls / caller / UTC day    [below]
//      A runaway bound on calls we actually serve. Its caller key is
//      hash(daily salt + IP) with NO user-agent, on purpose: rotating a UA
//      string must not mint a fresh identity. A second identity costs a second
//      IP, which is the cheapest spoof-resistance available here.
//      OPTIONAL, env-gated: setting FREE_TIER_DAILY = N restores a free tier of
//      N calls / caller / UTC day on the same counter and the same key. Unset
//      (the production default) means every call is a paid call.
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
// Both added 2026-08-30 with the second hosted wave, and both were checked for
// the one property that matters in workerd: no `node:` builtins anywhere in the
// graph the package's ESM entry actually reaches. wrangler.toml sets NO
// nodejs_compat flag, and it must not need to — a dependency that wants one is a
// dependency this Worker does not take.
import { parse as tomlParse, stringify as tomlStringify } from 'smol-toml';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
// Cloudflare's built-in email module, backing the `send_email` binding. It is a
// workerd built-in rather than an npm package, so it adds nothing to the bundle
// and it is present whether or not the binding is configured — the ALERT_EMAIL
// binding's ABSENCE is what turns the email channel off, not this import.
import { EmailMessage } from 'cloudflare:email';
// The catalog is compiled in at build time. FREE_TIER_DAILY is deliberately NOT
// imported: the build constant is what the STATIC surfaces advertise, and the
// only runtime authority is env.FREE_TIER_DAILY — see freeTierDaily() below.
import { CATALOG, SITE_BASE } from './catalog.generated.js';

const MAX_BODY = 1024; // bytes; a legitimate beacon body is ~40
const MAX_ENTRY_ID = 64;
const RUNG1_PER_ID_PER_DAY = 100;
const RUNG2_GLOBAL_PER_DAY = 200_000;

// The paid ceiling. A runaway bound, NOT a quota to advertise: it is deliberately
// absent from the catalog, the page and the machine files, because publishing it
// would read as a promise. OWNER-TUNABLE.
const PAID_DAILY = 5000;

/**
 * The free tier, per caller per UTC day. 0 (the default) means there is none.
 *
 * THE ENV VAR IS THE ONLY AUTHORITY, and unset is off. This is the whole
 * mechanism behind the 2026-08-19 decision to retire the free tier: Coinbase's
 * Bazaar discovery index requires that an unauthenticated request answer 402,
 * and it health-probes on an interval — so a tier that serves any fresh IP a
 * 200 keeps us out of the index and drops us once listed. Discoverability beat
 * the trial allowance.
 *
 * The mechanism stays alive rather than being deleted: a deployment that wants
 * a trial sets FREE_TIER_DAILY = "N" and gets exactly the old behaviour back,
 * and the suite exercises both paths so neither bit-rots.
 *
 * Anything unparseable, negative or fractional-below-one reads as 0. A
 * misconfigured var must fail towards "charge for it", never towards "give it
 * away" — a typo in a dashboard field should not become an unbounded free
 * service.
 */
function freeTierDaily(env) {
  const raw = Number(env?.FREE_TIER_DAILY ?? 0);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0;
}

const SECONDS_PER_DAY = 86_400;

const MAX_CONVERT_BODY = 256 * 1024; // 256 KB
const MAX_QUERY_LEN = 64;

// USDC on Base, 6 decimals. $0.005 is therefore "5000" atomic units. Prices are
// per tool since 2026-08-30; the figure comes from the entry, never from here.
const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const USDC_DECIMALS = 6;
const X402_TIMEOUT_SECONDS = 60;

// ONE CHAIN, TWO SPELLINGS. Base mainnet is `base` in x402 v1 and the CAIP-2
// `eip155:8453` in v2 — the same network, and the version decides which name is
// legal. v2's schema REQUIRES a colon (NetworkSchemaV2: min length 3, must
// contain ":"), so shipping "base" in a v2 envelope is not a cosmetic slip, it
// is an invalid envelope.
const NETWORK_V1 = 'base';
const NETWORK_V2 = 'eip155:8453';

// The v2 `resource` block's service identity. `serviceName` is capped at 32
// printable-ASCII characters and `tags` at 5 entries of 32 (ResourceInfoSchema
// in @x402/core 2.23.0).
const SERVICE_NAME = 'Toolshed';
const RESOURCE_TAGS = ['x402', 'conversion'];

// The three x402 header names, and which version owns which.
//
//   X-PAYMENT          v1 request  — the payment payload
//   PAYMENT-SIGNATURE  v2 request  — the same job, renamed
//   PAYMENT-REQUIRED   v2 response — where the v2 envelope lives (v1 uses the body)
//
// Lower-case because Request/Response header lookup is case-insensitive and
// these are also used as object keys on the way out.
const PAYMENT_HEADER_V1 = 'x-payment';
const PAYMENT_HEADER_V2 = 'payment-signature';
const PAYMENT_REQUIRED_HEADER = 'payment-required';

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
    if (path === '/check') return handleCheck(request, env);
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
//
// Matching is field-BOUND: `from` is tested against the have side only, `to`
// against the need side only. With no parameters at all, the answer is every
// hosted entry.
//
// Each side matches on EITHER a case-insensitive substring of the prose name
// (the original rule) OR an exact hit in that entry's alias set. The alias half
// is why `?from=md`, `?from=.md` and `?from=text/markdown` work: verified live
// 2026-08-19, all three used to return [] while only `?from=markdown` matched —
// and an extension and a Content-Type are exactly what a machine has on hand.
// Aliases are compiled per entry in build.mjs, already normalised.
//
// The reported free_tier_daily is the RUNTIME value this Worker enforces, not
// the one compiled into the catalog: flipping the env var has to be visible
// here immediately, without a rebuild, or /check starts advertising a tier that
// does not exist.

// Lowercase, trimmed, leading dots stripped — matching normaliseAlias() in
// build.mjs. The two have to agree; keeping the rule to one line is how.
const normaliseAlias = (s) => s.trim().toLowerCase().replace(/^\.+/, '');

const sideMatches = (prose, aliases, needle, alias) =>
  prose.toLowerCase().includes(needle) || (aliases || []).includes(alias);

function handleCheck(request, env) {
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
  const fAlias = from ? normaliseAlias(from) : '';
  const tAlias = to ? normaliseAlias(to) : '';

  const matches =
    !f && !t
      ? CATALOG.filter((e) => e.hosted)
      : CATALOG.filter(
          (e) =>
            (!f || sideMatches(e.x, e.xa, f, fAlias)) && (!t || sideMatches(e.y, e.ya, t, tAlias))
        );

  const tier = freeTierDaily(env);

  return json(
    {
      query: { from: from ?? null, to: to ?? null },
      // Which x402 versions a caller can pay these tools in. Published because
      // /check is the machine front door and the answer decides which header a
      // client reads the envelope out of — see the dual-stack note under
      // §tiers & x402. Both, since 2026-08-19.
      x402_versions: [1, 2],
      matches: matches.map((e) => ({
        id: e.id,
        x: e.x,
        y: e.y,
        // The spellings this entry answers to, published so a caller that had
        // to guess once can stop guessing. Machine surface only — the page
        // never shows these; a human does not need telling that Markdown files
        // end in .md.
        x_aliases: e.xa,
        y_aliases: e.ya,
        // The field stays present at 0 rather than disappearing: explicit beats
        // absent, and a reader that has to distinguish "no free tier" from "this
        // build forgot to say" will guess wrong.
        hosted: e.hosted ? { ...e.hosted, free_tier_daily: tier } : null,
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
// Order of checks is the reject discipline, cheapest first: method, then whether
// the id exists, then the declared size, then — for the unpaid call, which is
// now the common one — the 402 envelope. All of that happens before the
// rate-limit round trip, the body read and the conversion itself.
//
// The 402 sits AFTER the size check and BEFORE any store access on purpose:
// rejecting on a declared content-length is cheaper than building an envelope,
// and building an envelope is cheaper than deriving a caller identity for a
// call that is not going to be served.

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

  // The paid tier needs BOTH halves: an address to pay to, and a payment
  // presented. Either alone leaves the caller unpaid.
  //
  // "Presented" spans both protocol versions and stays header-cheap: the value
  // is not decoded here, only counted, because this runs in front of the 402
  // fast path where the whole point is to do nothing.
  const payTo = env.PAYTO || '';
  const presented = !!(request.headers.get(PAYMENT_HEADER_V2) || request.headers.get(PAYMENT_HEADER_V1));
  const tier = freeTierDaily(env);

  // THE 402 IS THE FRONT DOOR, and answering it is the cheapest thing this
  // route does. With no free tier configured and no payment presented there is
  // nothing to meter — no allowance to claim, no identity to derive — so the
  // envelope goes out with NO salt read, NO quota claim and NO D1 write at all.
  //
  // Ordering matters twice over. It is the CPU-minimal reject discipline this
  // file is built on: the 413 above stays in front of it because rejecting on a
  // declared size is cheaper still than constructing an envelope. And it is what
  // makes the service discoverable — Coinbase's Bazaar health-probes an
  // unauthenticated request and expects a 402, on an interval, forever.
  //
  // Rung 2 is deliberately NOT consulted here. It is a bound on D1 writes, and
  // this path performs none; making a doomsday day answer 503 instead of 402
  // would trade a free, correct answer for an expensive, wrong one.
  if (tier === 0 && !presented) return overQuota(entry, conv, { payTo, tier });

  // --- the conversion budget ---------------------------------------------
  const db = env.DB;
  if (!db) return json({ error: 'conversion is unavailable' }, 503);

  const now = Math.floor(Date.now() / 1000);
  const day = new Date(now * 1000).toISOString().slice(0, 10); // UTC
  const dayStart = Math.floor(Date.parse(`${day}T00:00:00Z`) / 1000);

  // What the response will say about payment, decided below and rendered by
  // servedHeaders(). `settle` is the deferred half of a verified payment, and
  // `alert` the owner-facing ping for a call served WITHOUT one — the verified
  // ping is fired by settleAndRecord(), which is the only place that knows
  // whether the settlement landed.
  let outcome = { kind: 'free', remaining: 0, presented };
  let settle = null;
  let alert = null;

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

    // WHEN A FREE TIER IS CONFIGURED IT IS CLAIMED FIRST, ALWAYS — and that
    // ordering is the whole "never bill inside the free tier" rule, expressed as
    // control flow rather than as a promise. A caller with allowance left takes
    // this branch and the facilitator is never reached, whatever it presented;
    // the payment path below is only reachable once the free claim has actually
    // failed. With the tier off (the default) there is no claim to make and
    // every caller goes straight to the payment path.
    //
    // It also fixes what the ceiling keys on. It used to key on the PRESENCE of
    // an X-PAYMENT header, so any caller that sent one got PAID_DAILY (5,000)
    // instead of the free tier — a pre-facilitator placeholder that let an
    // unverified claim buy a vastly higher ceiling for free. Now it is
    // claimed only after the facilitator says isValid, further down.
    const free = tier > 0 ? await claimConvertQuota(db, day, ipHash, tier) : null;

    if (free !== null) {
      outcome = { kind: 'free', remaining: tier - free, presented };
    } else {
      // NOTHING FREE LEFT — either the tier is spent or there is no tier.
      // Without somewhere to pay, or without a payment, there is nothing to
      // verify and the answer is the 402/429.
      if (!payTo || !presented) return overQuota(entry, conv, { payTo, tier, now, dayStart });

      const price = entry.hosted.price;
      const requirements = paymentRequirements(entry, conv, price, payTo);

      // VERSION IS DECIDED HERE, ONCE, and everything downstream follows it:
      // which shape the facilitator sees on verify and on settle, and which
      // `resource` a settle body is completed with. It is read out of the
      // PAYLOAD rather than out of the header it arrived in — see
      // presentedPayment().
      const payment = presentedPayment(request);
      const facRequirements = payment?.version === 2 ? requirementsV2(requirements) : requirements;
      const verdict = await verifyPayment(env, payment, facRequirements);

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
        return paymentRequired(requirements, conv, {
          error: 'the payment presented was not accepted',
          invalidReason: verdict.reason,
          invalidMessage: verdict.message ?? null,
          // v2 carries one `error` and it is a CODE, not prose — x402's own
          // client branches on it (`error === 'permit2_allowance_required'`),
          // so the facilitator's reason is the honest value to put there.
          v2Error: verdict.reason,
        });
      }

      // Past this point the conversion WILL be served, so claim against the
      // runaway bound. That is the outer limit on both remaining branches.
      const paidUsed = await claimConvertQuota(db, day, ipHash, PAID_DAILY);
      if (paidUsed === null) return paidCeilingReached({ now, dayStart });

      if (verdict.verified) {
        outcome = { kind: 'paid', presented };
        settle = {
          requirements,
          facRequirements,
          version: payment.version,
          payload: verdict.payload,
          payer: verdict.payer,
          tool: id,
        };
      } else {
        // UNREACHABLE / UNCONFIGURED. Availability-first: the price is a signal
        // until the payment infrastructure is reliable, so the caller is served
        // rather than turned away for our dependency's outage — and the
        // response says plainly that nothing was checked.
        outcome = { kind: 'unverified', presented, error: publicReason(verdict.unavailable) };
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
        // REVENUE LEAKING, and the owner wants to hear about it while it is
        // happening. This branch serves a conversion that nobody paid for —
        // availability-first is deliberate, but a RUN of these is the paid rail
        // silently not working, and the ledger query that would reveal it is one
        // nobody runs at 3am. It is queued rather than sent here, alongside the
        // settle block below, so a conversion that then 400s does not alarm
        // about a call that was never served.
        alert = {
          kind: 'unverified',
          tool: id,
          payer: verdict.payer,
          amount: requirements.maxAmountRequired,
          error: publicReason(verdict.unavailable),
        };
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
  //
  // PAYMENT FAIRNESS, and it is load-bearing ordering rather than a promise:
  // every exit between here and the settle block below is a 4xx, and `settle` is
  // only ever queued AFTER a conversion actually succeeded. Verify-yes /
  // settle-no leaves the signed authorization simply unused — an EIP-3009
  // authorization moves nothing until someone submits it, and nobody does — so a
  // buyer whose input we could not convert is not charged. The rule stated
  // outwards: YOU ARE ONLY CHARGED FOR CONVERSIONS THAT ARE SERVED.
  //
  // This mattered less when the free tier absorbed most malformed input. With
  // every call paid, a 400 that billed would be the service's worst behaviour.
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
  // conversion served for the tool's price that never arrived, recorded as settle_ok = 0.
  //
  // The owner's ALERT rides in the same deferred slot, for the same reason and
  // one more: a notification must never be able to slow, fail or change a
  // response the buyer already paid for. The two are mutually exclusive in
  // practice — `settle` is the verified path and `alert` the unverified one —
  // and the verified ping is fired from inside settleAndRecord(), which is the
  // only place that knows whether the settlement actually landed.
  const deferred = [];
  if (settle) deferred.push(settleAndRecord(env, db, settle));
  if (alert) deferred.push(sendPaymentAlert(env, alert));
  if (deferred.length) {
    const work = Promise.all(deferred);
    if (ctx?.waitUntil) ctx.waitUntil(work);
    else await work; // no ctx (direct invocation): correctness over latency
  }

  return new Response(output, {
    status: 200,
    headers: { 'content-type': conv.contentType, ...servedHeaders(outcome) },
  });
}

const tooLarge = () =>
  json({ error: `input is larger than the ${MAX_CONVERT_BODY / 1024} KB limit` }, 413);

// ------------------------------------------------------------------ tiers & x402
//
// Every hosted tool is priced, and as of 2026-08-19 that is ALL it is: an
// unauthenticated call answers immediately, and the answer has two forms:
//
//   PAYTO set (production) → HTTP 402 with a spec-valid x402 envelope, in BOTH
//                            protocol versions at once: pay to continue. The
//                            first call, not the fourth.
//   PAYTO unset            → HTTP 429. There is nowhere to pay, so the answer
//                            says exactly that instead of sending a 402 nobody
//                            can satisfy.
//
// DUAL-STACK, and the two versions do not share a transport (2026-08-19):
//
//   v1  the envelope is the 402's JSON BODY, and the payment comes back in an
//       `X-PAYMENT` request header. Unchanged, byte for byte — one real payment
//       has verified and settled on this rail, and nothing here may regress it.
//   v2  the envelope is a base64 `PAYMENT-REQUIRED` RESPONSE HEADER, and the
//       payment comes back in a `PAYMENT-SIGNATURE` request header.
//
// A v2 client reads the header and never looks at the body; a v1 client reads
// the body and never looks at the header (x402HTTPClient.getPaymentRequiredResponse
// in @x402/core 2.23.0: header first, body only when `x402Version === 1`). So
// the two can be served from the same 402 without either noticing the other,
// which is what "dual-stack" buys — and it is required, because Coinbase's
// Bazaar validator now answers a v1-only endpoint with "upgrade to x402 v2 to
// be discoverable".
//
// A deployment that sets FREE_TIER_DAILY = N gets the old behaviour back: N
// calls per caller per UTC day are simply served, with the count that is left
// in `x-free-tier-remaining`, and the two answers above move to call N + 1.
//
// Settlement IS implemented, against the CDP facilitator, and the three
// outcomes on the payment path are distinct:
//
//   verified            → the conversion, `x-payment-verified: true`, and the
//                         on-chain settlement runs after the response
//   rejected            → 402 with the envelope AND the facilitator's
//                         invalidReason, so the caller can see what to fix
//   facilitator down    → the conversion, `x-payment-verified: false` and
//                         `x-payment-error`. Availability-first, on purpose:
//                         at these prices the price is a signal, and turning
//                         paying callers away because OUR dependency is down is
//                         the worse failure. Every one of these is recorded.
//
// Two rules have not changed, and they are the ones worth protecting:
//
//   NOTHING IS EVER FAKE-VERIFIED. `x-payment-verified: true` appears only
//   after a facilitator round trip that returned isValid.
//
//   NOBODY IS CHARGED FOR A CONVERSION THAT WAS NOT SERVED. Settlement is
//   queued only after the conversion succeeds — see the note above the body
//   read in handleConvert. It mattered less when a free tier absorbed most
//   malformed input; with every call paid, it is the rule the service would be
//   most unforgivable for breaking.

/**
 * The payment headers on a SERVED response.
 *
 * WHY THERE IS NO `PAYMENT-RESPONSE` HEADER, which a v2 reader will look for.
 * In v2 that header is a settlement RECEIPT — `{ success, transaction, network,
 * payer }`, base64 — and this Worker does not have one to give at the moment it
 * answers. Settlement is deliberately queued behind the response (see the note
 * above the body read in handleConvert): the caller paid for a conversion, not
 * for a chain confirmation, so the ~2 s settle runs in ctx.waitUntil and lands
 * in the `settlements` table instead of in these headers.
 *
 * The alternative is to emit one anyway, with `success: true` and an empty
 * transaction, before anything has settled. That is a receipt for a payment
 * that has not happened yet, and it would be the first fake thing this file
 * says — the rule one line down from here is that nothing is ever
 * fake-verified. So the header is absent, and its absence is honest.
 *
 * It costs nothing to a real client: @x402/fetch reads the receipt inside a
 * try/catch and carries on without one (x402HTTPClient.processPaymentResult),
 * which the v2 positive control in the suite proves end to end. What a caller
 * gets instead is `x-payment-verified: true` — the claim we can actually
 * support, which is that the facilitator checked the payment before we served.
 * Moving settlement in front of the response would buy the receipt and cost the
 * ordering that guarantees nobody is charged for a conversion we did not serve.
 */
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
    // Served, unverified — a payment was presented and could not be checked.
    headers['x-payment-verified'] = 'false';
    headers['x-payment-error'] = error;
    headers['x-pricing'] = 'pending';
  }
  return headers;
}

/**
 * The answer to a call with nothing free left to spend and no payment presented.
 *
 * The 402 is the normal path and needs no clock at all. The 429 is the fallback
 * for a deployment with nowhere to take money, and it splits on WHY there is
 * nothing free left, because the two cases want opposite advice:
 *
 *   tier > 0   an allowance was spent. Waiting works, so Retry-After points at
 *              the next UTC midnight when the counter resets.
 *   tier === 0 there was never an allowance, and there is no receiving address:
 *              the deployment is misconfigured. Waiting does NOT work, so there
 *              is deliberately no Retry-After — a header promising that midnight
 *              fixes this would be a lie a client would obey.
 */
function overQuota(entry, conv, { payTo, tier, now, dayStart }) {
  const price = entry.hosted.price;
  if (payTo && price !== 'free') {
    return paymentRequired(paymentRequirements(entry, conv, price, payTo), conv, {
      error: 'X-PAYMENT header is required',
      // v2 renamed the header, so the v1 sentence would name the wrong thing.
      // "Payment required" is what x402's own resource server puts here for an
      // unpaid call (x402HTTPResourceServer.processHTTPRequest).
      v2Error: 'Payment required',
    });
  }

  if (tier > 0) {
    return json(
      {
        error: `free tier is ${tier} conversions per day per caller`,
        free_tier_daily: tier,
        paid_tier: 'per-call USDC via x402 — activating soon',
        retry: 'tomorrow UTC',
      },
      429,
      // Seconds to the next UTC midnight, which is when every counter resets.
      { 'retry-after': String(Math.max(1, dayStart + SECONDS_PER_DAY - now)) }
    );
  }

  // A `price: free` entry has no paid path to fall back on — there is nothing
  // to charge for — so with the tier off it has no answer left to give. Naming
  // that specifically matters: the generic message below blames a missing
  // receiving address, which for this entry may well be set, sending an operator
  // to fix the wrong thing. No entry in entries.yaml uses `price: free` today.
  if (price === 'free') {
    return json(
      {
        error: 'this conversion is configured as free, but this deployment enables no free tier',
        free_tier_daily: 0,
        paid_tier: 'not applicable — this entry carries no price',
        retry: 'not until this deployment sets FREE_TIER_DAILY, or the entry is given a price',
      },
      429
    );
  }

  return json(
    {
      error: 'this conversion is a paid call, and this deployment has no receiving address configured',
      free_tier_daily: 0,
      paid_tier: 'per-call USDC via x402 — no payTo configured on this deployment',
      retry: 'not until this deployment configures a receiving address',
    },
    429
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
 *
 * `outputSchema` is what makes the resource INDEXABLE rather than merely
 * payable. Two details in it are easy to get wrong and silent when you do:
 * `discoverable` lives inside `outputSchema.input`, not at the top level; and
 * these are v1 field names, which is why no v2 migration is needed — the shape
 * is copied from a resource already carrying an x402 v1 listing.
 *
 * It describes what these tools ACTUALLY take, which is a raw file body rather
 * than a JSON object of named fields. Saying `bodyType: "text"` and describing
 * the body in a sentence is honest; inventing an input object would advertise a
 * calling convention that would fail on first use. Descriptions are kept short
 * — the facilitator rejects anything past 500 characters.
 */
function paymentRequirements(entry, conv, price, payTo) {
  return {
    scheme: price.scheme || 'exact',
    network: NETWORK_V1,
    maxAmountRequired: atomicAmount(price.amount_usd),
    resource: `${SITE_BASE}${entry.hosted.path}`,
    description: conv.description,
    mimeType: conv.mimeType,
    payTo,
    maxTimeoutSeconds: X402_TIMEOUT_SECONDS,
    asset: USDC_BASE,
    // The EIP-712 domain the client must sign over — see USDC_BASE_EIP712.
    extra: USDC_BASE_EIP712,
    outputSchema: {
      input: {
        type: 'http',
        method: 'POST',
        discoverable: true,
        bodyType: 'text',
        description: `the raw ${conv.inputFormat} file as the request body, up to ${MAX_CONVERT_BODY / 1024} KB`,
      },
      output: {
        type: 'string',
        description: `the converted ${conv.outputFormat} file as the response body (${conv.mimeType})`,
      },
    },
  };
}

// ------------------------------------------------------------------ x402 v2
//
// The v2 view of the SAME facts. Everything below is derived from the v1
// `requirements` object built above rather than assembled a second time from
// entry/conv/price — that is what keeps the invariant at the top of
// paymentRequirements() true across the version split. The two envelopes cannot
// disagree about price, payTo, asset or resource, because there is nothing for
// them to disagree with: one is a projection of the other.
//
// What v2 moved, and it is more than a rename:
//
//   maxAmountRequired          → amount
//   network: "base"            → network: "eip155:8453"   (CAIP-2, colon required)
//   resource: "<url>"          → the top-level `resource` OBJECT
//   description, mimeType      → onto that same object
//   outputSchema               → extensions.bazaar
//
// so a v2 `accepts` entry is SEVEN fields and nothing else. Adding a stray one
// is not harmless: the client echoes our entry back as `accepted`, the server
// side deep-equals the two (paymentRequirementsMatchAccepted), and the
// facilitator validates the shape it is handed.

/**
 * The v2 `accepts[0]` entry. Exactly the fields PaymentRequirementsV2Schema
 * defines — scheme, network, amount, asset, payTo, maxTimeoutSeconds, extra.
 */
function requirementsV2(requirements) {
  return {
    scheme: requirements.scheme,
    network: NETWORK_V2,
    amount: requirements.maxAmountRequired,
    asset: requirements.asset,
    payTo: requirements.payTo,
    maxTimeoutSeconds: requirements.maxTimeoutSeconds,
    extra: requirements.extra,
  };
}

/**
 * The v2 top-level `resource` block — what is being sold, as opposed to the
 * terms it is sold on.
 *
 * `method` is here because the live v2 sellers already in Coinbase's index put
 * it here (observed on x402scan's own paid API, 2026-08-19) and a POST-only
 * resource that does not say so is a listing an agent will call wrong. It is
 * NOT in @x402/core's ResourceInfoSchema, which knows url, description,
 * mimeType, serviceName, tags and iconUrl — zod strips what it does not know,
 * so the field is inert for a v2 client and legible to a crawler. The same
 * fact is stated again, schema-legally, as extensions.bazaar.info.input.method.
 */
function resourceInfoV2(requirements) {
  return {
    url: requirements.resource,
    method: 'POST',
    description: requirements.description,
    mimeType: requirements.mimeType,
    tags: RESOURCE_TAGS,
    serviceName: SERVICE_NAME,
  };
}

/**
 * `extensions.bazaar` — the v2 successor to v1's `outputSchema`, and the thing
 * that makes the resource INDEXABLE rather than merely payable.
 *
 * The extension is two halves and both are required: `info` is one concrete
 * example of the call, and `schema` is the JSON Schema `info` is validated
 * against — the bazaar spec says a facilitator MUST validate one against the
 * other before cataloguing, so a schema that does not admit its own info is a
 * silent delisting. They are written next to each other here for that reason.
 *
 * `info.input` is a discriminated union on method. POST is a BODY method, so
 * the shape is { type, method, bodyType, body } — `body` being an example
 * request body, not a description of one. `discoverable` is deliberately absent:
 * that was v1's opt-in flag, and in v2 the presence of this extension IS the
 * opt-in. The 256 KB cap and the file format live in the schema's `description`
 * fields, which is both where a JSON Schema puts a constraint and the only
 * place the union leaves room for prose.
 */
function bazaarExtension(requirements, conv) {
  const input = requirements.outputSchema.input;
  return {
    bazaar: {
      info: {
        input: { type: 'http', method: input.method, bodyType: input.bodyType, body: conv.sample },
        // `example` is the sample body actually run through this converter —
        // computed, not typed, so it cannot drift from what the tool returns.
        // Closes the validator's last advisory (bazaar.info.output.example).
        output: { type: 'text', format: requirements.mimeType, example: sampleOutput(conv) },
      },
      schema: {
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        type: 'object',
        properties: {
          input: {
            type: 'object',
            properties: {
              type: { type: 'string', const: 'http' },
              method: { type: 'string', const: 'POST' },
              bodyType: { type: 'string', const: 'text' },
              body: {
                type: 'string',
                description: input.description,
                maxLength: MAX_CONVERT_BODY,
              },
            },
            required: ['type', 'method', 'bodyType', 'body'],
            additionalProperties: false,
          },
          output: {
            type: 'object',
            properties: {
              type: { type: 'string', const: 'text' },
              format: {
                type: 'string',
                const: requirements.mimeType,
                description: requirements.outputSchema.output.description,
              },
              example: {
                type: 'string',
                description: `the sample request body above, converted — what a ${requirements.outputSchema.output.description || 'response'} looks like`,
              },
            },
            required: ['type', 'format'],
            additionalProperties: false,
          },
        },
        required: ['input'],
      },
    },
  };
}

/**
 * The sample body run through its own converter, memoized. The converters are
 * pure and the samples tiny, so this costs sub-millisecond once per isolate
 * per tool — and the example in the envelope is by construction the truth.
 */
const sampleOutputCache = new Map();
function sampleOutput(conv) {
  let out = sampleOutputCache.get(conv);
  if (out === undefined) {
    out = String(conv.run(conv.sample));
    sampleOutputCache.set(conv, out);
  }
  return out;
}

/** The whole v2 PaymentRequired envelope, ready to base64 into the header. */
function paymentRequiredV2(requirements, conv, error) {
  return {
    x402Version: 2,
    ...(error ? { error } : {}),
    resource: resourceInfoV2(requirements),
    accepts: [requirementsV2(requirements)],
    extensions: bazaarExtension(requirements, conv),
  };
}

/**
 * 402, carrying the envelope plus whatever we can say about why — in both
 * protocol versions, from the one `requirements` object.
 *
 * The BODY is the v1 envelope, unchanged. The v2 envelope rides in the
 * `PAYMENT-REQUIRED` header, which is where a v2 client looks first and a v1
 * client never looks at all. `no-store` because an envelope is per-request:
 * a cached 402 hands the next caller someone else's terms.
 */
function paymentRequired(requirements, conv, { v2Error, ...body }) {
  return json({ x402Version: 1, ...body, accepts: [requirements] }, 402, {
    [PAYMENT_REQUIRED_HEADER]: base64Json(paymentRequiredV2(requirements, conv, v2Error)),
    'cache-control': 'no-store',
  });
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
 * The payment presented on this request, in whichever version it arrived.
 *
 * PAYMENT-SIGNATURE is read first because it is the newer transport and a
 * client that sends it means it; X-PAYMENT stays accepted because v1 clients
 * are still real and one of them has already paid us.
 *
 * THE VERSION COMES OUT OF THE PAYLOAD, NOT THE HEADER. `x402Version` is a
 * required field of both payload schemas, it is what the facilitator's own
 * client keys on (`x402Version: paymentPayload.x402Version`), and it survives a
 * client that puts a v2 payload in the old header. Anything that is not exactly
 * 2 is treated as v1 — which is the pre-existing behaviour for a payload that
 * omits the field, and leaves a hypothetical v3 to be forwarded verbatim and
 * refused by the facilitator rather than mis-shaped by us.
 *
 * Returns null when no payment was presented at all; `decoded` is null when one
 * was presented and could not be decoded, which is a rejection, not an absence.
 */
function presentedPayment(request) {
  const raw = request.headers.get(PAYMENT_HEADER_V2) || request.headers.get(PAYMENT_HEADER_V1);
  if (!raw) return null;
  const decoded = decodePaymentHeader(raw);
  return { decoded, version: decoded?.x402Version === 2 ? 2 : 1 };
}

/**
 * Ask the facilitator whether a presented payment is good.
 *
 * `requirements` is already the VERSION-APPROPRIATE shape — the v1 envelope for
 * a v1 payload, the v2 accepts entry for a v2 one. Getting that pairing wrong
 * is invisible locally and fatal in production: the facilitator recovers the
 * signature against what it is handed, so a v2 payload checked against a v1
 * envelope verifies as invalid however good the payment was.
 *
 * NEVER THROWS — every failure is a verdict, because the caller is mid-request
 * and an exception here would become a 503 for something that should be served.
 * Returns exactly one of:
 *   { verified: true, payload, payer }   isValid — serve, then settle
 *   { rejected: true, reason, message }  the facilitator said no — 402
 *   { unavailable: '<reason>' }          we could not ask — serve, unverified
 */
async function verifyPayment(env, payment, requirements) {
  const decoded = payment?.decoded;
  // A header we cannot even decode is the caller's bug, not an outage: there is
  // nothing to send the facilitator, so it is a rejection rather than a serve.
  if (!decoded) {
    return {
      rejected: true,
      reason: 'malformed_payment_header',
      message:
        'X-PAYMENT (x402 v1) or PAYMENT-SIGNATURE (x402 v2) must be base64-encoded JSON — an x402 payment payload',
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
async function settleAndRecord(env, db, { requirements, facRequirements, version, payload, payer, tool }) {
  let settleOk = 0;
  let txHash = null;
  let error = null;

  // `resource` on the SETTLE payload, and only there.
  //
  // The Bazaar attaches a settlement to a listing by reading `resource` off the
  // settle body, and an x402 client is not obliged to echo it back — x402-fetch
  // does not. So a settlement from a perfectly ordinary client would land with
  // no resource attached and index against nothing. The value is our own
  // envelope's, which the client signed against, so this adds nothing it did not
  // already agree to.
  //
  // It is spread in rather than assigned so a client that DID send one keeps its
  // own, and it is deliberately absent from the verify call: verify is the
  // signature check, and the payload it sees stays byte-for-byte what arrived.
  // `resource` is envelope metadata and is not covered by the EIP-712
  // signature, so adding it here cannot invalidate anything.
  //
  // The VALUE is version-shaped: v1's `resource` is the URL string, v2's is the
  // ResourceInfo object. A v2 client built by @x402/core echoes ours back
  // already, so this is a backstop for one that does not.
  const ownResource = version === 2 ? resourceInfoV2(requirements) : requirements.resource;
  const settlePayload = payload?.resource ? payload : { ...payload, resource: ownResource };

  try {
    const call = await facilitatorCall(env, 'settle', settlePayload, facRequirements, SETTLE_TIMEOUT_MS);
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

  // The owner's ping, LAST — after the ledger write, never instead of it. The
  // `settlements` table is the source of truth for money; this is a courtesy
  // that tells a human to go look. Ordering it this way means a channel outage
  // can never cost a row, and it never throws (see sendPaymentAlert).
  //
  // `verifyOk` is 1 by construction here — reaching this function at all means
  // the facilitator returned isValid — so this fires on real money moving, or
  // on real money that was supposed to move and did not. Both are worth waking
  // up for; `settleOk` is what tells them apart.
  await sendPaymentAlert(env, {
    kind: 'settled',
    tool,
    payer,
    amount: requirements.maxAmountRequired,
    settleOk,
    txHash,
    error,
  });
}

/**
 * One POST to the facilitator. Returns { ok: true, data } or { ok: false, reason }.
 *
 * The body shape is the x402 spec's, and matches what `useFacilitator` in the
 * `x402` package sends, field for field.
 *
 * IT IS THE SAME BODY IN BOTH VERSIONS — `{ x402Version, paymentPayload,
 * paymentRequirements }` — and the same two endpoints. Confirmed twice:
 * @x402/core 2.23.0's HTTPFacilitatorClient sends exactly this for v1 and v2
 * alike, differing only in the version number and in the shapes of the two
 * objects; and CDP's own reference pages for
 * /platform/v2/x402/{verify,settle} document `x402Version` as `1 | 2` with no
 * separate v2 route. (The `v2` in that path is CDP's platform API version and
 * has nothing to do with the protocol version.) So the version travels in the
 * payload and the shapes, and this function needs no branch.
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

/** The payment header is base64-encoded JSON. Returns null if it is not. */
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

// ------------------------------------------------------------------ alerts
//
// Owner-facing payment alerts on two channels: Telegram (instant, primary) and
// email through Cloudflare Email Routing (secondary). They exist because the
// `settlements` table is a perfect record that nobody reads at 3am, and the one
// event this service is built to produce — a stranger paying for something —
// is worth a phone buzzing.
//
// FOUR RULES, and together they are the whole design.
//
//   AN ALERT NEVER TOUCHES THE PAYING CALLER. Everything here runs inside
//   ctx.waitUntil, after the response has shipped, and each channel is caught
//   independently. A dead Telegram, a revoked token, an unverified email
//   destination or a missing binding costs a notification and nothing else.
//
//   NO RETRIES. AN ALERT IS NOT A LEDGER. `settlements` is the source of truth
//   and the queries in README § Reading the ledger are what reconcile money; a
//   retry loop here would buy duplicate pings on a flaky network and still lose
//   the alert in a real outage. Fire once, drop it, move on.
//
//   A CHANNEL WITH NO CONFIG IS SKIPPED BEFORE ANY NETWORK CALL. Unset is a
//   working state: this Worker ran without alerts for its entire life until
//   now, and a deployment that never sets the secrets must behave exactly as it
//   did — no fetch, no binding access, no cost.
//
//   ONLY VERIFIED MONEY IS WORTH A PING. Malformed headers and
//   facilitator-rejected payments are probe noise — the shed is on a public
//   index and gets scanned continuously — and paging on them would train the
//   owner to ignore the channel, which is the only way this feature can truly
//   fail. The two things that DO fire are a payment the facilitator accepted
//   (settled or not), and a call served with nothing checked at all.

// The email channel's identity. `alerts@lemon-agent.dev` need not be a real
// mailbox — Email Routing sends FROM the zone — but it must be ON the zone.
const ALERT_FROM = 'alerts@lemon-agent.dev';
const ALERT_FROM_NAME = 'Toolshed';

const DEFAULT_TELEGRAM_API_BASE = 'https://api.telegram.org';

// Generous, because nobody is waiting: the response shipped before this ran.
// It exists only so a hung socket cannot pin a waitUntil open indefinitely.
const ALERT_TIMEOUT_MS = 10_000;

/**
 * Atomic USDC (6 decimals) rendered as money: "5000" → "$0.005".
 *
 * Anything that is not a run of digits is passed through labelled rather than
 * coerced — a NaN in a revenue alert is worse than an ugly one.
 */
function formatUsdc(atomic) {
  const raw = String(atomic ?? '');
  if (!/^\d+$/.test(raw)) return `${raw || 'unknown'} (atomic)`;
  const padded = raw.padStart(USDC_DECIMALS + 1, '0');
  const whole = padded.slice(0, -USDC_DECIMALS);
  const frac = padded.slice(-USDC_DECIMALS).replace(/0+$/, '');
  return `$${whole}${frac ? `.${frac}` : ''}`;
}

/**
 * Is this payer one of the house's own wallets?
 *
 * HOUSE_PAYERS is a non-secret var of public chain addresses (wrangler.toml),
 * and it exists so the owner's own test buys read as a drill. The
 * distinction is the entire point of the channel: if a test buy and a stranger's
 * purchase produced the same message, the loud one would stop meaning anything.
 * Unset means every payer is a third party, which fails towards TOO LOUD — the
 * right direction for a revenue alert.
 */
function isHousePayer(env, payer) {
  if (!payer) return false;
  const target = String(payer).trim().toLowerCase();
  return String(env?.HOUSE_PAYERS || '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean)
    .includes(target);
}

/**
 * The alert's first line — the Telegram message's opener and the email subject,
 * deliberately the same string so a phone notification and an inbox preview say
 * the identical thing.
 *
 * Three shapes, visually distinct at a glance because that is all a lock screen
 * gives you:
 *
 *   🍋💰 THIRD PARTY PAID …   a stranger paid. The event.
 *   🧪 test settlement …      the house paying itself. A drill.
 *   ⚠️ SERVED WITHOUT VERIFICATION …   revenue leaked. Different problem.
 */
function alertHeadline(env, alert) {
  const amount = formatUsdc(alert.amount);
  const house = isHousePayer(env, alert.payer);
  const payer = alert.payer || 'unknown';

  if (alert.kind === 'unverified') {
    // The house marker still goes on, because the owner's own probe hitting a
    // down facilitator is a configuration story, not a revenue story. The ⚠️
    // stays either way — the leak is real in both cases.
    return (
      `⚠️ SERVED WITHOUT VERIFICATION${house ? ' (test payer)' : ''} — ` +
      `${amount} ${alert.tool} — payer ${payer} — x-payment-error: ${alert.error}`
    );
  }

  const settled = alert.settleOk === 1 ? 'settled' : `SETTLE FAILED (${alert.error || 'unknown'})`;
  const lead = house ? '🧪 test settlement' : '🍋💰 THIRD PARTY PAID';
  return `${lead} — ${amount} ${alert.tool} — payer ${payer} — tx ${alert.txHash || 'none'} — ${settled}`;
}

/** The headline plus the detail a human needs before deciding to care. */
function alertMessage(env, alert) {
  const subject = alertHeadline(env, alert);
  const lines = [subject, '', `tool     ${alert.tool}`];
  lines.push(`amount   ${formatUsdc(alert.amount)}  (${alert.amount} atomic USDC on Base)`);
  lines.push(`payer    ${alert.payer || 'unknown'}`);

  if (alert.kind === 'unverified') {
    lines.push(`checked  NO — ${alert.error}`);
    lines.push('');
    lines.push('This conversion was SERVED and the payment was never checked, so');
    lines.push('nobody paid for it. Serving anyway is deliberate (availability-first');
    lines.push('at these prices), but a run of these is the paid rail quietly down.');
  } else {
    lines.push('checked  yes — the facilitator returned isValid');
    lines.push(
      alert.settleOk === 1
        ? `settled  yes — ${alert.txHash}`
        : `settled  NO — ${alert.error || 'unknown'} (verified, so the caller was served)`
    );
    if (alert.settleOk === 1 && alert.txHash) {
      lines.push(`explorer https://basescan.org/tx/${alert.txHash}`);
    }
  }

  lines.push('');
  lines.push('The settlements table is the source of truth; this is a courtesy ping.');
  return { subject, text: lines.join('\n') };
}

/**
 * Fire every configured channel. NEVER THROWS, NEVER RETRIES.
 *
 * `allSettled` rather than `all` is the load-bearing choice: the channels must
 * not be able to cancel each other, so a Telegram outage still leaves the email
 * to arrive. Both halves are additionally caught inside themselves, which makes
 * this belt-and-braces — deliberately, because the caller of this function is a
 * ctx.waitUntil where a rejection is both invisible and pointless.
 */
async function sendPaymentAlert(env, alert) {
  try {
    const { subject, text } = alertMessage(env, alert);
    await Promise.allSettled([sendTelegramAlert(env, text), sendEmailAlert(env, subject, text)]);
  } catch {
    /* an alert is best-effort by construction — see the rules above */
  }
}

/**
 * Telegram — the primary channel, because it is the one that buzzes.
 *
 * TELEGRAM_API_BASE is overridable so the suite can point it at a local mock,
 * exactly as FACILITATOR_URL is; production never sets it.
 */
async function sendTelegramAlert(env, text) {
  // Config presence FIRST, before anything that costs. Both halves are needed:
  // a token with no chat id has nowhere to send.
  if (!env?.TELEGRAM_BOT_TOKEN || !env?.TELEGRAM_CHAT_ID) return;

  const base = (env.TELEGRAM_API_BASE || DEFAULT_TELEGRAM_API_BASE).replace(/\/+$/, '');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ALERT_TIMEOUT_MS);
  try {
    // The RESPONSE IS NOT INSPECTED, and that is a decision rather than an
    // oversight: there is nothing to do with a 400 here. No retry (rule two),
    // and the money is already recorded. Reading the body would only add a way
    // to throw inside a waitUntil.
    await fetch(`${base}/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text }),
      signal: controller.signal,
    });
  } catch {
    /* best-effort: an unreachable Telegram costs a ping, nothing more */
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Email — the secondary channel, through the `send_email` binding.
 *
 * BOTH halves are checked before anything is built. The binding is absent
 * unless wrangler.toml declares `[[send_email]]` AND the account has Email
 * Routing enabled, so `env.ALERT_EMAIL?.send` is a genuine runtime question and
 * not a formality; ALERT_EMAIL_TO is a secret, and must name a VERIFIED Email
 * Routing destination or Cloudflare rejects the send.
 *
 * Until the zone's DNS and routing are live this silently no-ops, which is the
 * intended state during setup rather than a failure to fix.
 */
async function sendEmailAlert(env, subject, text) {
  if (typeof env?.ALERT_EMAIL?.send !== 'function' || !env?.ALERT_EMAIL_TO) return;
  try {
    const raw = rawEmail({ to: env.ALERT_EMAIL_TO, subject, text });
    await env.ALERT_EMAIL.send(new EmailMessage(ALERT_FROM, env.ALERT_EMAIL_TO, raw));
  } catch {
    /* best-effort: an unverified destination or a dead zone costs a ping */
  }
}

// --- RFC 5322 ---------------------------------------------------------------
//
// Hand-rolled, and the trade is worth stating. A MIME library would be a
// production dependency in a Worker bundle to produce six headers and a
// plain-text body — the same argument that keeps @coinbase/x402 out of the
// facilitator path above. What it costs is that the details have to be right,
// because Cloudflare PARSES what it is handed and rejects what it cannot read:
// CRLF line endings (RFC 5322 § 2.1), a real Message-ID, a Date in the numeric-
// zone form, and a `From:` header whose address matches the envelope sender.

const RFC2822_DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const RFC2822_MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

// 75 characters is the RFC 2047 § 2 ceiling for one encoded-word. Minus
// "=?UTF-8?B?" (10) and "?=" (2) that leaves 63 for the base64 itself, which
// carries 47 bytes — rounded down to 45, a multiple of 3, so no chunk needs
// interior padding.
const MAX_ENCODED_WORD_BYTES = 45;

/**
 * A header value, RFC 2047 encoded when it is not plain ASCII.
 *
 * The headline carries emoji — 🍋💰, 🧪, ⚠️ — and a raw non-ASCII byte in a
 * header is not legal RFC 5322 and gets mangled or refused by real mail
 * servers. So a non-ASCII value becomes base64 encoded-words, each under the
 * 75-character limit, split on CODEPOINT boundaries (iterating the string
 * yields whole codepoints) so a multi-byte character is never cut in half —
 * which would decode to a replacement character in the subject line.
 *
 * Embedded newlines are flattened first: a header value that can contain CRLF
 * is a header-injection hole, and the subject is built from a tool id and a
 * facilitator's error string.
 */
function encodeHeaderValue(value) {
  const text = String(value).replace(/[\r\n]+/g, ' ');
  if (/^[\x20-\x7E]*$/.test(text)) return text;

  const encoder = new TextEncoder();
  const words = [];
  let chunk = '';
  let size = 0;
  for (const ch of text) {
    const width = encoder.encode(ch).length;
    if (size + width > MAX_ENCODED_WORD_BYTES && chunk) {
      words.push(chunk);
      chunk = '';
      size = 0;
    }
    chunk += ch;
    size += width;
  }
  if (chunk) words.push(chunk);

  // Continuation lines are joined by CRLF + a single space: that is the RFC
  // 5322 folding rule, and RFC 2047 says the whitespace between two adjacent
  // encoded-words is dropped on decode, so the subject reassembles exactly.
  return words.map((w) => `=?UTF-8?B?${base64Encode(encoder.encode(w))}?=`).join('\r\n ');
}

/** `"Toolshed" <alerts@lemon-agent.dev>`, or `<addr>` with no display name. */
function formatMailbox(name, address) {
  if (!name) return `<${address}>`;
  const encoded = encodeHeaderValue(name);
  // An encoded-word is already an atomic token and must NOT be quoted; a plain
  // display name is quoted so punctuation in it cannot be read as address
  // syntax.
  const display = encoded.startsWith('=?') ? encoded : `"${name.replace(/(["\\])/g, '\\$1')}"`;
  return `${display} <${address}>`;
}

/**
 * RFC 2822 § 3.3 date, in UTC.
 *
 * Built from the UTC getters rather than from `toUTCString()`, which ends in
 * "GMT" where the grammar wants a numeric zone. "GMT" is legal only as obsolete
 * syntax, and obsolete syntax is exactly what a strict parser declines.
 */
function rfc2822Date(date) {
  const p = (n) => String(n).padStart(2, '0');
  return (
    `${RFC2822_DAYS[date.getUTCDay()]}, ${p(date.getUTCDate())} ` +
    `${RFC2822_MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()} ` +
    `${p(date.getUTCHours())}:${p(date.getUTCMinutes())}:${p(date.getUTCSeconds())} +0000`
  );
}

/**
 * A Message-ID that is actually unique: milliseconds plus 8 random bytes, in
 * the sending domain. Cloudflare REQUIRES the header — a message without one is
 * rejected outright — and a duplicate id invites mail clients to thread or
 * dedupe two unrelated alerts into one.
 */
function newMessageId() {
  const domain = ALERT_FROM.split('@')[1];
  return `<${Date.now().toString(36)}.${randomHex(8)}@${domain}>`;
}

/** The whole message: headers, a blank line, and a plain-text body. */
function rawEmail({ to, subject, text, date = new Date() }) {
  const headers = [
    `From: ${formatMailbox(ALERT_FROM_NAME, ALERT_FROM)}`,
    `To: ${formatMailbox(null, to)}`,
    `Subject: ${encodeHeaderValue(subject)}`,
    `Date: ${rfc2822Date(date)}`,
    `Message-ID: ${newMessageId()}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
  ];
  // CRLF throughout, including inside the body — a bare LF in an SMTP payload
  // is the classic silently-corrupted-message bug.
  const body = String(text).replace(/\r?\n/g, '\r\n');
  return `${headers.join('\r\n')}\r\n\r\n${body}\r\n`;
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

function base64Encode(bytes) {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

const base64url = (bytes) =>
  base64Encode(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const base64urlJson = (value) => base64url(new TextEncoder().encode(JSON.stringify(value)));

// STANDARD base64 with padding, NOT the url-safe form above. The x402 v2
// headers are validated against /^[A-Za-z0-9+/]*={0,2}$/ before they are
// decoded (@x402/core's Base64EncodedRegex), so a url-safe envelope is thrown
// out unread — which reads, from the client side, as a seller that sent no
// envelope at all. The JWT above wants the opposite encoding; that is why there
// are two.
const base64Json = (value) => base64Encode(new TextEncoder().encode(JSON.stringify(value)));

// ------------------------------------------------------------------ converters

class ConvertError extends Error {}

function oneLineMessage(err) {
  const raw = String((err && err.message) || err || 'unknown error');
  return raw.replace(/\s+/g, ' ').trim().slice(0, 200);
}

// `sample` is a REAL request body for that tool, and it is published: it is
// what `extensions.bazaar.info.input.body` carries in every v2 envelope, which
// the bazaar spec treats as a worked example of the call rather than as a
// description of one. So it has to actually convert — an example that 400s is
// worse than no example, and the suite pays for each of these and asserts a 200.
// Kept short because it rides in a response HEADER on every unpaid call.
const CONVERTERS = {
  'md-html': {
    description: 'Markdown to HTML conversion',
    mimeType: 'text/html',
    inputFormat: 'Markdown',
    outputFormat: 'HTML',
    contentType: 'text/html; charset=utf-8',
    sample: '# Title\n\nSome **bold** text.\n',
    run: (input) => marked.parse(input),
  },

  'json-yaml': {
    description: 'JSON to YAML conversion',
    mimeType: 'application/yaml',
    inputFormat: 'JSON',
    outputFormat: 'YAML',
    contentType: 'application/yaml; charset=utf-8',
    sample: '{"name":"toolshed","tags":["x402"]}',
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
    inputFormat: 'YAML',
    outputFormat: 'JSON',
    contentType: 'application/json; charset=utf-8',
    sample: 'name: toolshed\ntags:\n  - x402\n',
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
    inputFormat: 'CSV',
    outputFormat: 'JSON',
    contentType: 'application/json; charset=utf-8',
    sample: 'name,tags\ntoolshed,x402\n',
    run: (input) => `${JSON.stringify(csvToRecords(input), null, 2)}\n`,
  },

  'html-markdown': {
    description: 'HTML to Markdown conversion',
    mimeType: 'text/markdown',
    inputFormat: 'HTML',
    outputFormat: 'Markdown',
    contentType: 'text/markdown; charset=utf-8',
    sample: '<h1>Title</h1>\n<p>Some <strong>bold</strong> text.</p>\n',
    run: (input) => {
      // Turndown's browser build reaches for a global `document` that workerd
      // does not have, so the HTML is parsed with domino here and the resulting
      // element handed to Turndown, which skips its own parser entirely.
      guardHtmlComplexity(input);
      const doc = domino.createDocument(input, true);
      return turndown.turndown(doc.body);
    },
  },

  // ---------------------------------------------------------------- 2026-08-30
  // The second wave. Same rule as the first: one parser in, one serializer out,
  // and a ConvertError wherever the two formats genuinely disagree about what
  // can be expressed — because a 400 naming the disagreement is worth more than
  // a 200 carrying a guess, and a 400 is never charged.

  'json-csv': {
    description:
      'JSON to CSV. POST an array of objects; the response is a CSV file whose header row is the ' +
      "union of every record's keys in first-seen order, so a record missing a key gets an empty " +
      'cell instead of a shifted row. One level of nesting flattens to dotted columns (user.id); ' +
      'deeper values and arrays are written as compact JSON in the cell. RFC 4180 quoting.',
    mimeType: 'text/csv',
    inputFormat: 'JSON',
    outputFormat: 'CSV',
    contentType: 'text/csv; charset=utf-8',
    sample: '[{"name":"lemon","qty":3},{"name":"lime","qty":4}]',
    run: (input) => recordsToCsv(parseJsonInput(input), 'the input'),
  },

  'csv-yaml': {
    description:
      'CSV to YAML. POST a CSV file with a header row; the response is block-style YAML — a list ' +
      'of maps, one per data row. Parsed to RFC 4180, so quoted commas and embedded newlines ' +
      'survive. Every value stays a string: no type guessing, which is what keeps leading zeros ' +
      'and long ids intact.',
    mimeType: 'application/yaml',
    inputFormat: 'CSV',
    outputFormat: 'YAML',
    contentType: 'application/yaml; charset=utf-8',
    sample: 'name,qty\nlemon,3\n',
    run: (input) => yaml.dump(csvToRecords(input)),
  },

  'yaml-csv': {
    description:
      'YAML to CSV. POST a YAML list of maps; the response is a CSV file with a header row. The ' +
      'first document of a stream is used and anchors are resolved. One level of nesting flattens ' +
      'to dotted columns; any other top-level shape is refused rather than flattened into a ' +
      'plausible-looking sheet.',
    mimeType: 'text/csv',
    inputFormat: 'YAML',
    outputFormat: 'CSV',
    contentType: 'text/csv; charset=utf-8',
    sample: '- name: lemon\n  qty: 3\n',
    run: (input) => recordsToCsv(parseYamlFirstDoc(input), 'the first YAML document'),
  },

  'json-ndjson': {
    description:
      'JSON array to NDJSON. POST a JSON array; the response is one compact JSON value per line — ' +
      'the shape streaming loaders, log shippers and jq pipelines take. A non-array input is ' +
      'refused rather than emitted as a stream of one, because that is the mistake this endpoint ' +
      'exists to catch.',
    mimeType: 'application/x-ndjson',
    inputFormat: 'JSON',
    outputFormat: 'NDJSON',
    contentType: 'application/x-ndjson; charset=utf-8',
    sample: '[{"a":1},{"a":2}]',
    run: (input) => {
      const parsed = parseJsonInput(input);
      if (!Array.isArray(parsed)) {
        throw new ConvertError(`input must be a JSON array; got ${describeShape(parsed)}`);
      }
      return parsed.length ? `${parsed.map((value) => JSON.stringify(value)).join('\n')}\n` : '';
    },
  },

  'ndjson-json': {
    description:
      'NDJSON to a JSON array. POST newline-delimited JSON; the response is a pretty-printed array ' +
      'of the parsed values. Blank lines are skipped and a line that does not parse is refused ' +
      'naming the 1-based line number — which is the reason to run a parser over a log file ' +
      'instead of wrapping it in brackets.',
    mimeType: 'application/json',
    inputFormat: 'NDJSON',
    outputFormat: 'JSON',
    contentType: 'application/json; charset=utf-8',
    sample: '{"a":1}\n{"a":2}\n',
    run: (input) => {
      const lines = normaliseNewlines(input).split('\n');
      const values = [];
      for (let i = 0; i < lines.length; i++) {
        if (!lines[i].trim()) continue;
        try {
          values.push(JSON.parse(lines[i]));
        } catch (err) {
          throw new ConvertError(`line ${i + 1} is not valid JSON: ${oneLineMessage(err)}`);
        }
      }
      return `${JSON.stringify(values, null, 2)}\n`;
    },
  },

  'frontmatter-json': {
    description:
      'Markdown frontmatter to JSON. POST a Markdown file that begins with a --- fence; the ' +
      'response is {"data": the parsed YAML frontmatter, "content": the body returned byte for ' +
      'byte}. A file with no opening fence is refused rather than reported as having no metadata, ' +
      'because a mistyped fence should not look like an empty one.',
    mimeType: 'application/json',
    inputFormat: 'Markdown with YAML frontmatter',
    outputFormat: 'JSON',
    contentType: 'application/json; charset=utf-8',
    sample: '---\ntitle: Toolshed\n---\n\nBody text.\n',
    run: (input) => `${JSON.stringify(splitFrontmatter(input), null, 2)}\n`,
  },

  'markdown-json': {
    description:
      'Markdown to a JSON token tree. POST Markdown; the response is {"toc": [{depth, text}], ' +
      '"tokens": [...]} — the marked lexer\'s token stream plus a table of contents derived from ' +
      'the real headings. The document\'s structure without rendering it to HTML and parsing that ' +
      'back. A bold line pretending to be a heading was never structure and is not in the toc.',
    mimeType: 'application/json',
    inputFormat: 'Markdown',
    outputFormat: 'JSON',
    contentType: 'application/json; charset=utf-8',
    sample: '# Title\n\nSome text.\n',
    run: (input) => markdownToJson(input),
  },

  'srt-vtt': {
    description:
      'SubRip to WebVTT. POST an .srt file; the response is a .vtt file — a WEBVTT header and ' +
      'timestamps written with a decimal point instead of a comma. Cue numbers are kept as WebVTT ' +
      'cue identifiers and caption text is passed through untouched, so a comma inside a line of ' +
      'dialogue is not mistaken for a timestamp separator.',
    mimeType: 'text/vtt',
    inputFormat: 'SubRip',
    outputFormat: 'WebVTT',
    contentType: 'text/vtt; charset=utf-8',
    sample: '1\n00:00:01,000 --> 00:00:02,000\nHello.\n',
    run: (input) => srtToVtt(input),
  },

  'vtt-srt': {
    description:
      'WebVTT to SubRip. POST a .vtt file; the response is an .srt file. Cues are renumbered from ' +
      '1 and hour-less timestamps are expanded to hh:mm:ss,mmm. The WEBVTT header, NOTE/STYLE/' +
      'REGION blocks and per-cue settings are dropped, because SubRip cannot express them. Input ' +
      'that does not begin with WEBVTT is refused.',
    mimeType: 'application/x-subrip',
    inputFormat: 'WebVTT',
    outputFormat: 'SubRip',
    contentType: 'application/x-subrip; charset=utf-8',
    sample: 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHello.\n',
    run: (input) => vttToSrt(input),
  },

  'toml-json': {
    description:
      'TOML to JSON. POST a TOML document; the response is pretty-printed JSON. A conforming ' +
      'parser handles the parts hand-rolled readers get wrong — dotted keys, arrays of tables, ' +
      'offset date-times. Dates become ISO-8601 strings and comments are dropped, because JSON has ' +
      'neither; this is a read path, not a round trip.',
    mimeType: 'application/json',
    inputFormat: 'TOML',
    outputFormat: 'JSON',
    contentType: 'application/json; charset=utf-8',
    sample: 'title = "toolshed"\n\n[owner]\nname = "lemon"\n',
    run: (input) => {
      let parsed;
      try {
        parsed = tomlParse(input);
      } catch (err) {
        throw new ConvertError(`input is not valid TOML: ${oneLineMessage(err)}`);
      }
      return `${JSON.stringify(parsed, null, 2)}\n`;
    },
  },

  'json-toml': {
    description:
      "JSON to TOML. POST a JSON object; the response is a TOML document. The root must be an " +
      "object, because TOML's root is a table, and a null anywhere in the document is refused — " +
      'TOML has no spelling for one. Both are errors rather than a file that quietly parses to ' +
      'something you did not write.',
    mimeType: 'application/toml',
    inputFormat: 'JSON',
    outputFormat: 'TOML',
    contentType: 'application/toml; charset=utf-8',
    sample: '{"title":"toolshed","owner":{"name":"lemon"}}',
    run: (input) => {
      const parsed = parseJsonInput(input);
      if (!isPlainObject(parsed)) {
        throw new ConvertError(
          `TOML's root is a table, so the input must be a JSON object; got ${describeShape(parsed)}`
        );
      }
      // CHECKED BEFORE STRINGIFY, because smol-toml does not refuse a null — it
      // DROPS the key, and a 200 that silently lost a field is the worst answer
      // available. TOML genuinely has no spelling for null, so the honest reply
      // is a 400 naming the path.
      const nulled = findNullPath(parsed);
      if (nulled) {
        throw new ConvertError(`TOML has no null, and \`${nulled}\` is null — remove it or give it a value`);
      }
      try {
        return `${tomlStringify(parsed)}\n`;
      } catch (err) {
        throw new ConvertError(`input cannot be written as TOML: ${oneLineMessage(err)}`);
      }
    },
  },

  'xml-json': {
    description:
      'XML to JSON. POST an XML document; the response is JSON in fast-xml-parser\'s convention — ' +
      'attributes prefixed @_, text content under #text, and repeated sibling elements collapsed ' +
      'into an array (so an element appearing once is an object and twice is an array). Values stay ' +
      'strings; no type guessing. A document carrying a <!DOCTYPE> is refused, because internal ' +
      'entities are an expansion attack.',
    mimeType: 'application/json',
    inputFormat: 'XML',
    outputFormat: 'JSON',
    contentType: 'application/json; charset=utf-8',
    sample: '<shed><tool id="1">lemon</tool></shed>',
    run: (input) => xmlToJson(input),
  },

  'html-text': {
    description:
      'HTML to readable plain text. POST an HTML file; the response is its prose. The page is ' +
      'parsed with a real DOM, so script, style, noscript, nav, header, footer and aside are ' +
      'dropped WITH their contents, block elements become paragraph breaks, and <pre> is preserved ' +
      'verbatim. Links become their text, not their URL.',
    mimeType: 'text/plain',
    inputFormat: 'HTML',
    outputFormat: 'plain text',
    contentType: 'text/plain; charset=utf-8',
    sample: '<h1>Title</h1>\n<p>Some text.</p>\n',
    run: (input) => htmlToText(input),
  },

  'html-json': {
    description:
      'HTML tables to JSON. POST an HTML page; the response is {"tables": [{caption, columns, ' +
      'rows}]} — every <table> read into row objects keyed by its header cells, in the same shape ' +
      'whether the page has one table or nine. Values stay strings with whitespace collapsed. ' +
      'colspan and rowspan are NOT expanded, and a page with no table is refused.',
    mimeType: 'application/json',
    inputFormat: 'HTML',
    outputFormat: 'JSON',
    contentType: 'application/json; charset=utf-8',
    sample: '<table><tr><th>name</th><th>qty</th></tr><tr><td>lemon</td><td>3</td></tr></table>',
    run: (input) => htmlTablesToJson(input),
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

// ------------------------------------------------------------------ shared parses
//
// Everything below throws ConvertError and nothing else. handleConvert turns
// that into a one-line JSON 400, and a 400 settles nothing — so the honest
// refusal is also the free one, for the caller and for us.

function parseJsonInput(input) {
  try {
    return JSON.parse(input);
  } catch (err) {
    throw new ConvertError(`input is not valid JSON: ${oneLineMessage(err)}`);
  }
}

// The same first-document-of-a-stream rule yaml-json states, in one place so the
// two endpoints cannot drift apart on it.
function parseYamlFirstDoc(input) {
  let docs;
  try {
    docs = yaml.loadAll(input);
  } catch (err) {
    throw new ConvertError(`input is not valid YAML: ${oneLineMessage(err)}`);
  }
  if (!docs.length || docs[0] === undefined) throw new ConvertError('input has no YAML document');
  return docs[0];
}

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

// Used in refusals, so it has to read as a sentence: "got an array", "got a
// string". Naming the shape we actually received is what turns a 400 into
// something a caller can act on without guessing.
const describeShape = (value) => {
  if (value === null) return 'null';
  if (value === undefined) return 'nothing';
  if (Array.isArray(value)) return 'an array';
  if (typeof value === 'object') return 'an object';
  return `a ${typeof value}`;
};

// A leading BOM is stripped and CRLF/CR collapse to LF, which every line-oriented
// converter below assumes. Doing it once means none of them has to remember.
const normaliseNewlines = (input) => input.replace(/^﻿/, '').replace(/\r\n?/g, '\n');

// ------------------------------------------------------------------ CSV out
//
// RFC 4180 in the writing direction: a field is quoted only when it holds a
// comma, a double quote or a line break, and an interior quote is doubled.
// Everything else is written bare, which keeps the output diff-friendly.

function csvField(value) {
  const s = String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// CSV cells are scalars. Null and undefined become the empty cell; anything
// structural is written back as compact JSON rather than as "[object Object]".
const scalarCell = (value) => {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
};

/**
 * Records to CSV, flattening exactly ONE level.
 *
 * The column set is the union of every record's keys IN FIRST-SEEN ORDER, not
 * the first record's keys — a record that omits a key gets an empty cell rather
 * than shifting every later value one column left, which is the bug that
 * `records.map(r => Object.values(r).join(','))` has the first time two records
 * differ. The header is therefore a function of the whole document.
 *
 * One level of nesting becomes dotted columns (`user.id`). Arrays and anything
 * deeper are written as compact JSON in the cell: CSV cannot express them, and
 * deriving columns from an array's length would make the header depend on the
 * data rather than on the shape.
 *
 * `what` names the input in refusals, because this is shared between json-csv
 * ("the input") and yaml-csv ("the first YAML document") and a caller reading a
 * 400 has to know which one it is being told about.
 */
function recordsToCsv(records, what) {
  if (!Array.isArray(records)) {
    throw new ConvertError(`${what} must be an array of objects; got ${describeShape(records)}`);
  }

  const columns = [];
  const seen = new Set();
  const rows = [];

  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (!isPlainObject(record)) {
      throw new ConvertError(`element ${i} of ${what} is ${describeShape(record)}, not an object`);
    }
    // Object.create(null) for the same reason csvToRecords uses it: a key named
    // `__proto__` has to become an own property, not a silent no-op.
    const row = Object.create(null);
    const put = (column, value) => {
      if (!seen.has(column)) {
        seen.add(column);
        columns.push(column);
      }
      row[column] = scalarCell(value);
    };

    for (const [key, value] of Object.entries(record)) {
      if (isPlainObject(value)) {
        for (const [sub, inner] of Object.entries(value)) put(`${key}.${sub}`, inner);
        continue;
      }
      put(key, value);
    }
    rows.push(row);
  }

  if (!records.length) throw new ConvertError(`${what} is an empty array — there is no header row to write`);
  if (!columns.length) throw new ConvertError(`${what} has no fields to write as columns`);

  const lines = [columns.map(csvField).join(',')];
  for (const row of rows) lines.push(columns.map((c) => csvField(row[c] ?? '')).join(','));
  return `${lines.join('\n')}\n`;
}

// ------------------------------------------------------------------ frontmatter
//
// The fence has to be the FIRST thing in the file. A `---` in the middle of a
// document is a horizontal rule, and treating it as a delimiter is how a naive
// splitter eats half a post. `^` is multiline so the closing fence has to be on
// a line of its own; `...` is YAML's other document terminator and is accepted.
const FRONTMATTER = /^---[ \t]*\n([\s\S]*?)^(?:---|\.\.\.)[ \t]*(?:\n|$)/m;

function splitFrontmatter(input) {
  const text = normaliseNewlines(input);
  if (!/^---[ \t]*\n/.test(text)) {
    throw new ConvertError('input has no YAML frontmatter — the file must begin with a --- fence line');
  }
  const match = FRONTMATTER.exec(text);
  if (!match) throw new ConvertError('the frontmatter fence is never closed — expected a --- line of its own');

  let data;
  try {
    data = yaml.load(match[1]);
  } catch (err) {
    throw new ConvertError(`the frontmatter is not valid YAML: ${oneLineMessage(err)}`);
  }
  // An empty fence parses to undefined, which JSON.stringify would DROP from the
  // object entirely — so the caller would get a reply with no `data` key at all
  // rather than one saying there was nothing in the fence.
  return { data: data === undefined ? null : data, content: text.slice(match[0].length) };
}

/**
 * The dotted path of the first null in a document, or null when there is none.
 *
 * Depth-first and returns the FIRST one rather than collecting them all: a
 * caller fixing a config wants one place to look, and the second null is found
 * by the next call.
 */
function findNullPath(value, path = '') {
  if (value === null) return path || '(the root)';
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const hit = findNullPath(value[i], `${path}[${i}]`);
      if (hit) return hit;
    }
    return null;
  }
  if (isPlainObject(value)) {
    for (const [key, inner] of Object.entries(value)) {
      const hit = findNullPath(inner, path ? `${path}.${key}` : key);
      if (hit) return hit;
    }
  }
  return null;
}

// ------------------------------------------------------------------ markdown AST

function markdownToJson(input) {
  let tokens;
  try {
    tokens = marked.lexer(input);
  } catch (err) {
    throw new ConvertError(`input could not be lexed as Markdown: ${oneLineMessage(err)}`);
  }

  // Headings nest inside blockquotes and list items, so the toc is built by
  // walking rather than by filtering the top level.
  const toc = [];
  const walk = (list) => {
    for (const token of list) {
      if (!token || typeof token !== 'object') continue;
      if (token.type === 'heading') toc.push({ depth: token.depth, text: token.text });
      if (Array.isArray(token.tokens)) walk(token.tokens);
      if (Array.isArray(token.items)) walk(token.items);
    }
  };
  walk(tokens);

  // `tokens` is an array carrying a non-index `links` property that
  // JSON.stringify drops; spreading it into a plain array makes that explicit
  // rather than surprising.
  return `${JSON.stringify({ toc, tokens: [...tokens] }, null, 2)}\n`;
}

// ------------------------------------------------------------------ subtitles
//
// SubRip and WebVTT differ in three mechanical ways: the WEBVTT header, the
// decimal separator inside a timestamp, and what each format allows around a
// cue. Nothing here recomputes timing, because none of the timing changes — the
// reason to parse rather than find-and-replace is that a comma inside a line of
// dialogue is not a timestamp separator.

const SRT_STAMP = /^\s*(\d+:\d{2}:\d{2})[,.](\d{3})\s*-->\s*(\d+:\d{2}:\d{2})[,.](\d{3})(.*)$/;
// WebVTT allows the hour field to be omitted. SubRip does not, so it is filled in.
const VTT_STAMP =
  /^\s*(?:(\d+):)?(\d{2}):(\d{2})[.,](\d{3})\s*-->\s*(?:(\d+):)?(\d{2}):(\d{2})[.,](\d{3})(.*)$/;

function srtToVtt(input) {
  const lines = normaliseNewlines(input).split('\n');
  let stamps = 0;

  const converted = lines.map((line) => {
    const m = SRT_STAMP.exec(line);
    if (!m) return line;
    stamps++;
    // Whatever followed the end stamp is SubRip's coordinate extension
    // (`X1:… Y1:…`). It is NOT a WebVTT cue setting, so it is dropped rather
    // than emitted as one a player would read as positioning.
    return `${m[1]}.${m[2]} --> ${m[3]}.${m[4]}`;
  });

  if (!stamps) {
    throw new ConvertError('input has no SubRip timestamp line (hh:mm:ss,mmm --> hh:mm:ss,mmm)');
  }
  return `WEBVTT\n\n${converted.join('\n').replace(/^\n+/, '').replace(/\n+$/, '')}\n`;
}

function vttToSrt(input) {
  const text = normaliseNewlines(input);
  if (!/^\s*WEBVTT/.test(text)) {
    throw new ConvertError('input does not begin with WEBVTT — this endpoint takes a WebVTT file');
  }

  const cues = [];
  for (const block of text.split(/\n{2,}/)) {
    const lines = block.split('\n').filter((line) => line.trim() !== '');
    if (!lines.length) continue;
    // The header block, and the three block types WebVTT has that SubRip has
    // nowhere to put.
    if (/^WEBVTT\b/.test(lines[0])) continue;
    if (/^(NOTE|STYLE|REGION)\b/.test(lines[0])) continue;

    const at = lines.findIndex((line) => VTT_STAMP.test(line));
    if (at === -1) continue;

    const m = VTT_STAMP.exec(lines[at]);
    const start = `${(m[1] || '0').padStart(2, '0')}:${m[2]}:${m[3]},${m[4]}`;
    const end = `${(m[5] || '0').padStart(2, '0')}:${m[6]}:${m[7]},${m[8]}`;

    // Lines BEFORE the stamp are the cue identifier, which SubRip replaces with
    // a sequence number; everything after the end stamp on the stamp line is cue
    // settings, which SubRip cannot express. Both are dropped, loudly, in the
    // entry's caveats.
    cues.push(`${cues.length + 1}\n${start} --> ${end}\n${lines.slice(at + 1).join('\n')}`);
  }

  if (!cues.length) throw new ConvertError('input has no WebVTT cue with a timestamp line');
  return `${cues.join('\n\n')}\n`;
}

// ------------------------------------------------------------------ XML

// parseTagValue/parseAttributeValue OFF, deliberately. The parser's default is
// to coerce anything numeric-looking, which turns an id of "007" into 7 and a
// long account number into a float — the same destruction csv-json refuses to
// do, and for the same reason. Every value comes back a string; cast downstream
// where the schema is known.
const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  trimValues: true,
  parseTagValue: false,
  parseAttributeValue: false,
});

function xmlToJson(input) {
  const text = input.replace(/^﻿/, '');

  // REFUSED, not parsed. Internal DTD entities are how an entity-expansion bomb
  // fits inside a 256 KB body — a few hundred bytes of nested entities expand to
  // gigabytes — and there is no XML document worth spending a Worker's CPU limit
  // on. The check is a substring rather than a parse because it has to happen
  // BEFORE the parser sees the DOCTYPE. Stated as a caveat on the entry.
  if (/<!DOCTYPE/i.test(text)) {
    throw new ConvertError(
      'input carries a <!DOCTYPE> — DTDs are refused here, because internal entities are an expansion attack'
    );
  }

  const verdict = XMLValidator.validate(text, { allowBooleanAttributes: true });
  if (verdict !== true) {
    const err = verdict && verdict.err;
    const detail = err ? `${err.msg}${err.line ? ` (line ${err.line})` : ''}` : 'unknown error';
    throw new ConvertError(`input is not well-formed XML: ${oneLineMessage(detail)}`);
  }

  let parsed;
  try {
    parsed = xmlParser.parse(text);
  } catch (err) {
    throw new ConvertError(`input could not be parsed as XML: ${oneLineMessage(err)}`);
  }
  return `${JSON.stringify(parsed, null, 2)}\n`;
}

// ------------------------------------------------------------------ HTML readers
//
// Both of these parse with domino for the same reason html-markdown does: a
// regex over markup is the thirty-year-old failure mode, and workerd has no
// `document` for a browser-oriented library to reach for.

// The complexity gate every HTML converter runs BEFORE domino sees the input.
// domino's parse is superlinear in nesting depth (measured: depth 5,000 →
// ~109 ms, 15,000 → ~877 ms on a 256 KB body) and the recursive walkers below
// overflow the stack around depth 10,000 — so a crafted <div>*20000 body burns
// ~3 s of billed CPU to produce a 400. Real documents don't look like that:
// depth caps at 512 (browsers themselves flatten around 512), and a single
// tag longer than 16 KB is an attribute bomb, not markup. Linear scan, void
// elements approximated — it is a guard, not a parser, and it only ever
// refuses; anything it mis-reads still gets parsed properly by domino.
const HTML_MAX_DEPTH = 512;
const HTML_MAX_TAG_CHARS = 16 * 1024;
const HTML_VOID = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta',
  'param', 'source', 'track', 'wbr',
]);
function guardHtmlComplexity(input) {
  const re = /<(\/?)([a-zA-Z][^\s/>]*)([^>]*)/g;
  let depth = 0;
  let m;
  while ((m = re.exec(input)) !== null) {
    if (m[3].length > HTML_MAX_TAG_CHARS) {
      throw new ConvertError('input has a single tag longer than 16 KB — that is not markup this tool converts');
    }
    const name = m[2].toLowerCase();
    if (m[1]) {
      if (depth > 0) depth -= 1;
    } else if (!HTML_VOID.has(name) && !m[3].endsWith('/')) {
      depth += 1;
      if (depth > HTML_MAX_DEPTH) {
        throw new ConvertError(`input nests deeper than ${HTML_MAX_DEPTH} elements — real documents do not, and parsing it would burn seconds of CPU`);
      }
    }
  }
}

// Dropped WITH their subtrees. Turndown's rule set drops script/style/noscript
// for the same reason; the page-chrome elements are added here because "readable
// plain text" means the article, not the navigation. It is a heuristic and the
// entry's caveat says so — a page that puts its article inside <aside> loses it.
const TEXT_DROP = new Set([
  'SCRIPT', 'STYLE', 'NOSCRIPT', 'NAV', 'HEADER', 'FOOTER', 'ASIDE', 'IFRAME', 'TEMPLATE', 'SVG', 'CANVAS',
]);

// Elements that end a paragraph. TD/TH are handled separately — as a tab, not a
// paragraph break, so a table row stays one line.
const TEXT_BLOCK = new Set([
  'ADDRESS', 'ARTICLE', 'BLOCKQUOTE', 'DD', 'DIV', 'DL', 'DT', 'FIELDSET', 'FIGCAPTION', 'FIGURE',
  'FORM', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HR', 'LI', 'MAIN', 'OL', 'P', 'SECTION', 'TABLE',
  'TR', 'UL',
]);

const tagOf = (node) => String(node.tagName || '').toUpperCase();

function htmlToText(input) {
  guardHtmlComplexity(input);
  const doc = domino.createDocument(input, true);
  const body = doc.body;
  if (!body) throw new ConvertError('input has no <body> to read');

  // <pre> is the one place whitespace is content, so its text is lifted OUT
  // before the collapsing pass and put back afterwards. Doing it any other way
  // means the pass that turns "one     two" into "one two" also eats a code
  // block's indentation — which it did, and which is why this is a placeholder
  // rather than a flag. NUL is the marker because it cannot occur in the text
  // (it is stripped from every text node below) and it is not whitespace, so
  // none of the collapsing regexes touch it.
  const preserved = [];
  let out = '';
  const visit = (node) => {
    for (const child of node.childNodes) {
      if (child.nodeType === 3) {
        out += String(child.nodeValue).replace(/\u0000/g, '').replace(/\s+/g, ' ');
        continue;
      }
      if (child.nodeType !== 1) continue;

      const tag = tagOf(child);
      if (TEXT_DROP.has(tag)) continue;
      if (tag === 'BR') {
        out += '\n';
        continue;
      }
      if (tag === 'PRE') {
        out += `\n\n\u0000${preserved.push(String(child.textContent || '')) - 1}\u0000\n\n`;
        continue;
      }
      if (tag === 'TD' || tag === 'TH') {
        visit(child);
        out += '\t';
        continue;
      }
      const block = TEXT_BLOCK.has(tag);
      if (block) out += '\n\n';
      visit(child);
      if (block) out += '\n\n';
    }
  };
  visit(body);

  const text = out
    .replace(/[ \t]*\n[ \t]*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/ {2,}/g, ' ')
    .trim()
    .replace(/\u0000(\d+)\u0000/g, (_, index) => preserved[Number(index)])
    .replace(/\n+$/, '');
  if (!text.trim()) {
    throw new ConvertError('input has no readable text once scripts, styles and page chrome are dropped');
  }
  return `${text}\n`;
}

// Rows belonging to THIS table. Descending only through THEAD/TBODY/TFOOT is
// what keeps a NESTED table's rows out — `querySelectorAll('tr')` would swallow
// them into the outer table silently, which is a wrong answer with no error.
function tableRows(table) {
  const rows = [];
  const collect = (parent) => {
    for (const child of parent.childNodes) {
      if (child.nodeType !== 1) continue;
      const tag = tagOf(child);
      if (tag === 'TR') rows.push(child);
      else if (tag === 'THEAD' || tag === 'TBODY' || tag === 'TFOOT') collect(child);
    }
  };
  collect(table);
  return rows;
}

function rowCells(row) {
  const cells = [];
  for (const child of row.childNodes) {
    if (child.nodeType !== 1) continue;
    const tag = tagOf(child);
    if (tag === 'TD' || tag === 'TH') cells.push(child);
  }
  return cells;
}

const cellText = (node) => String(node.textContent || '').replace(/\s+/g, ' ').trim();

// Header cells are written by people, so they repeat and they go missing. Both
// have to become distinct keys or a row silently loses a column — the same class
// of bug as the `__proto__` one csvToRecords fixed.
function uniqueColumns(names) {
  const used = new Set();
  return names.map((raw, i) => {
    const base = raw || `column_${i + 1}`;
    let name = base;
    let n = 2;
    while (used.has(name)) name = `${base}_${n++}`;
    used.add(name);
    return name;
  });
}

function htmlTablesToJson(input) {
  guardHtmlComplexity(input);
  const doc = domino.createDocument(input, true);
  const tables = Array.from(doc.getElementsByTagName('table'));
  if (!tables.length) throw new ConvertError('input contains no <table> element');

  const out = [];
  for (const table of tables) {
    const rows = tableRows(table);
    if (!rows.length) continue;

    // The header is the first row made of <th>, else the first row. A table
    // whose header is <td> is common enough that refusing it would be pedantry.
    const headerIndex = rows.findIndex((row) => rowCells(row).some((cell) => tagOf(cell) === 'TH'));
    const at = headerIndex === -1 ? 0 : headerIndex;
    const columns = uniqueColumns(rowCells(rows[at]).map(cellText));

    const body = [];
    for (let i = 0; i < rows.length; i++) {
      if (i === at) continue;
      const cells = rowCells(rows[i]);
      if (!cells.length) continue;
      const record = Object.create(null);
      const width = Math.max(columns.length, cells.length);
      for (let c = 0; c < width; c++) {
        record[columns[c] ?? `column_${c + 1}`] = c < cells.length ? cellText(cells[c]) : '';
      }
      body.push(record);
    }

    const caption = Array.from(table.childNodes).find((n) => n.nodeType === 1 && tagOf(n) === 'CAPTION');
    out.push({ caption: caption ? cellText(caption) : null, columns, rows: body });
  }

  if (!out.length) throw new ConvertError('input has a <table> but no rows in it');
  return `${JSON.stringify({ tables: out }, null, 2)}\n`;
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
