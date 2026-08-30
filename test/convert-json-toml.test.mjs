// POST /convert/json-toml — JSON to TOML.
//
// The direction where the target format is SMALLER, so most of this suite is
// about refusals. Two things JSON has that TOML does not:
//
//   a non-object root  — TOML's root is a table, so an array or a scalar has
//                        nowhere to go;
//   null               — TOML has no spelling for it, and the serializer does
//                        not error on one, it DROPS the key. A 200 that silently
//                        lost a field is the worst answer available, so it is a
//                        400 naming the path instead.
//
// PHASE: the env-gated free tier, so conversions are actually served.

import test, { before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { useWorker, client, callers, TIER_ON_VARS } from './harness.mjs';

let worker;
let api;
const ips = callers('json-toml');

before(async () => {
  worker = await useWorker({ vars: TIER_ON_VARS });
  api = client(worker);
});
after(async () => {
  await worker.stop();
});

const raw = (input) => api.convert('json-toml', input, { ip: ips.next() });

async function toml(input) {
  const res = await raw(input);
  assert.equal(res.status, 200, `json-toml refused ${res.status}: ${res.text}`);
  assert.match(res.contentType, /^application\/toml/);
  return res.text;
}

describe('json-toml', () => {
  test('scalars become key/value lines', async () => {
    const out = await toml('{"title":"toolshed","count":3,"ok":true}');
    assert.match(out, /title = "toolshed"/);
    assert.match(out, /count = 3/);
    assert.match(out, /ok = true/);
  });

  test('a nested object becomes a table header', async () => {
    const out = await toml('{"owner":{"name":"lemon"}}');
    assert.match(out, /\[owner\]/);
    assert.match(out, /name = "lemon"/);
  });

  test('an array of objects becomes an array of tables', async () => {
    const out = await toml('{"fruit":[{"name":"apple"},{"name":"lime"}]}');
    assert.equal((out.match(/\[\[fruit\]\]/g) || []).length, 2, out);
  });

  test('an array of scalars stays an inline array', async () => {
    assert.match(await toml('{"tags":["a","b"]}'), /tags = \[\s*"a",\s*"b",?\s*\]/);
  });

  test('a string containing a quote or a newline is escaped, not broken', async () => {
    const out = await toml('{"s":"he said \\"hi\\"","t":"one\\ntwo"}');
    assert.ok(!out.split('\n').some((line) => line.startsWith('two')), `the newline broke the file: ${out}`);
    assert.match(out, /\\"hi\\"/);
  });

  test('an empty object is valid TOML — an empty document', async () => {
    const res = await raw('{}');
    assert.equal(res.status, 200, res.text);
    assert.equal(res.text.trim(), '');
  });

  test('key order follows the JSON document', async () => {
    const out = await toml('{"z":1,"a":2}');
    assert.ok(out.indexOf('z = 1') < out.indexOf('a = 2'), `key order was not preserved: ${out}`);
  });

  test('unicode keys and values', async () => {
    const out = await toml('{"名前":"日本語 🍋"}');
    assert.ok(out.includes('日本語 🍋'), out);
  });
});

describe('json-toml refusals', () => {
  test('a non-object root is a 400 naming the shape it got', async () => {
    for (const [input, shape] of [
      ['[1,2]', /an array/],
      ['"x"', /a string/],
      ['5', /a number/],
      ['null', /null/],
    ]) {
      const res = await raw(input);
      assert.equal(res.status, 400, res.text);
      assert.match(res.json().error, /root is a table/, res.text);
      assert.match(res.json().error, shape, res.text);
    }
  });

  test('a null is a 400 naming its path, not a silently dropped key', async () => {
    const res = await raw('{"a":1,"b":null}');
    assert.equal(res.status, 400, res.text);
    assert.match(res.json().error, /TOML has no null/, res.text);
    assert.match(res.json().error, /`b`/, res.text);
  });

  test('a null nested inside an array is found too, with an indexed path', async () => {
    const res = await raw('{"a":{"b":[1,null]}}');
    assert.equal(res.status, 400, res.text);
    assert.match(res.json().error, /`a\.b\[1\]`/, res.text);
  });

  test('invalid JSON is a 400 naming the parse failure', async () => {
    const res = await raw('{not json');
    assert.equal(res.status, 400, res.text);
    assert.match(res.json().error, /not valid JSON/, res.text);
  });

  test('an empty body is a 400', async () => {
    const res = await raw('');
    assert.equal(res.status, 400);
    assert.equal(res.json().error, 'the request body is empty');
  });

  test('every refusal is a one-line JSON error with no stack trace', async () => {
    for (const input of ['[1,2]', '{"a":null}', '{not json', 'null']) {
      const res = await raw(input);
      assert.equal(res.status, 400);
      assert.match(res.contentType, /application\/json/);
      const { error } = res.json();
      assert.ok(!error.includes('\n'), `not one line: ${error}`);
      assert.ok(!/\bat\s+\w+\s+\(/.test(error), `a stack trace leaked: ${error}`);
    }
  });
});
