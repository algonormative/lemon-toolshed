// POST /convert/md-html — Markdown to HTML.
//
// Assertions are STRUCTURAL, not byte-exact. `marked` is a dependency with its
// own release cadence; pinning golden files would turn every upstream
// whitespace change into a red build without telling anyone anything about the
// product. What this suite pins is the contract a caller depends on: the
// construct they wrote came out as the element it means, entities are escaped,
// and nothing they wrote leaked through as raw markdown syntax.

import test, { before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { useWorker, client, callers } from './harness.mjs';

let worker;
let api;
const ips = callers('md-html');

before(async () => {
  worker = await useWorker();
  api = client(worker);
});
after(async () => {
  await worker.stop();
});

/** One conversion from a caller that has never called, so quota is never in play. */
async function md(input) {
  const res = await api.convert('md-html', input, { ip: ips.next() });
  return res;
}

async function html(input) {
  const res = await md(input);
  assert.equal(res.status, 200, `expected 200, got ${res.status}: ${res.text}`);
  assert.match(res.contentType, /^text\/html/);
  return res.text;
}

// The markers that must NOT survive into the output: if a `##` or a backtick
// fence is still sitting there as text, the construct did not convert.
const noRawMarkdown = (out, markers) => {
  for (const marker of markers) {
    assert.ok(!out.includes(marker), `output still contains raw markdown ${JSON.stringify(marker)}: ${out}`);
  }
};

describe('md-html structure', () => {
  test('headings h1 through h4', async () => {
    const out = await html('# one\n\n## two\n\n### three\n\n#### four\n');
    for (const level of [1, 2, 3, 4]) {
      assert.match(out, new RegExp(`<h${level}[^>]*>`), `no <h${level}> in ${out}`);
      assert.ok(out.includes(`</h${level}>`), `no closing </h${level}> in ${out}`);
    }
    noRawMarkdown(out, ['# one', '## two', '### three', '#### four']);
  });

  test('ordered list nested inside an unordered list', async () => {
    const out = await html('- alpha\n  1. first\n  2. second\n- beta\n');
    assert.ok(out.includes('<ul>'), `no <ul> in ${out}`);
    assert.ok(out.includes('<ol>'), `no <ol> in ${out}`);
    // The <ol> has to be INSIDE the <ul>, otherwise the nesting was flattened.
    assert.ok(out.indexOf('<ul>') < out.indexOf('<ol>'), `<ol> is not nested inside <ul>: ${out}`);
    assert.ok(out.indexOf('</ol>') < out.indexOf('</ul>'), `<ol> closes after <ul>: ${out}`);
    assert.equal((out.match(/<li>/g) || []).length, 4, `expected 4 list items: ${out}`);
    noRawMarkdown(out, ['- alpha', '1. first']);
  });

  test('fenced code carries its language, and inline code is a bare <code>', async () => {
    const out = await html('```js\nconst a = 1;\n```\n\nand `inline` too\n');
    assert.match(out, /<pre><code[^>]*>/, `no <pre><code> in ${out}`);
    assert.match(out, /class="language-js"/, `fenced language not carried onto the code element: ${out}`);
    assert.ok(out.includes('const a = 1;'), 'code content missing');
    assert.match(out, /<p>[^<]*<code>inline<\/code>/, `inline code did not become <code>: ${out}`);
    noRawMarkdown(out, ['```', '`inline`']);
  });

  test('code inside a fence is not interpreted as markdown', async () => {
    const out = await html('```\n# not a heading\n**not bold**\n```\n');
    assert.ok(!out.includes('<h1'), `fenced content was parsed as a heading: ${out}`);
    assert.ok(!out.includes('<strong>'), `fenced content was parsed as emphasis: ${out}`);
    assert.ok(out.includes('# not a heading'), 'fenced content lost');
  });

  test('GFM table becomes a real table with a head and a body', async () => {
    const out = await html('| name | qty |\n| --- | ---: |\n| lemon | 3 |\n| lime | 4 |\n');
    assert.ok(out.includes('<table>'), `no <table> in ${out}`);
    assert.ok(out.includes('<thead>'), `no <thead> in ${out}`);
    assert.ok(out.includes('<tbody>'), `no <tbody> in ${out}`);
    assert.match(out, /<th[^>]*>name<\/th>/);
    assert.match(out, /<td[^>]*>lemon<\/td>/);
    assert.equal((out.match(/<tr>/g) || []).length, 3, `expected 3 rows: ${out}`);
    noRawMarkdown(out, ['| name | qty |', '| --- |']);
  });

  test('blockquote wraps its paragraph', async () => {
    const out = await html('> quoted line\n>\n> second paragraph\n');
    assert.ok(out.includes('<blockquote>'), `no <blockquote> in ${out}`);
    assert.match(out, /<blockquote>\s*<p>/, `blockquote content is not a paragraph: ${out}`);
    noRawMarkdown(out, ['> quoted']);
  });

  test('inline links and autolinks both become anchors', async () => {
    const out = await html('[label](https://example.com/a) and <https://auto.example/b>\n');
    assert.match(out, /<a href="https:\/\/example\.com\/a"[^>]*>label<\/a>/, `inline link missing: ${out}`);
    assert.match(out, /<a href="https:\/\/auto\.example\/b"[^>]*>https:\/\/auto\.example\/b<\/a>/, `autolink missing: ${out}`);
    noRawMarkdown(out, ['[label](', '<https://auto.example/b>']);
  });

  test('emphasis combinations nest correctly', async () => {
    const out = await html('***both*** and **bold** and *italic* and _under_\n');
    assert.ok(out.includes('<strong>'), `no <strong> in ${out}`);
    assert.ok(out.includes('<em>'), `no <em> in ${out}`);
    assert.match(out, /<em><strong>both<\/strong><\/em>|<strong><em>both<\/em><\/strong>/, `*** did not nest: ${out}`);
    assert.match(out, /<strong>bold<\/strong>/);
    assert.match(out, /<em>italic<\/em>/);
    assert.match(out, /<em>under<\/em>/);
    noRawMarkdown(out, ['**bold**', '*italic*']);
  });

  test('horizontal rule', async () => {
    const out = await html('above\n\n---\n\nbelow\n');
    assert.match(out, /<hr\s*\/?>/, `no <hr> in ${out}`);
    // `---` under text is setext h2, not a rule — the blank line above is what
    // makes this a rule, and that distinction is worth keeping asserted.
    assert.ok(!out.includes('\n---'), `raw rule survived: ${out}`);
  });

  test('HTML entities in the source are escaped in the output', async () => {
    const out = await html('A & B < C > D and "quoted"\n');
    assert.ok(out.includes('&amp;'), `& was not escaped: ${out}`);
    assert.ok(out.includes('&lt;'), `< was not escaped: ${out}`);
    assert.ok(out.includes('&gt;'), `> was not escaped: ${out}`);
    // A bare, unescaped ampersand would be the failure this guards.
    assert.ok(!/&(?![a-z]+;|#\d+;)/i.test(out), `an unescaped & survived: ${out}`);
  });

  test('already-escaped entities are not double-escaped', async () => {
    const out = await html('caf&eacute; and &amp; alone\n');
    assert.ok(!out.includes('&amp;eacute;'), `entity was double-escaped: ${out}`);
  });

  test('unicode survives — emoji and CJK', async () => {
    const out = await html('emoji 🍋🛠 and CJK 日本語のテキスト and RTL مرحبا\n');
    for (const s of ['🍋', '🛠', '日本語のテキスト', 'مرحبا']) {
      assert.ok(out.includes(s), `${s} did not survive: ${out}`);
    }
  });

  test('a single character converts to a paragraph', async () => {
    const out = await html('a');
    assert.match(out, /<p>a<\/p>/, out);
  });

  test('an empty body is refused with 400, not converted to nothing', async () => {
    // The Worker rejects an empty body before any converter runs, so this is the
    // documented answer for the empty string on EVERY tool, not a marked quirk.
    const res = await md('');
    assert.equal(res.status, 400);
    assert.match(res.contentType, /application\/json/);
    assert.equal(res.json().error, 'the request body is empty');
  });

  test('a whitespace-only body is refused with 400', async () => {
    const res = await md('   \n\t\n  ');
    assert.equal(res.status, 400);
    assert.equal(res.json().error, 'the request body is empty');
  });

  test('raw HTML in the source passes through — markdown is a superset of HTML', async () => {
    // Documenting the contract rather than protecting anything: a markdown
    // converter that stripped embedded HTML would be the broken one. The
    // response carries no CORS header, so a browser on another origin cannot
    // read it; see protocol.test.mjs.
    const out = await html('before\n\n<div class="x">raw</div>\n\nafter\n');
    assert.ok(out.includes('<div class="x">raw</div>'), `embedded HTML was mangled: ${out}`);
  });

  test('a long document converts in one call', async () => {
    const doc = Array.from({ length: 500 }, (_, i) => `## section ${i}\n\ntext ${i} with **bold**.\n`).join('\n');
    const started = Date.now();
    const out = await html(doc);
    assert.equal((out.match(/<h2[^>]*>/g) || []).length, 500);
    assert.ok(Date.now() - started < 5000, 'a 500-section document took over 5 s');
  });
});
