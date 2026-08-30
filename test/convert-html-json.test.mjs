// POST /convert/html-json — the <table> elements of a page as JSON rows.
//
// The reply shape is FIXED — {tables: [{caption, columns, rows}]} — whether the
// page has one table or nine, because a shape that changes with the input is a
// shape every consumer has to branch on. That invariant is the first thing
// asserted here.
//
// The rest is the messy half of real markup: header cells that repeat or are
// blank, rows that are shorter or longer than the header, tables nested inside
// tables, and the merged cells this reader deliberately does NOT expand. Each is
// pinned as implemented, so a caller knows which way it went.
//
// PHASE: the env-gated free tier, so conversions are actually served.

import test, { before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { useWorker, client, callers, TIER_ON_VARS } from './harness.mjs';

let worker;
let api;
const ips = callers('html-json');

before(async () => {
  worker = await useWorker({ vars: TIER_ON_VARS });
  api = client(worker);
});
after(async () => {
  await worker.stop();
});

const raw = (input) => api.convert('html-json', input, { ip: ips.next() });

async function tables(input) {
  const res = await raw(input);
  assert.equal(res.status, 200, `html-json refused ${res.status}: ${res.text}`);
  assert.match(res.contentType, /^application\/json/);
  const body = JSON.parse(res.text);
  assert.deepEqual(Object.keys(body), ['tables'], `unexpected top level: ${res.text}`);
  return body.tables;
}

const SIMPLE =
  '<table><thead><tr><th>name</th><th>qty</th></tr></thead>' +
  '<tbody><tr><td>lemon</td><td>3</td></tr><tr><td>lime</td><td>4</td></tr></tbody></table>';

describe('html-json', () => {
  test('one table becomes rows keyed by the header cells', async () => {
    assert.deepEqual(await tables(SIMPLE), [
      {
        caption: null,
        columns: ['name', 'qty'],
        rows: [
          { name: 'lemon', qty: '3' },
          { name: 'lime', qty: '4' },
        ],
      },
    ]);
  });

  test('the shape is the same for one table and for several', async () => {
    const one = await tables(SIMPLE);
    const many = await tables(`${SIMPLE}${SIMPLE}`);
    assert.equal(many.length, 2);
    assert.deepEqual(Object.keys(many[0]), Object.keys(one[0]));
    assert.deepEqual(many[0], one[0]);
  });

  test('a caption is reported, and absent means null', async () => {
    const [withCaption] = await tables(
      '<table><caption>Stock</caption><tr><th>a</th></tr><tr><td>1</td></tr></table>'
    );
    assert.equal(withCaption.caption, 'Stock');
    const [without] = await tables(SIMPLE);
    assert.equal(without.caption, null);
  });

  test('a table with no thead uses its first row as the header', async () => {
    assert.deepEqual(await tables('<table><tr><td>a</td><td>b</td></tr><tr><td>1</td><td>2</td></tr></table>'), [
      { caption: null, columns: ['a', 'b'], rows: [{ a: '1', b: '2' }] },
    ]);
  });

  test('the header is the first row containing a <th>, wherever it sits', async () => {
    const [table] = await tables(
      '<table><tr><td>junk</td></tr><tr><th>a</th></tr><tr><td>1</td></tr></table>'
    );
    assert.deepEqual(table.columns, ['a']);
    // The row above the header is data, not a second header.
    assert.deepEqual(table.rows, [{ a: 'junk' }, { a: '1' }]);
  });

  test('a blank header cell gets a positional name', async () => {
    const [table] = await tables('<table><tr><th>a</th><th></th></tr><tr><td>1</td><td>2</td></tr></table>');
    assert.deepEqual(table.columns, ['a', 'column_2']);
    assert.deepEqual(table.rows, [{ a: '1', column_2: '2' }]);
  });

  test('duplicate header cells are disambiguated rather than colliding', async () => {
    // Two columns named `a` collapsing into one key is a row that silently lost
    // a value — the same class of bug as a dropped `__proto__` column.
    const [table] = await tables(
      '<table><tr><th>a</th><th>a</th></tr><tr><td>1</td><td>2</td></tr></table>'
    );
    assert.deepEqual(table.columns, ['a', 'a_2']);
    assert.deepEqual(table.rows, [{ a: '1', a_2: '2' }]);
  });

  test('a short row is padded, a long row gets positional keys', async () => {
    const [table] = await tables(
      '<table><tr><th>a</th><th>b</th></tr><tr><td>1</td></tr><tr><td>1</td><td>2</td><td>3</td></tr></table>'
    );
    assert.deepEqual(table.rows, [
      { a: '1', b: '' },
      { a: '1', b: '2', column_3: '3' },
    ]);
  });

  test('cell whitespace is collapsed and trimmed', async () => {
    const [table] = await tables('<table><tr><th>  a  </th></tr><tr><td>\n  x   y \n</td></tr></table>');
    assert.deepEqual(table.columns, ['a']);
    assert.deepEqual(table.rows, [{ a: 'x y' }]);
  });

  test('values stay strings — no type guessing', async () => {
    const [table] = await tables('<table><tr><th>zip</th></tr><tr><td>007</td></tr></table>');
    assert.equal(table.rows[0].zip, '007');
    assert.equal(typeof table.rows[0].zip, 'string');
  });

  test('inline markup inside a cell becomes its text', async () => {
    const [table] = await tables('<table><tr><th>a</th></tr><tr><td><b>x</b> <i>y</i></td></tr></table>');
    assert.deepEqual(table.rows, [{ a: 'x y' }]);
  });

  test('a `__proto__` header is an ordinary column — regression guard', async () => {
    const res = await raw('<table><tr><th>__proto__</th></tr><tr><td>kept</td></tr></table>');
    assert.equal(res.status, 200, res.text);
    assert.ok(res.text.includes('"__proto__": "kept"'), `the column was dropped: ${res.text}`);
  });

  test('a nested table is its own entry, not folded into the outer one', async () => {
    // Recorded as implemented: `querySelectorAll('tr')` would have swallowed the
    // inner rows into the outer table, which is a wrong answer with no error.
    const nested = await tables(
      '<table><tr><th>outer</th></tr><tr><td><table><tr><th>inner</th></tr><tr><td>1</td></tr></table></td></tr></table>'
    );
    assert.equal(nested.length, 2);
    assert.deepEqual(nested[1].columns, ['inner']);
    assert.deepEqual(nested[1].rows, [{ inner: '1' }]);
    // The outer table sees the nested table's TEXT in its cell, and only its own
    // single data row — not the inner one.
    assert.equal(nested[0].rows.length, 1);
  });

  test('colspan is NOT expanded — this is a data-table reader, not a layout reader', async () => {
    const [table] = await tables(
      '<table><tr><th>a</th><th>b</th></tr><tr><td colspan="2">merged</td></tr></table>'
    );
    assert.deepEqual(table.rows, [{ a: 'merged', b: '' }]);
  });

  test('rows in tfoot are read too', async () => {
    const [table] = await tables(
      '<table><thead><tr><th>a</th></tr></thead><tbody><tr><td>1</td></tr></tbody><tfoot><tr><td>total</td></tr></tfoot></table>'
    );
    assert.deepEqual(table.rows, [{ a: '1' }, { a: 'total' }]);
  });

  test('a header-only table yields no rows, not an error', async () => {
    const [table] = await tables('<table><tr><th>a</th><th>b</th></tr></table>');
    assert.deepEqual(table.columns, ['a', 'b']);
    assert.deepEqual(table.rows, []);
  });

  test('unicode in headers and cells', async () => {
    const [table] = await tables('<table><tr><th>名前</th></tr><tr><td>日本語 🍋</td></tr></table>');
    assert.deepEqual(table.rows, [{ 名前: '日本語 🍋' }]);
  });
});

describe('html-json refusals', () => {
  test('a page with no table at all is a 400', async () => {
    const res = await raw('<h1>Title</h1><p>Prose, no data.</p>');
    assert.equal(res.status, 400, res.text);
    assert.match(res.json().error, /no <table> element/, res.text);
  });

  test('a table with no rows in it is a 400', async () => {
    const res = await raw('<table></table>');
    assert.equal(res.status, 400, res.text);
    assert.match(res.json().error, /no rows in it/, res.text);
  });

  test('an empty body is a 400', async () => {
    const res = await raw('');
    assert.equal(res.status, 400);
    assert.equal(res.json().error, 'the request body is empty');
  });

  test('every refusal is a one-line JSON error with no stack trace', async () => {
    for (const input of ['<p>nope</p>', '<table></table>', '   ']) {
      const res = await raw(input);
      assert.equal(res.status, 400);
      assert.match(res.contentType, /application\/json/);
      const { error } = res.json();
      assert.ok(!error.includes('\n'), `not one line: ${error}`);
      assert.ok(!/\bat\s+\w+\s+\(/.test(error), `a stack trace leaked: ${error}`);
    }
  });
});
