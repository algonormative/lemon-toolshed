// POST /convert/yaml-json — the YAML side, tested directly.
//
// The round-trip battery in convert-json-yaml.test.mjs covers what json-yaml
// can produce. This file covers what a HUMAN can write and json-yaml never
// emits: block scalars, anchors and aliases, comments, tabs, multiple
// documents. Each case records what the implementation actually does, because
// several of these have two defensible answers and the caller needs to know
// which one they get.

// The free tier is OFF by default now, so a conversion is a paid call and an
// unauthenticated POST answers 402. This suite is about the CONVERTER, not about
// payment, so it boots the env-gated free tier and gets served 200s the cheap way.

import test, { before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { useWorker, client, callers, TIER_ON_VARS } from './harness.mjs';

let worker;
let api;
const ips = callers('yaml-json');

before(async () => {
  worker = await useWorker({ vars: TIER_ON_VARS });
  api = client(worker);
});
after(async () => {
  await worker.stop();
});

async function toJson(yamlText) {
  const res = await api.convert('yaml-json', yamlText, { ip: ips.next() });
  return res;
}

async function parsed(yamlText) {
  const res = await toJson(yamlText);
  assert.equal(res.status, 200, `yaml-json refused ${res.status}: ${res.text}`);
  assert.match(res.contentType, /^application\/json/);
  return JSON.parse(res.text);
}

describe('yaml-json — constructs json-yaml never emits', () => {
  test('literal block scalar (|) keeps its newlines', async () => {
    const value = await parsed('text: |\n  line one\n  line two\n');
    assert.deepEqual(value, { text: 'line one\nline two\n' });
  });

  test('literal block scalar keep/strip indicators (|+ and |-)', async () => {
    assert.deepEqual(await parsed('a: |-\n  no trailing newline\n'), { a: 'no trailing newline' });
    assert.deepEqual(await parsed('a: |+\n  kept\n\n'), { a: 'kept\n\n' });
  });

  test('folded block scalar (>) joins lines with spaces', async () => {
    const value = await parsed('text: >\n  folded across\n  two lines\n');
    assert.deepEqual(value, { text: 'folded across two lines\n' });
  });

  test('anchors and aliases are EXPANDED, not preserved as references', async () => {
    // The implementation choice, recorded: js-yaml resolves the alias while
    // loading, so JSON comes back with the value duplicated. It is not a 400,
    // and there is no `*alias` marker anywhere in the output.
    const value = await parsed('defaults: &d\n  retries: 3\n  mode: fast\nprod: *d\ndev: *d\n');
    assert.deepEqual(value, {
      defaults: { retries: 3, mode: 'fast' },
      prod: { retries: 3, mode: 'fast' },
      dev: { retries: 3, mode: 'fast' },
    });
  });

  test('a merge key (<<) folds the anchored map in', async () => {
    const value = await parsed('base: &b\n  a: 1\n  b: 2\nchild:\n  <<: *b\n  b: 99\n');
    assert.deepEqual(value, { base: { a: 1, b: 2 }, child: { a: 1, b: 99 } });
  });

  test('an alias with no anchor is a clean 400, not a crash', async () => {
    const res = await toJson('a: *missing\n');
    assert.equal(res.status, 400, res.text);
    assert.match(res.json().error, /not valid YAML/);
  });

  test('comments are stripped', async () => {
    const value = await parsed('# leading comment\na: 1 # trailing comment\n# another\nb: two\n');
    assert.deepEqual(value, { a: 1, b: 'two' });
  });

  test('a comment-only document converts to `null`, not to an error', async () => {
    // Recorded, because the other answer was plausible: js-yaml reads a
    // document with no content as an EMPTY document, whose value is null — so
    // the Worker's `input has no YAML document` guard does not fire. That guard
    // only catches loadAll() returning nothing at all, which needs an empty
    // input, which the Worker has already refused as an empty body. It is a
    // defensive branch, not a reachable one.
    for (const src of ['# just a comment\n', '---\n', '\n# c\n']) {
      const res = await toJson(src);
      assert.equal(res.status, 200, `${JSON.stringify(src)} -> ${res.status}: ${res.text}`);
      assert.equal(res.text.trim(), 'null', `${JSON.stringify(src)} -> ${res.text}`);
    }
  });

  test('tabs used for indentation are a clean 400', async () => {
    // Recorded answer: 400. YAML forbids tabs in indentation, js-yaml says so,
    // and the Worker passes that through as a one-line message.
    const res = await toJson('a:\n\t- 1\n');
    assert.equal(res.status, 400, res.text);
    assert.match(res.json().error, /tab characters must not be used in indentation/);
  });

  test('a tab INSIDE a scalar is fine — only indentation is forbidden', async () => {
    assert.deepEqual(await parsed('a: "one\\ttwo"\n'), { a: 'one\ttwo' });
  });

  test('a multi-document stream converts its FIRST document', async () => {
    // Documented caveat on the entry: a stream converts as its first document.
    const value = await parsed('a: 1\n---\nb: 2\n---\nc: 3\n');
    assert.deepEqual(value, { a: 1 });
  });

  test('flow style parses the same as block style', async () => {
    assert.deepEqual(await parsed('{a: 1, b: [1, 2, {c: 3}]}\n'), { a: 1, b: [1, 2, { c: 3 }] });
  });

  test('YAML 1.2 core schema — yes/no/on/off are strings, not booleans', async () => {
    // js-yaml 4 dropped the YAML 1.1 boolean aliases. Worth pinning: a caller
    // whose config says `enabled: yes` gets the STRING "yes" back.
    const value = await parsed('a: yes\nb: no\nc: on\nd: off\ne: true\nf: false\n');
    assert.deepEqual(value, { a: 'yes', b: 'no', c: 'on', d: 'off', e: true, f: false });
  });

  test('null spellings', async () => {
    assert.deepEqual(await parsed('a: null\nb: ~\nc:\n'), { a: null, b: null, c: null });
  });

  test('unicode keys and values survive', async () => {
    assert.deepEqual(await parsed('🍋: lemon\n日本語: テキスト\n'), { '🍋': 'lemon', 日本語: 'テキスト' });
  });

  test('a bare scalar document converts to a bare JSON scalar', async () => {
    assert.equal((await toJson('just a string\n')).text.trim(), '"just a string"');
    assert.equal((await toJson('42\n')).text.trim(), '42');
  });

  test('a document whose only content is `null` is not treated as absent', async () => {
    // `docs[0] === undefined` is the emptiness test, so an explicit null has to
    // survive it. A `null` mistaken for "no document" would be a 400 here.
    const res = await toJson('null\n');
    assert.equal(res.status, 200, res.text);
    assert.equal(res.text.trim(), 'null');
  });

  test('a `__proto__` key survives into the JSON text', async () => {
    // Asserted on the text, not on a deepEqual: `{ __proto__: x }` in a JS
    // object literal is the prototype-setter syntax and would build the wrong
    // expectation. csv-json had a real bug of exactly this shape — see
    // convert-csv-json.test.mjs.
    const res = await toJson('__proto__: kept\nok: 1\n');
    assert.equal(res.status, 200, res.text);
    assert.ok(res.text.includes('"__proto__": "kept"'), `__proto__ column lost: ${res.text}`);
    assert.ok(res.text.includes('"ok": 1'), res.text);
  });
});

describe('yaml-json refusals', () => {
  const bad = {
    'unterminated flow collection': '{not: [valid',
    'bad indentation': 'a:\n  b: 1\n   c: 2\n',
    'duplicate mapping key': 'a: 1\na: 2\n',
    'unclosed quote': "a: 'unterminated\n",
    'tab indentation': 'a:\n\tb: 1\n',
  };

  for (const [name, input] of Object.entries(bad)) {
    test(`${name} is a 400 with a one-line JSON error`, async () => {
      const res = await toJson(input);
      assert.equal(res.status, 400, `expected 400, got ${res.status}: ${res.text}`);
      assert.match(res.contentType, /application\/json/);
      const body = res.json();
      assert.equal(typeof body.error, 'string');
      assert.ok(body.error.length > 0);
      assert.ok(!body.error.includes('\n'), `the error message is not one line: ${body.error}`);
      assert.ok(!/\bat\s+\w+\s+\(/.test(body.error), `a stack trace leaked: ${body.error}`);
    });
  }

  test('an empty body is a 400 before the converter runs', async () => {
    const res = await toJson('');
    assert.equal(res.status, 400);
    assert.equal(res.json().error, 'the request body is empty');
  });
});
