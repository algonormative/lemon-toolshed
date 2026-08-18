// The HTTP contract: /check, the method and routing guards, the size limit and
// the beacon's never-error promise.
//
// This is the surface an agent codes against without reading the page, so the
// assertions are about the shape of the answer rather than about any one tool.

import test, { before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { useWorker, client, callers, CATALOG, FREE_TIER_DAILY } from './harness.mjs';

let worker;
let api;
const ips = callers('protocol');

const HOSTED_IDS = CATALOG.filter((e) => e.hosted).map((e) => e.id).sort();

before(async () => {
  worker = await useWorker();
  api = client(worker);
});
after(async () => {
  await worker.stop();
});

const check = async (query = '') => {
  const res = await api.get(`/check${query}`);
  const text = await res.text();
  return { status: res.status, headers: res.headers, body: JSON.parse(text), text };
};

describe('GET /check', () => {
  test('no parameters lists exactly the hosted tools', async () => {
    const { status, body } = await check();
    assert.equal(status, 200);
    assert.equal(HOSTED_IDS.length, 5, 'the catalog no longer has 5 hosted tools — update this test');
    assert.deepEqual(body.matches.map((m) => m.id).sort(), HOSTED_IDS);
    assert.deepEqual(body.query, { from: null, to: null });
  });

  test('every hosted match carries a price and the free-tier allowance', async () => {
    const { body } = await check();
    for (const match of body.matches) {
      assert.ok(match.hosted, `${match.id} has no hosted block`);
      assert.equal(match.hosted.path, `/convert/${match.id}`, `${match.id} path/id disagree`);
      assert.equal(match.hosted.status, 'live', `${match.id} is listed but not live`);
      assert.equal(
        match.hosted.free_tier_daily,
        FREE_TIER_DAILY,
        `${match.id} advertises a free tier the Worker does not enforce`
      );
      assert.ok(match.hosted.price, `${match.id} has no price`);
      assert.equal(match.hosted.price.scheme, 'exact');
      assert.ok(match.hosted.price.amount_usd > 0, `${match.id} price is not positive`);
      for (const field of ['id', 'x', 'y', 'hosted', 'local', 'url']) {
        assert.ok(field in match, `${match.id} is missing the ${field} field`);
      }
    }
  });

  test('matching is field-bound: from tests the have side, to tests the need side', async () => {
    assert.deepEqual((await check('?from=markdown&to=html')).body.matches.map((m) => m.id), ['md-html']);
    assert.deepEqual((await check('?from=html&to=markdown')).body.matches.map((m) => m.id), ['html-markdown']);
    assert.deepEqual((await check('?from=csv&to=json')).body.matches.map((m) => m.id), ['csv-json']);
    // Reversing the pair must NOT match — that is the whole point of binding
    // each parameter to one side.
    assert.ok(!(await check('?from=markdown&to=html')).body.matches.some((m) => m.id === 'html-markdown'));
    assert.ok(!(await check('?from=html&to=markdown')).body.matches.some((m) => m.id === 'md-html'));
  });

  test('matching is case-insensitive and trims surrounding whitespace', async () => {
    assert.deepEqual((await check('?from=MARKDOWN&to=HtMl')).body.matches.map((m) => m.id), ['md-html']);
    assert.deepEqual((await check('?from=%20markdown%20&to=%20html%20')).body.matches.map((m) => m.id), ['md-html']);
  });

  test('a from with no hosted conversion answers with local references instead', async () => {
    const { body } = await check('?from=docx');
    assert.ok(body.matches.length > 0, 'docx matched nothing at all');
    for (const match of body.matches) {
      assert.equal(match.hosted, null, `${match.id} claims to be hosted`);
      assert.ok(match.local, `${match.id} has no local block — a reference entry with no way to run it`);
      assert.equal(typeof match.local.tool, 'string');
      assert.ok(match.local.tool.length > 0, `${match.id} names no local tool`);
      assert.match(match.url, /^https?:\/\//, `${match.id} has no usable url`);
    }
    assert.deepEqual(body.query, { from: 'docx', to: null });
  });

  test('an unknown format matches nothing', async () => {
    const { status, body } = await check('?from=zzzznotathing');
    assert.equal(status, 200, 'no match is an empty answer, not an error');
    assert.deepEqual(body.matches, []);
    assert.deepEqual(body.query, { from: 'zzzznotathing', to: null });
  });

  test('an over-long parameter is a 400', async () => {
    const { status, body } = await check(`?from=${'x'.repeat(65)}`);
    assert.equal(status, 400);
    assert.match(body.error, /64 characters/);
  });

  test('CORS is open on GET', async () => {
    const { headers } = await check();
    assert.equal(headers.get('access-control-allow-origin'), '*');
    assert.match(headers.get('content-type'), /application\/json/);
  });

  test('POST /check is a 405 that says which method to use', async () => {
    const res = await api.request('/check', { method: 'POST' });
    assert.equal(res.status, 405);
    assert.equal(res.headers.get('allow'), 'GET');
    assert.equal(res.headers.get('access-control-allow-origin'), '*');
    assert.match((await res.json()).error, /GET only/);
  });

  test('/check needs no D1 — it is exempt from every rung', async () => {
    const before = (await worker.d1('SELECT COUNT(*) AS n FROM events;'))[0].n;
    for (let i = 0; i < 25; i++) await api.get('/check');
    const after = (await worker.d1('SELECT COUNT(*) AS n FROM events;'))[0].n;
    assert.equal(after, before, '/check wrote rows — it is supposed to touch no store at all');
  });
});

describe('POST /convert routing', () => {
  test('GET /convert/<id> is a 405 that says which method to use', async () => {
    const res = await api.request('/convert/md-html', { method: 'GET' });
    assert.equal(res.status, 405);
    assert.equal(res.headers.get('allow'), 'POST');
    assert.match((await res.json()).error, /POST the input/);
  });

  test('an unknown id is a 404 that points at /check', async () => {
    const res = await api.convert('not-a-real-tool', 'x', { ip: ips.next() });
    assert.equal(res.status, 404);
    assert.match(res.json().error, /no hosted conversion with id "not-a-real-tool"/);
    assert.match(res.json().error, /\/check/);
  });

  test('an unknown id is refused before any store work', async () => {
    const before = (await worker.d1('SELECT COUNT(*) AS n FROM events;'))[0].n;
    for (let i = 0; i < 5; i++) await api.convert('not-a-real-tool', 'x', { ip: ips.next() });
    const after = (await worker.d1('SELECT COUNT(*) AS n FROM events;'))[0].n;
    assert.equal(after, before, 'a 404 wrote an events row');
  });

  test('every hosted id in the catalog actually answers', async () => {
    // The 501 path exists for an entry listed live with no implementation. This
    // asserts nobody is standing on it.
    const inputs = {
      'md-html': '# hi\n',
      'json-yaml': '{"a":1}',
      'yaml-json': 'a: 1\n',
      'csv-json': 'a\n1\n',
      'html-markdown': '<p>hi</p>',
    };
    for (const id of HOSTED_IDS) {
      const res = await api.convert(id, inputs[id] ?? 'x', { ip: ips.next() });
      assert.notEqual(res.status, 501, `${id} is listed live with no implementation behind it`);
      assert.notEqual(res.status, 404, `${id} is in the catalog but not routed`);
      assert.equal(res.status, 200, `${id} answered ${res.status}: ${res.text}`);
    }
  });

  test('each tool answers with its own content-type', async () => {
    const expected = {
      'md-html': /^text\/html/,
      'json-yaml': /^application\/yaml/,
      'yaml-json': /^application\/json/,
      'csv-json': /^application\/json/,
      'html-markdown': /^text\/markdown/,
    };
    const inputs = {
      'md-html': '# hi\n',
      'json-yaml': '{"a":1}',
      'yaml-json': 'a: 1\n',
      'csv-json': 'a\n1\n',
      'html-markdown': '<p>hi</p>',
    };
    for (const [id, pattern] of Object.entries(expected)) {
      const res = await api.convert(id, inputs[id], { ip: ips.next() });
      assert.match(res.contentType, pattern, `${id} answered ${res.contentType}`);
    }
  });
});

describe('the 256 KB limit', () => {
  test('a body over the limit is a 413 and writes no row', async () => {
    // The size check runs on the DECLARED content-length, before the rate-limit
    // round trip and before any body read — so a rejected upload costs no quota
    // and no store write. Verified here by counting rows either side.
    const eventsBefore = (await worker.d1('SELECT COUNT(*) AS n FROM events;'))[0].n;
    const quotaBefore = (await worker.d1('SELECT COALESCE(SUM(used), 0) AS n FROM convert_quota;'))[0].n;

    const res = await api.convert('md-html', 'a'.repeat(300 * 1024), { ip: ips.next() });
    assert.equal(res.status, 413, res.text);
    assert.match(res.json().error, /256 KB limit/);

    const eventsAfter = (await worker.d1('SELECT COUNT(*) AS n FROM events;'))[0].n;
    const quotaAfter = (await worker.d1('SELECT COALESCE(SUM(used), 0) AS n FROM convert_quota;'))[0].n;
    assert.equal(eventsAfter, eventsBefore, 'a 413 wrote an events row');
    assert.equal(quotaAfter, quotaBefore, 'a 413 spent free-tier allowance');
  });

  test('a body just under the limit converts', async () => {
    // Built from many short lines rather than one enormous paragraph: the point
    // is the size guard, and a single 250 KB line would be measuring the inline
    // lexer instead.
    const line = `- item ${'x'.repeat(40)}\n`;
    const body = line.repeat(Math.floor((250 * 1024) / line.length));
    assert.ok(Buffer.byteLength(body) < 256 * 1024, 'fixture is not under the limit');
    assert.ok(Buffer.byteLength(body) > 200 * 1024, 'fixture is not close enough to the limit');
    const res = await api.convert('md-html', body, { ip: ips.next() });
    assert.equal(res.status, 200, `expected 200 under the limit, got ${res.status}: ${res.text.slice(0, 200)}`);
  });
});

describe('POST /b never errors', () => {
  const cases = {
    'malformed JSON': '{not json',
    'empty body': '',
    'a bare string': '"visit"',
    'a JSON array': '[]',
    'the number 5': '5',
    'null': 'null',
    'an unknown type': '{"t":"exfiltrate"}',
    'a missing type': '{"e":"x"}',
    'an over-long entry id': `{"t":"click","e":"${'x'.repeat(200)}"}`,
    'a non-string entry id': '{"t":"click","e":{"nested":true}}',
    'a body over the 1 KB cap': `{"t":"visit","pad":"${'x'.repeat(2000)}"}`,
  };

  for (const [name, body] of Object.entries(cases)) {
    test(`${name} answers 204 with no body`, async () => {
      const res = await api.post('/b', body, { ip: ips.next() });
      assert.equal(res.status, 204, `${name} answered ${res.status}`);
      assert.equal(await res.text(), '', 'a 204 carried a body');
      assert.equal(res.headers.get('access-control-allow-origin'), '*');
    });
  }

  test('a wrong method on /b is a 405 and a wrong path is a 404', async () => {
    assert.equal((await api.request('/b', { method: 'GET' })).status, 405);
    assert.equal((await api.post('/nope', '{}', { ip: ips.next() })).status, 404);
    assert.equal((await api.get('/')).status, 405);
  });
});
