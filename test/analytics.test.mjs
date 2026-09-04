// worker/analytics.js — the estate's PostHog event family, in process.
//
// NO WORKER, NO NETWORK, NO WRANGLER. This is the one suite in the repo that
// imports a Worker module directly and runs it under plain `node --test`, which
// is possible because analytics.js takes exactly two npm-free dependencies:
// `fetch` and `crypto.subtle`, both of which node has natively and both of which
// workerd has natively. It is therefore the fastest place to pin the things that
// are true of every send regardless of which route produced it.
//
// THE FETCH STUB THROWS ON ANY URL THAT IS NOT THE INGEST ENDPOINT, and every
// test asserts on the full list of calls it recorded. That is what makes "unset
// is a working state" a checked claim rather than a comment: a build that
// captured with no token, or captured to somewhere else, fails the run rather
// than quietly costing money.
//
// AF-06: nothing here reaches PostHog, the facilitator, or any billed service.

import { after, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';

import {
  EVENTS,
  REFUSAL_REASONS,
  analyticsEnabled,
  callRefused,
  capture,
  housePayer,
  paymentSettled,
  quoteIssued,
  refusalReason,
  toolServed,
  usdOf,
} from '../worker/analytics.js';

const TOKEN = 'phc_test_token_not_a_real_project';
const INGEST = 'https://us.i.posthog.com/i/v0/e/';
const HOUSE = '0x632Ff2f904CC6ab6d741A42014c4C483F328e92F';
const OUTSIDER = '0x00000000000000000000000000000000deadbeef';

const ENV = { POSTHOG_PROJECT_TOKEN: TOKEN, HOUSE_PAYERS: `${HOUSE},D7f9EifwoMdfwozWDNLFhBGwecVhryc5fs2SxLK93M45` };

/** A request with only the three headers analytics is ever allowed to read. */
const req = ({ ua = 'agent/1.0', ip = '203.0.113.7', country = 'US' } = {}) => ({
  headers: {
    get: (name) =>
      ({ 'user-agent': ua, 'cf-connecting-ip': ip, 'cf-ipcountry': country })[String(name).toLowerCase()] ?? null,
  },
});

const original = globalThis.fetch;
after(() => {
  globalThis.fetch = original;
});

/**
 * Replace fetch, and record every call before deciding what to do with it.
 *
 * Recorded FIRST so an unexpected URL still shows up in `calls` — a stub that
 * only threw would have its throw swallowed by send()'s own try/catch and the
 * test would pass while the Worker talked to the wrong host.
 */
function stubFetch({ reject = null } = {}) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init, body: JSON.parse(init?.body ?? 'null') });
    if (reject) throw reject;
    return { ok: true, status: 200 };
  };
  return calls;
}

/** The single event a capture produced, with the whole call list checked. */
async function one(fn) {
  const calls = stubFetch();
  await fn();
  assert.equal(calls.length, 1, 'exactly one capture');
  assert.equal(calls[0].url, INGEST, 'captures go to the ingest endpoint and nowhere else');
  assert.equal(calls[0].init.method, 'POST');
  return calls[0].body;
}

const SHED = { endpoint: '/convert/:id', path: '/convert/md-html', tool: 'md-html', price_usd: 0.002 };

