#!/usr/bin/env node
// `npm test` — the local suite runner.
//
// Two things make this a script rather than a bare `node --test test/`:
//
// 1. PHASES. One dev var changes the product's answer past the free tier — with
//    PAYTO unset it is a 429, with PAYTO set it is a 402 envelope — and a dev
//    var is fixed for the life of a `wrangler dev` process. So the run is two
//    phases against two workers, booted and torn down in turn.
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
import { bootWorker, PAYTO_TEST } from './harness.mjs';

const PHASES = [
  {
    name: 'free tier (PAYTO unset)',
    vars: {},
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
    name: 'paid tier (PAYTO set)',
    vars: { PAYTO: PAYTO_TEST },
    files: ['test/x402.test.mjs'],
  },
];

const only = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const totals = { tests: 0, pass: 0, fail: 0, skipped: 0 };
let failed = false;

for (const phase of PHASES) {
  const files = only.length ? phase.files.filter((f) => only.some((o) => f.includes(o))) : phase.files;
  if (!files.length) continue;

  process.stdout.write(`\n── phase: ${phase.name} ── ${files.length} file(s)\n`);
  const worker = await bootWorker({ vars: phase.vars });
  process.stdout.write(`   worker on ${worker.baseUrl}, fresh D1 at ${worker.persistDir}\n\n`);

  try {
    const code = await runNodeTest(files, {
      TOOLSHED_TEST_URL: worker.baseUrl,
      TOOLSHED_TEST_PAYTO: phase.vars.PAYTO || '',
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
