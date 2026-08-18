#!/usr/bin/env node
// X2Y build step.
//
// Reads entries.yaml and emits the read surface into dist/:
//   index.html    — the human page (per-entry anchors, how-we-count, privacy)
//   catalog.json  — the machine surface, verbatim entry fields
//   llms.txt      — the machine surface, one line per pair
//
// Static output only. The Pages project ships static assets and ZERO Functions
// (dossier § Limits): a Function re-opens the pages.dev twin's metered path.
//
// Dependency: js-yaml. Nothing else.

import { readFileSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const ROOT = dirname(fileURLToPath(import.meta.url));
const DIST = join(ROOT, 'dist');

// Build-time constant. Relative by default — a page served from the pages.dev
// twin then resolves /b against the twin, where no Worker route and no Function
// exist, so the request lands on static handling (dossier § Limits, "The twin").
// Override for the local demo: BEACON_URL=http://localhost:8787/b
const BEACON_URL = process.env.BEACON_URL || '/b';

const SITE_NAME = 'X2Y';
const STRAPLINE = 'which converter, when — a Lemon field directory';

// Refresh cadence is monthly (~4 h/month, dossier § Estimates). Entries whose
// `verified` date predates it are flagged in the build (dossier § Components 7).
const STALE_AFTER_DAYS = 35;

const KINDS = new Set(['deterministic', 'model', 'hybrid']);
const REQUIRED = ['id', 'x', 'y', 'tool', 'kind', 'verdict', 'install', 'url', 'caveats', 'escalate', 'verified'];

// The editorial stance, published on the page and in llms.txt.
const STANCE =
  'Every entry is a verdict, not a listing: the pair — what you have, what you need — ' +
  'is the primary key, and the named tool is the one worth reaching for. The stance is ' +
  'the deterministic tool wherever it suffices, and a model only where the target is ' +
  'judgment-defined. Where a model genuinely earns its place, the escalate line says so ' +
  'and says how narrow to keep it. All verdicts are engineering judgment, not measurement.';

// Bot policy, verbatim from KC-CUR (dossier § Limits, "Count integrity").
const BOT_POLICY =
  'the count is script-executing clients minus self-declared bots; thresholds are set ' +
  'so crawler residue does not clear them alone; no claim to perfect human detection is made';

// X-categories. Ordered rules, first match wins, matched against the lowercased
// `x` field. Editorial grouping — deliberately shallow, and easy to eyeball.
const CATEGORY_RULES = [
  [/photo \/ video \/ pdf/, 'Files, encodings & metadata'],
  [/legacy encoding|mojibake/, 'Files, encodings & metadata'],
  [/messy document/, 'Documents & markup'],
  [/\bpdf\b/, 'PDF'],
  [/markdown|docx|\bhtml\b|\bdom\b|ebook|mobi|azw3|office|pptx/, 'Documents & markup'],
  [/video|audio|speech|\bwav\b|flac/, 'Audio & video'],
  [/image|photo|heic|\bsvg\b|screenshot/, 'Images'],
  [/json|\bcsv\b|sqlite|yaml|xlsx|spreadsheet/, 'Data & tabular'],
];

const CATEGORY_ORDER = [
  'Documents & markup',
  'PDF',
  'Data & tabular',
  'Images',
  'Audio & video',
  'Files, encodings & metadata',
  'Other',
];

function categoryOf(entry) {
  const hay = String(entry.x).toLowerCase();
  for (const [re, name] of CATEGORY_RULES) if (re.test(hay)) return name;
  return 'Other';
}

// ---------------------------------------------------------------- helpers

const esc = (s) =>
  String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const oneLine = (s) => String(s).replace(/\s+/g, ' ').trim();

// Prose fields are authored with Markdown-style inline code. Escape first, then
// promote balanced backtick pairs to <code> — the escaped text contains no raw
// '<', so the tags added afterwards are the only markup in the output. An
// unpaired backtick stays a literal backtick.
const inline = (s) => esc(oneLine(s)).replace(/`([^`]+)`/g, '<code>$1</code>');

const firstSentence = (s) => {
  const t = oneLine(s);
  const m = t.split(/(?<=[.!?])\s+/);
  return m[0] || t;
};

const daysSince = (isoDate) => {
  const then = Date.parse(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(then)) return Infinity;
  return Math.floor((Date.now() - then) / 86400000);
};

// entries.yaml dates may parse as JS Date (YAML 1.1 timestamps) or as strings.
const asDate = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).trim());

// ---------------------------------------------------------------- load

const raw = yaml.load(readFileSync(join(ROOT, 'entries.yaml'), 'utf8'));
const entries = (raw && raw.entries) || [];
if (!entries.length) {
  console.error('build: entries.yaml has no entries');
  process.exit(1);
}

const problems = [];
const ids = new Set();
for (const e of entries) {
  e.verified = asDate(e.verified);
  for (const f of REQUIRED) {
    if (!e[f] || !String(e[f]).trim()) problems.push(`${e.id || '(no id)'}: missing field "${f}"`);
  }
  if (!KINDS.has(e.kind)) problems.push(`${e.id}: kind "${e.kind}" is not deterministic|model|hybrid`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(e.verified)) problems.push(`${e.id}: verified "${e.verified}" is not YYYY-MM-DD`);
  if (ids.has(e.id)) problems.push(`${e.id}: duplicate id`);
  ids.add(e.id);
}
if (problems.length) {
  console.error('build: entries.yaml failed validation');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}

// Staleness surfacing (dossier § Components 7). No entry is dropped; the build
// says which verdicts are due for the refresh pass, and the page marks them.
const stale = entries.filter((e) => daysSince(e.verified) > STALE_AFTER_DAYS);
for (const e of stale) {
  console.warn(`build: STALE — ${e.id} verified ${e.verified} (${daysSince(e.verified)} days ago)`);
}
const isStale = (e) => daysSince(e.verified) > STALE_AFTER_DAYS;

// Group by X-category, preserving source order inside each group.
const grouped = new Map(CATEGORY_ORDER.map((c) => [c, []]));
for (const e of entries) grouped.get(categoryOf(e)).push(e);
const sections = CATEGORY_ORDER.map((c) => [c, grouped.get(c)]).filter(([, list]) => list.length);

// ---------------------------------------------------------------- css

const CSS = `
/* LEMON house system. House chrome only — no citrus variety tint.
   Accents flavor, never flood: accent inks are for text, the bright
   accent is a background for chips alone. */