describe('the event family', () => {
  it('uses the estate\'s names, which are shared with the other four properties', () => {
    assert.deepEqual(EVENTS, {
      quoteIssued: 'x402 quote issued',
      callRefused: 'x402 call refused',
      toolServed: 'x402 tool served',
      paymentSettled: 'x402 payment settled',
    });
  });

  it('emits each of the four under its own name', async () => {
    for (const [emit, name] of [
      [quoteIssued, EVENTS.quoteIssued],
      [(...a) => callRefused(...a), EVENTS.callRefused],
      [toolServed, EVENTS.toolServed],
      [paymentSettled, EVENTS.paymentSettled],
    ]) {
      const body = await one(() => emit(ENV, null, req(), { ...SHED, reason: 'bad-input' }));
      assert.equal(body.event, name);
      assert.equal(body.api_key, TOKEN);
    }
  });

  it('carries endpoint, path, tool, price_usd, house and the user agent on every event', async () => {
    for (const emit of [quoteIssued, toolServed, paymentSettled]) {
      const body = await one(() => emit(ENV, null, req({ ua: 'curl/8.4.0' }), SHED));
      assert.equal(body.properties.endpoint, '/convert/:id');
      assert.equal(body.properties.path, '/convert/md-html');
      assert.equal(body.properties.tool, 'md-html');
      assert.equal(body.properties.price_usd, 0.002);
      assert.equal(body.properties.house, false);
      assert.equal(body.properties.$raw_user_agent, 'curl/8.4.0');
      assert.equal(body.properties.$host, 'toolshed.lemon-agent.dev');
      assert.equal(body.properties.$process_person_profile, false);
      assert.equal(body.properties.$geoip_country_code, 'US');
    }
  });

  it('reports the four shared properties as null rather than dropping them', async () => {
    const body = await one(() => callRefused(ENV, null, req(), { reason: 'unknown-tool', status: 404 }));
    for (const key of ['endpoint', 'path', 'tool', 'price_usd']) {
      assert.ok(key in body.properties, `${key} is present`);
      assert.equal(body.properties[key], null);
    }
  });

  it('carries payer, amount_atomic, rail and tx_hash on a settlement', async () => {
    const body = await one(() =>
      paymentSettled(ENV, null, req(), {
        ...SHED,
        payer: OUTSIDER,
        amount_atomic: '2000',
        rail: 'base',
        tx_hash: '0xabc',
        settle_ok: true,
      })
    );
    assert.equal(body.properties.payer, OUTSIDER);
    assert.equal(body.properties.amount_atomic, '2000');
    assert.equal(body.properties.rail, 'base');
    assert.equal(body.properties.tx_hash, '0xabc');
    assert.equal(body.properties.settle_ok, true);
  });

  it('never lets a call site overwrite house, $host or $process_person_profile', async () => {
    const body = await one(() =>
      toolServed(ENV, null, req(), {
        ...SHED,
        house: true,
        $host: 'evil.example',
        $process_person_profile: true,
      })
    );
    assert.equal(body.properties.house, false);
    assert.equal(body.properties.$host, 'toolshed.lemon-agent.dev');
    assert.equal(body.properties.$process_person_profile, false);
  });
});

