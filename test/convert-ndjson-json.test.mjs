// POST /convert/ndjson-json — a newline-delimited stream back into an array.
//
// The product here is the ERROR as much as the conversion: a log file that does
// not quite parse should tell you which line, which is the whole reason to run a
// parser over it rather than wrapping the file in brackets.
//
// PHASE: the env-gated free tier, so conversions are actually served.

import test, { before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { useWorker, client, callers, TIER_ON_VARS } from './harness.mjs';

let worker;
let api;
const ips = callers('ndjson-json');

before(async () => {
  worker = await useWorker({ vars: TIER_ON_VARS });
  api = client(worker);
});
after(async () => {
  await worker.stop();
});

const raw = (input) => api.convert('ndjson-json', input, { ip: ips.next() });

async function values(input) {
  const res = await raw(input);
  assert.equal(res.status, 200, `ndjson-json refused ${res.status}: ${res.text}`);
  assert.match(res.contentType, /^application\/json/);
  return JSON.parse(res.text);
}

describe('ndjson-json', () => {
  test('one value per line becomes an array', async () => {
    assert.deepEqual(await values('{"a":1}\n{"a":2}\n'), [{ a: 1 }, { a: 2 }]);
  });

  test('no trailing newline still yields the last record', async () => {
    assert.deepEqual(await values('{"a":1}\n{"a":2}'), [{ a: 1 }, { a: 2 }]);
  });

  test('blank lines are skipped', async () => {
    assert.deepEqual(await values('{"a":1}\n\n\n{"a":2}\n\n'), [{ a: 1 }, { a: 2 }]);
  });

  test('CRLF line endings parse identically to LF', async () => {
    assert.deepEqual(await values('{"a":1}\r\n{"a":2}\r\n'), await values('{"a":1}\n{"a":2}\n'));
  });

  test('scalars are records too', async () => {
    assert.deepEqual(await values('1\n"two"\nnull\ntrue\n'), [1, 'two', null, true]);
  });

  test('a record holding a newline in a string is one line and stays one record', async () => {
    assert.deepEqual(await values('{"a":"one\\ntwo"}\n'), [{ a: 'one\ntwo' }]);
  });

  test('the output is pretty-printed, so a human can read the result', async () => {
    const res = await raw('{"a":1}\n');
    assert.equal(res.status, 200);
    assert.ok(res.text.includes('\n  '), `not pretty-printed: ${JSON.stringify(res.text)}`);
  });

  test('a stream of one is an array of one, not the bare value', async () => {
    assert.deepEqual(await values('{"a":1}\n'), [{ a: 1 }]);
  });

  test('1,000 lines convert well inside 5 s', async () => {
    const body = Array.from({ length: 1000 }, (_, i) => JSON.stringify({ id: i })).join('\n');
    const started = Date.now();
    const out = await values(body);
    const elapsed = Date.now() - started;
    assert.equal(out.length, 1000);
    assert.deepEqual(out.at(-1), { id: 999 });
    assert.ok(elapsed < 5000, `1,000 lines took ${elapsed} ms`);
  });
});

describe('ndjson-json refusals', () => {
  test('a bad line is a 400 naming the 1-based line number', async () => {
    const res = await raw('{"a":1}\nnope\n');
    assert.equal(res.status, 400, res.text);
    assert.match(res.json().error, /line 2\b/, res.text);
    assert.match(res.json().error, /not valid JSON/, res.text);
  });

  test('the line number counts blank lines too', async () => {
    const res = await raw('{"a":1}\n\n\nnope\n');
    assert.equal(res.status, 400, res.text);
    assert.match(res.json().error, /line 4\b/, res.text);
  });

  test('a trailing partial record is an error, not a truncation', async () => {
    const res = await raw('{"a":1}\n{"a":2');
    assert.equal(res.status, 400, res.text);
    assert.match(res.json().error, /line 2\b/, res.text);
  });

  test('a whole JSON array on one line is a RECORD, not the whole document', async () => {
    // It parses as one value, so it is not refused. Recorded as implemented,
    // because the surprise (an array nested inside the array) is worth pinning:
    // a caller that meant json-ndjson's input has posted to the wrong endpoint.
    assert.deepEqual(await values('[1,2]\n'), [[1, 2]]);
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
    for (const input of ['nope\n', '{"a":1}\n{\n', '{"a":1}\n{"a":2']) {
      const res = await raw(input);
      assert.equal(res.status, 400);
      assert.match(res.contentType, /application\/json/);
      const { error } = res.json();
      assert.ok(!error.includes('\n'), `not one line: ${error}`);
      assert.ok(!/\bat\s+\w+\s+\(/.test(error), `a stack trace leaked: ${error}`);
    }
  });
});
