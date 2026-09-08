// The registry ownership-verification files, and the env vars behind them.
//
// WHY THEY ARE VARS AND NOT FILES. Two registries verify that we own this
// origin by asking for a static file at a well-known path, and both hand out a
// token that EXPIRES — 402 Index's claim hash and x402-list's one-time update
// token are good for roughly 72 hours. A committed file would be a short-lived
// secret in git that goes stale before the next deploy, and re-verifying would
// mean a code change. So the Worker reads them from `env` and a rotation is a
// var edit that rebuilds nothing:
//
//   GET /.well-known/402index-verify.txt   env.WELLKNOWN_402INDEX
//   GET /.well-known/x402list.txt          env.WELLKNOWN_X402LIST
//
// THREE CLAIMS, each of which fails silently in production:
//
//   1. THE BODY IS VERBATIM. A registry compares bytes. Trimming whitespace or
//      appending a newline "helpfully" is how a verification fails for a reason
//      nobody can see from either side.
//   2. UNSET IS A 404, NOT AN ERROR. Outside a verification window there is no
//      token, and the honest answer is that the file is not there. A 200 with
//      an empty body would read to a registry as "wrong token".
//   3. IT IS text/plain. Both registries fetch a .txt; serving JSON or HTML
//      fails the check with a 200.
//
// PHASE: standalone — this file boots its own workers, because the answer is
// fixed by a dev var for the life of a `wrangler dev` process and it needs both
// the configured and the unconfigured deployment. Same pattern as
// surfaces.test.mjs / x402-solana.test.mjs. No network beyond localhost (AF-06).

import test, { before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { bootWorker, client } from './harness.mjs';

const INDEX_PATH = '/.well-known/402index-verify.txt';
const LIST_PATH = '/.well-known/x402list.txt';

// A realistic-looking claim hash and a one-time token. Neither is real, and
// neither is checked by anything — they exist so "verbatim" has something with
// shape to be verbatim about. The x402-list value deliberately carries a
// TRAILING NEWLINE: the ticket says the token is served as its own line, and a
// route that trims it would pass every other assertion here.
const INDEX_HASH = 'abc123hash';
const LIST_TOKEN = 'tok-one\n';

let configured;
let unconfigured;
let set;
let unset;

before(async () => {
  configured = await bootWorker({
    vars: { WELLKNOWN_402INDEX: INDEX_HASH, WELLKNOWN_X402LIST: LIST_TOKEN },
  });
  // Not merely "the vars are absent": one is absent and one is an empty string,
  // which is what a dashboard field cleared by hand actually leaves behind.
  unconfigured = await bootWorker({ vars: { WELLKNOWN_X402LIST: '   ' } });
  set = client(configured);
  unset = client(unconfigured);
});

after(async () => {
  await configured?.stop();
  await unconfigured?.stop();
});

describe('with the verification vars set', () => {
  for (const [path, expected] of [
    [INDEX_PATH, INDEX_HASH],
    [LIST_PATH, LIST_TOKEN],
  ]) {
    test(`GET ${path} returns the var's value verbatim`, async () => {
      const res = await set.get(path);
      assert.equal(res.status, 200);
      assert.equal(await res.text(), expected, `${path}: the body is not the var, byte for byte`);
    });

    test(`GET ${path} is text/plain and uncacheable`, async () => {
      const res = await set.get(path);
      assert.ok(
        (res.headers.get('content-type') || '').startsWith('text/plain'),
        `${path}: content-type is ${res.headers.get('content-type')}`
      );
      // The token rotates inside a 72-hour window; a cached copy of a retired
      // one is a verification that fails against a file we already replaced.
      assert.equal(res.headers.get('cache-control'), 'no-store');
      assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(res.headers.get('access-control-allow-origin'), '*');
    });

    test(`HEAD ${path} answers the same headers with no body`, async () => {
      const res = await set.request(path, { method: 'HEAD' });
      assert.equal(res.status, 200);
      assert.equal((await res.text()).length, 0);
      assert.ok((res.headers.get('content-type') || '').startsWith('text/plain'));
    });

    test(`POST ${path} is 405 with an allow header`, async () => {
      const res = await set.post(path, 'x');
      assert.equal(res.status, 405);
      assert.equal(res.headers.get('allow'), 'GET, HEAD');
    });
  }
});

describe('with the verification vars unset', () => {
  for (const path of [INDEX_PATH, LIST_PATH]) {
    test(`GET ${path} is a 404, not an empty 200`, async () => {
      const res = await unset.get(path);
      assert.equal(res.status, 404, `${path}: an unset var must read as "the file is not there"`);
      assert.equal((await res.text()).length, 0);
    });
  }

  test('an all-whitespace var reads as unset', async () => {
    // WELLKNOWN_X402LIST is '   ' on this worker — a cleared dashboard field.
    const res = await unset.get(LIST_PATH);
    assert.equal(res.status, 404);
  });

  test('POST is still 405 — the method check runs before the var lookup', async () => {
    const res = await unset.post(INDEX_PATH, 'x');
    assert.equal(res.status, 405);
    assert.equal(res.headers.get('allow'), 'GET, HEAD');
  });
});

describe('the rest of /.well-known/ is unaffected', () => {
  test('an unknown well-known path is a plain 404 on both workers', async () => {
    for (const api of [set, unset]) {
      const res = await api.get('/.well-known/nothing-here.txt');
      assert.equal(res.status, 404);
    }
  });

  test('the discovery document still answers from the compiled surfaces', async () => {
    // /.well-known/x402 is a MACHINE SURFACE, matched before these two routes.
    // A regression that let the var handler swallow it would be invisible until
    // a crawler read the 404.
    const res = await set.get('/.well-known/x402');
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8');
    assert.equal(JSON.parse(await res.text()).x402Version, 2);
  });
});
