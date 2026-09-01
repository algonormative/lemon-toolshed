// Local test harness for the Toolshed Worker.
//
// Boots `wrangler dev --local` against a FRESH temporary D1 state, so a suite
// run never touches production and never inherits yesterday's rows. Nothing in
// here talks to the network beyond localhost.
//
// Three things are worth knowing before reading further.
//
// 1. `cf-connecting-ip` IS honoured by `wrangler dev --local`.
//    Verified empirically 2026-08-18 (wrangler 4.42.2, workerd darwin-arm64):
//    three POSTs to /convert/md-html carrying cf-connecting-ip 203.0.113.1,
//    .2 and .2 produced TWO convert_quota rows with used = 1 and used = 2. If
//    the header were ignored, one row with used = 3 would have appeared. So the
//    quota and spoof-resistance suites can give every virtual caller its own
//    address, and per-test isolation is a header rather than a rebooted worker.
//    (Production gets the header from the edge and a client cannot forge it
//    there; locally there is no edge, which is exactly what makes it useful.)
//
// 2. Fresh state per run. Every boot gets its own `--persist-to` directory
//    under the OS temp dir, `worker/schema.sql` is applied to it BEFORE the
//    server starts, and the directory is removed on teardown. Two runs cannot
//    see each other's quota rows, so the free-tier assertions are exact rather
//    than "greater than".
//
// 3. Teardown kills the process GROUP. `wrangler dev` is a node CLI that
//    spawns two workerd children; killing the node process alone orphans them
//    and leaks the port. The child is therefore spawned `detached: true` (its
//    own group leader) and torn down with `process.kill(-pid, ...)`, with a
//    SIGKILL escalation and a synchronous best-effort sweep on process exit.

import { spawn, execFile } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import net from 'node:net';

const execFileAsync = promisify(execFile);

export const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const WRANGLER = join(ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
const SCHEMA = join(ROOT, 'worker', 'schema.sql');

// The catalog is plain data with no worker globals, so the tests can import the
// same module the Worker compiles in — the numbers under test and the numbers
// asserted are then one source, not two.
//
// FREE_TIER_DAILY here is the BUILD constant, i.e. what the static surfaces
// advertise. It is 0 in production and it is NOT what the Worker enforces —
// env.FREE_TIER_DAILY is. Assert on it only when the claim is about the static
// surfaces; for behaviour, use FREE_TIER_ENABLED with TIER_ON_VARS below.
export { CATALOG, SITE_BASE, FREE_TIER_DAILY } from '../worker/catalog.generated.js';

/**
 * The width of the free tier in the phase that boots one.
 *
 * The tier is off by default now (see freeTierDaily() in worker/beacon.js), so
 * "no vars" no longer means "free tier". The suites that exist to prove the
 * tier mechanism — countdown, spoof resistance, per-caller-not-per-tool — boot
 * a worker with FREE_TIER_DAILY set to this, and keep every assertion they had.
 * The mechanism stays tested rather than becoming dead env-gated code.
 *
 * The fixture suites (convert-*.test.mjs, protocol.test.mjs) boot it too, for a
 * duller reason: they need conversions actually SERVED, and a free tier is the
 * only way to be served without a facilitator and a wallet.
 */
export const FREE_TIER_ENABLED = 3;
export const TIER_ON_VARS = { FREE_TIER_DAILY: String(FREE_TIER_ENABLED) };

/** Order-independent identity for a boot config, so a suite can join or not. */
const varsKey = (vars = {}) =>
  JSON.stringify(Object.fromEntries(Object.entries(vars).sort(([a], [b]) => a.localeCompare(b))));

// A test-only receiving address. Nothing settles against it; it exists so the
// 402 envelope has a `payTo` to assert on.
export const PAYTO_TEST = '0xTEST0000000000000000000000000000000000';

// The Solana half of the same idea (2026-08-31, the second rail). Nothing
// settles against it either; it exists so the dual-rail envelope has a base58
// `payTo` to assert on. Deliberately NOT the production address — a suite that
// hard-codes the real receiving account is one grep away from looking like a
// leak, and asserting on a fake proves the same thing.
//
// It IS valid base58: no 0, O, I or l, which are the four characters the
// alphabet drops precisely because they are the ones humans transcribe wrong.
export const PAYTO_SOLANA_TEST = 'So1anaTESTpayTo1111111111111111111111111111';

// Mirrors PAID_DAILY in worker/beacon.js. Deliberately not exported by the
// catalog (it is a runaway bound, not an advertised quota), so it is typed here.
export const PAID_DAILY = 5000;

const BOOT_TIMEOUT_MS = 120_000;
const STOP_GRACE_MS = 8_000;

// ------------------------------------------------------------------ caller IPs
//
// Each suite owns one octet, so two suites sharing a worker can never collide on
// a quota row. 198.18.0.0/15 is the benchmarking range (RFC 2544) — never a real
// client, and distinct from the 203.0.113.0/24 documentation range the manual
// probes above used.

const SUITE_OCTET = {
  'md-html': 11,
  'json-yaml': 12,
  'csv-json': 13,
  'html-markdown': 14,
  protocol: 15,
  quota: 16,
  beacon: 17,
  x402: 18,
  'yaml-json': 19,
  settlement: 20,
  'tier-off': 21,
  alerts: 22,
  // The 2026-08-30 wave. One octet each, same rule: a suite that shares a worker
  // with another must never share a convert_quota row with it.
  'json-csv': 23,
  'csv-yaml': 24,
  'yaml-csv': 25,
  'json-ndjson': 26,
  'ndjson-json': 27,
  'frontmatter-json': 28,
  'markdown-json': 29,
  'srt-vtt': 30,
  'vtt-srt': 31,
  'toml-json': 32,
  'json-toml': 33,
  'xml-json': 34,
  'html-text': 35,
  'html-json': 36,
  // The second rail (2026-08-31). Boots its own workers, but takes an octet on
  // the same rule so nothing it does can collide with a shared-worker suite.
  solana: 37,
};

/**
 * A structurally real CDP Secret API Key that is worth nothing.
 *
 * The Worker signs an Ed25519 JWT with this, so it cannot be a placeholder
 * string — it has to be what CDP actually issues: base64 of 64 bytes, a 32-byte
 * seed followed by its 32-byte public key. Generated fresh per call and never
 * sent anywhere but the local mock, so it authorises nothing and there is
 * nothing to leak. The point is that the JWT path is exercised for real: if
 * workerd could not import or sign with an Ed25519 key, the settlement suite
 * would fail rather than quietly skip.
 */
export function fakeCdpCredentials() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pkcs8 = privateKey.export({ format: 'der', type: 'pkcs8' });
  const spki = publicKey.export({ format: 'der', type: 'spki' });
  // Both DER wrappers put the 32 raw bytes last.
  const seed = pkcs8.subarray(pkcs8.length - 32);
  const pub = spki.subarray(spki.length - 32);
  return {
    CDP_API_KEY_ID: 'test-key-0000-0000-0000-000000000000',
    CDP_API_KEY_SECRET: Buffer.concat([seed, pub]).toString('base64'),
  };
}

