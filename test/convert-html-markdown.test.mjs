// POST /convert/html-markdown — HTML to Markdown.
//
// This is the converter with the load-bearing implementation note in the
// README: Turndown's browser build reaches for a global `document` that workerd
// does not have, so the Worker parses with domino and hands Turndown the
// resulting element. A regression there throws at RUNTIME, not at build time —
// which means every test in this file is also a check that the domino wiring is
// still in place.
//
// Two behaviours are pinned with their reasons, because both had a defensible
// alternative:
//
//   <table>  -> DEGRADES to plain text. Turndown ships no GFM table rule and
//               none is configured, so a table's cells come back as text.
//   <script> -> REMOVED entirely, content and all. Not merely inert: absent.

import test, { before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { useWorker, client, callers } from './harness.mjs';

let worker;
let api;
const ips = callers('html-markdown');

before(async () => {
  worker = await useWorker();
  api = client(worker);
});
after(async () => {
  await worker.stop();
});

const raw = (input) => api.convert('html-markdown', input, { ip: ips.next() });

async function markdown(input) {
  const res = await raw(input);
  assert.equal(res.status, 200, `html-markdown refused ${res.status}: ${res.text}`);
  assert.match(res.contentType, /^text\/markdown/);
  return res.text;
}

describe('html-markdown structure', () => {
  test('headings become ATX headings', async () => {
    const out = await markdown('<h1>one</h1><h2>two</h2><h3>three</h3>');
    assert.match(out, /^# one$/m, out);
    assert.match(out, /^## two$/m, out);
    assert.match(out, /^### three$/m, out);
  });

  test('nested lists keep their nesting and their marker types', async () => {
    const out = await markdown('<ul><li>alpha<ol><li>first</li><li>second</li></ol></li><li>beta</li></ul>');
    assert.match(out, /^-\s+alpha/m, out);
    assert.match(out, /^-\s+beta/m, out);
    // The ordered items must be indented under the unordered one.
    assert.match(out, /^\s+1\.\s+first/m, `ordered item not nested: ${JSON.stringify(out)}`);
    assert.match(out, /^\s+2\.\s+second/m, `ordered item not nested: ${JSON.stringify(out)}`);
    assert.ok(!out.includes('<li>'), `list markup survived: ${out}`);
  });

  test('a link with a title carries the title', async () => {
    const out = await markdown('<a href="https://example.com/a" title="The Title">label</a>');
    assert.equal(out.trim(), '[label](https://example.com/a "The Title")');
  });

  test('a link without a title has no empty title slot', async () => {
    const out = await markdown('<a href="https://example.com/a">label</a>');
    assert.equal(out.trim(), '[label](https://example.com/a)');
  });

  test('images become image syntax with their alt text', async () => {
    const out = await markdown('<p><img src="/pics/lemon.png" alt="a lemon"></p>');
    assert.equal(out.trim(), '![a lemon](/pics/lemon.png)');
  });

  test('an image with no alt still converts', async () => {
    const out = await markdown('<p><img src="/pics/lemon.png"></p>');
    assert.match(out, /!\[\]\(\/pics\/lemon\.png\)/, out);
  });

  test('<pre><code> becomes a fenced block, and the language class rides along', async () => {
    const out = await markdown('<pre><code class="language-js">const a = 1;\nconst b = 2;</code></pre>');
    assert.match(out, /^```js$/m, `fence did not carry the language: ${JSON.stringify(out)}`);
    assert.ok(out.includes('const a = 1;'), out);
    assert.ok(out.includes('const b = 2;'), out);
    assert.equal((out.match(/```/g) || []).length, 2, `unbalanced fences: ${out}`);
  });

  test('inline <code> becomes backticks, not a fence', async () => {
    const out = await markdown('<p>call <code>fetch()</code> now</p>');
    assert.equal(out.trim(), 'call `fetch()` now');
  });

  test('a table DEGRADES to text — no GFM table rule is configured', async () => {
    const out = await markdown(
      '<table><thead><tr><th>name</th><th>qty</th></tr></thead>' +
        '<tbody><tr><td>lemon</td><td>3</td></tr></tbody></table>'
    );
    // The cell content survives; the table structure does not.
    for (const cell of ['name', 'qty', 'lemon', '3']) {
      assert.ok(out.includes(cell), `cell ${cell} was lost: ${JSON.stringify(out)}`);
    }
    assert.ok(!out.includes('<table'), `table markup survived: ${out}`);
    assert.ok(!out.includes('|---'), `a GFM table appeared — update this test and the README: ${out}`);
  });

  test('<strong> and <em> become their markdown forms', async () => {
    const out = await markdown('<p><strong>bold</strong> and <em>italic</em> and <b>b</b> and <i>i</i></p>');
    assert.match(out, /\*\*bold\*\*/, out);
    assert.match(out, /[*_]italic[*_]/, out);
    assert.match(out, /\*\*b\*\*/, out);
    assert.ok(!out.includes('<strong>') && !out.includes('<em>'), `markup survived: ${out}`);
  });

  test('character entities are decoded', async () => {
    const out = await markdown('<p>A &amp; B &lt; C &gt; D &quot;E&quot; &#39;F&#39; &nbsp;G</p>');
    assert.ok(out.includes('A & B'), `&amp; not decoded: ${JSON.stringify(out)}`);
    assert.ok(out.includes('< C'), `&lt; not decoded: ${JSON.stringify(out)}`);
    assert.ok(out.includes('> D'), `&gt; not decoded: ${JSON.stringify(out)}`);
    assert.ok(!out.includes('&amp;'), `an entity survived undecoded: ${out}`);
  });

  test('<script> is removed entirely — content and all', async () => {
    // Regression guard. Turndown's default rule emits the text of any element
    // it has no rule for, so a <script> INSIDE the body used to come back as
    // its own source in the prose. `turndown.remove([...])` in worker/beacon.js
    // is the fix; a <script> before any body content never showed the bug,
    // because the parser hoists it into <head> and doc.body never sees it.
    const out = await markdown('<p>before</p><script>alert(1)</script><p>after</p>');
    assert.ok(!/<script/i.test(out), `a script tag survived: ${out}`);
    assert.ok(!out.includes('alert(1)'), `script body survived as text: ${JSON.stringify(out)}`);
    assert.ok(out.includes('before') && out.includes('after'), `surrounding content lost: ${out}`);
  });

  test('a realistic saved page does not leak its inline JS, CSS or JSON-LD', async () => {
    const out = await markdown(
      '<html><head><title>T</title></head><body>' +
        '<h1>Post</h1><p>Body text.</p>' +
        '<script>window.ga=function(){};ga("send","pageview");</script>' +
        '<script type="application/ld+json">{"@context":"https://schema.org"}</script>' +
        '<style>.ad{display:none}</style>' +
        '<noscript>Please enable JavaScript.</noscript>' +
        '<p>More text.</p></body></html>'
    );
    for (const leak of ['window.ga', 'pageview', 'schema.org', 'display:none', 'enable JavaScript']) {
      assert.ok(!out.includes(leak), `${JSON.stringify(leak)} leaked into the prose: ${JSON.stringify(out)}`);
    }
    assert.match(out, /^# Post$/m, out);
    assert.ok(out.includes('Body text.') && out.includes('More text.'), `prose lost: ${out}`);
  });

  test('script content does not become active again on the way back to HTML', async () => {
    // The round trip an agent actually makes: page -> markdown -> HTML.
    const md = await markdown('<p>before</p><script>alert(1)</script><p>after</p>');
    const back = await api.convert('md-html', md, { ip: ips.next() });
    assert.equal(back.status, 200, back.text);
    assert.ok(!/<script/i.test(back.text), `a script tag reappeared after the round trip: ${back.text}`);
    assert.ok(!back.text.includes('alert(1)'), `script source reappeared: ${back.text}`);
  });

  test('inline event handlers and javascript: URLs are not re-emitted as markup', async () => {
    const out = await markdown('<p onclick="alert(1)">text</p><img src="x" onerror="alert(2)">');
    assert.ok(!out.includes('onclick'), `an event handler survived: ${out}`);
    assert.ok(!out.includes('onerror'), `an event handler survived: ${out}`);
    assert.ok(!/<\w+[^>]*\son\w+=/i.test(out), `active markup survived: ${out}`);
  });

  test('<style> is removed, wherever it sits', async () => {
    // Both positions, because only the in-body one ever failed.
    for (const html of ['<style>p{color:red}</style><p>visible</p>', '<p>visible</p><style>p{color:red}</style>']) {
      const out = await markdown(html);
      assert.ok(!out.includes('color:red'), `stylesheet body survived from ${html}: ${JSON.stringify(out)}`);
      assert.equal(out.trim(), 'visible');
    }
  });

  test('deeply nested divs collapse to their content', async () => {
    const depth = 40;
    const out = await markdown(`${'<div>'.repeat(depth)}<p>bottom</p>${'</div>'.repeat(depth)}`);
    assert.equal(out.trim(), 'bottom');
  });

  test('malformed HTML with unclosed tags is coped with, not refused', async () => {
    // domino is a forgiving parser; the recorded answer is 200 plus something
    // sane, not a 400.
    const res = await raw('<p>unclosed <b>bold');
    assert.equal(res.status, 200, res.text);
    assert.match(res.text, /unclosed\s+\*\*bold\*\*/, JSON.stringify(res.text));
  });

  test('mismatched and stray tags still produce their text', async () => {
    const res = await raw('<div><p>one</div></p><span>two');
    assert.equal(res.status, 200, res.text);
    assert.ok(res.text.includes('one') && res.text.includes('two'), res.text);
  });

  test('a full document with head and body converts the body', async () => {
    const out = await markdown(
      '<!doctype html><html><head><title>T</title><meta charset="utf-8"></head>' +
        '<body><h1>Heading</h1><p>Body text.</p></body></html>'
    );
    assert.match(out, /^# Heading$/m, out);
    assert.ok(out.includes('Body text.'), out);
    assert.ok(!out.includes('<meta'), `head markup leaked: ${out}`);
  });

  test('plain text with no tags at all converts to itself', async () => {
    assert.equal((await markdown('just text')).trim(), 'just text');
  });

  test('unicode survives', async () => {
    const out = await markdown('<p>emoji 🍋 CJK 日本語 RTL مرحبا</p>');
    for (const s of ['🍋', '日本語', 'مرحبا']) assert.ok(out.includes(s), `${s} lost: ${out}`);
  });

  test('blockquotes and horizontal rules', async () => {
    const out = await markdown('<blockquote><p>quoted</p></blockquote><hr><p>after</p>');
    assert.match(out, /^>\s*quoted$/m, out);
    assert.match(out, /^\s*(\* \* \*|---|___)\s*$/m, `no horizontal rule: ${JSON.stringify(out)}`);
  });

  test('an empty body is a 400', async () => {
    const res = await raw('');
    assert.equal(res.status, 400);
    assert.equal(res.json().error, 'the request body is empty');
  });

  test('HTML that produces no text is still a 200 with an empty result', async () => {
    // `<div></div>` is a legitimate document that converts to nothing. It must
    // not be mistaken for a failure.
    const res = await raw('<div></div>');
    assert.equal(res.status, 200, res.text);
    assert.equal(res.text.trim(), '');
  });
});
