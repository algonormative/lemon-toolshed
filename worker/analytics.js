// PostHog capture from the edge, over plain fetch.
//
// WHY THIS FILE EXISTS AT ALL. The `events` and `settlements` tables are the
// ledger — exact, private, and the source of truth for anything about money or
// about work that was actually done. They answer "what did we earn" and "how
// many conversions ran". They do not answer "who is knocking, and where do they
// stop", because everything interesting about this service's traffic is a thing
// that never reaches a table: a 402 that nobody ever pays, an agent that reads
// /llms.txt every hour and never buys, a client that keeps POSTing an id that
// does not exist, an indexer prober that quietly stopped calling. `events`
// records one row per call we SERVED, with no user agent and no per-endpoint
// quote — so as of 2026-09-02 the property with the most third-party paying
// customers in the estate was the least observable one. This file is the shape
// of the funnel, and only that.
//
// CONFIGURATION. Two vars, both optional, and UNSET IS A WORKING STATE:
//
//   POSTHOG_PROJECT_TOKEN  a Worker SECRET (`npx wrangler secret put
//                          POSTHOG_PROJECT_TOKEN`). The estate's shared PostHog
//                          project. Unset = this file makes no network call of
//                          any kind, and the Worker behaves exactly as if it
//                          were not imported.
//   POSTHOG_HOST           OPTIONAL override of the ingest root, default
//                          https://us.i.posthog.com. Only the test suite sets
//                          it, to reach a local mock — the same pattern
//                          FACILITATOR_URL and TELEGRAM_API_BASE already use.
//
// Neither belongs in wrangler.toml: the token is a credential, and the host has
// no non-test reason to move. See README § Traffic analytics.
//
// WHY NOT posthog-node. This Worker's bundle is npm dependencies chosen one at a
// time, each checked for `node:` builtins because wrangler.toml sets no
// nodejs_compat flag. Analytics is the least good reason in the world to add
// another one: the capture API is a single POST of a JSON object, so it is a
// single POST of a JSON object.
//
// THE FIVE RULES, restated in one line each because the next person to edit this
// file should not have to go and find them. README § Traffic analytics argues
// each one out; the code below is where they are actually enforced.
//
//   1. ANALYTICS NEVER TOUCHES THE CALLER. Every send is inside ctx.waitUntil,
//      after the response shipped, in its own try/catch. A dead PostHog, a
//      revoked token or a partition costs a graph and NOTHING ELSE — there is no
//      path from this file to a status code, a quote or a settlement.
//   2. NO RETRIES. `settlements` and `events` are the ledger and survive PostHog
//      being down for a week. Fire once, drop it, move on.
//   3. NO CONFIG IS SKIPPED BEFORE ANY NETWORK CALL, DNS included, and
//      test/analytics.test.mjs proves it rather than documenting it.
//   4. NOTHING THE CALLER OWNS LEAVES THIS WORKER. Not the input file, not the
//      output, not the referrer, not the raw IP — the same line the `events`
//      table already draws. What ships is which endpoint, which tool, what it
//      costs, what happened, and the user agent, which is the one field that
//      makes agent traffic legible. `payer` ships only when a payment was
//      actually presented: an address its owner revealed by signing onto a
//      public chain, already in `settlements` for the same reason.
//   5. EVENTS ARE ANONYMOUS. `$process_person_profile: false` on every send.
//      Nobody logs in here, and it is ~4x cheaper to ingest.
//
// THE EVENT NAMES ARE THE ESTATE'S, NOT THIS SERVICE'S. `x402 quote issued`,
// `x402 call refused` and `x402 payment settled` already exist in the shared
// PostHog project, sent by 10x402, kino402, penny402 and parallax. Renaming them
// here — even to something more accurate about conversion — would split every
// estate-wide funnel in two, silently, and the graph would just show a smaller
// number. One name is added, `x402 tool served`, which is this property's half
// of the per-property "served" event the other four already have.

import { SITE_BASE } from './catalog.generated.js';

const DEFAULT_HOST = 'https://us.i.posthog.com';

// Generous, because nobody is waiting: the response shipped before this ran. It
// exists only so a hung socket cannot pin a waitUntil open indefinitely.
const CAPTURE_TIMEOUT_MS = 5_000;

/** The event names, in one place so a rename is one edit and greppable. */
export const EVENTS = {
  quoteIssued: 'x402 quote issued',
  callRefused: 'x402 call refused',
  toolServed: 'x402 tool served',
  paymentSettled: 'x402 payment settled',
};

/**
 * The complete vocabulary of `x402 call refused`.
 *
 * A CLASS, NEVER THE MESSAGE. The refusal bodies this Worker returns carry prose
 * written for a human — `could not convert the input: Unexpected token } in JSON
 * at position 41` — and prose is where a fragment of the caller's own file would
 * eventually end up quoted back into an analytics store. The graph only needs to
 * know which KIND of thing went wrong, and a closed set keeps the breakdown
 * readable besides.
 *
 * One entry per refusing branch in handleConvert(), plus `other`, which is the
 * sink `refusalReason()` coerces anything unrecognised into — so the invariant
 * "every reason shipped is in this list" holds by construction and not by
 * vigilance. test/analytics.test.mjs asserts both halves.
 */
