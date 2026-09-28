#!/usr/bin/env node
// `npm test` — the local suite runner.
//
// Two things make this a script rather than a bare `node --test test/`:
//
// 1. PHASES. Dev vars change the product's answer, and a dev var is fixed for
//    the life of a `wrangler dev` process, so each configuration needs its own
//    worker. Two vars matter:
//      FREE_TIER_DAILY  unset (production) = every call is a paid call and the
//                       FIRST unauthenticated call is the 402; set to N = the
//                       legacy free tier of N calls per caller per UTC day.
//      PAYTO            unset = 429 where a 402 would otherwise go, because
//                       there is nowhere to pay.
//    So the run is three phases against three workers, booted and torn down in
//    turn.
//
// 2. ONE WORKER PER PHASE. Booting is the expensive part (~2 s), and a shared
//    instance is safe here because every suite addresses its own band of
//    `cf-connecting-ip` addresses — see SUITE_OCTET in harness.mjs. Suites run
//    with --test-concurrency=1 so that the handful of tests which count rows in
//    D1 can compare a before and an after without another file writing between
//    them.
//
// Nothing here touches the network beyond localhost, and each phase gets a
// fresh temporary D1 that is deleted on teardown. Run one file on its own with
// `node --test test/quota.test.mjs` — the file boots its own worker when the
// runner has not already exported one.

import { spawn } from 'node:child_process';
import { bootWorker, PAYTO_TEST, TIER_ON_VARS } from './harness.mjs';

