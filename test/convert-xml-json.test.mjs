// POST /convert/xml-json — XML into fast-xml-parser's JSON convention.
//
// XML-to-JSON is not a bijection, so the product is the CONVENTION being stated
// and held: attributes prefixed `@_`, text under `#text`, and a repeated sibling
// element collapsing into an array — which means an element appearing once is an
// object and twice is an array, and a consumer has to handle both. That asymmetry
// is pinned here rather than left to be discovered in production.
//
// The DOCTYPE refusal is the other half. It is a denial-of-service guard, not
// pedantry: a few hundred bytes of nested entities expand to gigabytes, and this
// runs inside a Worker's CPU limit.
//
// PHASE: the env-gated free tier, so conversions are actually served.

import test, { before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { useWorker, client, callers, TIER_ON_VARS } from './harness.mjs';

let worker;
let api;
const ips = callers('xml-json');

before(async () => {
  worker = await useWorker({ vars: TIER_ON_VARS });
  api = client(worker);
});
after(async () => {
  await worker.stop();
});

const raw = (input) => api.convert('xml-json', input, { ip: ips.next() });

async function json(input) {
  const res = await raw(input);
  assert.equal(res.status, 200, `xml-json refused ${res.status}: ${res.text}`);
  assert.match(res.contentType, /^application\/json/);
  return JSON.parse(res.text);
}

describe('xml-json', () => {
  test('elements nest as objects', async () => {
    assert.deepEqual(await json('<r><a>x</a><b>y</b></r>'), { r: { a: 'x', b: 'y' } });
  });

  test('attributes are prefixed @_', async () => {
    assert.deepEqual(await json('<r id="1" kind="shed"/>'), { r: { '@_id': '1', '@_kind': 'shed' } });
  });

  test('an element with both attributes and text puts the text under #text', async () => {
    assert.deepEqual(await json('<r><a id="1">x</a></r>'), { r: { a: { '#text': 'x', '@_id': '1' } } });
  });

  test('a repeated sibling collapses into an array — once is an object, twice is an array', async () => {
    assert.deepEqual(await json('<r><a>1</a></r>'), { r: { a: '1' } });
    assert.deepEqual(await json('<r><a>1</a><a>2</a></r>'), { r: { a: ['1', '2'] } });
  });

  test('values stay strings — no type guessing', async () => {
    // The parser's default is to coerce anything numeric-looking, which turns an
    // id of "007" into 7. Switched off, for the same reason csv-json refuses it.
    const out = await json('<r><id>007</id><n>1.50</n><big>12345678901234567890</big></r>');
    assert.deepEqual(out, { r: { id: '007', n: '1.50', big: '12345678901234567890' } });
    for (const value of Object.values(out.r)) assert.equal(typeof value, 'string');
  });

  test('an attribute value is a string too', async () => {
    const out = await json('<r id="007"/>');
    assert.equal(out.r['@_id'], '007');
  });

  test('an XML declaration lands under a "?xml" key, not silently', async () => {
    // Recorded as implemented rather than as preferred: the parser keeps the
    // declaration as a pseudo-element, so a consumer walking the top level sees
    // TWO keys for a single-root document and has to know which is the root.
    assert.deepEqual(await json('<?xml version="1.0" encoding="UTF-8"?><r><a>x</a></r>'), {
      '?xml': { '@_version': '1.0', '@_encoding': 'UTF-8' },
      r: { a: 'x' },
    });
  });

  test('predefined entities are decoded', async () => {
    assert.deepEqual(await json('<r><a>a &amp; b &lt; c</a></r>'), { r: { a: 'a & b < c' } });
  });

  test('a CDATA section is text', async () => {
    const out = await json('<r><a><![CDATA[x < y]]></a></r>');
    assert.equal(JSON.stringify(out).includes('x < y'), true, JSON.stringify(out));
  });

  test('a namespace prefix is kept verbatim as part of the key', async () => {
    // Namespaces are NOT resolved: `ns:a` is the key, and the declaration comes
    // through as an ordinary attribute. A consumer that wants real namespace
    // semantics has to do that itself.
    const out = await json('<r xmlns:ns="urn:x"><ns:a>1</ns:a></r>');
    assert.equal(out.r['ns:a'], '1', JSON.stringify(out));
    assert.equal(out.r['@_xmlns:ns'], 'urn:x', JSON.stringify(out));
  });

  test('an empty element is present as an empty string, not missing', async () => {
    assert.deepEqual(await json('<r><a/></r>'), { r: { a: '' } });
  });

  test('the output is pretty-printed', async () => {
    const res = await raw('<r><a>1</a></r>');
    assert.ok(res.text.includes('\n  '), 'not pretty-printed');
  });

  test('unicode content survives', async () => {
    assert.deepEqual(await json('<r><名前>日本語 🍋</名前></r>'), { r: { 名前: '日本語 🍋' } });
  });
});

describe('xml-json refusals', () => {
  test('a document carrying a <!DOCTYPE> is refused before it is parsed', async () => {
    const res = await raw('<!DOCTYPE r [<!ENTITY a "b">]><r>&a;</r>');
    assert.equal(res.status, 400, res.text);
    assert.match(res.json().error, /DOCTYPE/, res.text);
    assert.match(res.json().error, /expansion attack/, res.text);
  });

  test('an entity-expansion bomb never reaches the parser', async () => {
    // The billion-laughs shape, small enough to post and large enough to matter.
    // The assertion is the 400 AND that it comes back promptly — an expansion
    // would either hang or blow the isolate's memory.
    const bomb =
      '<!DOCTYPE lolz [<!ENTITY lol "lol">' +
      Array.from({ length: 8 }, (_, i) => `<!ENTITY lol${i + 1} "&lol${i || ''};&lol${i || ''};">`).join('') +
      ']><lolz>&lol8;</lolz>';
    const started = Date.now();
    const res = await raw(bomb);
    assert.equal(res.status, 400, res.text);
    assert.ok(Date.now() - started < 5000, 'the bomb was not refused promptly');
  });

  test('a lowercase doctype is refused too', async () => {
    const res = await raw('<!doctype r><r/>');
    assert.equal(res.status, 400, res.text);
    assert.match(res.json().error, /DOCTYPE/, res.text);
  });

  test('an unclosed tag is a 400 naming the tag', async () => {
    const res = await raw('<r><a>1</r>');
    assert.equal(res.status, 400, res.text);
    assert.match(res.json().error, /not well-formed XML/, res.text);
  });

  test('a mismatched closing tag is a 400', async () => {
    const res = await raw('<r><a>1</b></r>');
    assert.equal(res.status, 400, res.text);
    assert.match(res.json().error, /not well-formed XML/, res.text);
  });

  test('plain text with no markup is a 400', async () => {
    const res = await raw('just some text');
    assert.equal(res.status, 400, res.text);
    assert.match(res.json().error, /not well-formed XML/, res.text);
  });

  test('an empty body is a 400', async () => {
    const res = await raw('');
    assert.equal(res.status, 400);
    assert.equal(res.json().error, 'the request body is empty');
  });

  test('every refusal is a one-line JSON error with no stack trace', async () => {
    for (const input of ['<r><a>1</r>', 'just text', '<!DOCTYPE r><r/>', '<r><a>1</b></r>']) {
      const res = await raw(input);
      assert.equal(res.status, 400);
      assert.match(res.contentType, /application\/json/);
      const { error } = res.json();
      assert.ok(!error.includes('\n'), `not one line: ${error}`);
      assert.ok(!/\bat\s+\w+\s+\(/.test(error), `a stack trace leaked: ${error}`);
    }
  });
});
