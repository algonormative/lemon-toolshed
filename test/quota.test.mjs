// The free tier, and the claim that makes it worth anything.
//
// PHASE: no PAYTO. With no receiving address configured there is nowhere to
// pay, so the over-tier answer is a 429 rather than a 402. The 402 half lives
// in x402.test.mjs, which runs against a second worker.
//
// The product claim under test is not "there is a limit" — it is that a second
// identity costs a second IP address. The counter key is hash(daily salt + IP)
// with NO user-agent, deliberately, and the UA-rotation test below is what
// stops that from quietly regressing into a UA-keyed (therefore infinite)
// free tier.
//
// Every caller here is a distinct `cf-connecting-ip`, which wrangler dev
// --local honours — see the note at the top of harness.mjs.

import test, { before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { useWorker, client, callers, FREE_TIER_DAILY, secondsToUtcMidnight } from './harness.mjs';

let worker;
let api;
const ips = callers('quota');

const RUNG1_PER_ID_PER_DAY = 100; // mirrors worker/beacon.js

before(async () => {
  worker = await useWorker();
  api = client(worker);
});
after(async () => {
  await worker.stop();
});

const convert = (opts) => api.convert('md-html', '# hi\n', opts);

describe('the free tier counts down and then refuses', () => {
  test(`${FREE_TIER_DAILY} calls are served, each reporting what is left`, async () => {
    const ip = ips.pinned(1);
    for (let call = 1; call <= FREE_TIER_DAILY; call++) {
      const res = await convert({ ip, ua: 'quota-suite/1' });
      assert.equal(res.status, 200, `call ${call} answered ${res.status}: ${res.text}`);
      assert.equal(
        res.headers.get('x-free-tier-remaining'),
        String(FREE_TIER_DAILY - call),
        `call ${call} reported the wrong remaining count`
      );
      assert.ok(res.text.includes('<h1>hi</h1>'), 'the conversion did not actually run');
    }
    // The store agrees with the headers.
    const [row] = await worker.d1(
      `SELECT used FROM convert_quota WHERE used = ${FREE_TIER_DAILY} AND day = date('now');`
    );
    assert.ok(row, 'no caller reached the ceiling in convert_quota');
  });

  test(`call ${FREE_TIER_DAILY + 1} is a 429 carrying the documented body`, async () => {
    const ip = ips.pinned(1); // the caller exhausted above
    const res = await convert({ ip, ua: 'quota-suite/1' });
    assert.equal(res.status, 429, `expected 429, got ${res.status}: ${res.text}`);

    const body = res.json();
    assert.equal(body.error, `free tier is ${FREE_TIER_DAILY} conversions per day per caller`);
    assert.equal(body.free_tier_daily, FREE_TIER_DAILY);
    assert.equal(body.paid_tier, 'per-call USDC via x402 — activating soon');
    assert.equal(body.retry, 'tomorrow UTC');
    // No PAYTO, so no x402 envelope: offering an address that does not exist
    // would be the dishonest answer.
    assert.ok(!('x402Version' in body), 'a 402 envelope appeared with no PAYTO configured');
    assert.ok(!('accepts' in body), 'a 402 envelope appeared with no PAYTO configured');
  });

  test('Retry-After points at the next UTC midnight', async () => {
    const res = await convert({ ip: ips.pinned(1), ua: 'quota-suite/1' });
    assert.equal(res.status, 429);
    const retryAfter = Number(res.headers.get('retry-after'));
    assert.ok(Number.isFinite(retryAfter), 'Retry-After is not a number');
    const expected = secondsToUtcMidnight();
    assert.ok(
      Math.abs(retryAfter - expected) <= 120,
      `Retry-After ${retryAfter}s is not within 120 s of the ${expected}s left until UTC midnight`
    );
    assert.ok(retryAfter > 0 && retryAfter <= 86_400, `Retry-After ${retryAfter} is outside one day`);
  });

  test('an over-tier refusal serves no conversion and claims no further quota', async () => {
    const ip = ips.pinned(1);
    const before = (await worker.d1('SELECT COALESCE(SUM(used), 0) AS n FROM convert_quota;'))[0].n;
    const res = await convert({ ip, ua: 'quota-suite/1' });
    assert.equal(res.status, 429);
    assert.ok(!res.text.includes('<h1>'), 'a refused call still returned a conversion');
    const after = (await worker.d1('SELECT COALESCE(SUM(used), 0) AS n FROM convert_quota;'))[0].n;
    assert.equal(after, before, 'a refused call incremented the counter anyway');
  });
});

describe('spoof resistance', () => {
  test('rotating the user-agent from the same IP does not mint a fresh allowance', async () => {
    // The failure this guards: keying the counter on anything a caller can type.
    const ip = ips.pinned(1); // still exhausted
    const agents = [
      'toolshed-quota-probe/1.0',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/131.0 Safari/537.36',
      'curl/8.7.1',
      'python-requests/2.32.3',
    ];
    for (const ua of agents) {
      const res = await convert({ ip, ua });
      assert.equal(res.status, 429, `user-agent ${JSON.stringify(ua)} bought a fresh allowance`);
      assert.equal(res.json().free_tier_daily, FREE_TIER_DAILY);
    }
  });

  test('sending no user-agent at all does not mint a fresh allowance', async () => {
    const res = await convert({ ip: ips.pinned(1) });
    assert.equal(res.status, 429);
  });

  test('other spoofable headers do not mint a fresh allowance', async () => {
    const ip = ips.pinned(1);
    for (const headers of [
      { 'x-forwarded-for': '9.9.9.9' },
      { 'x-real-ip': '9.9.9.9' },
      { referer: 'https://elsewhere.example/' },
      { 'accept-language': 'fr-CA' },
      { origin: 'https://elsewhere.example' },
    ]) {
      const res = await convert({ ip, headers });
      assert.equal(res.status, 429, `${Object.keys(headers)[0]} bought a fresh allowance`);
    }
  });

  test('a second IP gets a whole fresh allowance', async () => {
    // The other half of the claim: a fresh identity is available, and it costs
    // exactly one thing — another address.
    const ip = ips.pinned(2);
    const first = await convert({ ip, ua: 'quota-suite/1' });
    assert.equal(first.status, 200);
    assert.equal(first.headers.get('x-free-tier-remaining'), String(FREE_TIER_DAILY - 1));

    for (let call = 2; call <= FREE_TIER_DAILY; call++) {
      const res = await convert({ ip, ua: 'quota-suite/1' });
      assert.equal(res.status, 200, `call ${call} on the second IP answered ${res.status}`);
    }
    assert.equal((await convert({ ip })).status, 429, 'the second IP was not bounded');
  });

  test('the allowance is per caller, not per tool', async () => {
    const ip = ips.pinned(3);
    const tools = ['md-html', 'json-yaml', 'yaml-json', 'csv-json', 'html-markdown'];
    const inputs = {
      'md-html': '# hi\n',
      'json-yaml': '{"a":1}',
      'yaml-json': 'a: 1\n',
      'csv-json': 'a\n1\n',
      'html-markdown': '<p>hi</p>',
    };
    let spent = 0;
    for (let round = 0; round < 2; round++) {
      for (const id of tools) {
        const res = await api.convert(id, inputs[id], { ip });
        spent += 1;
        assert.equal(res.status, 200, `${id} answered ${res.status}`);
        assert.equal(
          res.headers.get('x-free-tier-remaining'),
          String(FREE_TIER_DAILY - spent),
          `switching tools reset the counter at ${id}`
        );
      }
    }
    assert.equal((await api.convert('md-html', '# hi\n', { ip })).status, 429);
  });
});

describe('the beacon budget and the conversion budget are separate', () => {
  test('beacons do not consume conversion quota', async () => {
    const ip = ips.pinned(4);
    for (let i = 0; i < 5; i++) {
      const res = await api.beacon({ t: 'visit' }, { ip, ua: 'quota-suite/1' });
      assert.equal(res.status, 204);
    }
    const res = await convert({ ip, ua: 'quota-suite/1' });
    assert.equal(res.status, 200, 'five beacons spent conversion allowance');
    assert.equal(
      res.headers.get('x-free-tier-remaining'),
      String(FREE_TIER_DAILY - 1),
      'the conversion budget was not whole after five beacons'
    );
  });

  test('conversions do not consume the rung-1 beacon identifier budget', async () => {
    // Rung 1 caps an identifier at 100 EVENTS a day, counting rows where
    // type <> 'convert'. So: spend some conversions first, then send more than
    // 100 beacons from the SAME IP and user-agent (which is what makes them one
    // identifier), and count what landed. Exactly RUNG1 beacon rows means the
    // conversions did not eat into the beacon budget — and that rung 1 still
    // bites at the documented number.
    const ip = ips.pinned(5);
    const ua = 'rung1-suite/1';
    const conversions = 5;
    const attempts = RUNG1_PER_ID_PER_DAY + 3;

    for (let i = 0; i < conversions; i++) {
      assert.equal((await convert({ ip, ua })).status, 200, `conversion ${i + 1} was refused`);
    }
    for (let i = 0; i < attempts; i++) {
      await api.beacon({ t: 'click', e: `rung1-${i}` }, { ip, ua });
    }

    const [row] = await worker.d1(
      `SELECT SUM(type <> 'convert') AS beacons, SUM(type = 'convert') AS converts
         FROM events
        WHERE id_hash = (SELECT id_hash FROM events WHERE entry = 'rung1-0');`
    );
    assert.equal(
      Number(row.beacons),
      RUNG1_PER_ID_PER_DAY,
      `expected exactly ${RUNG1_PER_ID_PER_DAY} beacon rows for this identifier, got ${row.beacons} — ` +
        'conversions are spending the beacon budget again'
    );
    assert.equal(Number(row.converts), conversions, 'the conversion rows are missing or duplicated');
  });

  test('a conversion still writes exactly one measurement row, and never the input', async () => {
    const ip = ips.pinned(6);
    const secret = 'CANARY-ffb1c0de-do-not-store';
    const before = (await worker.d1("SELECT COUNT(*) AS n FROM events WHERE type = 'convert';"))[0].n;
    const res = await api.convert('md-html', `# ${secret}\n`, { ip, ua: 'quota-suite/1' });
    assert.equal(res.status, 200);
    const after = (await worker.d1("SELECT COUNT(*) AS n FROM events WHERE type = 'convert';"))[0].n;
    assert.equal(Number(after) - Number(before), 1, 'a conversion wrote something other than one row');

    // The whole events table, checked for the input text.
    const [leak] = await worker.d1(
      `SELECT COUNT(*) AS n FROM events
        WHERE COALESCE(entry, '') LIKE '%CANARY%' OR COALESCE(ref_class, '') LIKE '%CANARY%'
           OR COALESCE(id_hash, '') LIKE '%CANARY%';`
    );
    assert.equal(Number(leak.n), 0, 'the conversion input reached the store');
  });

  test('the conversion row records which tool ran, and no raw referrer', async () => {
    const ip = ips.pinned(7);
    await api.convert('csv-json', 'a\n1\n', {
      ip,
      ua: 'quota-suite/1',
      headers: { referer: 'https://secret.example/private/page?token=abc' },
    });
    const rows = await worker.d1(
      "SELECT type, entry, ref_class FROM events WHERE type = 'convert' AND entry = 'csv-json' LIMIT 5;"
    );
    assert.ok(rows.length > 0, 'no row for the csv-json call');
    for (const row of rows) {
      assert.equal(row.type, 'convert');
      assert.equal(row.entry, 'csv-json');
      assert.ok(['internal', 'external', 'none'].includes(row.ref_class), `bad ref_class ${row.ref_class}`);
    }
    const [leak] = await worker.d1(
      "SELECT COUNT(*) AS n FROM events WHERE COALESCE(ref_class, '') LIKE '%secret.example%';"
    );
    assert.equal(Number(leak.n), 0, 'the raw referrer was stored');
  });
});
