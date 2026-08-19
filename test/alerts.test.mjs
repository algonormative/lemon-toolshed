// Owner-facing payment alerts: Telegram and email.
//
// The claim under test is narrow and worth stating precisely: WHEN MONEY MOVES
// THE OWNER IS TOLD, WHEN IT DOES NOT NOBODY IS DISTURBED, AND NEITHER CASE CAN
// AFFECT THE PAYING CALLER. Each third of that is a describe block below.
//
// Four things are worth knowing before reading further.
//
// 1. THE MOCKS ARE IN-PROCESS AND RECORD EVERY HIT, which is what makes the
//    negative assertions real: "Telegram was not called" is `mock.hits.length
//    === 0`, not an inference from a response header. The silence assertions
//    are the bulk of this file, because a revenue alert that also fires on the
//    continuous background scanning of a publicly-indexed endpoint is an alert
//    the owner learns to swipe away.
//
// 2. THE MOCK FACILITATOR HERE IS DELIBERATELY SIMPLE. x402-settlement.test.mjs
//    owns the strict version-shape checking; this suite is downstream of that
//    question and only needs a payment to verify and settle so an alert has
//    something to be about. Duplicating the strictness would test the envelope
//    twice and the alerts once.
//
// 3. ALERTS FIRE IN ctx.waitUntil, AFTER the response — so every positive
//    assertion polls (`awaitTelegram`, `awaitEmail`) and every negative one
//    waits first (`settleFor`), because reading once, immediately, would also
//    pass against a Worker that alerts on everything a moment later.
//
// 4. THE EMAIL ASSERTION IS REAL, not a no-op. Miniflare implements the
//    `send_email` binding locally: it parses the raw message with PostalMime,
//    REJECTS one without a Message-ID or whose From header disagrees with the
//    envelope sender, then writes an .eml and logs the path. So the test reads
//    that file back and asserts on the actual RFC 5322 bytes the Worker built —
//    which makes miniflare the parser proving the hand-rolled message is valid.

import test, { before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import {
  bootWorker,
  client,
  callers,
  fakeCdpCredentials,
  PAYTO_TEST,
  TIER_ON_VARS,
} from './harness.mjs';

const ips = callers('alerts');

// The house's own wallet, and a stranger's. The whole loud/quiet split turns on
// telling these two apart, so they are the fixture the suite is built around.
const HOUSE_PAYER = '0x632Ff2f904Cc6Ab6D741A42014c4C483F328E92F';
const THIRD_PARTY_PAYER = '0x00000000000000000000000000000000000Fa11e5';
const TX_HASH = '0xfeedfacefeedfacefeedfacefeedfacefeedfacefeedfacefeedfacefeedface';

const CHAT_ID = '-1001234567890';
const BOT_TOKEN = '123456:test-bot-token';
const ALERT_TO = 'owner@example.com';

// Telegram config as the Worker reads it, minus the API base — which each
// worker points wherever that test needs it.
const telegramVars = (apiBase) => ({
  TELEGRAM_BOT_TOKEN: BOT_TOKEN,
  TELEGRAM_CHAT_ID: CHAT_ID,
  TELEGRAM_API_BASE: apiBase,
});

let facilitator;
let telegram;
let worker;
let api;

// ------------------------------------------------------------------ the mocks

/** A stand-in for https://api.telegram.org that records every sendMessage. */
async function startMockTelegram() {
  const state = { hits: [], status: 200, body: { ok: true, result: { message_id: 1 } } };

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      // The path is /bot<token>/<method>, so both halves are recorded: a Worker
      // that sent the right message to the wrong bot is still broken.
      const [, botSegment = '', method = ''] = new URL(req.url, 'http://mock').pathname.split('/');
      let body = null;
      try {
        body = JSON.parse(raw);
      } catch {
        /* recorded as null — a malformed body is itself a finding */
      }
      state.hits.push({
        method,
        token: botSegment.startsWith('bot') ? botSegment.slice(3) : null,
        contentType: req.headers['content-type'] || null,
        body,
        text: body?.text ?? null,
      });
      res.writeHead(state.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(state.body));
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    state,
    url: `http://127.0.0.1:${server.address().port}`,
    get hits() {
      return state.hits;
    },
    sends: () => state.hits.filter((h) => h.method === 'sendMessage'),
    reset: () => {
      state.hits.length = 0;
      state.status = 200;
      state.body = { ok: true, result: { message_id: 1 } };
    },
    stop: () => new Promise((resolve) => server.close(resolve)),
  };
}

