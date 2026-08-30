// POST /convert/csv-yaml — the RFC 4180 parser, dumped as YAML.
//
// It shares csv-json's parser, so the parsing edge cases are proved there. What
// is proved HERE is the half that is specific to this endpoint: the YAML that
// comes out is a list of maps, every value is still a string, and a value that
// would change meaning unquoted comes back quoted.
//
// PHASE: the env-gated free tier, so conversions are actually served.

import test, { before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import yaml from 'js-yaml';
import { useWorker, client, callers, TIER_ON_VARS } from './harness.mjs';

let worker;
let api;
const ips = callers('csv-yaml');

before(async () => {
  worker = await useWorker({ vars: TIER_ON_VARS });
  api = client(worker);
});
after(async () => {
  await worker.stop();
});

const raw = (input) => api.convert('csv-yaml', input, { ip: ips.next() });

async function parsed(input) {
  const res = await raw(input);
  assert.equal(res.status, 200, `csv-yaml refused ${res.status}: ${res.text}`);
  assert.match(res.contentType, /^application\/yaml/);
  return { text: res.text, value: yaml.load(res.text) };
}

describe('csv-yaml', () => {
  test('a plain file becomes a list of maps', async () => {
    const { value } = await parsed('name,qty\nlemon,3\nlime,4\n');
    assert.deepEqual(value, [
      { name: 'lemon', qty: '3' },
      { name: 'lime', qty: '4' },
    ]);
  });

  test('the output is block style, not flow style', async () => {
    // The reason to run this rather than JSON.stringify: a config file people
    // read. A single flow-style line would be valid YAML and useless.
    const { text } = await parsed('a,b\n1,2\n');
    assert.match(text, /^- a: '1'\n/m, text);
    assert.ok(!text.trim().startsWith('['), `flow style: ${text}`);
  });

  test('every value stays a string — no type guessing', async () => {
    const { value } = await parsed('zip,id,flag,money\n007,12345678901234567890,true,1.50\n');
    for (const [key, want] of Object.entries({
      zip: '007',
      id: '12345678901234567890',
      flag: 'true',
      money: '1.50',
    })) {
      assert.equal(value[0][key], want);
      assert.equal(typeof value[0][key], 'string', `${key} was coerced away from a string`);
    }
  });

  test('a value that would change meaning unquoted comes back quoted', async () => {
    // "no" is YAML 1.1's boolean false and "3" is a number. Round-tripping the
    // dumped text is the assertion that matters, not the exact quoting style.
    const { value } = await parsed('a,b,c\nno,3,~\n');
    assert.deepEqual(value, [{ a: 'no', b: '3', c: '~' }]);
  });

  test('quoted commas and embedded newlines survive the round trip', async () => {
    const { value } = await parsed('a,b\n"one, two","line one\nline two"\n');
    assert.deepEqual(value, [{ a: 'one, two', b: 'line one\nline two' }]);
  });

  test('a header-only file yields an empty list, not an error', async () => {
    const { value } = await parsed('a,b\n');
    assert.deepEqual(value, []);
  });

  test('unicode in headers and values', async () => {
    const { value } = await parsed('名前,emoji\n日本語,🍋\n');
    assert.deepEqual(value, [{ 名前: '日本語', emoji: '🍋' }]);
  });

  test('a `__proto__` column is not dropped — regression guard', async () => {
    const res = await raw('name,__proto__\nlemon,kept\n');
    assert.equal(res.status, 200, res.text);
    assert.match(res.text, /__proto__: kept/, `the __proto__ column was dropped: ${res.text}`);
  });
});

describe('csv-yaml refusals', () => {
  test('an over-wide row is a 400 naming the 1-based line number', async () => {
    const res = await raw('a,b\n1,2,3\n');
    assert.equal(res.status, 400, res.text);
    assert.match(res.json().error, /row 2\b/, res.text);
  });

  test('an unterminated quoted field is a 400', async () => {
    const res = await raw('a,b\n"never closed,2\n');
    assert.equal(res.status, 400, res.text);
    assert.equal(res.json().error, 'input has an unterminated quoted field');
  });

  test('an all-empty header row is a 400', async () => {
    const res = await raw(',,\n1,2,3\n');
    assert.equal(res.status, 400, res.text);
    assert.match(res.json().error, /non-empty header row/);
  });

  test('an empty body is a 400', async () => {
    const res = await raw('');
    assert.equal(res.status, 400);
    assert.equal(res.json().error, 'the request body is empty');
  });

  test('every refusal is a one-line JSON error with no stack trace', async () => {
    for (const input of ['a,b\n1,2,3\n', '"unclosed\n', ',,\n1,2,3\n']) {
      const res = await raw(input);
      assert.equal(res.status, 400);
      assert.match(res.contentType, /application\/json/);
      const { error } = res.json();
      assert.ok(!error.includes('\n'), `not one line: ${error}`);
      assert.ok(!/\bat\s+\w+\s+\(/.test(error), `a stack trace leaked: ${error}`);
    }
  });
});