export const REFUSAL_REASONS = [
  'method-not-allowed', // 405 — anything but POST
  'unknown-tool', // 404 — no hosted entry with that id
  'not-implemented', // 501 — listed with no converter behind it
  'body-too-large', // 413 — declared or actual, over MAX_CONVERT_BODY
  'bad-input', // 400 — empty, unreadable, or unconvertible input
  'no-payto', // 429 — a paid tool on a deployment with no receiving address
  'no-price', // 429 — a `price: free` entry with no free tier enabled
  'free-tier-spent', // 429 — the caller's free allowance is gone
  'paid-ceiling', // 429 — the per-caller runaway bound (PAID_DAILY)
  'global-ceiling', // 429 — rung 2, the whole-service daily bound
  'payment-invalid', // 402 — the facilitator refused the presented payment
  'payment-replayed', // 402 — that exact payload already bought a conversion
  'unavailable', // 503 — the limiter/store is unreachable; we fail closed
  'other', // the coercion sink; a reason outside this list is a bug
];

const REFUSAL_SET = new Set(REFUSAL_REASONS);

/**
 * Coerce a reason into the closed vocabulary.
 *
 * A call site that invents a reason gets `other` rather than silently widening
 * the breakdown — the graph stays readable and the bug stays visible as an
 * `other` bar rather than as a new legend entry nobody notices.
 */
export const refusalReason = (reason) => (REFUSAL_SET.has(reason) ? reason : 'other');

/**
 * Is analytics configured?
 *
 * The ONLY authority is the token. A host with no token is not a half-working
 * deployment, it is an unconfigured one — see the third rule.
 */
export function analyticsEnabled(env) {
  return typeof env?.POSTHOG_PROJECT_TOKEN === 'string' && env.POSTHOG_PROJECT_TOKEN !== '';
}

/**
 * Is this payer one of the house's own wallets?
 *
 * DUPLICATED FROM beacon.js ON PURPOSE, and it is the same six lines. beacon.js
 * imports this file, so importing its copy back would be a cycle; and the
 * question this one answers is a different one — beacon's decides how loudly to
 * ring the owner's phone, this one decides whether a point belongs in the
 * revenue graph or in the drill bucket. A no-payer event is `false`: an
 * unauthenticated 402 is not the house.
 *
 * Lowercased on both sides, so a base58 Solana address matches in whatever case
 * the facilitator reports it in.
 */
