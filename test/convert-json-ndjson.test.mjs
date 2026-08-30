// POST /convert/json-ndjson — a JSON array to newline-delimited JSON.
//
// The thing worth testing is the thing string surgery gets wrong: commas inside
// strings and inside nested structures are not record delimiters. So the fixtures
// deliberately carry commas and newlines in places a split() would break on.
//
// PHASE: the env-gated free tier, so conversions are actually served.

import test, { before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { useWorker, client, callers, TIER_ON_VARS } from './harness.mjs';

let worker;
let api;
const ips = callers('json-ndjson');

before(async () => {
  worker = await useWorker({ vars: TIER_ON_VARS });
  api = client(worker);
});
after(async () => {
  await worker.stop();
});

const raw = (input) => api.convert('json-ndjson', input, { ip: ips.next() });

async function ndjson(input) {
  const res = await raw(input);
  assert.equal(res.status, 200, `json-ndjson refused ${res.status}: ${res.text}`);
  assert.match(res.contentType, /^application\/x-ndjson/);
  return res.text;
}

describe('json-ndjson', () => {
  test('one compact JSON value per line, with a trailing newline', async () => {
    assert.equal(await ndjson('[{"a":1},{"a":2}]'), '{"a":1}\n{"a":2}\n');
  });

  test('input formatting is not preserved — the output is compact by definition', async () => {
    assert.equal(await ndjson('[\n  {\n    "a": 1\n  }\n]'), '{"a":1}\n');
  });

  test('a comma inside a string is not a record boundary', async () => {
    assert.equal(await ndjson('[{"a":"x,y"},{"a":"p,q"}]'), '{"a":"x,y"}\n{"a":"p,q"}\n');
  });

  test('a newline inside a string is escaped, so every record stays one line', async () => {
    const out = await ndjson('[{"a":"one\\ntwo"}]');
    assert.equal(out, '{"a":"one\\ntwo"}\n');
    assert.equal(out.trimEnd().split('\n').length, 1, `a record was split across lines: ${JSON.stringify(out)}`);
  });

  test('nested arrays and objects stay on their record line', async () => {
    assert.equal(await ndjson('[{"a":[1,2],"b":{"c":3}}]'), '{"a":[1,2],"b":{"c":3}}\n');
  });

  test('key order is preserved', async () => {
    assert.equal(await ndjson('[{"z":1,"a":2}]'), '{"z":1,"a":2}\n');
  });

  test('scalar elements are values too, one per line', async () => {
    assert.equal(await ndjson('[1,"two",null,true]'), '1\n"two"\nnull\ntrue\n');
  });

  test('an empty array converts to an empty stream, not an error', async () => {
    const res = await raw('[]');
    assert.equal(res.status, 200, res.text);
    assert.equal(res.text, '');
  });

  test('1,000 elements convert well inside 5 s', async () => {
    const body = JSON.stringify(Array.from({ length: 1000 }, (_, i) => ({ id: i, note: 'a, b' })));
    const started = Date.now();
    const out = await ndjson(body);
    const elapsed = Date.now() - started;
    const lines = out.trimEnd().split('\n');
    assert.equal(lines.length, 1000);
    assert.equal(lines[999], '{"id":999,"note":"a, b"}');
    assert.ok(elapsed < 5000, `1,000 elements took ${elapsed} ms`);
  });
});

describe('json-ndjson refusals', () => {
  test('invalid JSON is a 400 naming the parse failure', async () => {
    const res = await raw('[{"a":1},');
    assert.equal(res.status, 400, res.text);
    assert.match(res.json().error, /not valid JSON/);
  });

  test('a non-array top level is a 400 rather than a stream of one', async () => {
    for (const [input, shape] of [
      ['{"a":1}', /an object/],
      ['"x"', /a string/],
      ['5', /a number/],
      ['null', /null/],
    ]) {
      const res = await raw(input);
      assert.equal(res.status, 400, res.text);
      assert.match(res.json().error, /must be a JSON array/, res.text);
      assert.match(res.json().error, shape, res.text);
    }
  });

  test('an empty body is a 400', async () => {
    const res = await raw('');
    assert.equal(res.status, 400);
    assert.equal(res.json().error, 'the request body is empty');
  });

  test('every refusal is a one-line JSON error with no stack trace', async () => {
    for (const input of ['[{"a":1},', '{"a":1}', '5']) {
      const res = await raw(input);
      assert.equal(res.status, 400);
      assert.match(res.contentType, /application\/json/);
      const { error } = res.json();
      assert.ok(!error.includes('\n'), `not one line: ${error}`);
      assert.ok(!/\bat\s+\w+\s+\(/.test(error), `a stack trace leaked: ${error}`);
    }
  });
});