:root {
  color-scheme: light dark;
  --bg: #f5f3e9;
  --ink: #24271f;
  --muted: #666c5d;
  --card: #fbfaf4;
  --border: rgba(36, 39, 31, 0.15);
  --code-ink: #454a3e;
  --code-bg: rgba(36, 39, 31, 0.07);
  --term-bg: #151710;
  --term-ink: #dfe3d4;
  --chip-ink: #202319;
  --accent: #c7d86f;
  --accent-ink: #5e7024;
  --accent-soft: rgba(199, 216, 111, 0.15);
  --accent-hover: #8b9d43;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #12140f;
    --ink: #dde1d4;
    --muted: #969d8c;
    --card: #171a14;
    --border: rgba(189, 207, 120, 0.16);
    --code-ink: #c8cfbb;
    --code-bg: rgba(189, 207, 120, 0.09);
    --term-bg: #0b0d09;
    --term-ink: #d9ddcf;
    --accent: #b8c970;
    --accent-ink: #bdcf78;
    --accent-soft: rgba(189, 207, 120, 0.10);
    --accent-hover: #87964f;
  }
}
* { box-sizing: border-box; }
html { background: var(--bg); }
body {
  margin: 0;
  font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  font-size: 1rem;
  line-height: 1.68;
  color: var(--ink);
  -webkit-text-size-adjust: 100%;
}
body::before {
  content: '';
  display: block;
  height: 3px;
  background: linear-gradient(90deg, var(--accent), transparent 85%);
}
::selection { background: var(--accent); color: var(--chip-ink); }
main { max-width: 72ch; margin: 0 auto; padding: 2.5rem 1.25rem 4rem; }

a { color: var(--accent-ink); text-decoration-thickness: 1px; text-underline-offset: 3px; }
a:hover { text-decoration-thickness: 2px; color: var(--accent-hover); }

h1 { font-size: clamp(2rem, 6vw, 3.2rem); line-height: 1.08; letter-spacing: -0.035em; margin: 0.4rem 0 0.5rem; }
h2 { font-size: clamp(1.35rem, 3.2vw, 1.7rem); font-weight: 700; line-height: 1.25; letter-spacing: -0.02em; margin: 3rem 0 0.8rem; }
h2::before { content: '// '; color: var(--accent-ink); }
h3 { font-size: 1.08rem; line-height: 1.35; margin: 0 0 0.35rem; letter-spacing: -0.01em; }

