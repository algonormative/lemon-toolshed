import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import test from 'node:test';

import {
  BINDING,
  OFF_DEADLINE,
  parseArgs,
  parseDuration,
  runFirehose,
  SITES,
} from '../scripts/analytics-firehose.mjs';

const deployed = JSON.stringify({ versions: [{ version_id: 'v1', percentage: 100 }] });
const sink = () => ({ text: '', write(chunk) { this.text += chunk; } });

test('flags default to all four filtered sites and compute one UTC deadline', async () => {
  const calls = [];
  const output = sink();
  const result = await runFirehose(['--for', '6h'], {
    now: () => Date.parse('2026-09-07T12:00:00.000Z'),
    output,
    runWrangler: async (call) => {
      calls.push(call);
      return call.args[0] === 'deployments'
        ? { code: 0, stdout: deployed, stderr: '' }
        : { code: 0, stdout: 'ok', stderr: '' };
    },
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.report.expires_utc, '2026-09-07T18:00:00.000Z');
  assert.deepEqual(result.report.targets.map((t) => t.worker), Object.values(SITES));
  assert.equal(calls.length, 8);
  assert.ok(calls.slice(0, 4).every((c) => c.args.slice(0, 2).join(' ') === 'deployments status'));
  assert.ok(calls.slice(4).every((c) => c.args.slice(0, 3).join(' ') === `secret put ${BINDING}`));
  assert.ok(calls.slice(4).every((c) => c.input === '2026-09-07T18:00:00.000Z\n'));
  assert.match(output.text, /"parallax": "skipped-already-full"/);
});

test('site selection and --off use the fixed Worker and expired deadline', async () => {
  const calls = [];
  const result = await runFirehose(['--off', '--site', 'tenx'], {
    output: sink(),
    runWrangler: async (call) => {
      calls.push(call);
      return call.args[0] === 'deployments'
        ? { code: 0, stdout: deployed, stderr: '' }
        : { code: 0, stdout: 'ok', stderr: '' };
    },
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.report.expires_utc, OFF_DEADLINE);
  assert.equal(result.report.targets[0].worker, 'tenx402-api');
  assert.equal(calls[1].input, `${OFF_DEADLINE}\n`);
});

test('dry-run performs zero subprocess or network work', async () => {
  let calls = 0;
  const result = await runFirehose(['--for', '30m', '--dry-run'], {
    now: () => 0,
    output: sink(),
    runWrangler: async () => { calls += 1; throw new Error('must not run'); },
  });
  assert.equal(result.exitCode, 0);
  assert.equal(calls, 0);
  assert.ok(result.report.targets.every((target) => target.status === 'planned'));
});

test('invalid flags, sites, durations, and durations over 30d are refused', () => {
  for (const argv of [[], ['--off', '--for', '1h'], ['--for', '0m'], ['--for', '1.5h'],
    ['--for', '31d'], ['--for', '6h', '--site', 'parallax'], ['--wat']]) {
    assert.throws(() => parseArgs(argv));
  }
  assert.equal(parseDuration('30d'), 30 * 86_400_000);
  assert.equal(parseDuration('6h'), 21_600_000);
});

test('a failed preflight prevents every secret mutation', async () => {
  const calls = [];
  const result = await runFirehose(['--for', '2d'], {
    output: sink(),
    runWrangler: async (call) => {
      calls.push(call);
      if (call.args.includes('kino402')) return { code: 1, stdout: '', stderr: 'missing' };
      return { code: 0, stdout: deployed, stderr: '' };
    },
  });
  assert.equal(result.exitCode, 1);
  assert.ok(calls.every((call) => call.args[0] === 'deployments'));
  assert.equal(result.report.targets.find((t) => t.site === 'kino').status, 'preflight-failed');
  assert.ok(result.report.targets.every((t) => !['updated', 'update-failed'].includes(t.status)));
});

test('the explicit temporary config is removed when subprocess execution rejects', async () => {
  let configPath;
  const result = await runFirehose(['--off', '--site', 'penny'], {
    output: sink(),
    runWrangler: async ({ args }) => {
      configPath = args[args.indexOf('--config') + 1];
      assert.equal(existsSync(configPath), true);
      throw new Error('spawn failed');
    },
  });
  assert.equal(result.exitCode, 1);
  assert.equal(result.report.targets[0].status, 'preflight-failed');
  assert.match(result.report.targets[0].error, /spawn failed/);
  assert.equal(existsSync(configPath), false);
});

test('one update failure is reported while remaining preflighted sites are attempted', async () => {
  const updates = [];
  const result = await runFirehose(['--for', '1h'], {
    output: sink(),
    runWrangler: async (call) => {
      if (call.args[0] === 'deployments') return { code: 0, stdout: deployed, stderr: '' };
      const worker = call.args[call.args.indexOf('--name') + 1];
      updates.push(worker);
      return worker === 'kino402'
        ? { code: 1, stdout: '', stderr: 'denied' }
        : { code: 0, stdout: 'ok', stderr: '' };
    },
  });
  assert.equal(result.exitCode, 1);
  assert.deepEqual(updates, Object.values(SITES));
  assert.equal(result.report.targets.find((t) => t.site === 'kino').status, 'update-failed');
});

test('an elapsed short window fails without silently enabling capture', async () => {
  const calls = [];
  let clockReads = 0;
  const result = await runFirehose(['--for', '1m'], {
    output: sink(),
    now: () => clockReads++ === 0 ? 0 : 60_000,
    runWrangler: async (call) => {
      calls.push(call);
      return { code: 0, stdout: deployed, stderr: '' };
    },
  });
  assert.equal(result.exitCode, 1);
  assert.equal(calls.length, 4, 'only the four preflights ran');
  assert.ok(calls.every((call) => call.args[0] === 'deployments'));
  assert.ok(result.report.targets.every((target) => target.status === 'update-failed'));
});

test('a rejected second update preserves partial success and continues reporting', async () => {
  let update = 0;
  const output = sink();
  const result = await runFirehose(['--off'], {
    output,
    runWrangler: async (call) => {
      if (call.args[0] === 'deployments') return { code: 0, stdout: deployed, stderr: '' };
      update += 1;
      if (update === 2) throw new Error('child spawn rejected');
      return { code: 0, stdout: 'ok', stderr: '' };
    },
  });
  assert.equal(result.exitCode, 1);
  assert.deepEqual(result.report.targets.map((target) => target.status),
    ['updated', 'update-failed', 'updated', 'updated']);
  assert.match(result.report.targets[1].error, /child spawn rejected/);
  assert.match(output.text, /"status": "update-failed"/);
});
