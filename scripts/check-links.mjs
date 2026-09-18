#!/usr/bin/env node
// Link-check over every `url:` in entries.yaml.
//
//   npm run check-links
//   node scripts/check-links.mjs
//
// THIS RUN SPENDS NOTHING. It touches no Lemon surface at all — not the Worker,
// not the static site, not a facilitator. Every request goes to a third-party
// reference site (pandoc.org, ffmpeg.org, a GitHub repo), and one HEAD per
// unique URL is the entire cost.
//
// What that buys, and what it does not:
//
//   checked here      that the reference link behind each entry still RESOLVES.
//                     Every `url:` in entries.yaml, deduplicated — the catalogue
//                     names the same tool from several entries, so pandoc.org is
//                     fetched once and the table says how many entries lean on
//                     it. Redirects are followed, and a row that landed
//                     somewhere else prints where.
//   NOT checked here  that the page still says what the verdict claims. A 200
//                     from a URL that now serves a parked domain or a rewritten
//                     "we've moved to v3" page is a green row here and a wrong
//                     opinion in the catalogue. Only the human refresh pass can
//                     see that difference.
//
// This belongs to the MONTHLY REFRESH PASS, not to deploy. A rotted link is a
// stale opinion rather than a broken product, and a third-party outage must not
// be able to block shipping — so nothing in .github/workflows calls this, and
// nothing should start.
//
// Reading entries.yaml: by line scan, not by a YAML parser. The repo has
// js-yaml as a build dependency, but this script deliberately imports only
// node: builtins so it can be run anywhere with no install. That relies on the
// one-url-per-line shape the file actually has — every `url:` is a single
// double-quoted scalar at four-space indent, and there is no other http(s)
// string in the file. If that ever stops being true, this scan is what breaks,
// and the fix is to reach for js-yaml rather than a cleverer regex.
//
// Zero dependencies — Node 18+ for global fetch, and nothing else.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ENTRIES = join(ROOT, 'entries.yaml');

const TIMEOUT_MS = 15_000;
const CONCURRENCY = 6;
const USER_AGENT = 'lemon-toolshed-link-check/1.0 (+https://toolshed.lemon-agent.dev)';

// ---------------------------------------------------------------- read

// `  - id: <id>` opens an entry; `    url: "<url>"` is the field we want. The id
// is only carried so a failure names the entries that have to be edited, rather
// than leaving the reader to grep for the URL.
const ENTRY_RE = /^\s*-\s+id:\s*(\S+)\s*$/;
const URL_RE = /^\s+url:\s*"(https?:\/\/[^"]+)"\s*$/;

function readUrls() {
  const lines = readFileSync(ENTRIES, 'utf8').split('\n');
  const byUrl = new Map(); // url -> { url, order, entries: [id] }
  let currentId = '(no id)';

  lines.forEach((line, i) => {
    const entry = ENTRY_RE.exec(line);
    if (entry) {
      currentId = entry[1];
      return;
    }
    const match = URL_RE.exec(line);
    if (!match) return;
    const url = match[1];
    if (!byUrl.has(url)) byUrl.set(url, { url, order: i, entries: [] });
    byUrl.get(url).entries.push(currentId);
  });

  return [...byUrl.values()].sort((a, b) => a.order - b.order);
}

// ---------------------------------------------------------------- harness

const results = [];

function record(name, ok, detail) {
  results.push({ name, ok, detail });
}

// ---------------------------------------------------------------- check

async function request(url, method) {
  const res = await fetch(url, {
    method,
    redirect: 'follow',
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { 'user-agent': USER_AGENT, accept: '*/*' },
  });
  // A body left unread on a GET keeps the socket open until the process exits.
  if (method === 'GET') await res.arrayBuffer().catch(() => {});
  return res;
}