describe('the refusal vocabulary', () => {
  it('is closed, and every emitted reason is in it', async () => {
    for (const reason of REFUSAL_REASONS) {
      const body = await one(() => callRefused(ENV, null, req(), { ...SHED, reason, status: 400 }));
      assert.ok(REFUSAL_REASONS.includes(body.properties.reason));
      assert.equal(body.properties.reason, reason);
    }
  });

  it('coerces anything unrecognised to `other` rather than widening the breakdown', async () => {
    for (const bogus of ['could not convert the input: Unexpected token }', '', undefined, null, 42]) {
      const body = await one(() => callRefused(ENV, null, req(), { ...SHED, reason: bogus }));
      assert.equal(body.properties.reason, 'other');
      assert.ok(REFUSAL_REASONS.includes(body.properties.reason));
    }
    assert.equal(refusalReason('bad-input'), 'bad-input');
  });

  it('has no duplicates and includes the `other` sink', () => {
    assert.equal(new Set(REFUSAL_REASONS).size, REFUSAL_REASONS.length);
    assert.ok(REFUSAL_REASONS.includes('other'));
  });

  it('covers every reason the Worker actually wires', () => {
    // Read as TEXT rather than imported: beacon.js pulls in `cloudflare:email`,
    // which only exists inside workerd. A static read is enough — the point is
    // that no call site can name a reason this file has never heard of, and a
    // new branch that invents one fails here rather than shipping an `other`.
    //
    // Scoped to the analytics call sites deliberately: beacon.js also carries
    // `reason:` fields belonging to the facilitator verdict
    // (`facilitator-unconfigured`, `unsupported_network`), which are a different
    // vocabulary owned by a different system and must NOT be swept in here.
    const source = readFileSync(new URL('../worker/beacon.js', import.meta.url), 'utf8');
    const wired = new Set([
      // refuse('x', …) — the shorthand most branches use.
      ...[...source.matchAll(/\brefuse\(\s*'([a-z-]+)'/g)].map((m) => m[1]),
      // callRefused(env, ctx, request, { … reason: 'x' … }) — the long form.
      ...[...source.matchAll(/\bcallRefused\([\s\S]{0,400}?\breason:\s*'([a-z-]+)'/g)].map((m) => m[1]),
      // meterOffer()'s three-way `const reason = …;`.
      ...[...source.matchAll(/\bconst reason =([^;]+);/g)].flatMap((m) =>
        [...m[1].matchAll(/'([a-z-]+)'/g)].map((n) => n[1])
      ),
    ]);
    assert.ok(wired.size >= 10, `found ${wired.size} wired reasons — the scrape stopped matching`);
    for (const reason of wired) {
      assert.ok(REFUSAL_REASONS.includes(reason), `beacon.js refuses with "${reason}", which is not in the vocabulary`);
    }
  });
});

describe('the caller id', () => {
  const idOf = async (body) => body.distinct_id;

  it('is the estate-compatible salted edge id: SHA-256 over `${token}:${ip}`, first 8 bytes', async () => {
    const ip = '198.51.100.4';
    const digest = await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(`${TOKEN}:${ip}`));
    const expected = `edge-${[...new Uint8Array(digest)]
      .slice(0, 8)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')}`;

    const body = await one(() => quoteIssued(ENV, null, req({ ip }), SHED));
    assert.match(await idOf(body), /^edge-[0-9a-f]{16}$/);
    assert.equal(await idOf(body), expected);
  });

  it('is deterministic for one caller and different for another', async () => {
    const a1 = await idOf(await one(() => quoteIssued(ENV, null, req({ ip: '203.0.113.1' }), SHED)));
    const a2 = await idOf(await one(() => quoteIssued(ENV, null, req({ ip: '203.0.113.1', ua: 'other/2' }), SHED)));
    const b = await idOf(await one(() => quoteIssued(ENV, null, req({ ip: '203.0.113.2' }), SHED)));
    assert.equal(a1, a2, 'the same address is the same caller, whatever it calls itself');
    assert.notEqual(a1, b);
  });

  it('is salted by the project token, so the same address elsewhere is a different id', async () => {
    const here = await idOf(await one(() => quoteIssued(ENV, null, req({ ip: '203.0.113.9' }), SHED)));
    const elsewhere = await idOf(
      await one(() =>
        quoteIssued({ ...ENV, POSTHOG_PROJECT_TOKEN: 'phc_a_different_project' }, null, req({ ip: '203.0.113.9' }), SHED)
      )
    );
    assert.notEqual(here, elsewhere);
  });

  it('never ships the raw address', async () => {
    const ip = '203.0.113.77';
    const body = await one(() => quoteIssued(ENV, null, req({ ip }), SHED));
    assert.ok(!JSON.stringify(body).includes(ip), 'the IP appears nowhere in the payload');
  });

  it('falls back to edge-anonymous with no address and no request', async () => {
    assert.equal(await idOf(await one(() => quoteIssued(ENV, null, req({ ip: '' }), SHED))), 'edge-anonymous');
    assert.equal(await idOf(await one(() => quoteIssued(ENV, null, null, SHED))), 'edge-anonymous');
  });

  it('lets a presented payer win, so a buyer joins across properties and IPs', async () => {
    const body = await one(() =>
      paymentSettled(ENV, null, req({ ip: '203.0.113.5' }), { ...SHED, payer: OUTSIDER })
    );
    assert.equal(await idOf(body), OUTSIDER);

    // Same wallet, different network path: still one caller.
    const moved = await one(() =>
      paymentSettled(ENV, null, req({ ip: '198.51.100.200' }), { ...SHED, payer: OUTSIDER })
    );
    assert.equal(await idOf(moved), OUTSIDER);
  });

  it('ignores a blank payer and falls back to the salted id', async () => {
    const body = await one(() => callRefused(ENV, null, req(), { ...SHED, reason: 'payment-invalid', payer: null }));
    assert.match(await idOf(body), /^edge-[0-9a-f]{16}$/);
  });
});

describe('the house flag', () => {
  it('is true for a wallet in HOUSE_PAYERS, in whatever case it arrives', async () => {
    for (const payer of [HOUSE, HOUSE.toLowerCase(), HOUSE.toUpperCase(), ` ${HOUSE} `]) {
      const body = await one(() => paymentSettled(ENV, null, req(), { ...SHED, payer }));
      assert.equal(body.properties.house, true, `${payer} is the house`);
    }
  });

  it('is true for the base58 Solana house buyer, which is case-sensitive on chain', async () => {
    const body = await one(() =>
      paymentSettled(ENV, null, req(), { ...SHED, payer: 'D7f9EifwoMdfwozWDNLFhBGwecVhryc5fs2SxLK93M45' })
    );
    assert.equal(body.properties.house, true);
  });

  it('is false for a third party, and for an event with no payer at all', async () => {
    const outside = await one(() => paymentSettled(ENV, null, req(), { ...SHED, payer: OUTSIDER }));
    assert.equal(outside.properties.house, false);
    const anon = await one(() => quoteIssued(ENV, null, req(), SHED));
    assert.equal(anon.properties.house, false);
  });

  it('fails towards third-party when HOUSE_PAYERS is unset', () => {
    assert.equal(housePayer({ POSTHOG_PROJECT_TOKEN: TOKEN }, HOUSE), false);
    assert.equal(housePayer({ HOUSE_PAYERS: '' }, HOUSE), false);
    assert.equal(housePayer(ENV, null), false);
    assert.equal(housePayer(ENV, HOUSE), true);
  });
});

describe('unset is a working state', () => {
  it('makes no network call at all with no token', async () => {
    for (const env of [{}, { HOUSE_PAYERS: HOUSE }, { POSTHOG_PROJECT_TOKEN: '' }, undefined]) {
      const calls = stubFetch();
      assert.equal(analyticsEnabled(env), false);
      const ctx = { waitUntil: mock.fn() };
      assert.equal(quoteIssued(env, ctx, req(), SHED), undefined);
      assert.equal(callRefused(env, ctx, req(), { ...SHED, reason: 'bad-input' }), undefined);
      assert.equal(toolServed(env, ctx, req(), SHED), undefined);
      assert.equal(await paymentSettled(env, null, req(), SHED), undefined);
      assert.deepEqual(calls, [], 'not one fetch, not even a DNS lookup');
      assert.equal(ctx.waitUntil.mock.callCount(), 0, 'nothing queued either');
    }
  });

  it('reads the token as the only authority', () => {
    assert.equal(analyticsEnabled({ POSTHOG_PROJECT_TOKEN: TOKEN }), true);
    assert.equal(analyticsEnabled({ POSTHOG_HOST: 'https://example.test' }), false);
  });
});

describe('it never touches the caller', () => {
  it('defers through ctx.waitUntil when there is a ctx', async () => {
    const calls = stubFetch();
    const queued = [];
    const ctx = { waitUntil: (p) => queued.push(p) };
    quoteIssued(ENV, ctx, req(), SHED);
    assert.equal(queued.length, 1, 'exactly one promise handed to waitUntil');
    await Promise.all(queued);
    assert.equal(calls.length, 1);
  });

  it('swallows a rejecting fetch instead of propagating it', async () => {
    stubFetch({ reject: new Error('posthog is down') });
    await assert.doesNotReject(() => capture(ENV, null, EVENTS.quoteIssued, SHED, req()));
    await assert.doesNotReject(() => paymentSettled(ENV, null, req(), { ...SHED, payer: OUTSIDER }));

    // And through a ctx, where an unhandled rejection would be a Worker error.
    const queued = [];
    quoteIssued(ENV, { waitUntil: (p) => queued.push(p) }, req(), SHED);
    await assert.doesNotReject(() => Promise.all(queued));
  });

  it('survives a request object with no headers at all', async () => {
    const body = await one(() => toolServed(ENV, null, {}, SHED));
    assert.equal(body.properties.$raw_user_agent, '');
    assert.equal(body.distinct_id, 'edge-anonymous');
  });

  it('honours POSTHOG_HOST so a test can point it at a local mock', async () => {
    const calls = stubFetch();
    await quoteIssued({ ...ENV, POSTHOG_HOST: 'http://127.0.0.1:9999/' }, null, req(), SHED);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'http://127.0.0.1:9999/i/v0/e/', 'trailing slash trimmed, path appended');
  });
});

describe('usdOf', () => {
  it('reads an atomic USDC string off an existing amount', () => {
    assert.equal(usdOf('2000'), 0.002);
    assert.equal(usdOf('1000000'), 1);
    assert.equal(usdOf('0'), 0);
  });

  it('returns null rather than guessing', () => {
    for (const bad of [null, undefined, '', 'free', '1.5', '-1', 'NaN']) assert.equal(usdOf(bad), null);
  });
});