/**
 * A per-suite source of caller addresses.
 *
 * `next()` hands out a previously unused address, which is how the fixture
 * suites stay clear of the free tier without a reboot: a caller that has never
 * called has all FREE_TIER_DAILY of its allowance. `pinned(n)` returns a stable
 * address for the tests that need the SAME caller across many calls.
 */
export function callers(suite) {
  const octet = SUITE_OCTET[suite];
  if (octet === undefined) throw new Error(`unregistered suite "${suite}" — add it to SUITE_OCTET`);
  let cursor = 0;
  const at = (n) => `198.18.${octet}.${n}`;
  return {
    next: () => at((cursor++ % 200) + 1),
    // 201-254 is the pinned band, so an auto-allocated address can never
    // wander into a caller a quota test is counting.
    pinned: (n) => at(201 + n),
  };
}

// ------------------------------------------------------------------ boot

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function applySchema(persistDir) {
  await execFileAsync(
    process.execPath,
    [WRANGLER, 'd1', 'execute', 'DB', '--local', '--persist-to', persistDir, '--file', SCHEMA, '-y'],
    { cwd: ROOT, env: quietEnv(), maxBuffer: 32 * 1024 * 1024 }
  );
}

const quietEnv = () => ({
  ...process.env,
  CI: '1',
  NO_COLOR: '1',
  WRANGLER_SEND_METRICS: 'false',
});

// Best-effort sweep: if the test process dies unexpectedly, still take the
// workerd children with it. Synchronous, because `exit` handlers cannot await.
const live = new Set();
let sweeperInstalled = false;
function installSweeper() {
  if (sweeperInstalled) return;
  sweeperInstalled = true;
  const sweep = () => {
    for (const pid of live) {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
    }
  };
  process.on('exit', sweep);
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      sweep();
      process.exit(1);
    });
  }
}

/**
 * Boot one `wrangler dev --local` instance on a fresh D1 state.
 *
 * @param {{ vars?: Record<string,string> }} options dev vars, e.g. { PAYTO }
 * @returns {Promise<Worker>}
 */