// HEAD first, because it is the cheapest question that answers "is this still
// here". Some hosts answer it badly — a 405 because they never implemented it,
// or a transient 5xx that a GET clears (sqlite.org did exactly that during
// development) — so anything that looks like a failure gets ONE retry with GET
// before the link is called dead. One retry, deliberately: a backoff ladder here
// would turn a genuinely dead link into a slow red row instead of a fast one.
async function check(entry) {
  const { url } = entry;
  let res;
  try {
    res = await request(url, 'HEAD');
  } catch (err) {
    try {
      res = await request(url, 'GET');
    } catch (err2) {
      return { ok: false, detail: `${short(err)} (GET retry: ${short(err2)})` };
    }
  }

  if (res.status >= 400) {
    const headStatus = res.status;
    try {
      res = await request(url, 'GET');
    } catch (err) {
      return { ok: false, detail: `HEAD ${headStatus}, GET retry: ${short(err)}` };
    }
    if (res.status >= 400) {
      return { ok: false, detail: `HEAD ${headStatus}, GET ${res.status}` };
    }
    return { ok: true, detail: `${res.status} via GET (HEAD ${headStatus})${landed(url, res)}` };
  }

  return { ok: true, detail: `${res.status}${landed(url, res)}` };
}

/** Where a redirect actually put us, when that is not where we asked. */
function landed(url, res) {
  const final = res.url || '';
  if (!final || final === url) return '';
  // A bare trailing slash is a redirect, but not one a refresh pass needs to see.
  if (final === `${url}/`) return '';
  return ` -> ${final}`;
}

const short = (err) => String((err && err.message) || err).replace(/\s+/g, ' ').slice(0, 120);

// ---------------------------------------------------------------- run

async function run() {
  const entries = readUrls();
  if (!entries.length) {
    console.error(`No url: lines found in ${ENTRIES} — the line scan is broken, not the links.`);
    process.exit(1);
  }

  const total = entries.length;
  console.log(
    `Checking ${total} unique url${total === 1 ? '' : 's'} from entries.yaml ` +
      `(${entries.reduce((n, e) => n + e.entries.length, 0)} entry references), ` +
      `${CONCURRENCY} at a time.\n`
  );

  // Small fixed pool. Each host answers at most two requests in a whole run, so
  // there is nothing to pace — the cap is about not opening 26 sockets at once.
  let next = 0;
  const out = new Array(total);
  const worker = async () => {
    while (next < total) {
      const i = next++;
      out[i] = await check(entries[i]);
      process.stdout.write(`${out[i].ok ? '  ok  ' : ' FAIL '} ${entries[i].url}\n`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, total) }, worker));

  entries.forEach((entry, i) => {
    const shared = entry.entries.length > 1 ? ` [${entry.entries.length} entries]` : '';
    record(entry.url, out[i].ok, `${out[i].detail}${shared}`);
  });

  return printTable(entries);
}

// ---------------------------------------------------------------- table

function printTable(entries) {
  const passed = results.filter((r) => r.ok).length;
  const failed = results.length - passed;
  const nameWidth = Math.max(4, ...results.map((r) => r.name.length));
  const rule = '='.repeat(nameWidth + 10);

  console.log(`\n${rule}`);
  console.log(`${'URL'.padEnd(nameWidth)}  RESULT  DETAIL`);
  console.log('-'.repeat(nameWidth + 10));
  for (const r of results) {
    console.log(`${r.name.padEnd(nameWidth)}  ${r.ok ? 'PASS' : 'FAIL'}    ${r.detail || ''}`.trimEnd());
  }
  console.log('-'.repeat(nameWidth + 10));
  console.log(
    `${String(`${passed} passed, ${failed} failed`).padEnd(nameWidth)}  ${failed ? 'FAIL' : 'PASS'}`
  );
  console.log(`${rule}\n`);

  if (failed) {
    console.log('DEAD LINKS — and the entries that have to be edited');
    results.forEach((r, i) => {
      if (r.ok) return;
      console.log(`  * ${r.name}\n      ${r.detail}\n      entries: ${entries[i].entries.join(', ')}`);
    });
    console.log(
      '\nA dead link is a stale opinion, not an outage: fix it in the monthly refresh ' +
        'pass, not by reverting a deploy.\n'
    );
  }

  return failed;
}

const failed = await run();
process.exit(failed ? 1 : 0);