/**
 * A minimal CDP facilitator: verify and settle, both programmable.
 *
 * No version-shape strictness on purpose — see note 2 at the top. What this
 * suite needs from it is a payment that verifies, so that an alert has a reason
 * to exist.
 */
async function startMockFacilitator() {
  const state = {
    hits: [],
    verify: { status: 200, body: { isValid: true, payer: THIRD_PARTY_PAYER } },
    settle: { status: 200, body: { success: true, transaction: TX_HASH, network: 'base' } },
  };

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      const endpoint = new URL(req.url, 'http://mock').pathname.split('/').pop();
      state.hits.push({ endpoint });
      const canned = state[endpoint];
      if (!canned) {
        res.writeHead(404, { 'content-type': 'application/json' });
        return res.end('{"error":"no such endpoint"}');
      }
      res.writeHead(canned.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(canned.body));
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    state,
    url: `http://127.0.0.1:${server.address().port}/platform/v2/x402`,
    /** Make the next verify succeed, attributing the payment to `payer`. */
    verifiedAs: (payer) => {
      state.verify = { status: 200, body: { isValid: true, payer } };
    },
    reset: () => {
      state.hits.length = 0;
      state.verify = { status: 200, body: { isValid: true, payer: THIRD_PARTY_PAYER } };
      state.settle = { status: 200, body: { success: true, transaction: TX_HASH, network: 'base' } };
    },
    stop: () => new Promise((resolve) => server.close(resolve)),
  };
}

// ------------------------------------------------------------------ helpers

/** A well-formed x402 v1 payment payload. The signature is nonsense by design. */
function paymentHeader({ from = THIRD_PARTY_PAYER } = {}) {
  const now = Math.floor(Date.now() / 1000);
  return Buffer.from(
    JSON.stringify({
      x402Version: 1,
      scheme: 'exact',
      network: 'base',
      payload: {
        signature: `0x${'ab'.repeat(65)}`,
        authorization: {
          from,
          to: PAYTO_TEST,
          value: '1000',
          validAfter: String(now - 600),
          validBefore: String(now + 60),
          nonce: `0x${'cd'.repeat(32)}`,
        },
      },
    })
  ).toString('base64');
}

/** Poll for a Telegram send matching `predicate` — alerts are asynchronous. */
async function awaitTelegram(mock, predicate, what, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const hit = mock.sends().find(predicate);
    if (hit) return hit;
    if (Date.now() > deadline) {
      throw new Error(
        `no Telegram sendMessage matching ${what} within ${timeoutMs} ms; saw ${JSON.stringify(mock.sends().map((h) => h.text))}`
      );
    }
    await new Promise((r) => setTimeout(r, 200));
  }
}

/**
 * Long enough for a wrongly-queued alert to arrive.
 *
 * Every "nothing was sent" assertion waits this out first. Without it the
 * negative tests would pass against a Worker that alerts on absolutely
 * everything, just slightly later than the assertion looked.
 */
const settleFor = (ms = 1_500) => new Promise((r) => setTimeout(r, ms));

/** Paths of every .eml miniflare's send_email simulator has written so far. */
function emailFiles(w) {
  return [...w.log().matchAll(/send_email binding called[^\n]*\n\s*(\S+\.eml)/g)].map((m) => m[1]);
}