export function housePayer(env, payer) {
  if (!payer) return false;
  const target = String(payer).trim().toLowerCase();
  return String(env?.HOUSE_PAYERS || '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean)
    .includes(target);
}

/**
 * The atomic USDC string the envelope and the ledger carry, as the number a
 * graph can sum.
 *
 * READ OFF AN EXISTING AMOUNT, NEVER RECOMPUTED. The settlement call site hands
 * this the value that already went into the 402 and onto the `settlements` row,
 * so there is no second pricing implementation in this file — which is the one
 * thing this service claims not to have.
 */
export function usdOf(atomic) {
  const raw = String(atomic ?? '');
  return /^\d+$/.test(raw) ? Number(raw) / 1e6 : null;
}

// ------------------------------------------------------------------ emitters
//
// Four functions, one per event, so a call site names the thing that happened
// and nothing else. Each is fire-and-forget and safe everywhere; each returns
// whatever capture() returns (undefined when analytics is off), which no call
// site uses.

/** A 402 went out: an envelope was quoted and nobody has paid it yet. */
export const quoteIssued = (env, ctx, request, props) =>
  capture(env, ctx, EVENTS.quoteIssued, shape(props), request);

/** A call was turned away. `props.reason` is coerced into REFUSAL_REASONS. */
export const callRefused = (env, ctx, request, props) =>
  capture(env, ctx, EVENTS.callRefused, { ...shape(props), reason: refusalReason(props?.reason) }, request);

/** A conversion was served — the 200. `paid` says under which tier. */
export const toolServed = (env, ctx, request, props) =>
  capture(env, ctx, EVENTS.toolServed, shape(props), request);

/**
 * A verified payment reached the facilitator's settle endpoint.
 *
 * `ctx` is null at the only call site: settleAndRecord() already runs inside a
 * waitUntil of its own, so this is awaited inline rather than registering a
 * second one there that nobody would await.
 */
export const paymentSettled = (env, ctx, request, props) =>
  capture(env, ctx, EVENTS.paymentSettled, shape(props), request);

/**
 * The four properties every event carries, present even when unknown.
 *
 * `null` rather than absent: a breakdown that has to distinguish "this call had
 * no price" from "this build forgot to send one" will guess wrong, and the
 * property list is the contract the estate's shared dashboards read.
 */
function shape(props = {}) {
  return {
    endpoint: null, // the route template, e.g. /convert/:id
    path: null, // the pathname as called, e.g. /convert/md-html
    tool: null, // the hosted conversion id, e.g. md-html
    price_usd: null, // what the call costs, in dollars, from the catalog
    ...props,
  };
}

/**
 * Send one event. Call it from anywhere; it is safe everywhere.
 *
 *   capture(env, ctx, event, properties, request)   — deferred via ctx.waitUntil
 *   await capture(env, null, event, properties, request)
 *                                                   — for callers ALREADY off
 *                                                     the response path
 *
 * `request` is optional and is the only thing read off the caller's own message:
 * the user agent, which PostHog's bot and AI-traffic classification needs and is
 * worthless without, and the country code Cloudflare has already computed.
 * Nothing else about the request is looked at, and the BODY is never in scope
 * here at all.
 *
 * Returns undefined when analytics is off, so a caller cannot accidentally await
 * a network call that a correct deployment never makes.
 */
export function capture(env, ctx, event, properties = {}, request = null) {
  if (!analyticsEnabled(env)) return undefined;

  // .catch here as well as inside send(): belt and braces on the one promise
  // that is allowed to be abandoned, because an unhandled rejection inside a
  // waitUntil is a Worker-level error and this file is not permitted to cause
  // one.
  const work = send(env, event, properties, request).catch(() => {});

  // Deferred when there is a ctx, awaitable when there is not — the same shape
  // as beacon.js's own deferWork(), and correctness over latency when a direct
  // invocation has no ctx to hang the work on.
  if (ctx?.waitUntil) ctx.waitUntil(work);
  return work;
}

/** One POST. Fire once, never retried, never allowed to throw. */
async function send(env, event, properties, request) {
  const token = env.POSTHOG_PROJECT_TOKEN;
  const host = (env.POSTHOG_HOST || DEFAULT_HOST).replace(/\/+$/, '');

  let distinctId;
  try {
    distinctId = await callerId(token, properties?.payer, request);
  } catch {
    // crypto.subtle unavailable or failing: the event is still worth having
    // without a caller grouping. There is no path from here to a response.
    distinctId = 'edge-anonymous';
  }

  const ua = request?.headers?.get?.('user-agent');
  const country = request?.headers?.get?.('cf-ipcountry') || null;

  const payload = {
    api_key: token,
    event,
    distinct_id: distinctId,
    timestamp: new Date().toISOString(),
    properties: {
      ...properties,
      // LAST, so no caller-supplied property object can spread over any of them.
      //
      // The house flag is derived here rather than at each call site for exactly
      // that reason: it decides whether a point lands in the revenue graph or in
      // the drill bucket, and that is not a decision a call site should be able
      // to get wrong in one place out of thirteen.
      house: housePayer(env, properties?.payer),
      // ON EVERY EVENT, not just a pageview. These land in a PostHog project
      // shared with every other house property, and $host is what separates
      // them — without it an estate-wide "which property is doing anything"
      // breakdown silently drops every sale this service makes into an
      // unattributed bucket.
      $host: hostOf(env),
      ...(request ? { $raw_user_agent: ua || '' } : {}),
      ...(country ? { $geoip_country_code: country } : {}),
      // No accounts, no logins, nothing a person profile could hold — and ~4x
      // cheaper to ingest. See the fifth rule.
      $process_person_profile: false,
    },
  };

  const timer = AbortSignal.timeout ? AbortSignal.timeout(CAPTURE_TIMEOUT_MS) : undefined;
  try {
    await fetch(`${host}/i/v0/e/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: timer,
    });
  } catch {
    // First rule. A graph, and nothing else.
  }
}

/** The public origin's host, which is what separates this property from its siblings. */
function hostOf(env) {
  try {
    return new URL(env?.SITE_BASE || SITE_BASE).host;
  } catch {
    return new URL(SITE_BASE).host;
  }
}

/**
 * A stable caller id, shaped so Toolshed's callers join to the rest of the
 * estate rather than forming an island in the shared project.
 *
 * A PAYER ADDRESS WINS WHENEVER ONE WAS PRESENTED. It is the strongest identity
 * a caller here can have — the same wallet across every property, across IPs and
 * across days — and its owner revealed it by signing a payment onto a public
 * chain. It is what makes "this buyer also calls kino402" a question the shared
 * project can answer at all.
 *
 * Otherwise: NOT the IP, and never stored anywhere. SHA-256 over the project
 * token and the address, truncated to 8 bytes — byte-for-byte the same
 * derivation the other four properties use, which is the whole point of copying
 * it rather than inventing one. The token is the salt purely so the same address
 * on a different project is a different id; there is nothing secret being
 * protected here, an IP is not a secret, but an analytics store is the wrong
 * place to accumulate a list of them and this costs one hash to avoid.
 *
 * Note this is NOT the day-scoped `events` identity beacon.js writes: that one
 * is salted with a rotating daily salt and is deliberately unlinkable across
 * days, which is exactly the property that makes it useless for a funnel.
 */
async function callerId(token, payer, request) {
  if (typeof payer === 'string' && payer.trim() !== '') return payer.trim();
  const ip = request?.headers?.get?.('cf-connecting-ip') || '';
  if (!ip) return 'edge-anonymous';
  const bytes = new TextEncoder().encode(`${token}:${ip}`);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return `edge-${[...new Uint8Array(digest)]
    .slice(0, 8)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')}`;
}