code {
  font-family: ui-monospace, Menlo, Monaco, Consolas, monospace;
  font-size: 0.92em;
  background: var(--code-bg);
  color: var(--code-ink);
  padding: 0.08em 0.35em;
}
pre {
  font-family: ui-monospace, Menlo, Monaco, Consolas, monospace;
  background: var(--term-bg);
  color: var(--term-ink);
  border: 1px solid var(--border);
  padding: 0.7rem 0.9rem;
  margin: 0.85rem 0;
  overflow-x: auto;
  font-size: 0.85rem;
  line-height: 1.6;
}
pre code { background: none; color: inherit; padding: 0; font-size: inherit; }

.site-header {
  display: flex; align-items: center; justify-content: space-between;
  gap: 1.5rem; flex-wrap: wrap;
  margin-bottom: 3rem; padding-bottom: 1rem;
  border-bottom: 1px solid var(--border);
}
.site-brand {
  color: var(--muted); text-decoration: none;
  font-weight: 700; letter-spacing: 0.12em; font-size: 0.75rem;
  font-family: ui-monospace, Menlo, Monaco, Consolas, monospace;
}
.site-brand:hover { color: var(--accent-ink); }
.site-nav { display: flex; align-items: center; gap: 1.1rem; flex-wrap: wrap; }
.site-nav a { color: var(--muted); text-decoration: none; font-size: 0.86rem; font-weight: 650; }
.site-nav a:hover { color: var(--accent-ink); }

.strapline { color: var(--muted); margin: 0 0 1.5rem; font-size: 1.05rem; }
.stance { font-size: 1.02rem; }
.note { color: var(--muted); font-size: 0.92rem; }

.chip {
  display: inline-block; background: var(--accent); color: var(--chip-ink);
  font-weight: 700; letter-spacing: 0.08em; padding: 0.05em 0.45em;
  font-size: 0.72rem; text-transform: uppercase;
  font-family: ui-monospace, Menlo, Monaco, Consolas, monospace;
}

.filter-wrap { margin: 2.5rem 0 0; display: flex; align-items: baseline; gap: 0.75rem; flex-wrap: wrap; }
#filter {
  flex: 1 1 18rem; min-width: 0;
  font: inherit; font-size: 0.95rem;
  padding: 0.5rem 0.7rem;
  color: var(--ink); background: var(--card);
  border: 1px solid var(--border); border-radius: 2px;
}
#filter:focus { outline: 2px solid var(--accent); outline-offset: 1px; border-color: var(--accent-hover); }
#filter-count { color: var(--muted); font-size: 0.85rem; font-family: ui-monospace, Menlo, Monaco, Consolas, monospace; }

.entry {
  border: 1px solid var(--border);
  background: var(--card);
  padding: 1.1rem 1.15rem;
  margin: 1rem 0;
  scroll-margin-top: 1.5rem;
}
.entry:target { border-color: var(--accent-hover); background: var(--accent-soft); }
.pair-arrow { color: var(--accent-ink); padding: 0 0.25em; }
.tool-line { margin: 0 0 0.7rem; font-size: 0.9rem; }
.tool-name { font-family: ui-monospace, Menlo, Monaco, Consolas, monospace; font-weight: 700; }
.kind {
  display: inline-block; margin-left: 0.5rem;
  font-size: 0.68rem; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase;
  font-family: ui-monospace, Menlo, Monaco, Consolas, monospace;
  padding: 0.1em 0.5em;
}
.kind-deterministic { background: var(--accent); color: var(--chip-ink); }
.kind-hybrid { background: var(--accent-soft); color: var(--accent-ink); border: 1px solid var(--border); }
.kind-model { background: transparent; color: var(--accent-ink); border: 1px solid var(--accent-hover); }
.verdict { margin: 0 0 0.2rem; }
.meta { margin: 0.55rem 0 0; font-size: 0.93rem; color: var(--muted); }
.meta .label {
  font-family: ui-monospace, Menlo, Monaco, Consolas, monospace;
  font-size: 0.72rem; letter-spacing: 0.08em; text-transform: uppercase;
  color: var(--accent-ink); margin-right: 0.4em;
}
.entry-foot {
  margin: 0.9rem 0 0; padding-top: 0.7rem; border-top: 1px solid var(--border);
  display: flex; justify-content: space-between; align-items: baseline; gap: 1rem; flex-wrap: wrap;
  font-size: 0.85rem;
}
.verified { color: var(--muted); font-family: ui-monospace, Menlo, Monaco, Consolas, monospace; font-size: 0.78rem; }
.verified.stale { color: var(--accent-hover); font-weight: 700; }
.anchor { color: var(--muted); text-decoration: none; font-family: ui-monospace, Menlo, Monaco, Consolas, monospace; font-size: 0.78rem; }
.anchor:hover { color: var(--accent-ink); }

