// POST /convert/json-csv — records to CSV.
//
// The inverse of csv-json, and the assertions are about the two decisions that
// are not forced by the format:
//
//   the header is the UNION of every record's keys, in first-seen order — not
//   the first record's keys, which is the bug that shifts every later value one
//   column left the first time two records differ;
//   one level of nesting flattens to dotted columns, and anything deeper is
//   written back as compact JSON rather than invented into columns.
//
// The free tier is OFF by default now, so a conversion is a paid call and an
// unauthenticated POST answers 402. This suite is about the CONVERTER, so it
// boots the env-gated free tier and gets served 200s the cheap way.

import test, { before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { useWorker, client, callers, TIER_ON_VARS } from './harness.mjs';

let worker;
let api;
const ips = callers('json-csv');

before(async () => {
  worker = await useWorker({ vars: TIER_ON_VARS });
  api = client(worker);
});
after(async () => {
  await worker.stop();
});

const raw = (input) => api.convert('json-csv', input, { ip: ips.next() });

async function csv(input) {
  const res = await raw(input);
  assert.equal(res.status, 200, `json-csv refused ${res.status}: ${res.text}`);
  assert.match(res.contentType, /^text\/csv/);
  return res.text;
}

describe('json-csv', () => {
  test('a plain array of records', async () => {
    assert.equal(await csv('[{"name":"lemon","qty":"3"},{"name":"lime","qty":"4"}]'), 'name,qty\nlemon,3\nlime,4\n');
  });

  test('the header is the union of every key, in first-seen order', async () => {
    // The whole point: record 2 introduces `c`, record 1 never had it, and both
    // rows still line up under the same header.
    assert.equal(await csv('[{"a":1,"b":2},{"a":3,"c":4}]'), 'a,b,c\n1,2,\n3,,4\n');
  });

  test('a missing key is an empty cell, not a shifted row', async () => {
    const out = await csv('[{"a":1,"b":2},{"b":9}]');
    assert.equal(out, 'a,b\n1,2\n,9\n');
  });

  test('commas, quotes and newlines in values are quoted per RFC 4180', async () => {
    assert.equal(await csv('[{"a":"x,y"}]'), 'a\n"x,y"\n');
    assert.equal(await csv('[{"a":"he said \\"hi\\""}]'), 'a\n"he said ""hi"""\n');
    assert.equal(await csv('[{"a":"one\\ntwo"}]'), 'a\n"one\ntwo"\n');
  });

  test('a value with nothing special in it is written bare', async () => {
    assert.equal(await csv('[{"a":"plain"}]'), 'a\nplain\n');
  });

  test('one level of nesting becomes dotted columns', async () => {
    assert.equal(await csv('[{"user":{"id":1,"name":"lemon"}}]'), 'user.id,user.name\n1,lemon\n');
  });

  test('arrays and deeper nesting are written back as compact JSON in the cell', async () => {
    // CSV cannot express them, and deriving columns from an array's length would
    // make the header depend on the data.
    assert.equal(await csv('[{"tags":["a","b"]}]'), 'tags\n"[""a"",""b""]"\n');
    assert.equal(await csv('[{"a":{"b":{"c":1}}}]'), 'a.b\n"{""c"":1}"\n');
  });

  test('null and false survive as themselves, not as "null" and ""', async () => {
    assert.equal(await csv('[{"a":null,"b":false,"c":0}]'), 'a,b,c\n,false,0\n');
  });

  test('a `__proto__` key is a column like any other — regression guard', async () => {
    const res = await raw('[{"__proto__":"kept","a":1}]');
    assert.equal(res.status, 200, res.text);
    assert.equal(res.text, '__proto__,a\nkept,1\n');
  });

  test('unicode keys and values survive', async () => {
    assert.equal(await csv('[{"名前":"日本語","emoji":"🍋"}]'), '名前,emoji\n日本語,🍋\n');
  });

  test('1,000 records convert well inside 5 s', async () => {
    const records = Array.from({ length: 1000 }, (_, i) => ({ id: i, note: 'a, b' }));
    const started = Date.now();
    const out = await csv(JSON.stringify(records));
    const elapsed = Date.now() - started;
    const lines = out.trimEnd().split('\n');
    assert.equal(lines.length, 1001);
    assert.equal(lines[0], 'id,note');
    assert.equal(lines[1000], '999,"a, b"');
    assert.ok(elapsed < 5000, `1,000 records took ${elapsed} ms`);
  });
});

describe('json-csv refusals', () => {
  test('invalid JSON is a 400 naming the parse failure', async () => {
    const res = await raw('{not json');
    assert.equal(res.status, 400, res.text);
    assert.match(res.json().error, /not valid JSON/);
  });

  test('a non-array top level is a 400 naming the shape it got', async () => {
    for (const [input, shape] of [
      ['{"a":1}', /an object/],
      ['"x"', /a string/],
      ['5', /a number/],
      ['null', /null/],
    ]) {
      const res = await raw(input);
      assert.equal(res.status, 400, res.text);
      assert.match(res.json().error, /must be an array of objects/, res.text);
      assert.match(res.json().error, shape, res.text);
    }
  });

  test('a non-object element is a 400 naming its index', async () => {
    const res = await raw('[{"a":1},2]');
    assert.equal(res.status, 400, res.text);
    assert.match(res.json().error, /element 1 .* is a number, not an object/, res.text);
  });

  test('an empty array is a 400 — there is no header row to write', async () => {
    const res = await raw('[]');
    assert.equal(res.status, 400, res.text);
    assert.match(res.json().error, /empty array/);
  });

  test('records with no fields at all are a 400', async () => {
    const res = await raw('[{},{}]');
    assert.equal(res.status, 400, res.text);
    assert.match(res.json().error, /no fields/);
  });

  test('an empty body is a 400', async () => {
    const res = await raw('');
    assert.equal(res.status, 400);
    assert.equal(res.json().error, 'the request body is empty');
  });

  test('every refusal is a one-line JSON error with no stack trace', async () => {
    for (const input of ['{not json', '{"a":1}', '[]', '[1]']) {
      const res = await raw(input);
      assert.equal(res.status, 400);
      assert.match(res.contentType, /application\/json/);
      const { error } = res.json();
      assert.ok(!error.includes('\n'), `not one line: ${error}`);
      assert.ok(!/\bat\s+\w+\s+\(/.test(error), `a stack trace leaked: ${error}`);
    }
  });
});