const PHASES = [
  {
    // FIRST, and the only phase that boots nothing at all: worker/analytics.js
    // is imported in process and driven against a stubbed fetch. It runs ahead
    // of everything else because it is ~200 ms and it is what proves the
    // property every later phase quietly depends on — with no
    // POSTHOG_PROJECT_TOKEN set (which is every phase here) the analytics path
    // makes no network call whatsoever.
    name: 'analytics (in process, stubbed fetch and subprocess)',
    standalone: true,
    note: 'boots no worker: analytics fetch and firehose subprocess execution are stubbed',
    files: ['test/analytics.test.mjs', 'test/analytics-firehose.test.mjs'],
  },
  {
    // SECOND, and the other phase that boots nothing: the billing-terms
    // disclosure is read straight out of the COMMITTED
    // worker/surfaces.generated.js — the exact bytes the zone Worker serves —
    // and compared against the module that renders it and the README that
    // quotes it. It runs BEFORE the machine-surfaces phase below, which
    // rebuilds those bytes, so what it checks is what is committed; that phase
    // is what proves the committed copy still equals a fresh build.
    name: 'billing terms (in process, no build, no worker)',
    standalone: true,
    note: 'boots no worker: the committed machine surfaces are compared against the renderer and the README',
    files: ['test/billing-terms.test.mjs'],
  },
  {
    // First because it is the cheapest thing in the run: it runs the
    // production build, then boots its own worker (same shape as
    // settlement/solana/alerts below) to exercise the machine surfaces the
    // zone Worker now serves — no D1 fixtures or dev vars needed, so the
    // default boot is enough. `standalone` here means only what the runner
    // means by it — do not join it into the shared phase-boot worker below.
    name: 'machine surfaces (build + Worker, own boot)',
    standalone: true,
    note: 'boots its own worker: the suite runs the build, then serves the machine surfaces off it',
    files: ['test/surfaces.test.mjs'],
  },
  {
    // STANDALONE because it DROPs tables out from under the running Worker and
    // puts them back: on a shared phase worker, whichever suite ran next would
    // fail for reasons that had nothing to do with it. No dev vars — /check
    // reports the schema whatever the payment configuration is.
    name: 'schema self-check (/check against a database missing a table)',
    standalone: true,
    note: 'boots its own worker: tables are dropped and restored on its own fresh D1',
    files: ['test/schema-check.test.mjs'],
  },
  {
    // STANDALONE, same shape as machine surfaces above and for a sharper
    // reason: the registry ownership files are answered out of env vars whose
    // values are fixed for the life of a `wrangler dev` process, and the suite
    // needs BOTH a worker with them set and one without. It boots its own two.
    name: 'registry ownership files (WELLKNOWN_* vars set and unset)',
    standalone: true,
    note: 'boots its own two workers: one with the verification vars set, one without',
    files: ['test/wellknown.test.mjs'],
  },
  {
    // The env-gated free tier. These suites need conversions actually SERVED —
    // the converter fixtures because that is what they assert on, the quota and
    // spoof suites because the tier IS what they assert on — and with no
    // facilitator and no wallet in the loop, a free tier is the only way to be
    // served. It is booted explicitly rather than inherited, so the file that
    // reads these assertions can see which configuration produced them.
    name: `free tier enabled (FREE_TIER_DAILY=${TIER_ON_VARS.FREE_TIER_DAILY}, PAYTO unset)`,
    vars: TIER_ON_VARS,
    files: [
      'test/convert-md-html.test.mjs',
      'test/convert-json-yaml.test.mjs',
      'test/convert-yaml-json.test.mjs',
      'test/convert-csv-json.test.mjs',
      'test/convert-html-markdown.test.mjs',
      // The 2026-08-30 wave.
      'test/convert-json-csv.test.mjs',
      'test/convert-csv-yaml.test.mjs',
      'test/convert-yaml-csv.test.mjs',
      'test/convert-json-ndjson.test.mjs',
      'test/convert-ndjson-json.test.mjs',
      'test/convert-frontmatter-json.test.mjs',
      'test/convert-markdown-json.test.mjs',
      'test/convert-srt-vtt.test.mjs',
      'test/convert-vtt-srt.test.mjs',
      'test/convert-toml-json.test.mjs',
      'test/convert-json-toml.test.mjs',
      'test/convert-xml-json.test.mjs',
      'test/convert-html-text.test.mjs',
      'test/convert-html-json.test.mjs',
      'test/protocol.test.mjs',
      'test/quota.test.mjs',
      // Last on purpose: it rotates the shared salt, which re-keys every
      // convert_quota row. Harmless afterwards, confusing before.
      'test/beacon.test.mjs',
    ],
  },
  {
    // THE PRODUCTION CONFIGURATION: no free tier, a receiving address set. The
    // first unauthenticated call is the 402, which is both the product and the
    // thing Coinbase's Bazaar index probes for.
    name: 'production default (free tier off, PAYTO set)',
    vars: { PAYTO: PAYTO_TEST },
    files: ['test/tier-off.test.mjs', 'test/x402.test.mjs'],
  },
  {
    // STANDALONE, and it has to be: this suite runs a mock facilitator on a
    // port it only learns at startup, and FACILITATOR_URL must name that port.
    // The worker therefore cannot be booted out here, before the mock exists.
    // The file boots its own — on its own fresh D1, like every other phase.
    name: 'settlement (PAYTO + mock facilitator)',
    standalone: true,
    files: ['test/x402-settlement.test.mjs'],
  },
  {
    // STANDALONE for the same reason as settlement, and one more: the rails a
    // worker offers are fixed by PAYTO_SOLANA for the life of its process, and
    // this suite needs workers with it set, with it unset, and with a
    // /supported that fails — three configurations it boots for itself.
    name: 'solana rail (dual-rail accepts + mock facilitator)',
    standalone: true,
    files: ['test/x402-solana.test.mjs'],
  },
  {
    // STANDALONE for the same two reasons as the solana phase above: the
    // Solana half of the discovery document can only be compared against a 402
    // that actually offers the rail, which needs a mock facilitator on a port
    // learned at startup, and the addresses a worker substitutes are fixed by
    // PAYTO / PAYTO_SOLANA for the life of its process — this suite wants one
    // worker with both and one with Base only.
    name: 'discovery payTo (well-known vs the live envelope, both rails)',
    standalone: true,
    note: 'boots its own two workers plus a mock facilitator: dual-rail, then Base only',
    files: ['test/wellknown-payto.test.mjs'],
  },
  {
    // STANDALONE for the same reason as settlement, twice over: this suite runs
    // a mock facilitator AND a mock Telegram, both on ports it only learns at
    // startup, so FACILITATOR_URL and TELEGRAM_API_BASE cannot be known out
    // here. It also reads the worker's own stdout to find the .eml files
    // miniflare's send_email simulator writes, which needs the worker it booted.
    name: 'alerts (mock facilitator + mock Telegram + send_email)',
    standalone: true,
    files: ['test/alerts.test.mjs'],
  },
  {
    // STANDALONE for the same reasons as alerts, and one more: POSTHOG_HOST is
    // a dev var, so the ingest root must name a port the mock only learns at
    // startup — and the suite needs BOTH the production shape (no free tier,
    // PAYTO set) and a worker with the free tier on, to capture a served
    // conversion that nobody paid for. It boots its own two.
    name: 'analytics capture (booted worker + mock PostHog)',
    standalone: true,
    note: 'boots its own two workers plus a mock PostHog host and a mock facilitator',
    files: ['test/analytics-capture.test.mjs'],
  },
];

