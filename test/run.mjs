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
];

const only = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const totals = { tests: 0, pass: 0, fail: 0, skipped: 0 };
let failed = false;

for (const phase of PHASES) {
  const files = only.length ? phase.files.filter((f) => only.some((o) => f.includes(o))) : phase.files;
  if (!files.length) continue;

  process.stdout.write(`\n── phase: ${phase.name} ── ${files.length} file(s)\n`);

  if (phase.standalone) {
    process.stdout.write('   the suite boots its own worker\n\n');
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
