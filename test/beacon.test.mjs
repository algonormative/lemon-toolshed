// POST /b — the beacon, and the anonymisation it promises.
//
// Every outcome on this route answers 204: accepted, rate-limited, bot-dropped
// and malformed are indistinguishable from outside, on purpose. So almost every
// assertion here reads the STORE rather than the response — the response is
// designed to tell you nothing.
//
// It shares phase 1's worker (the env-gated free tier), which changes nothing
// here: /b has never consulted the conversion tier. The var is passed only so
// this file joins that worker instead of booting a fourth one.
//
// The salt-rotation test is the one that would otherwise need a day to run. It
// does not wait: it ages the salt row in D1 by hand and then makes one request,
// which is enough to prove the identity space really is discarded at rotation
// rather than merely relabelled.

import test, { before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { useWorker, client, callers, sqlString, TIER_ON_VARS } from './harness.mjs';

let worker;
let api;
const ips = callers('beacon');

const HEX16 = /^[0-9a-f]{16}$/;

before(async () => {
  worker = await useWorker({ vars: TIER_ON_VARS });
  api = client(worker);
});
after(async () => {
  await worker.stop();
});

/** The single events row written for a marker entry id. */
async function rowFor(entryId) {
  const rows = await worker.d1(
    `SELECT ts, type, id_hash, entry, ref_class FROM events WHERE entry = ${sqlString(entryId)};`
  );
  assert.equal(rows.length, 1, `expected exactly one row for ${entryId}, got ${rows.length}`);
  return rows[0];
}

async function countFor(entryId) {
  const [row] = await worker.d1(
    `SELECT COUNT(*) AS n FROM events WHERE entry = ${sqlString(entryId)};`
  );
  return Number(row.n);
}

describe('what a beacon writes', () => {
  test('a visit writes type=visit with a NULL entry', async () => {
    const ip = ips.pinned(1);
    const before = (await worker.d1("SELECT COUNT(*) AS n FROM events WHERE type = 'visit';"))[0].n;
    assert.equal((await api.beacon({ t: 'visit' }, { ip, ua: 'beacon-suite/1' })).status, 204);

    const [row] = await worker.d1(
      "SELECT COUNT(*) AS n, SUM(entry IS NULL) AS nulls FROM events WHERE type = 'visit';"
    );
    assert.equal(Number(row.n), Number(before) + 1, 'the visit did not land');
    assert.equal(
      Number(row.nulls),
      Number(row.n),
      'a visit row carried an entry id — visits have no entry, by schema'
    );
  });

  test('a click writes type=click with the entry id it was given', async () => {
    const row = await rowFor(await click('beacon-click-1'));
    assert.equal(row.type, 'click');
    assert.equal(row.entry, 'beacon-click-1');
  });

  test('id_hash is 16 lowercase hex characters', async () => {
    const row = await rowFor(await click('beacon-hash-1'));
    assert.match(row.id_hash, HEX16, `id_hash is not a truncated hex digest: ${row.id_hash}`);
  });

  test('one identity, one id_hash: same IP and user-agent hash the same', async () => {
    const ip = ips.pinned(2);
    const ua = 'beacon-suite/identity';
    await api.beacon({ t: 'click', e: 'beacon-same-a' }, { ip, ua });
    await api.beacon({ t: 'click', e: 'beacon-same-b' }, { ip, ua });
    const a = await rowFor('beacon-same-a');
    const b = await rowFor('beacon-same-b');
    assert.equal(a.id_hash, b.id_hash, 'the same caller produced two identifiers');
  });

  test('a different IP or a different user-agent is a different id_hash', async () => {
    const ip = ips.pinned(3);
    const ua = 'beacon-suite/identity';
    await api.beacon({ t: 'click', e: 'beacon-base' }, { ip, ua });
    await api.beacon({ t: 'click', e: 'beacon-other-ip' }, { ip: ips.pinned(4), ua });
    await api.beacon({ t: 'click', e: 'beacon-other-ua' }, { ip, ua: 'beacon-suite/other' });

    const base = (await rowFor('beacon-base')).id_hash;
    assert.notEqual((await rowFor('beacon-other-ip')).id_hash, base, 'a different IP hashed the same');
    // events.id_hash includes the user-agent, unlike convert_quota.ip_hash —
    // this is the documented difference between measurement and metering.
    assert.notEqual((await rowFor('beacon-other-ua')).id_hash, base, 'a different user-agent hashed the same');
  });

  test('ref_class is the coarse class, and the raw referrer is never stored', async () => {
    const ip = ips.pinned(5);
    const ua = 'beacon-suite/ref';
    await api.beacon({ t: 'click', e: 'beacon-ref-none' }, { ip, ua });
    await api.beacon({ t: 'click', e: 'beacon-ref-internal' }, {
      ip,
      ua,
      headers: { referer: `${worker.baseUrl}/some/page` },
    });
    await api.beacon({ t: 'click', e: 'beacon-ref-external' }, {
      ip,
      ua,
      headers: { referer: 'https://elsewhere.example/deep/path?token=SECRETVALUE' },
    });
    await api.beacon({ t: 'click', e: 'beacon-ref-garbage' }, { ip, ua, headers: { referer: 'not a url' } });

    assert.equal((await rowFor('beacon-ref-none')).ref_class, 'none');
    assert.equal((await rowFor('beacon-ref-internal')).ref_class, 'internal');
    assert.equal((await rowFor('beacon-ref-external')).ref_class, 'external');
    assert.equal((await rowFor('beacon-ref-garbage')).ref_class, 'none', 'an unparseable referrer is not "none"');

    const [leak] = await worker.d1(
      "SELECT COUNT(*) AS n FROM events WHERE COALESCE(ref_class,'') LIKE '%SECRET%' OR COALESCE(ref_class,'') LIKE '%elsewhere%';"
    );
    assert.equal(Number(leak.n), 0, 'a raw referrer reached the store');
  });

  test('ts is unix seconds in the current day', async () => {
    const row = await rowFor(await click('beacon-ts-1'));
    const now = Math.floor(Date.now() / 1000);
    assert.ok(Number.isInteger(row.ts), `ts is not an integer: ${row.ts}`);
    assert.ok(Math.abs(now - row.ts) < 300, `ts ${row.ts} is not within five minutes of now (${now})`);
  });

  test('the counters row moves with every accepted event', async () => {
    const day = new Date().toISOString().slice(0, 10);
    const read = async () => {
      const rows = await worker.d1(`SELECT total FROM counters WHERE day = ${sqlString(day)};`);
      return rows.length ? Number(rows[0].total) : 0;
    };
    const before = await read();
    for (let i = 0; i < 3; i++) await api.beacon({ t: 'click', e: `beacon-counter-${i}` }, { ip: ips.pinned(6) });
    assert.equal(await read(), before + 3, 'the global rung-2 counter did not move');
  });
});

describe('what a beacon drops', () => {
  const botAgents = [
    'Googlebot/2.1 (+http://www.google.com/bot.html)',
    'Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)',
    'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ClaudeBot/1.0)',
    'python-crawler/1.0',
    'SomeSpider/2.0',
    'Yahoo! Slurp',
    'HeadlessChrome/131.0.0.0',
  ];

  for (const ua of botAgents) {
    test(`a self-declared bot is dropped — ${ua.slice(0, 28)}`, async () => {
      const marker = `beacon-bot-${ua.replace(/\W+/g, '-').slice(0, 24)}`;
      const res = await api.beacon({ t: 'click', e: marker }, { ip: ips.pinned(7), ua });
      assert.equal(res.status, 204, 'a dropped beacon must be indistinguishable from an accepted one');
      assert.equal(await countFor(marker), 0, `a bot user-agent wrote a row: ${ua}`);
    });
  }

  test('a human-looking user-agent is not dropped', async () => {
    const marker = 'beacon-human-1';
    await api.beacon(
      { t: 'click', e: marker },
      {
        ip: ips.pinned(8),
        ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36',
      }
    );
    assert.equal(await countFor(marker), 1, 'a normal browser user-agent was dropped as a bot');
  });

  test('malformed and out-of-contract payloads write nothing', async () => {
    const before = (await worker.d1('SELECT COUNT(*) AS n FROM events;'))[0].n;
    const payloads = [
      '{not json',
      '',
      '[]',
      '"visit"',
      '{"t":"exfiltrate","e":"beacon-bad-1"}',
      '{"e":"beacon-bad-2"}',
      `{"t":"click","e":"${'x'.repeat(200)}"}`,
      '{"t":"click","e":{"nested":true}}',
      '{"t":"click","e":123}',
    ];
    for (const body of payloads) {
      assert.equal((await api.post('/b', body, { ip: ips.pinned(9) })).status, 204);
    }
    const after = (await worker.d1('SELECT COUNT(*) AS n FROM events;'))[0].n;
    assert.equal(Number(after), Number(before), 'an out-of-contract beacon wrote a row');
    assert.equal(await countFor('beacon-bad-1'), 0);
    assert.equal(await countFor('beacon-bad-2'), 0);
  });
});

describe('the daily salt', () => {
  test('rotating the day mints a new salt and a new identity for the same caller', async () => {
    const ip = ips.pinned(10);
    const ua = 'beacon-suite/salt';

    await api.beacon({ t: 'click', e: 'beacon-salt-before' }, { ip, ua });
    const beforeHash = (await rowFor('beacon-salt-before')).id_hash;
    const [beforeSalt] = await worker.d1("SELECT day, value FROM salt WHERE key = 'current';");
    assert.match(beforeSalt.value, /^[0-9a-f]{64}$/, 'the salt is not 32 random bytes of hex');

    // Age the salt row. The Worker rotates lazily on the first request of a new
    // UTC day, and its staleness test is `row.day === today` — so a past day is
    // exactly the condition a real midnight produces.
    await worker.d1("UPDATE salt SET day = '1999-01-01' WHERE key = 'current';");

    await api.beacon({ t: 'click', e: 'beacon-salt-after' }, { ip, ua });
    const afterHash = (await rowFor('beacon-salt-after')).id_hash;
    const [afterSalt] = await worker.d1("SELECT day, value FROM salt WHERE key = 'current';");

    assert.notEqual(afterSalt.value, beforeSalt.value, 'the salt was not rotated');
    assert.match(afterSalt.value, /^[0-9a-f]{64}$/);
    assert.equal(afterSalt.day, beforeSalt.day, 'the rotated row does not carry today');
    assert.notEqual(
      afterHash,
      beforeHash,
      'the same IP and user-agent hashed identically across a rotation — yesterday stays linkable'
    );
    assert.match(afterHash, HEX16);
  });

  test('within one day the salt is reused, not re-rolled per request', async () => {
    const [first] = await worker.d1("SELECT value FROM salt WHERE key = 'current';");
    for (let i = 0; i < 3; i++) await api.beacon({ t: 'visit' }, { ip: ips.pinned(11) });
    const [second] = await worker.d1("SELECT value FROM salt WHERE key = 'current';");
    assert.equal(second.value, first.value, 'the salt rotated mid-day — identities would not aggregate');
  });
});

// --- helpers ------------------------------------------------------------

let clickSeq = 0;
async function click(marker) {
  const res = await api.beacon(
    { t: 'click', e: marker },
    { ip: ips.pinned(12), ua: `beacon-suite/click-${clickSeq++}` }
  );
  assert.equal(res.status, 204);
  return marker;
}
