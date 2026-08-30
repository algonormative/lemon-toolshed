// POST /convert/markdown-json — the lexer's token stream plus a derived toc.
//
// Two claims are under test and they are separable. The TOKENS are marked's data
// structure and the suite only pins their outline — type, depth, order — because
// pinning a library's internals here would make an upstream bump look like a
// product regression. The TOC is ours, and it is pinned exactly: it is built from
// real headings, it finds nested ones, and it does not invent structure that was
// only ever formatting.
//
// PHASE: the env-gated free tier, so conversions are actually served.

import test, { before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { useWorker, client, callers, TIER_ON_VARS } from './harness.mjs';

let worker;
let api;
const ips = callers('markdown-json');

before(async () => {
  worker = await useWorker({ vars: TIER_ON_VARS });
  api = client(worker);
});
after(async () => {
  await worker.stop();
});

const raw = (input) => api.convert('markdown-json', input, { ip: ips.next() });

async function tree(input) {
  const res = await raw(input);
  assert.equal(res.status, 200, `markdown-json refused ${res.status}: ${res.text}`);
  assert.match(res.contentType, /^application\/json/);
  return JSON.parse(res.text);
}

describe('markdown-json', () => {
  test('the reply is {toc, tokens} and nothing else', async () => {
    const out = await tree('# Title\n\nText.\n');
    assert.deepEqual(Object.keys(out).sort(), ['toc', 'tokens']);
    assert.ok(Array.isArray(out.toc));
    assert.ok(Array.isArray(out.tokens));
  });

  test('the toc is depth and text, in document order', async () => {
    const { toc } = await tree('# One\n\n## Two\n\n### Three\n\n## Four\n');
    assert.deepEqual(toc, [
      { depth: 1, text: 'One' },
      { depth: 2, text: 'Two' },
      { depth: 3, text: 'Three' },
      { depth: 2, text: 'Four' },
    ]);
  });

  test('setext headings are headings too', async () => {
    const { toc } = await tree('Title\n=====\n\nSub\n---\n');
    assert.deepEqual(toc, [
      { depth: 1, text: 'Title' },
      { depth: 2, text: 'Sub' },
    ]);
  });

  test('a heading nested in a blockquote is found', async () => {
    const { toc } = await tree('# Top\n\n> ## Quoted\n');
    assert.deepEqual(toc, [
      { depth: 1, text: 'Top' },
      { depth: 2, text: 'Quoted' },
    ]);
  });

  test('a bold line pretending to be a heading is NOT in the toc', async () => {
    // It was never structure. Inferring that it was is the judgment call the
    // entry's escalate line points at a model for.
    const { toc } = await tree('**Not A Heading**\n\ntext\n');
    assert.deepEqual(toc, []);
  });

  test('a # inside a fenced code block is not a heading', async () => {
    const { toc } = await tree('# Real\n\n```sh\n# a shell comment\n```\n');
    assert.deepEqual(toc, [{ depth: 1, text: 'Real' }]);
  });

  test('the token stream carries the block types in order', async () => {
    const { tokens } = await tree('# T\n\npara\n\n- a\n- b\n\n```js\nx\n```\n');
    const types = tokens.map((t) => t.type).filter((t) => t !== 'space');
    assert.deepEqual(types, ['heading', 'paragraph', 'list', 'code']);
  });

  test('a table is a token, not flattened into a paragraph', async () => {
    const { tokens } = await tree('| a | b |\n| - | - |\n| 1 | 2 |\n');
    assert.ok(
      tokens.some((t) => t.type === 'table'),
      `no table token: ${JSON.stringify(tokens.map((t) => t.type))}`
    );
  });

  test('a document with no headings has an empty toc, not an error', async () => {
    const { toc, tokens } = await tree('just a paragraph\n');
    assert.deepEqual(toc, []);
    assert.ok(tokens.length > 0);
  });

  test('the output is pretty-printed', async () => {
    const res = await raw('# T\n');
    assert.ok(res.text.includes('\n  '), 'not pretty-printed');
  });

  test('unicode headings survive into the toc', async () => {
    const { toc } = await tree('# 日本語 🍋\n');
    assert.deepEqual(toc, [{ depth: 1, text: '日本語 🍋' }]);
  });
});

describe('markdown-json refusals', () => {
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

  test('there is otherwise nothing to refuse — any text is valid Markdown', async () => {
    // Recorded deliberately: this converter has no malformed input, so the only
    // 400s are the shared ones above. A future contributor looking for the
    // missing refusals block should read this instead of adding one.
    const res = await raw('<<< not markup, still Markdown >>>\n');
    assert.equal(res.status, 200, res.text);
  });

  test('the empty-body refusal is a one-line JSON error with no stack trace', async () => {
    const res = await raw('   ');
    assert.equal(res.status, 400);
    assert.match(res.contentType, /application\/json/);
    const { error } = res.json();
    assert.ok(!error.includes('\n'), `not one line: ${error}`);
    assert.ok(!/\bat\s+\w+\s+\(/.test(error), `a stack trace leaked: ${error}`);
  });
});
