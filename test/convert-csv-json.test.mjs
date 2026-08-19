// POST /convert/csv-json — the RFC 4180 battery.
//
// The parser's stated contract is fidelity: "values stay strings — guessing
// types is where leading zeros and long ids get destroyed". So the assertions
// here are about what survives, not about how it is formatted. Two behaviours
// that RFC 4180 leaves open are pinned explicitly, with the reason, because a
// caller has to know which way they went:
//
//   over-wide row  -> 400 naming the 1-based line number
//   under-wide row -> 200, missing trailing fields padded with ""
//
// A `__proto__` header column used to be dropped silently here. That was a real
// bug, fixed in worker/beacon.js (csvToRecords now builds null-prototype
// records); the test below is the regression guard.

// The free tier is OFF by default now, so a conversion is a paid call and an
// unauthenticated POST answers 402. This suite is about the CONVERTER, not about
// payment, so it boots the env-gated free tier and gets served 200s the cheap way.

import test, { before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { useWorker, client, callers, TIER_ON_VARS } from './harness.mjs';

let worker;
let api;
const ips = callers('csv-json');

before(async () => {
  worker = await useWorker({ vars: TIER_ON_VARS });
  api = client(worker);
});
after(async () => {
  await worker.stop();
});

const raw = (input) => api.convert('csv-json', input, { ip: ips.next() });

async function records(input) {
  const res = await raw(input);
  assert.equal(res.status, 200, `csv-json refused ${res.status}: ${res.text}`);
  assert.match(res.contentType, /^application\/json/);
  return JSON.parse(res.text);
}

describe('csv-json — RFC 4180', () => {
  test('a plain file', async () => {
    assert.deepEqual(await records('name,qty\nlemon,3\nlime,4\n'), [
      { name: 'lemon', qty: '3' },
      { name: 'lime', qty: '4' },
    ]);
  });

  test('quoted field containing commas', async () => {
    assert.deepEqual(await records('a,b\n"one, two, three",2\n'), [{ a: 'one, two, three', b: '2' }]);
  });

  test('escaped double quotes inside a quoted field', async () => {
    assert.deepEqual(await records('a,b\n"she said ""hi""",2\n'), [{ a: 'she said "hi"', b: '2' }]);
  });

  test('a field that is only doubled quotes', async () => {
    assert.deepEqual(await records('a\n""""\n'), [{ a: '"' }]);
  });

  test('embedded CRLF inside a quoted field is data, not a row break', async () => {
    const rows = await records('a,b\r\n"line one\r\nline two",2\r\n');
    assert.equal(rows.length, 1, `the embedded CRLF split the row: ${JSON.stringify(rows)}`);
    assert.equal(rows[0].a, 'line one\r\nline two');
    assert.equal(rows[0].b, '2');
  });

  test('embedded LF inside a quoted field is data too', async () => {
    const rows = await records('a,b\n"line one\nline two",2\n');
    assert.deepEqual(rows, [{ a: 'line one\nline two', b: '2' }]);
  });

  test('trailing empty field', async () => {
    assert.deepEqual(await records('a,b,c\n1,2,\n'), [{ a: '1', b: '2', c: '' }]);
  });

  test('leading and interior empty fields', async () => {
    assert.deepEqual(await records('a,b,c\n,2,\n,,\n'), [
      { a: '', b: '2', c: '' },
      { a: '', b: '', c: '' },
    ]);
  });

  test('empty lines between records are skipped', async () => {
    assert.deepEqual(await records('a,b\n\n1,2\n\n\n3,4\n\n'), [
      { a: '1', b: '2' },
      { a: '3', b: '4' },
    ]);
  });

  test('a header-only file yields an empty array, not an error', async () => {
    assert.deepEqual(await records('a,b,c\n'), []);
    assert.deepEqual(await records('a,b,c'), []);
  });

  test('a single-column file needs no commas', async () => {
    assert.deepEqual(await records('a\n1\n2\n'), [{ a: '1' }, { a: '2' }]);
  });

  test('CRLF and LF files parse identically', async () => {
    const lf = await records('a,b\n1,2\n3,4\n');
    const crlf = await records('a,b\r\n1,2\r\n3,4\r\n');
    assert.deepEqual(crlf, lf);
  });

  test('a UTF-8 BOM is stripped from the first header', async () => {
    const rows = await records('﻿a,b\n1,2\n');
    assert.deepEqual(rows, [{ a: '1', b: '2' }]);
    assert.deepEqual(Object.keys(rows[0]), ['a', 'b'], 'the BOM survived into the first key');
  });

  test('no trailing newline still yields the last row', async () => {
    assert.deepEqual(await records('a,b\n1,2'), [{ a: '1', b: '2' }]);
  });

  test('unicode in headers and values', async () => {
    assert.deepEqual(await records('名前,emoji\n日本語,🍋\n'), [{ 名前: '日本語', emoji: '🍋' }]);
  });

  test('header cells are trimmed, values are not', async () => {
    const rows = await records('  a  , b \n  1  , 2 \n');
    assert.deepEqual(Object.keys(rows[0]), ['a', 'b']);
    assert.equal(rows[0].a, '  1  ', 'a value was trimmed — leading whitespace is data');
  });

  test('values stay strings — no type guessing', async () => {
    const rows = await records('zip,id,flag,money\n007,12345678901234567890,true,1.50\n');
    for (const [key, want] of Object.entries({
      zip: '007',
      id: '12345678901234567890',
      flag: 'true',
      money: '1.50',
    })) {
      assert.equal(rows[0][key], want);
      assert.equal(typeof rows[0][key], 'string', `${key} was coerced away from a string`);
    }
  });

  test('a `__proto__` header column is not dropped — regression guard', async () => {
    // Before the fix, `record['__proto__'] = value` on a plain object hit
    // Object.prototype's setter and silently discarded the column: a 200 with a
    // column missing. Asserted on the raw text because a JS object literal
    // cannot express the expectation.
    const res = await raw('name,__proto__,qty\nlemon,kept,3\n');
    assert.equal(res.status, 200, res.text);
    assert.ok(res.text.includes('"__proto__": "kept"'), `the __proto__ column was dropped: ${res.text}`);
    const rows = JSON.parse(res.text);
    assert.equal(Object.keys(rows[0]).length, 3, `expected 3 columns, got ${JSON.stringify(rows[0])}`);
  });

  test('other Object.prototype names are ordinary columns', async () => {
    const rows = await records('constructor,toString,hasOwnProperty\na,b,c\n');
    assert.deepEqual(rows, [{ constructor: 'a', toString: 'b', hasOwnProperty: 'c' }]);
  });

  test('1,000 rows convert well inside 5 s', async () => {
    const rows = 1000;
    const body = ['id,name,note', ...Array.from({ length: rows }, (_, i) => `${i},row ${i},"a, b"`)].join('\n');
    const started = Date.now();
    const out = await records(body);
    const elapsed = Date.now() - started;
    assert.equal(out.length, rows);
    assert.deepEqual(out[0], { id: '0', name: 'row 0', note: 'a, b' });
    assert.deepEqual(out.at(-1), { id: '999', name: 'row 999', note: 'a, b' });
    assert.ok(elapsed < 5000, `1,000 rows took ${elapsed} ms`);
  });
});

describe('csv-json refusals', () => {
  test('an over-wide row is a 400 naming the 1-based line number', async () => {
    const res = await raw('a,b\n1,2\n1,2,3\n');
    assert.equal(res.status, 400, res.text);
    const { error } = res.json();
    assert.match(error, /row 3\b/, `the error does not name row 3: ${error}`);
    assert.match(error, /3 fields/, error);
    assert.match(error, /header has 2/, error);
  });

  test('the row number counts blank lines too', async () => {
    const res = await raw('a,b\n\n\n1,2,3\n');
    assert.equal(res.status, 400, res.text);
    assert.match(res.json().error, /row 4\b/, res.text);
  });

  test('an under-wide row is PADDED, not refused', async () => {
    // The other defensible answer would be a 400. Recorded as implemented:
    // missing trailing fields become "".
    assert.deepEqual(await records('a,b,c\n1,2\n'), [{ a: '1', b: '2', c: '' }]);
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

  test('a whitespace-only body is a 400', async () => {
    const res = await raw('\n\n\n');
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