export async function bootWorker({ vars = {} } = {}) {
  installSweeper();

  const persistDir = await mkdtemp(join(tmpdir(), 'toolshed-test-'));
  await applySchema(persistDir);

  const port = await freePort();
  const inspectorPort = await freePort();

  // NO OWNER SECRETS IN THE TEST WORKER. `wrangler dev` loads a repo-root
  // `.env` into the Worker's vars by default, and this repo has one: the CDP
  // API key pair the owner-run Solana setup script reads (gitignored, real).
  // Inherited, it makes the suite behave differently on the owner's machine
  // than in a clean checkout — the phase that asserts
  // `x-payment-error: facilitator-unconfigured` finds itself CONFIGURED, calls
  // the LIVE CDP facilitator with a real key, and fails with
  // `facilitator-unreachable`. That is two problems, and the second is the
  // serious one: a local suite must never spend, authenticate, or reach a
  // billed service. `--env-file` replaces the default discovery with this empty
  // file, so every var the Worker sees comes from `--var` below and from
  // wrangler.toml — which is the only configuration a test asserts about.
  const emptyEnvFile = join(persistDir, 'empty.env');
  await writeFile(emptyEnvFile, '');

  const args = [
    WRANGLER,
    'dev',
    '--local',
    '--port',
    String(port),
    '--inspector-port',
    String(inspectorPort),
    '--persist-to',
    persistDir,
    '--env-file',
    emptyEnvFile,
  ];
  // wrangler.toml ships PAYTO_SOLANA for production (enabled 2026-08-31), so
  // the toml value would leak into every test worker. Tests default the rail
  // OFF — the single-rail suites assert the ungated shape — and a suite that
  // wants it on passes its own value (PAYTO_SOLANA_TEST) which wins below.
  const bootVars = { PAYTO_SOLANA: '', ...vars };
  for (const [key, value] of Object.entries(bootVars)) args.push('--var', `${key}:${value}`);

  const child = spawn(process.execPath, args, {
    cwd: ROOT,
    detached: true, // own process group — see the teardown note at the top
    stdio: ['ignore', 'pipe', 'pipe'],
    env: quietEnv(),
  });
  live.add(child.pid);

  let log = '';
  const capture = (chunk) => {
    log += chunk;
    if (log.length > 200_000) log = log.slice(-100_000);
  };
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', capture);
  child.stderr.on('data', capture);

  let exitedWith = null;
  const exited = new Promise((resolve) => {
    child.on('exit', (code, signal) => {
      exitedWith = { code, signal };
      live.delete(child.pid);
      resolve();
    });
  });

  const baseUrl = `http://127.0.0.1:${port}`;

  const worker = {
    baseUrl,
    port,
    persistDir,
    payTo: vars.PAYTO || '',
    owned: true,
    log: () => log,
    d1: (sql) => d1(persistDir, sql),
    stop: async () => {
      if (exitedWith) {
        live.delete(child.pid);
      } else {
        try {
          process.kill(-child.pid, 'SIGTERM');
        } catch {
          /* already gone */
        }
        const killed = await Promise.race([
          exited.then(() => true),
          new Promise((r) => setTimeout(() => r(false), STOP_GRACE_MS)),
        ]);
        if (!killed) {
          try {
            process.kill(-child.pid, 'SIGKILL');
          } catch {
            /* already gone */
          }
          await Promise.race([exited, new Promise((r) => setTimeout(r, 2000))]);
        }
        live.delete(child.pid);
      }
      await rm(persistDir, { recursive: true, force: true });
    },
  };

  // Readiness: /check is the cheapest route in the Worker — no D1, no rungs.
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  for (;;) {
    if (exitedWith) {
      await worker.stop();
      throw new Error(`wrangler dev exited during boot (${JSON.stringify(exitedWith)})\n${log}`);
    }
    try {
      const res = await fetch(`${baseUrl}/check`);
      if (res.status === 200) {
        await res.arrayBuffer();
        return worker;
      }
    } catch {
      /* not listening yet */
    }
    if (Date.now() > deadline) {
      await worker.stop();
      throw new Error(`wrangler dev did not answer /check within ${BOOT_TIMEOUT_MS} ms\n${log}`);
    }
    await new Promise((r) => setTimeout(r, 200));
  }
}

/**
 * Read or write the local D1 directly.
 *
 * Runs alongside a live `wrangler dev` — verified: rows written by the Worker
 * are visible here immediately, and writes made here are visible to the Worker.
 * That is what makes the salt-rotation test possible without waiting a day.
 */
export async function d1(persistDir, sql) {
  let stdout;
  try {
    ({ stdout } = await execFileAsync(
      process.execPath,
      [WRANGLER, 'd1', 'execute', 'DB', '--local', '--persist-to', persistDir, '--json', '--command', sql],
      { cwd: ROOT, env: quietEnv(), maxBuffer: 64 * 1024 * 1024 }
    ));
  } catch (err) {
    // wrangler reports SQL errors as a non-zero exit with the message on stdout.
    throw new Error(`d1 query failed: ${sql}\n${err.stdout || err.stderr || err.message}`);
  }
  const start = stdout.indexOf('[');
  if (start === -1) throw new Error(`no JSON in wrangler d1 output:\n${stdout}`);
  const parsed = JSON.parse(stdout.slice(start));
  return parsed.flatMap((r) => r.results ?? []);
}

