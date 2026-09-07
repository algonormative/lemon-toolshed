#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
export const WRANGLER_CLI = require.resolve('wrangler/bin/wrangler.js');
export const BINDING = 'ANALYTICS_FULL_CAPTURE_UNTIL';
export const OFF_DEADLINE = '1970-01-01T00:00:00.000Z';
export const MAX_DURATION_MS = 30 * 24 * 60 * 60 * 1000;

export const SITES = Object.freeze({
  toolshed: 'lemon-toolshed-beacon',
  kino: 'kino402',
  tenx: 'tenx402-api',
  penny: 'penny402',
});

export function usage() {
  return `Usage:
  npm run analytics:firehose -- --for 6h [--site all|toolshed|kino|tenx|penny] [--dry-run]
  npm run analytics:firehose -- --off [--site all|toolshed|kino|tenx|penny] [--dry-run]

Durations are positive whole minutes, hours, or days (for example 30m, 6h, 2d), up to 30d.
"all" means the four filtered Workers above. Parallax already captures its full stream and is skipped.`;
}

export function parseDuration(value) {
  const match = /^(\d+)(m|h|d)$/.exec(value ?? '');
  if (!match || Number(match[1]) === 0) {
    throw new Error('--for must be a positive whole duration such as 30m, 6h, or 2d');
  }
  const scale = { m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2]];
  const milliseconds = Number(match[1]) * scale;
  if (!Number.isSafeInteger(milliseconds) || milliseconds > MAX_DURATION_MS) {
    throw new Error('--for cannot exceed 30d');
  }
  return milliseconds;
}

export function parseArgs(argv) {
  let duration;
  let off = false;
  let site = 'all';
  let dryRun = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--for') {
      if (duration !== undefined) throw new Error('--for may be supplied only once');
      duration = argv[++i];
      if (!duration) throw new Error('--for requires a duration');
    } else if (arg === '--off') {
      off = true;
    } else if (arg === '--site') {
      site = argv[++i];
      if (!site) throw new Error('--site requires a value');
    } else if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg === '--help' || arg === '-h') {
      return { help: true };
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if ((duration === undefined) === !off) throw new Error('choose exactly one of --for DURATION or --off');
  if (site !== 'all' && !Object.hasOwn(SITES, site)) throw new Error(`unknown site: ${site}`);
  return {
    help: false,
    durationMs: off ? null : parseDuration(duration),
    off,
    site,
    dryRun,
  };
}

export function runWranglerProcess({ args, input = '' }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [WRANGLER_CLI, ...args], {
      cwd: process.cwd(),
      env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.stdin.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
    child.stdin.end(input);
  });
}

async function runSafely(runWrangler, command) {
  try {
    return await runWrangler(command);
  } catch (error) {
    return { code: 1, stdout: '', stderr: error?.message ?? String(error) };
  }
}

function targetsFor(site) {
  const names = site === 'all' ? Object.keys(SITES) : [site];
  return names.map((name) => ({ site: name, worker: SITES[name] }));
}

function validDeploymentStatus(stdout) {
  try {
    const parsed = JSON.parse(stdout);
    return parsed && Array.isArray(parsed.versions) && parsed.versions.length > 0;
  } catch {
    return false;
  }
}

export async function runFirehose(argv, {
  now = () => Date.now(),
  runWrangler = runWranglerProcess,
  output = process.stdout,
} = {}) {
  const options = parseArgs(argv);
  if (options.help) {
    output.write(`${usage()}\n`);
    return { exitCode: 0, help: true };
  }

  const targets = targetsFor(options.site);
  let deadline = options.off ? OFF_DEADLINE : null;
  const report = {
    action: options.off ? 'off' : 'full-capture',
    expires_utc: deadline,
    dry_run: options.dryRun,
    parallax: 'skipped-already-full',
    targets: targets.map(({ site, worker }) => ({ site, worker, status: options.dryRun ? 'planned' : 'pending' })),
  };

  if (options.dryRun) {
    deadline = options.off ? OFF_DEADLINE : new Date(now() + options.durationMs).toISOString();
    report.expires_utc = deadline;
    output.write(`${JSON.stringify(report, null, 2)}\n`);
    return { exitCode: 0, report };
  }

  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'analytics-firehose-'));
  const configPath = join(temporaryDirectory, 'wrangler.json');
  try {
    // An explicit minimal config prevents a caller's cwd or repo environment
    // from selecting a different Worker. Authentication still uses the same
    // Wrangler login/account selection as every existing operator command.
    await writeFile(configPath, `${JSON.stringify({ send_metrics: false }, null, 2)}\n`);

    // Preflight every target before the first mutation. This guard is required:
    // `wrangler secret put` otherwise offers to create a missing Worker and its
    // non-interactive fallback accepts that offer.
    let preflightFailed = false;
    for (const target of report.targets) {
      const checked = await runSafely(runWrangler, {
        args: ['deployments', 'status', '--name', target.worker, '--json', '--config', configPath],
      });
      if (checked.code !== 0 || !validDeploymentStatus(checked.stdout)) {
        target.status = 'preflight-failed';
        target.error = (checked.stderr || checked.stdout || 'no deployed version returned').trim();
        preflightFailed = true;
      } else {
        target.status = 'preflight-ok';
      }
    }
    if (preflightFailed) {
      for (const target of report.targets) {
        if (target.status === 'preflight-ok') target.status = 'not-attempted';
      }
      output.write(`${JSON.stringify(report, null, 2)}\n`);
      return { exitCode: 1, report };
    }

    // Authentication can take time. Start the requested window only after all
    // workers are proven to exist, while keeping one deadline for the fleet.
    deadline = options.off ? OFF_DEADLINE : new Date(now() + options.durationMs).toISOString();
    report.expires_utc = deadline;
    let failed = false;
    for (const target of report.targets) {
      if (!options.off && now() >= Date.parse(deadline)) {
        failed = true;
        target.status = 'update-failed';
        target.error = 'capture deadline elapsed before this Worker could be updated';
        continue;
      }
      const updated = await runSafely(runWrangler, {
        args: ['secret', 'put', BINDING, '--name', target.worker, '--config', configPath],
        input: `${deadline}\n`,
      });
      if (updated.code === 0) {
        target.status = 'updated';
      } else {
        failed = true;
        target.status = 'update-failed';
        target.error = (updated.stderr || updated.stdout || 'Wrangler exited without output').trim();
      }
    }
    output.write(`${JSON.stringify(report, null, 2)}\n`);
    return { exitCode: failed ? 1 : 0, report };
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

async function main() {
  try {
    const result = await runFirehose(process.argv.slice(2));
    process.exitCode = result.exitCode;
  } catch (error) {
    process.stderr.write(`analytics-firehose: ${error.message}\n\n${usage()}\n`);
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();
