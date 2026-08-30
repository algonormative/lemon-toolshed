// POST /convert/toml-json — a conforming TOML parser, dumped as JSON.
//
// The reason to pay for this rather than regex a version out of pyproject.toml
// is the shapes a hand-rolled reader gets wrong, so those are the fixtures:
// dotted keys, arrays of tables, multi-line strings, date-times. The lossy edges
// are pinned too — comments go, dates become strings — because a read path that
// quietly loses something is worse than one that says it will.
//
// PHASE: the env-gated free tier, so conversions are actually served.

import test, { before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { useWorker, client, callers, TIER_ON_VARS } from './harness.mjs';

let worker;
let api;
const ips = callers('toml-json');

before(async () => {
  worker = await useWorker({ vars: TIER_ON_VARS });
  api = client(worker);
});
after(async () => {
  await worker.stop();
});

const raw = (input) => api.convert('toml-json', input, { ip: ips.next() });

async function json(input) {
  const res = await raw(input);
  assert.equal(res.status, 200, `toml-json refused ${res.status}: ${res.text}`);
  assert.match(res.contentType, /^application\/json/);
  return JSON.parse(res.text);
}

describe('toml-json', () => {
  test('a key/value document', async () => {
    assert.deepEqual(await json('title = "toolshed"\ncount = 3\nok = true\n'), {
      title: 'toolshed',
      count: 3,
      ok: true,
    });
  });

  test('tables become nested objects', async () => {
    assert.deepEqual(await json('[owner]\nname = "lemon"\n\n[owner.address]\ncity = "here"\n'), {
      owner: { name: 'lemon', address: { city: 'here' } },
    });
  });

  test('dotted keys nest, they are not one flat key', async () => {
    assert.deepEqual(await json('a.b.c = 1\n'), { a: { b: { c: 1 } } });
  });

  test('an array of tables becomes an array of objects', async () => {
    assert.deepEqual(await json('[[fruit]]\nname = "apple"\n\n[[fruit]]\nname = "lime"\n'), {
      fruit: [{ name: 'apple' }, { name: 'lime' }],
    });
  });

  test('inline tables and arrays', async () => {
    assert.deepEqual(await json('point = { x = 1, y = 2 }\ntags = ["a", "b"]\n'), {
      point: { x: 1, y: 2 },
      tags: ['a', 'b'],
    });
  });

  test('a multi-line basic string keeps its newlines', async () => {
    assert.deepEqual(await json('s = """\none\ntwo\n"""\n'), { s: 'one\ntwo\n' });
  });

  test('a literal string does not process escapes', async () => {
    // Single quotes in TOML mean "take these bytes"; a parser that unescapes
    // them turns a Windows path into a tab and a form feed.
    assert.deepEqual(await json("path = 'C:\\dir\\file'\n"), { path: 'C:\\dir\\file' });
  });

  test('an offset date-time becomes an ISO-8601 string, because JSON has no date', async () => {
    const out = await json('d = 1979-05-27T07:32:00Z\n');
    assert.equal(typeof out.d, 'string');
    assert.match(out.d, /^1979-05-27T07:32:00/);
  });

  test('comments are dropped — this is a read path, not a round trip', async () => {
    const res = await raw('# a comment\na = 1 # trailing\n');
    assert.equal(res.status, 200, res.text);
    assert.ok(!res.text.includes('comment'), `a comment survived: ${res.text}`);
    assert.deepEqual(JSON.parse(res.text), { a: 1 });
  });

  test('the output is pretty-printed', async () => {
    const res = await raw('a = 1\n');
    assert.ok(res.text.includes('\n  '), 'not pretty-printed');
  });

  test('unicode keys and values', async () => {
    assert.deepEqual(await json('"名前" = "日本語 🍋"\n'), { 名前: '日本語 🍋' });
  });
});

describe('toml-json refusals', () => {
  test('an unfinished array is a 400 naming the problem', async () => {
    const res = await raw('a = [\n');
    assert.equal(res.status, 400, res.text);
    assert.match(res.json().error, /not valid TOML/, res.text);
  });

  test('a duplicate key is a 400 rather than a last-one-wins guess', async () => {
    const res = await raw('a = 1\na = 2\n');
    assert.equal(res.status, 400, res.text);
    assert.match(res.json().error, /not valid TOML/, res.text);
  });

  test('bare JSON is not TOML', async () => {
    const res = await raw('{"a": 1}');
    assert.equal(res.status, 400, res.text);
    assert.match(res.json().error, /not valid TOML/, res.text);
  });

  test('an empty body is a 400', async () => {
    const res = await raw('');
    assert.equal(res.status, 400);
    assert.equal(res.json().error, 'the request body is empty');
  });

  test('every refusal is a one-line JSON error with no stack trace', async () => {
    // TOML parse errors are multi-line by nature — they carry a caret pointing
    // at the offending column — so this is the assertion that they are flattened
    // on the way out rather than sprayed into the response.
    for (const input of ['a = [\n', 'a = 1\na = 2\n', '{"a": 1}', '= 1\n']) {
      const res = await raw(input);
      assert.equal(res.status, 400);
      assert.match(res.contentType, /application\/json/);
      const { error } = res.json();
      assert.ok(!error.includes('\n'), `not one line: ${error}`);
      assert.ok(!/\bat\s+\w+\s+\(/.test(error), `a stack trace leaked: ${error}`);
    }
  });
});
