// The machine surfaces, and the Pages Function that serves them.
//
// WHY THIS EXISTS. Measured 2026-09-03: the Pages ASSET layer 403s requests
// whose User-Agent is a Python stdlib default (`error code: 1010`), while code
// paths answer normally. functions/[[path]].js moves the machine surfaces onto
// a code path; dist/_routes.json bounds the invocations to exactly those. Two
// things break that silently: a surface the build emits and _routes.json does
// not list (a 403 for Python agents again), and a Function that rewrites what
// it forwards. Both are asserted below.
//
// PHASE: standalone, and it boots NO worker — the only I/O is the build it runs
// itself and a fake ASSETS binding reading dist/. No network (AF-06).

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');

// The PRODUCTION build, run here rather than assumed: dist/ is gitignored, and
// a developer whose last run was `build:demo` has localhost baked in. The three
// overrides that change the output are stripped, so this is the same anywhere.
const buildEnv = { ...process.env };
delete buildEnv.BEACON_URL;
delete buildEnv.SITE_HOST;
delete buildEnv.API_HOST;
execFileSync(process.execPath, ['build.mjs'], { cwd: ROOT, env: buildEnv, stdio: 'pipe' });

// `[[path]].js` is a Pages wildcard route, not a specifier a static import
// survives cleanly — resolve it as a file URL.
const { onRequest } = await import(pathToFileURL(join(ROOT, 'functions', '[[path]].js')).href);

const ROUTES = JSON.parse(readFileSync(join(DIST, '_routes.json'), 'utf8'));

// Every file the build wrote into dist/, as a served path.
const emitted = [];
(function walk(dir, prefix) {
  for (const dirent of readdirSync(dir, { withFileTypes: true })) {
    if (dirent.isDirectory()) walk(join(dir, dirent.name), `${prefix}${dirent.name}/`);
    else emitted.push(`/${prefix}${dirent.name}`);
  }
})(DIST, '');
emitted.sort();

// index.html is deliberately static (browsers pass the integrity check, and
// that is the volume worth keeping off the meter); _routes.json is config.
const NOT_ROUTED = ['/index.html', '/_routes.json'];
const surfaces = emitted.filter((p) => !NOT_ROUTED.includes(p));

// Cloudflare's _routes.json grammar: an exact path, or a trailing `/*` glob.
const covers = (pattern, path) =>
  pattern.endsWith('/*') ? path.startsWith(pattern.slice(0, -1)) : pattern === path;
const included = (path) => ROUTES.include.some((p) => covers(p, path));

// A stand-in for the Pages ASSETS binding: the real built bytes, under a status
// and content-type of its own so pass-through has something to be seen by.
function fakeAssets({ status = 200, contentType = 'application/octet-stream' } = {}) {
  const seen = [];
  return {
    seen,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      seen.push(path);
      const body = readFileSync(join(DIST, path.slice(1)));
      return new Response(body, { status, headers: { 'content-type': contentType } });
    },
  };
}

const call = (path, assets) =>
  onRequest({
    request: new Request(`https://toolshed.lemon-agent.dev${path}`),
    env: { ASSETS: assets },
  });

describe('dist/_routes.json', () => {
  test('routes every machine surface the build emits through the Function', () => {
    assert.equal(ROUTES.version, 1);
    assert.ok(Array.isArray(ROUTES.exclude));
    for (const pattern of ROUTES.include) assert.match(pattern, /^\/[^*]*(\*)?$/);

    const missing = surfaces.filter((p) => !included(p));
    assert.deepEqual(missing, [], `served by the static layer, which 403s Python agents: ${missing}`);
  });

  test('names the surfaces this service is discovered by', () => {
    // Each is read by a buyer agent before it ever pays, so a build that stops
    // emitting one — or emits it unrouted — fails here rather than in the wild.
    for (const p of ['/llms.txt', '/llms-full.txt', '/openapi.json', '/catalog.json', '/robots.txt']) {
      assert.ok(emitted.includes(p), `build no longer emits ${p}`);
      assert.ok(included(p), `${p} is not in _routes.json include`);
    }
    // Globbed whether or not the tree exists yet: the discovery doc and the
    // registry-verification files land there later.
    assert.ok(included('/.well-known/x402'), '/.well-known/* is not covered');
    assert.ok(included('/.well-known/anything-else'), '/.well-known/* is not a glob');
  });

  test('leaves the browser surface on the static path', () => {
    assert.ok(emitted.includes('/index.html'));
    assert.equal(included('/index.html'), false, 'index.html must not invoke a Function');
    assert.equal(included('/_routes.json'), false, '_routes.json must not invoke a Function');
    assert.equal(included('/'), false, 'the root must not invoke a Function');
  });
});

describe('functions/[[path]].js', () => {
  test('serves bytes identical to the built asset, for every surface', async () => {
    const assets = fakeAssets({ contentType: 'text/plain' });
    for (const path of surfaces) {
      const served = Buffer.from(await (await call(path, assets)).arrayBuffer());
      assert.ok(served.equals(readFileSync(join(DIST, path.slice(1)))), `${path} bytes differ`);
    }
    // ...and the path reached the binding unrewritten, in order.
    assert.deepEqual(assets.seen, surfaces);
  });

  test('passes the asset status and content-type through unchanged', async () => {
    const ok = await call('/llms.txt', fakeAssets({ contentType: 'text/plain; charset=utf-8' }));
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get('content-type'), 'text/plain; charset=utf-8');

    const json = await call('/openapi.json', fakeAssets({ contentType: 'application/json' }));
    assert.equal(json.headers.get('content-type'), 'application/json');

    // A Function inventing its own status would turn a missing asset into a
    // 200 of nothing.
    const gone = await call('/robots.txt', fakeAssets({ status: 404, contentType: 'text/html' }));
    assert.equal(gone.status, 404);
    assert.equal(gone.headers.get('content-type'), 'text/html');
  });
});