/** Poll for the next .eml beyond `after`, and return its raw bytes as text. */
async function awaitEmail(w, after = 0, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const files = emailFiles(w);
    if (files.length > after) return readFile(files[files.length - 1], 'utf8');
    if (Date.now() > deadline) {
      throw new Error(`no send_email beyond #${after} within ${timeoutMs} ms`);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

/**
 * Decode an RFC 2047 header value back to the string it encodes.
 *
 * The subject carries emoji, so it goes out as folded base64 encoded-words.
 * Decoding it here rather than asserting on the encoded bytes is what makes the
 * assertion about the MESSAGE instead of about the encoding, and it doubles as
 * a check that the folding and the chunk boundaries reassemble cleanly.
 */
function decodeHeaderValue(raw) {
  return raw
    .replace(/\?=\r?\n\s+=\?/g, '?==?') // unfold: adjacent encoded-words join
    .replace(/=\?UTF-8\?B\?([^?]*)\?=/gi, (_, b64) => Buffer.from(b64, 'base64').toString('utf8'));
}

/** Split a raw RFC 5322 message into unfolded headers and its body. */
function parseEmail(raw) {
  const split = raw.indexOf('\r\n\r\n');
  assert.notEqual(split, -1, 'the message has no header/body separator');
  const headerBlock = raw.slice(0, split);
  const headers = {};
  // Fold continuation lines (CRLF + whitespace) back onto their header first.
  for (const line of headerBlock.split(/\r\n(?![ \t])/)) {
    const colon = line.indexOf(':');
    if (colon > 0) headers[line.slice(0, colon).toLowerCase()] = line.slice(colon + 1).trim();
  }
  return { raw, headers, body: raw.slice(split + 4) };
}

// ------------------------------------------------------------------ lifecycle

before(async () => {
  facilitator = await startMockFacilitator();
  telegram = await startMockTelegram();
  worker = await bootWorker({
    vars: {
      PAYTO: PAYTO_TEST,
      FACILITATOR_URL: facilitator.url,
      ...fakeCdpCredentials(),
      ...telegramVars(telegram.url),
      HOUSE_PAYERS: HOUSE_PAYER,
      ALERT_EMAIL_TO: ALERT_TO,
    },
  });
  api = client(worker);
});

after(async () => {
  await worker?.stop();
  await telegram?.stop();
  await facilitator?.stop();
});

// ------------------------------------------------------------------ it fires

describe('a settled payment pings the owner', () => {
  test('a third party paying gets the loud message, once', async () => {
    facilitator.reset();
    telegram.reset();
    facilitator.verifiedAs(THIRD_PARTY_PAYER);

    const res = await api.convert('md-html', '# hi\n', {
      ip: ips.pinned(1),
      ua: 'alerts-suite/1',
      headers: { 'x-payment': paymentHeader() },
    });
    assert.equal(res.status, 200, res.text);
    assert.equal(res.headers.get('x-payment-verified'), 'true');

    const hit = await awaitTelegram(telegram, () => true, 'the settlement alert');

    // Addressed correctly: right bot, right chat, right shape.
    assert.equal(hit.token, BOT_TOKEN, 'the alert went to the wrong bot');
    assert.equal(hit.body.chat_id, CHAT_ID, 'the alert went to the wrong chat');
    assert.match(hit.contentType, /application\/json/);

    // …and it says the things a phone-glance has to answer.
    assert.match(hit.text, /THIRD PARTY PAID/, 'a stranger paying did not read as a sale');
    assert.match(hit.text, /md-html/, 'the alert does not name the tool');
    assert.match(hit.text, /\$0\.001/, 'the alert does not carry the amount in dollars');
    assert.match(hit.text, new RegExp(THIRD_PARTY_PAYER, 'i'), 'the alert does not name the payer');
    assert.match(hit.text, new RegExp(TX_HASH, 'i'), 'the alert does not carry the transaction');
    assert.match(hit.text, /settled/, 'the alert does not say the settlement landed');
    assert.ok(!/test settlement/.test(hit.text), 'a third-party payment was labelled a test');

    // EXACTLY ONE. A duplicated alert is how a channel becomes noise.
    await settleFor();
    assert.equal(telegram.sends().length, 1, `expected one alert, saw ${telegram.sends().length}`);
  });

  test("the house paying itself is a quiet drill, not a sale", async () => {
    facilitator.reset();
    telegram.reset();
    facilitator.verifiedAs(HOUSE_PAYER);

    const res = await api.convert('csv-json', 'a\n1\n', {
      ip: ips.pinned(2),
      ua: 'alerts-suite/1',
      headers: { 'x-payment': paymentHeader({ from: HOUSE_PAYER }) },
    });
    assert.equal(res.status, 200, res.text);

    const hit = await awaitTelegram(telegram, () => true, 'the test-settlement alert');
    assert.match(hit.text, /test settlement/, 'the house wallet did not read as a test');
    assert.ok(
      !/THIRD PARTY PAID/.test(hit.text),
      'THE OWNER’S OWN TEST BUY WAS ANNOUNCED AS A THIRD-PARTY SALE'
    );
    assert.match(hit.text, /csv-json/);
    assert.match(hit.text, /\$0\.001/);
  });

  test('the house match is case-insensitive, as an address written anywhere is', async () => {
    // HOUSE_PAYERS is configured lowercase and the facilitator here reports the
    // checksummed mixed-case form — which is what CDP actually returns. A
    // case-sensitive comparison would silently reclassify every one of the
    // owner's own test buys as a stranger's purchase.
    facilitator.reset();
    telegram.reset();
    facilitator.verifiedAs(HOUSE_PAYER.toUpperCase().replace('0X', '0x'));

    const res = await api.convert('md-html', '# hi\n', {
      ip: ips.pinned(3),
      ua: 'alerts-suite/1',
      headers: { 'x-payment': paymentHeader({ from: HOUSE_PAYER }) },
    });
    assert.equal(res.status, 200, res.text);

    const hit = await awaitTelegram(telegram, () => true, 'the test-settlement alert');
    assert.match(hit.text, /test settlement/, 'an upper-cased house address read as a third party');
  });

  test('a verify-yes settle-no still pings, and says the money did not land', async () => {
    // The alert-worthy failure: the caller was served because verify passed, and
    // the transfer then did not happen. Silence here would be the one case where
    // the owner most needs to know.
    facilitator.reset();
    telegram.reset();
    facilitator.state.settle = {
      status: 200,
      body: { success: false, errorReason: 'unexpected_settle_error' },
    };

    const res = await api.convert('json-yaml', '{"a":1}', {
      ip: ips.pinned(4),
      ua: 'alerts-suite/1',
      headers: { 'x-payment': paymentHeader() },
    });
    assert.equal(res.status, 200, res.text);
    assert.equal(res.headers.get('x-payment-verified'), 'true');

    const hit = await awaitTelegram(telegram, () => true, 'the failed-settlement alert');
    assert.match(hit.text, /SETTLE FAILED/, 'a failed settlement was announced as a success');
    assert.match(hit.text, /unexpected_settle_error/, 'the alert does not say why it failed');
    assert.ok(!/— settled/.test(hit.text), 'a failed settlement claimed to have settled');
  });
});

describe('a call served without verification is its own alarm', () => {
  test('the message is visually distinct and names the payment error', async () => {
    // Revenue leaking: the conversion is served, nothing was checked, nobody
    // paid. It must not look like either of the settlement messages.
    facilitator.reset();
    telegram.reset();
    facilitator.state.verify = { status: 500, body: { error: 'internal' } };

    const res = await api.convert('md-html', '# hi\n', {
      ip: ips.pinned(5),
      ua: 'alerts-suite/1',
      headers: { 'x-payment': paymentHeader() },
    });

    assert.equal(res.status, 200, 'availability-first: the conversion is still served');
    assert.equal(res.headers.get('x-payment-verified'), 'false');

    const hit = await awaitTelegram(telegram, () => true, 'the unverified-serve alert');
    assert.match(hit.text, /SERVED WITHOUT VERIFICATION/, 'the leak did not announce itself');
    assert.match(hit.text, /facilitator-unreachable/, 'the alert does not say what failed');
    assert.match(hit.text, /md-html/);
    assert.match(hit.text, /\$0\.001/);
    // Distinct from both settlement messages, which is the whole point.
    assert.ok(!/THIRD PARTY PAID/.test(hit.text), 'a leak was announced as a sale');
    assert.ok(!/test settlement/.test(hit.text), 'a leak was announced as a drill');
  });

  test('an unverified serve that then fails to convert alerts about nothing', async () => {
    // The payment-fairness ordering, seen from the alert side: the alert is
    // queued with the settle block, AFTER the conversion succeeded. A 400 means
    // nothing was served, so there is no leak to report.
    facilitator.reset();
    telegram.reset();
    facilitator.state.verify = { status: 500, body: { error: 'internal' } };

    const res = await api.convert('csv-json', 'a,b\n"unterminated', {
      ip: ips.pinned(6),
      ua: 'alerts-suite/1',
      headers: { 'x-payment': paymentHeader() },
    });
    assert.equal(res.status, 400, res.text);

    await settleFor();
    assert.equal(
      telegram.sends().length,
      0,
      `a call that was never served raised a leak alert: ${JSON.stringify(telegram.sends().map((h) => h.text))}`
    );
  });
});

// ------------------------------------------------------------------ it stays quiet

describe('nothing that is not money disturbs the owner', () => {
  test('an unpaid 402 is silent', async () => {
    facilitator.reset();
    telegram.reset();

    const res = await api.convert('md-html', '# hi\n', { ip: ips.pinned(7), ua: 'alerts-suite/1' });
    assert.equal(res.status, 402, res.text);

    await settleFor();
    assert.equal(telegram.hits.length, 0, 'the 402 front door pinged the owner');
  });

  test('a malformed payment header is silent — it is scanner noise', async () => {
    facilitator.reset();
    telegram.reset();

    for (const value of ['x', 'not-base64-!!', Buffer.from('[1,2,3]').toString('base64')]) {
      const res = await api.convert('md-html', '# hi\n', {
        ip: ips.pinned(8),
        ua: 'alerts-suite/1',
        headers: { 'x-payment': value },
      });
      assert.equal(res.status, 402, `X-PAYMENT ${JSON.stringify(value.slice(0, 12))} answered ${res.status}`);
    }

    await settleFor();
    assert.equal(telegram.hits.length, 0, 'a garbage payment header pinged the owner');
  });

  test('a facilitator-rejected payment is silent', async () => {
    // A rejection is someone failing to pay, not someone paying. The shed is on
    // a public index; alerting here would page on every scan.
    facilitator.reset();
    telegram.reset();
    facilitator.state.verify = {
      status: 200,
      body: { isValid: false, invalidReason: 'insufficient_funds' },
    };

    const res = await api.convert('md-html', '# hi\n', {
      ip: ips.pinned(9),
      ua: 'alerts-suite/1',
      headers: { 'x-payment': paymentHeader() },
    });
    assert.equal(res.status, 402, res.text);

    await settleFor();
    assert.equal(telegram.hits.length, 0, 'a rejected payment pinged the owner');
  });

  test('a free-tier serve is silent even with the channel fully configured', async () => {
    // Booted with Telegram configured AND pointed at the live mock, so silence
    // here is a POLICY decision rather than an accident of configuration —
    // which is the only version of this test that proves anything.
    const scratchTelegram = await startMockTelegram();
    const scratch = await bootWorker({
      vars: { ...TIER_ON_VARS, ...telegramVars(scratchTelegram.url), HOUSE_PAYERS: HOUSE_PAYER },
    });
    try {
      const scratchApi = client(scratch);
      const res = await scratchApi.convert('md-html', '# hi\n', {
        ip: ips.pinned(10),
        ua: 'alerts-suite/1',
      });
      assert.equal(res.status, 200, `the free tier did not serve: ${res.text}`);
      assert.equal(res.headers.get('x-free-tier-remaining'), '2');

      await settleFor();
      assert.equal(scratchTelegram.hits.length, 0, 'a free conversion pinged the owner');
    } finally {
      await scratch.stop();
      await scratchTelegram.stop();
    }
  });
});

// ------------------------------------------------------------------ it is harmless

describe('a broken alert channel never reaches the caller', () => {
  test('Telegram answering 500 leaves the response 200 and the ledger intact', async () => {
    facilitator.reset();
    telegram.reset();
    telegram.state.status = 500;
    telegram.state.body = { ok: false, description: 'Internal Server Error' };

    const res = await api.convert('md-html', '# hi\n', {
      ip: ips.pinned(11),
      ua: 'alerts-suite/1',
      headers: { 'x-payment': paymentHeader() },
    });

    assert.equal(res.status, 200, `a failing alert channel broke the conversion: ${res.text}`);
    assert.ok(res.text.includes('<h1>hi</h1>'), 'the conversion did not run');
    assert.equal(res.headers.get('x-payment-verified'), 'true');

    // The attempt was made, and the money is still recorded exactly as it would
    // have been — the alert is downstream of the ledger, never a gate on it.
    await awaitTelegram(telegram, () => true, 'the attempted alert');
    const rows = await worker.d1(
      "SELECT tool, verify_ok, settle_ok, tx_hash FROM settlements WHERE tool = 'md-html' AND settle_ok = 1 ORDER BY ts DESC, rowid DESC LIMIT 1;"
    );
    assert.equal(rows.length, 1, 'the settlement row is missing');
    assert.equal(rows[0].verify_ok, 1);
    assert.equal(rows[0].settle_ok, 1);
    assert.equal(rows[0].tx_hash, TX_HASH);
  });

  test('an unreachable Telegram host costs a ping and nothing else', async () => {
    const scratchFacilitator = await startMockFacilitator();
    // A port nothing is listening on. Connection refused is the fastest way to
    // be sure the fetch fails rather than hangs.
    const dead = await startMockTelegram();
    const deadUrl = dead.url;
    await dead.stop();

    const scratch = await bootWorker({
      vars: {
        PAYTO: PAYTO_TEST,
        FACILITATOR_URL: scratchFacilitator.url,
        ...fakeCdpCredentials(),
        ...telegramVars(deadUrl),
        HOUSE_PAYERS: HOUSE_PAYER,
      },
    });
    try {
      const scratchApi = client(scratch);
      const res = await scratchApi.convert('md-html', '# hi\n', {
        ip: ips.pinned(12),
        ua: 'alerts-suite/1',
        headers: { 'x-payment': paymentHeader() },
      });

      assert.equal(res.status, 200, `an unreachable alert host broke the conversion: ${res.text}`);
      assert.equal(res.headers.get('x-payment-verified'), 'true');

      // The settlement still lands, which is the assertion that matters: the
      // alert failed inside waitUntil and took nothing with it.
      const deadline = Date.now() + 15_000;
      let rows = [];
      for (;;) {
        rows = await scratch.d1('SELECT verify_ok, settle_ok, tx_hash FROM settlements;');
        if (rows.length) break;
        if (Date.now() > deadline) throw new Error('no settlement row after an unreachable alert host');
        await new Promise((r) => setTimeout(r, 250));
      }
      assert.equal(rows[0].verify_ok, 1);
      assert.equal(rows[0].settle_ok, 1, 'the settlement was lost to a failed alert');
      assert.equal(rows[0].tx_hash, TX_HASH);
    } finally {
      await scratch.stop();
      await scratchFacilitator.stop();
    }
  });

  test('an unconfigured channel makes no network call at all', async () => {
    // TELEGRAM_API_BASE points at a live mock, but the token and chat id are
    // absent — so a Worker that checked its config lazily, or not at all, would
    // still be caught here. Zero hits is the assertion.
    const scratchFacilitator = await startMockFacilitator();
    const scratchTelegram = await startMockTelegram();
    const scratch = await bootWorker({
      vars: {
        PAYTO: PAYTO_TEST,
        FACILITATOR_URL: scratchFacilitator.url,
        ...fakeCdpCredentials(),
        TELEGRAM_API_BASE: scratchTelegram.url,
        HOUSE_PAYERS: HOUSE_PAYER,
      },
    });
    try {
      const scratchApi = client(scratch);
      const res = await scratchApi.convert('md-html', '# hi\n', {
        ip: ips.pinned(13),
        ua: 'alerts-suite/1',
        headers: { 'x-payment': paymentHeader() },
      });
      assert.equal(res.status, 200, res.text);
      assert.equal(res.headers.get('x-payment-verified'), 'true');

      await settleFor(2_500);
      assert.equal(
        scratchTelegram.hits.length,
        0,
        'an unconfigured Telegram channel still called the API'
      );
    } finally {
      await scratch.stop();
      await scratchTelegram.stop();
      await scratchFacilitator.stop();
    }
  });
});

// ------------------------------------------------------------------ email

describe('the email channel produces a valid RFC 5322 message', () => {
  // Miniflare implements send_email locally and PARSES what it is given —
  // rejecting a message with no Message-ID, or whose From header disagrees with
  // the envelope sender. So reaching these assertions at all already proves the
  // hand-rolled message is well formed; what they add is that it says the right
  // things.
  test('a settlement sends mail whose subject mirrors the Telegram first line', async () => {
    facilitator.reset();
    telegram.reset();
    facilitator.verifiedAs(THIRD_PARTY_PAYER);
    const before = emailFiles(worker).length;

    const res = await api.convert('yaml-json', 'a: 1\n', {
      ip: ips.pinned(14),
      ua: 'alerts-suite/1',
      headers: { 'x-payment': paymentHeader() },
    });
    assert.equal(res.status, 200, res.text);

    const hit = await awaitTelegram(telegram, () => true, 'the settlement alert');
    const mail = parseEmail(await awaitEmail(worker, before));

    // Addressing and identity.
    assert.equal(mail.headers.from, '"Toolshed" <alerts@lemon-agent.dev>');
    assert.equal(mail.headers.to, `<${ALERT_TO}>`);
    assert.equal(mail.headers['mime-version'], '1.0');
    assert.match(mail.headers['content-type'], /text\/plain;\s*charset=utf-8/);

    // A Message-ID is mandatory — Cloudflare rejects a message without one.
    assert.match(mail.headers['message-id'], /^<[^@\s]+@lemon-agent\.dev>$/);

    // The Date must be the numeric-zone form, not the obsolete "GMT" spelling.
    assert.match(
      mail.headers.date,
      /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} \w{3} \d{4} \d{2}:\d{2}:\d{2} \+0000$/,
      `Date is not RFC 2822: ${mail.headers.date}`
    );

    // CRLF everywhere: a bare LF in an SMTP payload is the classic corruption.
    assert.ok(!/(?<!\r)\n/.test(mail.raw), 'the message contains a bare LF');

    // THE SUBJECT IS THE TELEGRAM FIRST LINE, decoded back through RFC 2047 —
    // which also proves the folded encoded-words reassemble without loss.
    const subject = decodeHeaderValue(mail.headers.subject);
    assert.equal(subject, hit.text.split('\n')[0], 'the subject and the Telegram opener disagree');
    assert.match(subject, /THIRD PARTY PAID/);
    assert.match(subject, /🍋💰/, 'the emoji did not survive the header encoding');

    // …and the body carries the detail.
    assert.match(mail.body, /yaml-json/);
    assert.match(mail.body, /\$0\.001/);
    assert.match(mail.body, new RegExp(TX_HASH, 'i'));
    assert.match(mail.body, /basescan\.org/, 'no explorer link for a settled payment');
  });

  test('no ALERT_EMAIL_TO means no mail, while Telegram still fires', async () => {
    // The channels are independent: the email half being unconfigured must not
    // cost the ping that actually wakes someone up.
    const scratchFacilitator = await startMockFacilitator();
    const scratchTelegram = await startMockTelegram();
    const scratch = await bootWorker({
      vars: {
        PAYTO: PAYTO_TEST,
        FACILITATOR_URL: scratchFacilitator.url,
        ...fakeCdpCredentials(),
        ...telegramVars(scratchTelegram.url),
        HOUSE_PAYERS: HOUSE_PAYER,
      },
    });
    try {
      const scratchApi = client(scratch);
      const res = await scratchApi.convert('md-html', '# hi\n', {
        ip: ips.pinned(15),
        ua: 'alerts-suite/1',
        headers: { 'x-payment': paymentHeader() },
      });
      assert.equal(res.status, 200, res.text);

      await awaitTelegram(scratchTelegram, () => true, 'the settlement alert');
      await settleFor();
      assert.equal(emailFiles(scratch).length, 0, 'mail was sent with no recipient configured');
    } finally {
      await scratch.stop();
      await scratchTelegram.stop();
      await scratchFacilitator.stop();
    }
  });
});