.empty { color: var(--muted); font-style: italic; display: none; }
.empty.shown { display: block; }

footer { margin-top: 4rem; padding-top: 1.25rem; border-top: 1px solid var(--border); color: var(--muted); font-size: 0.9rem; }
`.trim();

// ---------------------------------------------------------------- beacon

// Beacon client (dossier § Components 3). Outbound links stay plain <a href>
// with no redirect, so they work with this script blocked and the target gets an
// ordinary referrer. sendBeacon survives the unload the click causes; delivery is
// still best-effort, so the click count is a floor.
const BEACON_JS = `
(function () {
  var B = ${JSON.stringify(BEACON_URL)};
  function send(t, e) {
    if (!navigator || typeof navigator.sendBeacon !== 'function') return;
    try { navigator.sendBeacon(B, JSON.stringify(e ? { t: t, e: e } : { t: t })); } catch (err) {}
  }
  send('visit');
  document.addEventListener('click', function (ev) {
    var el = ev.target;
    var hit = el && el.closest ? el.closest('[data-entry]') : null;
    if (!hit) return;
    send('click', hit.getAttribute('data-entry'));
  }, true);
})();
`.trim();

const FILTER_JS = `
(function () {
  var box = document.getElementById('filter');
  var count = document.getElementById('filter-count');
  var empty = document.getElementById('no-matches');
  if (!box) return;
  var entries = Array.prototype.slice.call(document.querySelectorAll('.entry'));
  var sections = Array.prototype.slice.call(document.querySelectorAll('.category'));
  var total = entries.length;
  function apply() {
    var q = box.value.trim().toLowerCase();
    var shown = 0;
    entries.forEach(function (el) {
      var hit = !q || el.getAttribute('data-search').indexOf(q) !== -1;
      el.hidden = !hit;
      if (hit) shown++;
    });
    sections.forEach(function (sec) {
      var any = sec.querySelector('.entry:not([hidden])');
      sec.hidden = !any;
    });
    if (empty) empty.classList.toggle('shown', shown === 0);
    if (count) count.textContent = shown === total ? total + ' pairs' : shown + ' of ' + total + ' pairs';
  }
  box.addEventListener('input', apply);
  apply();
})();
`.trim();

// ---------------------------------------------------------------- index.html

function renderEntry(e) {
  const search = esc(oneLine(`${e.x} ${e.y} ${e.tool}`).toLowerCase());
  const staleMark = isStale(e) ? ' stale' : '';
  const staleNote = isStale(e) ? ' · review due' : '';
  return `      <article class="entry" id="${esc(e.id)}" data-search="${search}">
        <h3><span class="pair-x">${esc(oneLine(e.x))}</span><span class="pair-arrow">&rarr;</span><span class="pair-y">${esc(oneLine(e.y))}</span></h3>
        <p class="tool-line"><span class="tool-name">${esc(e.tool)}</span><span class="kind kind-${esc(e.kind)}">${esc(e.kind)}</span></p>
        <p class="verdict">${inline(e.verdict)}</p>
        <pre><code>${esc(oneLine(e.install))}</code></pre>
        <p class="meta"><span class="label">Caveats</span>${inline(e.caveats)}</p>
        <p class="meta"><span class="label">Escalate</span>${inline(e.escalate)}</p>
        <p class="entry-foot">
          <a href="${esc(e.url)}" data-entry="${esc(e.id)}" rel="noopener">${esc(e.url)}</a>
          <span class="verified${staleMark}">verified ${esc(e.verified)}${staleNote}</span>
        </p>
      </article>`;
}

function renderSection([category, list]) {
  const slug = category.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return `    <section class="category" id="cat-${slug}">
      <h2>${esc(category)}</h2>
