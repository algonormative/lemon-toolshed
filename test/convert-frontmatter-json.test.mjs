// POST /convert/frontmatter-json — split the --- fence off a Markdown file.
//
// Three lines of code that everyone writes slightly wrong, so the assertions are
// about the three ways it goes wrong: a `---` in the BODY is a horizontal rule
// and not a delimiter; a fence that is not the first thing in the file is not a
// fence; and an EMPTY fence has to report `data: null` rather than vanish out of
// the JSON object entirely.
//
// PHASE: the env-gated free tier, so conversions are actually served.

import test, { before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { useWorker, client, callers, TIER_ON_VARS } from './harness.mjs';

let worker;
let api;
const ips = callers('frontmatter-json');

before(async () => {
  worker = await useWorker({ vars: TIER_ON_VARS });
  api = client(worker);
});
after(async () => {
  await worker.stop();
});

const raw = (input) => api.convert('frontmatter-json', input, { ip: ips.next() });

async function split(input) {
  const res = await raw(input);
  assert.equal(res.status, 200, `frontmatter-json refused ${res.status}: ${res.text}`);
  assert.match(res.contentType, /^application\/json/);
  return JSON.parse(res.text);
}

describe('frontmatter-json', () => {
  test('metadata and body come back split apart', async () => {
    assert.deepEqual(await split('---\ntitle: Toolshed\ndraft: true\n---\nBody text.\n'), {
      data: { title: 'Toolshed', draft: true },
      content: 'Body text.\n',
    });
  });

  test('the body is returned byte for byte, unrendered', async () => {
    const { content } = await split('---\na: 1\n---\n# Heading\n\n- item\n\n  indented\n');
    assert.equal(content, '# Heading\n\n- item\n\n  indented\n');
  });

  test('a --- inside the body is a horizontal rule, not a second fence', async () => {
    const { data, content } = await split('---\na: 1\n---\nbefore\n\n---\n\nafter\n');
    assert.deepEqual(data, { a: 1 });
    assert.ok(content.includes('---'), `the body lost its horizontal rule: ${JSON.stringify(content)}`);
    assert.ok(content.includes('after'), `the body was truncated at the rule: ${JSON.stringify(content)}`);
  });

  test('an empty fence reports data: null rather than dropping the key', async () => {
    // JSON.stringify DROPS an undefined value, so a caller would have got a
    // reply with no `data` key at all — indistinguishable from a broken server.
    const out = await split('---\n---\nbody\n');
    assert.deepEqual(out, { data: null, content: 'body\n' });
    assert.ok('data' in out, 'the data key was dropped from the reply');
  });

  test('... also closes a fence, as YAML says it does', async () => {
    assert.deepEqual(await split('---\na: 1\n...\nbody\n'), { data: { a: 1 }, content: 'body\n' });
  });

  test('a file with only frontmatter has an empty body', async () => {
    assert.deepEqual(await split('---\na: 1\n---\n'), { data: { a: 1 }, content: '' });
  });

  test('CRLF input is handled and the body comes back with LF endings', async () => {
    assert.deepEqual(await split('---\r\na: 1\r\n---\r\nbody\r\n'), { data: { a: 1 }, content: 'body\n' });
  });

  test('nested and list metadata survives', async () => {
    const { data } = await split('---\ntags:\n  - a\n  - b\nauthor:\n  name: lemon\n---\nx\n');
    assert.deepEqual(data, { tags: ['a', 'b'], author: { name: 'lemon' } });
  });

  test('unicode in metadata and body', async () => {
    assert.deepEqual(await split('---\n名前: 日本語\n---\n🍋\n'), { data: { 名前: '日本語' }, content: '🍋\n' });
  });
});

describe('frontmatter-json refusals', () => {
  test('a file with no opening fence is a 400, not an empty data object', async () => {
    // Reporting "no metadata" for a file whose fence you mistyped is the bug
    // this refusal exists to make impossible.
    const res = await raw('# Just a heading\n\nBody.\n');
    assert.equal(res.status, 400, res.text);
    assert.match(res.json().error, /no YAML frontmatter/, res.text);
  });

  test('a fence that is not the FIRST thing in the file is not a fence', async () => {
    const res = await raw('\n---\na: 1\n---\nbody\n');
    assert.equal(res.status, 400, res.text);
    assert.match(res.json().error, /no YAML frontmatter/, res.text);
  });

  test('an unclosed fence is a 400 that says so', async () => {
    const res = await raw('---\ntitle: x\nbody with no closing fence\n');
    assert.equal(res.status, 400, res.text);
    assert.match(res.json().error, /never closed/, res.text);
  });

  test('invalid YAML in the fence is a 400 naming the parse failure', async () => {
    const res = await raw('---\na:\n  - b\n c: broken\n---\nbody\n');
    assert.equal(res.status, 400, res.text);
    assert.match(res.json().error, /frontmatter is not valid YAML/, res.text);
  });

  test('an empty body is a 400', async () => {
    const res = await raw('');
    assert.equal(res.status, 400);
    assert.equal(res.json().error, 'the request body is empty');
  });

  test('every refusal is a one-line JSON error with no stack trace', async () => {
    for (const input of ['no fence\n', '---\nunclosed\n', '---\na:\n  - b\n c: x\n---\n']) {
      const res = await raw(input);
      assert.equal(res.status, 400);
      assert.match(res.contentType, /application\/json/);
      const { error } = res.json();
      assert.ok(!error.includes('\n'), `not one line: ${error}`);
      assert.ok(!/\bat\s+\w+\s+\(/.test(error), `a stack trace leaked: ${error}`);
    }
  });
});