const only = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const totals = { tests: 0, pass: 0, fail: 0, skipped: 0 };
let failed = false;

for (const phase of PHASES) {
  const files = only.length ? phase.files.filter((f) => only.some((o) => f.includes(o))) : phase.files;
  if (!files.length) continue;

  process.stdout.write(`\n── phase: ${phase.name} ── ${files.length} file(s)\n`);

  if (phase.standalone) {
    process.stdout.write(`   ${phase.note ?? 'the suite boots its own worker'}\n\n`);
    // Nothing is exported into the child, so a bootWorker() inside the file
    // cannot accidentally join a worker left over from an earlier phase.
    if ((await runNodeTest(files, {})) !== 0) failed = true;
    continue;
  }

  const worker = await bootWorker({ vars: phase.vars });
  process.stdout.write(`   worker on ${worker.baseUrl}, fresh D1 at ${worker.persistDir}\n\n`);

  try {
    const code = await runNodeTest(files, {
      TOOLSHED_TEST_URL: worker.baseUrl,
      // The WHOLE var set, canonically ordered: useWorker() joins this worker
      // only when the config it asked for is the config that was booted.
      TOOLSHED_TEST_VARS: JSON.stringify(
        Object.fromEntries(Object.entries(phase.vars).sort(([a], [b]) => a.localeCompare(b)))
      ),
      TOOLSHED_TEST_PERSIST: worker.persistDir,
    });
    if (code !== 0) failed = true;
  } finally {
    await worker.stop();
  }
}

process.stdout.write(
  `\n══ total: ${totals.pass} passed, ${totals.fail} failed` +
    `${totals.skipped ? `, ${totals.skipped} skipped` : ''} of ${totals.tests} tests ══\n`
);
process.exit(failed || totals.fail > 0 ? 1 : 0);

// ------------------------------------------------------------------ helpers

function runNodeTest(files, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['--test', '--test-concurrency=1', '--test-reporter=spec', ...files],
      { cwd: process.cwd(), env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'inherit'] }
    );

    let tail = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      process.stdout.write(chunk);
      tail = (tail + chunk).slice(-4000);
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      // The spec reporter's summary block, e.g. "ℹ pass 128". Parsed so the two
      // phases can be added up into one line at the end.
      for (const key of ['tests', 'pass', 'fail', 'skipped']) {
        const match = tail.match(new RegExp(`^[^\\w\\n]*${key}\\s+(\\d+)\\s*$`, 'm'));
        if (match) totals[key] += Number(match[1]);
      }
      resolve(code ?? 1);
    });
  });
}
