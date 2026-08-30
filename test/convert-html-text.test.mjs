// POST /convert/html-text — a saved page to readable plain text.
//
// The claim is "readable", and readable is a heuristic, so the suite pins the
// heuristic rather than pretending it is a rule: script/style/nav/header/footer/
// aside go WITH THEIR CONTENTS, block elements become paragraph breaks, <pre>
// keeps its whitespace, and a link becomes its text and not its URL.
//
// The dropped-with-contents part is the one that regressed in the sibling
// converter and is worth a guard: Turndown's default emits the TEXT of anything
// it has no rule for, which is how an analytics snippet ends up wedged between
// two sentences.
//
// PHASE: the env-gated free tier, so conversions are actually served.

import test, { before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { useWorker, client, callers, TIER_ON_VARS } from './harness.mjs';

let worker;
let api;
const ips = callers('html-text');

before(async () => {
  worker = await useWorker({ vars: TIER_ON_VARS });
  api = client(worker);
});
after(async () => {
  await worker.stop();
});

const raw = (input) => api.convert('html-text', input, { ip: ips.next() });

async function text(input) {
  const res = await raw(input);
  assert.equal(res.status, 200, `html-text refused ${res.status}: ${res.text}`);
  assert.match(res.contentType, /^text\/plain/);
  return res.text;
}

describe('html-text', () => {
  test('headings and paragraphs become separated blocks', async () => {
    assert.equal(await text('<h1>Title</h1><p>One.</p><p>Two.</p>'), 'Title\n\nOne.\n\nTwo.\n');
  });

  test('inline markup disappears and its text stays', async () => {
    assert.equal(await text('<p>Some <strong>bold</strong> and <em>italic</em>.</p>'), 'Some bold and italic.\n');
  });

  test('a link becomes its text, not its URL', async () => {
    const out = await text('<p>See <a href="https://example.com/very/long">the docs</a>.</p>');
    assert.equal(out, 'See the docs.\n');
    assert.ok(!out.includes('example.com'), `the URL leaked into the prose: ${out}`);
  });

  test('script and style are dropped WITH their contents', async () => {
    // The regression this exists for: emitting the text of an element you have
    // no rule for puts an analytics snippet in the middle of the article.
    const out = await text('<p>Before.</p><script>window.ga=function(){};ga("send");</script><p>After.</p>');
    assert.equal(out, 'Before.\n\nAfter.\n');
    for (const leak of ['window.ga', 'ga(']) {
      assert.ok(!out.includes(leak), `the script body leaked: ${out}`);
    }
  });

  test('inline CSS is dropped with its contents too', async () => {
    const out = await text('<style>.x{color:red}</style><p>Body.</p>');
    assert.equal(out, 'Body.\n');
  });

  test('page chrome is dropped with its contents', async () => {
    const out = await text(
      '<header>Site name</header><nav>Home About Contact</nav><p>Article.</p>' +
        '<aside>Related links</aside><footer>Copyright</footer>'
    );
    assert.equal(out, 'Article.\n');
  });

  test('<br> is a line break, not a paragraph break', async () => {
    assert.equal(await text('<p>one<br>two</p>'), 'one\ntwo\n');
  });

  test('list items land on their own lines', async () => {
    assert.equal(await text('<ul><li>a</li><li>b</li></ul>'), 'a\n\nb\n');
  });

  test('<pre> keeps its whitespace verbatim', async () => {
    const out = await text('<p>Code:</p><pre>  indented\n    more</pre><p>After.</p>');
    assert.ok(out.includes('  indented\n    more'), `pre was collapsed: ${JSON.stringify(out)}`);
  });

  test('whitespace outside <pre> is collapsed', async () => {
    assert.equal(await text('<p>one     two\n\n\nthree</p>'), 'one two three\n');
  });

  test('table cells are tab-separated on one line per row', async () => {
    const out = await text('<table><tr><td>a</td><td>b</td></tr><tr><td>c</td><td>d</td></tr></table>');
    assert.equal(out, 'a\tb\n\nc\td\n');
  });

  test('HTML entities are decoded', async () => {
    assert.equal(await text('<p>a &amp; b &lt; c &nbsp;d</p>'), 'a & b < c d\n');
  });

  test('a fragment with no <body> tag still reads', async () => {
    assert.equal(await text('Just some text.'), 'Just some text.\n');
  });

  test('unicode survives', async () => {
    assert.equal(await text('<p>日本語 🍋</p>'), '日本語 🍋\n');
  });

  test('the output ends in exactly one newline', async () => {
    const out = await text('<p>a</p><p>b</p>\n\n\n');
    assert.ok(out.endsWith('b\n'), JSON.stringify(out));
    assert.ok(!out.endsWith('\n\n'), `trailing blank lines: ${JSON.stringify(out)}`);
  });
});

describe('html-text refusals', () => {
  test('pathological nesting is refused before the parser sees it', async () => {
    // domino's parse is superlinear in depth and the tree walk is recursive: a
    // <div>*20000 body used to burn ~3s of billed CPU and then blow the stack.
    // The complexity guard refuses it in a linear pre-scan instead.
    const started = Date.now();
    const res = await raw('<div>'.repeat(20000) + 'hi' + '</div>'.repeat(20000));
    assert.equal(res.status, 400, res.text);
    assert.match(res.json().error, /nests deeper/, res.text);
    assert.ok(Date.now() - started < 2000, 'the refusal is cheap, not a parse that failed');
  });

  test('an attribute bomb is refused as a single oversized tag', async () => {
    const res = await raw(`<div ${'a1=b '.repeat(4000)}>hi</div>`);
    assert.equal(res.status, 400, res.text);
    assert.match(res.json().error, /single tag longer/, res.text);
  });

  test('a legitimately deep-but-sane page still converts', async () => {
    const res = await raw('<div>'.repeat(400) + '<p>real text</p>' + '</div>'.repeat(400));
    assert.equal(res.status, 200, res.text);
    assert.match(res.text, /real text/);
  });

  test('a page that is nothing but chrome is a 400, not an empty 200', async () => {
    // An empty 200 would look like a working conversion of an empty page. It is
    // not: it is the heuristic having eaten everything, and the caller has to
    // know that to reach for a readability extractor instead.
    const res = await raw('<nav>Home</nav><script>x()</script><style>.a{}</style>');
    assert.equal(res.status, 400, res.text);
    assert.match(res.json().error, /no readable text/, res.text);
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

  test('markup with no text is a 400', async () => {
    const res = await raw('<div><span></span></div>');
    assert.equal(res.status, 400, res.text);
    assert.match(res.json().error, /no readable text/, res.text);
  });

  test('every refusal is a one-line JSON error with no stack trace', async () => {
    for (const input of ['<nav>x</nav>', '<div></div>', '   ']) {
      const res = await raw(input);
      assert.equal(res.status, 400);
      assert.match(res.contentType, /application\/json/);
      const { error } = res.json();
      assert.ok(!error.includes('\n'), `not one line: ${error}`);
      assert.ok(!/\bat\s+\w+\s+\(/.test(error), `a stack trace leaked: ${error}`);
    }
  });
});
