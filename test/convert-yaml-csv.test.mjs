// POST /convert/yaml-csv — a YAML list of maps to CSV.
//
// The direction where the shapes disagree: YAML can hold anything, CSV holds a
// table. So the assertions here are mostly about what is REFUSED — a mapping at
// the top level, a list of scalars, a stream's second document — because a
// plausible-looking sheet built from the wrong shape is the failure this
// endpoint exists to prevent.
//
// PHASE: the env-gated free tier, so conversions are actually served.

import test, { before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { useWorker, client, callers, TIER_ON_VARS } from './harness.mjs';

let worker;
let api;
const ips = callers('yaml-csv');

before(async () => {
  worker = await useWorker({ vars: TIER_ON_VARS });
  api = client(worker);
});
after(async () => {
  await worker.stop();
});

const raw = (input) => api.convert('yaml-csv', input, { ip: ips.next() });

async function csv(input) {
  const res = await raw(input);
  assert.equal(res.status, 200, `yaml-csv refused ${res.status}: ${res.text}`);
  assert.match(res.contentType, /^text\/csv/);
  return res.text;
}

describe('yaml-csv', () => {
  test('a list of maps becomes a header row plus one line per record', async () => {
    assert.equal(await csv('- name: lemon\n  qty: 3\n- name: lime\n  qty: 4\n'), 'name,qty\nlemon,3\nlime,4\n');
  });

  test('the header is the union of every key, in first-seen order', async () => {
    assert.equal(await csv('- a: 1\n- a: 2\n  b: 3\n'), 'a,b\n1,\n2,3\n');
  });

  test('one level of nesting becomes dotted columns', async () => {
    assert.equal(await csv('- user:\n    id: 1\n    name: lemon\n'), 'user.id,user.name\n1,lemon\n');
  });

  test('a sequence value is written back as compact JSON in the cell', async () => {
    assert.equal(await csv('- tags:\n    - a\n    - b\n'), 'tags\n"[""a"",""b""]"\n');
  });

  test('anchors are resolved rather than emitted as references', async () => {
    const out = await csv('- &base\n  a: 1\n- <<: *base\n  b: 2\n');
    assert.equal(out, 'a,b\n1,\n1,2\n');
  });

  test('flow style is the same document as block style', async () => {
    assert.equal(await csv('[{a: 1, b: 2}]'), await csv('- a: 1\n  b: 2\n'));
  });

  test('a stream converts as its FIRST document', async () => {
    // The same rule yaml-json states. Recorded here because the second document
    // vanishing without a word is exactly the kind of thing a caller has to know.
    assert.equal(await csv('- a: 1\n---\n- a: 999\n'), 'a\n1\n');
  });

  test('values that YAML types are stringified into the cell', async () => {
    assert.equal(await csv('- n: 1\n  b: true\n  s: "007"\n'), 'n,b,s\n1,true,007\n');
  });

  test('a comma in a value is quoted on the way out', async () => {
    assert.equal(await csv('- a: "one, two"\n'), 'a\n"one, two"\n');
  });
});

describe('yaml-csv refusals', () => {
  test('invalid YAML is a 400 naming the parse failure', async () => {
    const res = await raw('a:\n  - b\n c: broken indent\n');
    assert.equal(res.status, 400, res.text);
    assert.match(res.json().error, /not valid YAML/);
  });

  test('a mapping at the top level is a 400 — that is not a table', async () => {
    const res = await raw('a: 1\n');
    assert.equal(res.status, 400, res.text);
    assert.match(res.json().error, /first YAML document must be an array of objects/, res.text);
    assert.match(res.json().error, /an object/, res.text);
  });

  test('a list of scalars is a 400 naming the offending index', async () => {
    const res = await raw('- 1\n- 2\n');
    assert.equal(res.status, 400, res.text);
    assert.match(res.json().error, /element 0 .* is a number, not an object/, res.text);
  });

  test('an empty list is a 400 — there is no header row to write', async () => {
    const res = await raw('[]\n');
    assert.equal(res.status, 400, res.text);
    assert.match(res.json().error, /empty array/);
  });

  test('an empty body is a 400', async () => {
    const res = await raw('');
    assert.equal(res.status, 400);
    assert.equal(res.json().error, 'the request body is empty');
  });

  test('every refusal is a one-line JSON error with no stack trace', async () => {
    for (const input of ['a: 1\n', '- 1\n', '[]\n', 'a:\n  - b\n c: x\n']) {
      const res = await raw(input);
      assert.equal(res.status, 400);
      assert.match(res.contentType, /application\/json/);
      const { error } = res.json();
      assert.ok(!error.includes('\n'), `not one line: ${error}`);
      assert.ok(!/\bat\s+\w+\s+\(/.test(error), `a stack trace leaked: ${error}`);
    }
  });
});
