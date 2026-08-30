// The HTTP contract: /check, the method and routing guards, the size limit and
// the beacon's never-error promise.
//
// This is the surface an agent codes against without reading the page, so the
// assertions are about the shape of the answer rather than about any one tool.
//
// PHASE: the env-gated free tier, because several tests here need a conversion
// actually served and that is the cheapest way to get one. What /check reports
// as `free_tier_daily` is therefore the RUNTIME value this worker was booted
// with, which is the claim being tested — that the number moves with the env
// var rather than with the build constant. tier-off.test.mjs asserts the other
// half: the same field reads 0 on a worker booted without it.

import test, { before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  useWorker,
  client,
  callers,
  CATALOG,
  FREE_TIER_ENABLED,
  TIER_ON_VARS,
} from './harness.mjs';

let worker;
let api;
const ips = callers('protocol');

const HOSTED_IDS = CATALOG.filter((e) => e.hosted).map((e) => e.id).sort();

// A real body for every hosted tool, in ONE place — the two tests below both
// need one, and a tool added to the catalog without an entry here fails loudly
// on the completeness assertion rather than quietly converting the string 'x'.
const INPUTS = {
  'md-html': '# hi\n',
  'json-yaml': '{"a":1}',
  'yaml-json': 'a: 1\n',
  'csv-json': 'a\n1\n',
  'html-markdown': '<p>hi</p>',
  'json-csv': '[{"a":1}]',
  'csv-yaml': 'a\n1\n',
  'yaml-csv': '- a: 1\n',
  'json-ndjson': '[{"a":1}]',
  'ndjson-json': '{"a":1}\n',
  'frontmatter-json': '---\ntitle: hi\n---\nbody\n',
  'markdown-json': '# hi\n',
  'srt-vtt': '1\n00:00:01,000 --> 00:00:02,000\nhi\n',
  'vtt-srt': 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nhi\n',
  'toml-json': 'a = 1\n',
  'json-toml': '{"a":1}',
  'xml-json': '<r><a>1</a></r>',
  'html-text': '<p>hi</p>',
  'html-json': '<table><tr><th>a</th></tr><tr><td>1</td></tr></table>',
};

// The Content-Type each hosted tool answers a 200 with. Keyed on the same ids as
// INPUTS, and the pair is what proves a tool is routed to its own converter
// rather than to a neighbour that happens to accept the same body.
const CONTENT_TYPES = {
  'md-html': /^text\/html/,
  'json-yaml': /^application\/yaml/,
  'yaml-json': /^application\/json/,
  'csv-json': /^application\/json/,
  'html-markdown': /^text\/markdown/,
  'json-csv': /^text\/csv/,
  'csv-yaml': /^application\/yaml/,
  'yaml-csv': /^text\/csv/,
  'json-ndjson': /^application\/x-ndjson/,
  'ndjson-json': /^application\/json/,
  'frontmatter-json': /^application\/json/,
  'markdown-json': /^application\/json/,
  'srt-vtt': /^text\/vtt/,
  'vtt-srt': /^application\/x-subrip/,
  'toml-json': /^application\/json/,
  'json-toml': /^application\/toml/,
  'xml-json': /^application\/json/,
  'html-text': /^text\/plain/,
  'html-json': /^application\/json/,
};

before(async () => {
  worker = await useWorker({ vars: TIER_ON_VARS });
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
    assert.equal(HOSTED_IDS.length, 19, 'the hosted tool count changed — update this test and INPUTS below');
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
        FREE_TIER_ENABLED,
        `${match.id} advertises a free tier the Worker does not enforce — /check must report the ` +
          'RUNTIME env value, not the number compiled into the catalog'
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

  test('extensions and MIME types match, with or without a leading dot', async () => {
    // THE BUG THIS FIXES, verified live 2026-08-19 against the production host:
    // `?from=md`, `?from=.md` and `?from=text/markdown` all returned [] while
    // only `?from=markdown` matched. An extension and a Content-Type are the two
    // things a machine actually has on hand — it reads them off a filename and
    // off a response header — so the one spelling that worked was the one least
    // likely to be tried.
    const ids = async (q) => (await check(q)).body.matches.map((m) => m.id);

    for (const q of ['?from=md&to=html', '?from=.md&to=html', '?from=text/markdown&to=text/html']) {
      assert.deepEqual(await ids(q), ['md-html'], `${q} did not resolve to md-html`);
    }
    for (const q of ['?from=yml&to=json', '?from=.yaml&to=json', '?from=yaml&to=application/json']) {
      assert.deepEqual(await ids(q), ['yaml-json'], `${q} did not resolve to yaml-json`);
    }
    assert.deepEqual(await ids('?from=text/csv&to=application/json'), ['csv-json']);
    assert.deepEqual(await ids('?to=text/html'), ['md-html']);

    // An alias is an EXACT hit, not a second substring pass: `.md` must not
    // start matching things that merely contain "md".
    assert.deepEqual(await ids('?from=zzzznotathing'), []);
    assert.deepEqual(await ids('?from=.zzzznotathing'), []);
  });

  test('aliasing never crosses the have/need binding', async () => {
    // The whole point of field-bound matching, restated for the alias half: an
    // alias hit on the wrong side must not resurrect the reversed pair.
    const { body } = await check('?from=md&to=text/html');
    assert.ok(!body.matches.some((m) => m.id === 'html-markdown'), 'the reversed pair matched via an alias');
  });

  test('every catalog entry carries alias sets containing its own label', async () => {
    // Compiled in build.mjs, so a missing set means the build silently stopped
    // emitting them and /check quietly went back to substring-only.
    for (const entry of CATALOG) {
      assert.ok(Array.isArray(entry.xa) && entry.xa.length, `${entry.id} has no from-side aliases`);
      assert.ok(Array.isArray(entry.ya) && entry.ya.length, `${entry.id} has no to-side aliases`);
      for (const alias of [...entry.xa, ...entry.ya]) {
        assert.equal(alias, alias.toLowerCase(), `${entry.id} has an unnormalised alias: ${alias}`);
        assert.ok(!alias.startsWith('.'), `${entry.id} has a dotted alias: ${alias}`);
      }
    }
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
    assert.deepEqual(
      HOSTED_IDS.filter((id) => !(id in INPUTS)),
      [],
      'a hosted tool has no fixture body in INPUTS — add one rather than letting it convert "x"'
    );
    for (const id of HOSTED_IDS) {
      const res = await api.convert(id, INPUTS[id], { ip: ips.next() });
      assert.notEqual(res.status, 501, `${id} is listed live with no implementation behind it`);
      assert.notEqual(res.status, 404, `${id} is in the catalog but not routed`);
      assert.equal(res.status, 200, `${id} answered ${res.status}: ${res.text}`);
    }
  });

  test('each tool answers with its own content-type', async () => {
    assert.deepEqual(
      HOSTED_IDS.filter((id) => !(id in CONTENT_TYPES)),
      [],
      'a hosted tool has no expected content-type — add one to CONTENT_TYPES'
    );
    for (const id of HOSTED_IDS) {
      const res = await api.convert(id, INPUTS[id], { ip: ips.next() });
      assert.equal(res.status, 200, `${id} answered ${res.status}: ${res.text}`);
      assert.match(res.contentType, CONTENT_TYPES[id], `${id} answered ${res.contentType}`);
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