// ------------------------------------------------------------------ per-file entry
//
// A test file calls useWorker() in before(). Under `npm test` the runner has
// already booted the phase's worker and exported it, so the file joins it;
// invoked directly (`node --test test/quota.test.mjs`) the file boots its own.
// Either way the file's code is identical, and either way the D1 is fresh.

/**
 * Join the phase's worker if its boot config is the one this file asked for,
 * otherwise boot a private one.
 *
 * The match is on the WHOLE var set, not just PAYTO. It used to be PAYTO alone,
 * which was enough while that was the only var that changed behaviour; then
 * FREE_TIER_DAILY became the var that decides whether the first call is a 200 or
 * a 402, and a file that joined a worker configured differently from what it
 * asked for would fail in a way that looked like a product bug.
 *
 * `payTo` is kept as sugar for the common case and merged into `vars`.
 */
export async function useWorker({ payTo = null, vars = {} } = {}) {
  const want = { ...(payTo ? { PAYTO: payTo } : {}), ...vars };
  const shared = process.env.TOOLSHED_TEST_URL;
  if (shared && (process.env.TOOLSHED_TEST_VARS || '{}') === varsKey(want)) {
    const persistDir = process.env.TOOLSHED_TEST_PERSIST;
    return {
      baseUrl: shared.replace(/\/+$/, ''),
      persistDir,
      payTo: want.PAYTO || '',
      owned: false,
      log: () => '',
      d1: (sql) => d1(persistDir, sql),
      stop: async () => {},
    };
  }
  return bootWorker({ vars: want });
}

// ------------------------------------------------------------------ client

/**
 * Request helpers bound to one worker.
 *
 * `ip` is the whole isolation mechanism: it becomes `cf-connecting-ip`, which
 * is what the free-tier counter and the beacon identity are keyed on.
 */
export function client(worker) {
  const url = (path) => `${worker.baseUrl}${path}`;

  const request = (path, { method = 'GET', body, ip, ua, headers = {} } = {}) => {
    const h = { ...headers };
    if (ip) h['cf-connecting-ip'] = ip;
    if (ua) h['user-agent'] = ua;
    return fetch(url(path), { method, body, headers: h });
  };

  return {
    url,
    request,
    get: (path, opts) => request(path, { ...opts, method: 'GET' }),
    post: (path, body, opts) => request(path, { ...opts, method: 'POST', body }),
    /** POST /convert/<id>. Returns { status, headers, text, json() }. */
    convert: async (id, input, opts = {}) => {
      const res = await request(`/convert/${id}`, { ...opts, method: 'POST', body: input });
      const text = await res.text();
      return {
        status: res.status,
        headers: res.headers,
        contentType: res.headers.get('content-type') || '',
        text,
        json: () => JSON.parse(text),
      };
    },
    /** POST /b. Always 204 by design, so the assertion is usually about rows. */
    beacon: (payload, opts = {}) =>
      request('/b', {
        ...opts,
        method: 'POST',
        body: typeof payload === 'string' ? payload : JSON.stringify(payload),
        headers: { 'content-type': 'text/plain', ...(opts.headers || {}) },
      }),
  };
}

// ------------------------------------------------------------------ small helpers

export const sqlString = (value) => `'${String(value).replace(/'/g, "''")}'`;

/**
 * True when a column read back through `d1()` is SQL NULL.
 *
 * Needed because `wrangler d1 execute --json` renders a NULL column as the
 * STRING "null", not as JSON null — so `assert.equal(row.tx_hash, null)` fails
 * against a row that is genuinely NULL. Measured 2026-08-18 (wrangler 4.42.2):
 *
 *   INSERT … VALUES (NULL)   → {"error":"null","typeof":"null","IS NULL":1}
 *   INSERT … VALUES ('null') → {"error":"null","typeof":"text","IS NULL":0}
 *
 * The two are INDISTINGUISHABLE in the value, which is why this is a helper
 * rather than a normalisation inside `d1()`: rewriting "null" to null there
 * would silently corrupt a column legitimately holding the text "null". No
 * column in worker/schema.sql ever does, but a reader that quietly destroys
 * data is the wrong default. Where the difference actually matters, select
 * `typeof(col)` alongside the column and assert on that.
 */
export const isSqlNull = (value) => value === null || value === 'null';

/** Seconds from now to the next UTC midnight — what Retry-After should carry. */
export function secondsToUtcMidnight(at = Date.now()) {
  const now = Math.floor(at / 1000);
  const day = new Date(now * 1000).toISOString().slice(0, 10);
  const dayStart = Math.floor(Date.parse(`${day}T00:00:00Z`) / 1000);
  return dayStart + 86_400 - now;
}