${list.map(renderEntry).join('\n')}
    </section>`;
}

const FAVICON =
  'data:image/svg+xml,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" fill="#c7d86f"/></svg>'
  );

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${SITE_NAME} — ${STRAPLINE}</title>
<meta name="description" content="A curated directory of file-conversion tools at the use-case layer: which converter, when. Deterministic tool wherever it suffices; a model only where the target is judgment-defined.">
<link rel="icon" href="${FAVICON}">
<style>
${CSS}
</style>
</head>
<body>
<main>
  <header class="site-header">
    <a class="site-brand" href="https://lemon-agent.dev/">LEMON</a>
    <nav class="site-nav" aria-label="Primary">
      <a href="#entries">Entries</a>
      <a href="#how-we-count">How we count</a>
      <a href="#privacy">Privacy</a>
      <a href="catalog.json">catalog.json</a>
      <a href="llms.txt">llms.txt</a>
    </nav>
  </header>

  <h1>${SITE_NAME}</h1>
  <p class="strapline">${STRAPLINE}</p>

  <p class="stance">${esc(STANCE)}</p>
  <p class="note">Curation is an owner-taste surface. These ${entries.length} entries are drafts for review, not a finished list.</p>

  <h2 id="how-we-count">How we count</h2>
  <p>This page runs a small script that reports two things: that the page loaded, and which outbound link was clicked. Nothing else is collected, and links are plain links — no redirects, no interstitials, so they work with the script blocked.</p>
  <p>The counting policy, stated plainly: ${esc(BOT_POLICY)}. Delivery of the click signal is best-effort, so the click number is a floor rather than a total.</p>

  <h2 id="privacy">Privacy</h2>
  <p>There are two stores here, and they have two different answers to a subject-rights request.</p>
  <p><strong>The beacon store</strong> holds a truncated, daily-salted hash — not an address, not an identifier that survives the day. The salt is overwritten with fresh random bytes at the first request of each UTC day, and the overwrite is the discard: once the salt is gone, nothing in the store is attributable to a requester. Raw rows are kept 90 days at most, then compacted to aggregates and deleted.</p>
  <p><strong>An IP blocklist</strong> exists for abuse defence. It is keyed on the address, is therefore attributable, and is purged on request; rows expire 90 days after last-seen.</p>

  <div class="filter-wrap" id="entries">
    <input id="filter" type="search" placeholder="Filter by what you have, what you need, or the tool…" aria-label="Filter entries">
    <span id="filter-count">${entries.length} pairs</span>
  </div>
  <p class="empty" id="no-matches">No pair matches that. Try a format name — pdf, csv, epub, docx.</p>

${sections.map(renderSection).join('\n')}

  <footer>
    <p><span class="chip">LEMON</span> ${SITE_NAME} — ${STRAPLINE}</p>
    <p>Machine surface: <a href="catalog.json">catalog.json</a> · <a href="llms.txt">llms.txt</a>. Entry set generated from <code>entries.yaml</code> on ${new Date().toISOString().slice(0, 10)}.</p>
    <p>Provenance: mostly AI-generated, human-guided and reviewed. Verdicts are engineering judgment, not measurement.</p>
  </footer>
</main>
<script>
${FILTER_JS}
</script>
<script>
${BEACON_JS}
</script>
</body>
</html>
`;

// ---------------------------------------------------------------- catalog.json

const catalog = {
  generated: new Date().toISOString(),
  source: 'entries.yaml',
  entries: entries.map((e) => ({
    id: e.id,
    x: oneLine(e.x),
    y: oneLine(e.y),
    tool: e.tool,
    kind: e.kind,
    verdict: oneLine(e.verdict),
    install: oneLine(e.install),
    url: e.url,
    caveats: oneLine(e.caveats),
    escalate: oneLine(e.escalate),
    verified: e.verified,
  })),
};

// ---------------------------------------------------------------- llms.txt

const llms = [
  `# ${SITE_NAME} — ${STRAPLINE}`,
  '',
  `A curated directory of file-conversion tools at the use-case layer. The unit is the pair — what you have, what you need — not the tool: ${entries.length} pairs, each naming one tool worth reaching for, with the install line, the caveats that bite, and where a model is honestly warranted. Structured fields are in catalog.json alongside this file.`,
  '',
  `Editorial stance: ${STANCE}`,
  '',
  ...sections.flatMap(([category, list]) => [
    `## ${category}`,
    ...list.map(
      (e) =>
        `${oneLine(e.x)} -> ${oneLine(e.y)}: ${e.tool} (${e.kind}) — ${firstSentence(e.verdict)} — ${e.url}`
    ),
    '',
  ]),
].join('\n');

// ---------------------------------------------------------------- emit

rmSync(DIST, { recursive: true, force: true });
mkdirSync(DIST, { recursive: true });
writeFileSync(join(DIST, 'index.html'), html);
writeFileSync(join(DIST, 'catalog.json'), `${JSON.stringify(catalog, null, 2)}\n`);
writeFileSync(join(DIST, 'llms.txt'), llms);

console.log(`build: ${entries.length} entries in ${sections.length} categories`);
for (const [category, list] of sections) console.log(`  ${category}: ${list.length}`);
console.log(`build: beacon URL ${BEACON_URL}`);
console.log(`build: stale entries ${stale.length}`);
console.log('build: wrote dist/index.html dist/catalog.json dist/llms.txt');
