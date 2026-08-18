#!/usr/bin/env node
// Toolshed build step.
//
// Reads entries.yaml and emits the read surface into dist/:
//   index.html      — the human page (shelves, have/need picker, how-we-count, privacy)
//   catalog.json    — the machine surface, verbatim entry fields
//   llms.txt        — the machine surface, one line per pair
//   llms-full.txt   — the machine surface, full verdicts
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

// Build-time constant. The hostname printed in the "For agents" curl lines.
// Override for the local demo: SITE_HOST=localhost:4173
const HOST = process.env.SITE_HOST || 'toolshed.lemon-agent.dev';
// A demo host has to print a command that actually works, so the scheme follows
// the host rather than being hard-coded to https.
const SCHEME = /^(localhost|127\.0\.0\.1|\[::1\])(:|$)/.test(HOST) ? 'http' : 'https';
const BASE = `${SCHEME}://${HOST}`;

const SITE_NAME = 'Toolshed';
const HOUSE = 'Lemon';
const KICKER = 'the Lemon';
const STRAPLINE = 'Which tool, when. Every entry is a verdict, not a listing.';
const TITLE = `${SITE_NAME} — which tool, when · ${HOUSE}`;

// Refresh cadence is monthly (~4 h/month, dossier § Estimates). Entries whose
// `verified` date predates it are flagged in the build (dossier § Components 7).
const STALE_AFTER_DAYS = 35;

const KINDS = ['deterministic', 'model', 'hybrid'];
const KIND_SET = new Set(KINDS);
const REQUIRED = ['id', 'x', 'y', 'tool', 'kind', 'verdict', 'install', 'url', 'caveats', 'escalate', 'verified'];

// The editorial stance, published on the page and in the machine surfaces.
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

// X-categories — the shelves. Ordered rules, first match wins, matched against
// the lowercased `x` field. Editorial grouping — deliberately shallow, and easy
// to eyeball.
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

const slugify = (s) =>
  String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

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
  if (!KIND_SET.has(e.kind)) problems.push(`${e.id}: kind "${e.kind}" is not deterministic|model|hybrid`);
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

const BUILD_DATE = new Date().toISOString().slice(0, 10);

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
[hidden] { display: none !important; }
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
main { max-width: 1080px; margin: 0 auto; padding: 2.5rem 1.25rem 4rem; }

/* The reading column. The grid uses the full 1080; prose stays legible. */
.prose { max-width: 72ch; margin-left: auto; margin-right: auto; }

a { color: var(--accent-ink); text-decoration-thickness: 1px; text-underline-offset: 3px; }
a:hover { text-decoration-thickness: 2px; color: var(--accent-hover); }

h1 {
  font-size: clamp(2.8rem, 8vw, 4.5rem);
  line-height: 1.02;
  letter-spacing: -0.045em;
  margin: 0.1rem 0 0.6rem;
}
h2 { font-size: clamp(1.35rem, 3.2vw, 1.7rem); font-weight: 700; line-height: 1.25; letter-spacing: -0.02em; margin: 3rem 0 0.9rem; }
h2::before { content: '// '; color: var(--accent-ink); }
h3 { font-size: 1.05rem; font-weight: 700; line-height: 1.3; margin: 0 0 0.5rem; letter-spacing: -0.01em; }

code {
  font-family: ui-monospace, Menlo, Monaco, Consolas, monospace;
  font-size: 0.92em;
  background: var(--code-bg);
  color: var(--code-ink);
  padding: 0.08em 0.35em;
}

/* ---- header ---------------------------------------------------------- */
.site-header {
  display: flex; align-items: center; justify-content: space-between;
  gap: 1.5rem; flex-wrap: wrap;
  margin-bottom: 2.5rem; padding-bottom: 1rem;
  border-bottom: 1px solid var(--border);
}
.site-brand { text-decoration: none; }
.site-nav { display: flex; align-items: center; gap: 1.1rem; flex-wrap: wrap; }
.site-nav a { color: var(--muted); text-decoration: none; font-size: 0.86rem; font-weight: 650; }
.site-nav a:hover { color: var(--accent-ink); }

.chip {
  display: inline-block; background: var(--accent); color: var(--chip-ink);
  font-weight: 700; letter-spacing: 0.14em; padding: 0.1em 0.5em;
  font-size: 0.72rem; text-transform: uppercase;
  font-family: ui-monospace, Menlo, Monaco, Consolas, monospace;
}

/* ---- hero ------------------------------------------------------------ */
.kicker {
  margin: 0; color: var(--accent-ink);
  font-family: ui-monospace, Menlo, Monaco, Consolas, monospace;
  font-size: 0.78rem; letter-spacing: 0.16em; text-transform: lowercase;
}
.strapline { color: var(--muted); margin: 0 0 1.6rem; font-size: 1.08rem; }
.stance { font-size: 1.02rem; margin: 0 0 0.9rem; }
.note { color: var(--muted); font-size: 0.92rem; }
.draft-note { margin: 0 0 0.4rem; }

/* ---- the have/need picker -------------------------------------------- */
.picker { margin: 2.4rem 0 0.9rem; }
.picker-fields { display: flex; align-items: flex-end; gap: 0.9rem; }
.field { flex: 1 1 0; min-width: 0; display: flex; flex-direction: column; gap: 0.3rem; }
.field label {
  color: var(--muted); font-size: 0.75rem; letter-spacing: 0.1em; text-transform: uppercase;
  font-family: ui-monospace, Menlo, Monaco, Consolas, monospace;
}
.field input {
  font: inherit; font-size: 0.98rem; width: 100%; min-width: 0;
  padding: 0.55rem 0.7rem;
  color: var(--ink); background: var(--card);
  border: 1px solid var(--border); border-radius: 6px;
}
.field input:focus { outline: 2px solid var(--accent); outline-offset: 1px; border-color: var(--accent-hover); }
.picker-arrow {
  color: var(--accent-ink); font-size: 2rem; line-height: 1; padding-bottom: 0.4rem;
  flex: 0 0 auto; user-select: none;
}
.count-line {
  margin: 0.9rem 0 0; color: var(--muted);
  font-family: ui-monospace, Menlo, Monaco, Consolas, monospace; font-size: 0.82rem;
}
.chip-rows { margin: 0.9rem 0 0; display: flex; flex-direction: column; gap: 0.5rem; }
.chip-row { display: flex; align-items: center; gap: 0.4rem; flex-wrap: wrap; }
.chip-row .row-label {
  color: var(--muted); font-size: 0.72rem; letter-spacing: 0.1em; text-transform: uppercase;
  font-family: ui-monospace, Menlo, Monaco, Consolas, monospace;
  margin-right: 0.2rem;
}
.chip-btn {
  font: inherit; cursor: pointer;
  background: var(--accent-soft); color: var(--accent-ink);
  border: 1px solid var(--border); border-radius: 999px;
  padding: 0.1em 0.7em;
  font-size: 0.72rem; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase;
  font-family: ui-monospace, Menlo, Monaco, Consolas, monospace;
}
.chip-btn:hover { border-color: var(--accent-hover); }
.chip-btn.on { background: var(--accent); color: var(--chip-ink); border-color: var(--accent-hover); }
.chip-btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.clear-btn {
  font: inherit; cursor: pointer; background: none; border: 0; padding: 0;
  color: var(--accent-ink); text-decoration: underline; text-underline-offset: 3px;
  font-size: 0.82rem;
}
.clear-btn:hover { color: var(--accent-hover); }
.empty { color: var(--muted); font-style: italic; margin: 1.5rem 0 0; }

/* ---- shelves --------------------------------------------------------- */
.shelf { margin: 0; }
.shelf h2 { margin-bottom: 1rem; }
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(330px, 100%), 1fr));
  gap: 1rem;
}

/* ---- card ------------------------------------------------------------ */
.card {
  border: 1px solid var(--border);
  border-color: color-mix(in srgb, var(--ink) 12%, transparent);
  border-radius: 10px;
  padding: 1rem;
  background: transparent;
  scroll-margin-top: 1.5rem;
  display: flex; flex-direction: column;
}
.card:hover, .card:target {
  border-color: var(--accent-hover);
  background: var(--accent-soft);
  background: color-mix(in srgb, var(--accent-soft) 55%, transparent);
}
.pair { display: block; }
.pair .arrow { color: var(--accent-ink); padding: 0 0.3em; }
.toolrow {
  margin: 0 0 0.6rem;
  display: flex; align-items: baseline; justify-content: space-between; gap: 0.6rem;
  font-size: 0.9rem;
}
.tool {
  font-family: ui-monospace, Menlo, Monaco, Consolas, monospace;
  font-weight: 700; color: var(--accent-ink);
  text-decoration: none; min-width: 0; overflow-wrap: anywhere;
}
.tool:hover { text-decoration: underline; color: var(--accent-hover); }
.kind {
  flex: 0 0 auto;
  font-size: 0.66rem; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase;
  font-family: ui-monospace, Menlo, Monaco, Consolas, monospace;
  padding: 0.1em 0.5em; border-radius: 3px;
  border: 1px solid transparent;
}
.kind-deterministic { background: var(--accent-soft); color: var(--accent-ink); }
.kind-model { background: transparent; color: var(--accent-ink); border: 1px dashed var(--border); }
.kind-hybrid { background: var(--accent-soft); color: var(--accent-ink); border: 1px dashed var(--accent-hover); }

.verdict {
  margin: 0 0 0.5rem; font-size: 0.94rem; line-height: 1.55;
  display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 4;
  line-clamp: 4; overflow: hidden;
}
.card:has(details[open]) .verdict {
  display: block; -webkit-line-clamp: unset; line-clamp: unset; overflow: visible;
}
details.more { margin: 0 0 0.75rem; }
details.more summary {
  cursor: pointer; list-style: none;
  color: var(--accent-ink); font-size: 0.78rem; font-weight: 700;
  letter-spacing: 0.08em; text-transform: uppercase;
  font-family: ui-monospace, Menlo, Monaco, Consolas, monospace;
}
details.more summary::-webkit-details-marker { display: none; }
details.more summary:hover { color: var(--accent-hover); }
details.more summary::after { content: ' \\203a'; }
details[open].more summary::after { content: ' \\2039'; }
.lbl-less { display: none; }
details[open].more .lbl-more { display: none; }
details[open].more .lbl-less { display: inline; }
.meta { margin: 0.55rem 0 0; font-size: 0.9rem; color: var(--muted); }
.meta .label {
  font-family: ui-monospace, Menlo, Monaco, Consolas, monospace;
  font-size: 0.7rem; letter-spacing: 0.08em; text-transform: uppercase;
  color: var(--accent-ink); margin-right: 0.4em;
}

/* ---- command rows (card installs + For agents) ----------------------- */
.cmd {
  display: flex; align-items: center; gap: 0.5rem;
  background: var(--term-bg); border: 1px solid var(--border);
  border-radius: 6px; padding: 0.45rem 0.5rem 0.45rem 0.7rem;
  margin: 0 0 0.75rem;
}
/* Inside a card the install row is pushed to the bottom, so installs and
   verified dates line up across a grid row however the verdicts clamp. */
.card > .cmd { margin-top: auto; }
.cmd code {
  flex: 1 1 auto; min-width: 0;
  background: none; color: var(--term-ink); padding: 0;
  font-size: 0.8rem; white-space: pre; overflow-x: auto;
}
.copy {
  flex: 0 0 auto; cursor: pointer;
  font-family: ui-monospace, Menlo, Monaco, Consolas, monospace;
  font-size: 0.66rem; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase;
  color: var(--term-ink); background: transparent;
  border: 1px solid rgba(223, 227, 212, 0.28); border-radius: 4px;
  padding: 0.2em 0.55em;
}
.copy:hover { border-color: var(--accent); color: var(--accent); }
.copy.copied { background: var(--accent); color: var(--chip-ink); border-color: var(--accent); }
.copy:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }

.cardfoot {
  margin: 0; padding-top: 0.6rem; border-top: 1px solid var(--border);
  font-size: 0.85rem;
}
.verified { color: var(--muted); font-family: ui-monospace, Menlo, Monaco, Consolas, monospace; font-size: 0.74rem; }
.verified.stale { color: var(--accent-hover); font-weight: 700; }

/* ---- for agents ------------------------------------------------------ */
.agent-row { margin: 0 0 1.1rem; }
.agent-row .note { margin: -0.35rem 0 0; }

/* ---- footer ---------------------------------------------------------- */
footer { margin-top: 4rem; padding-top: 1.25rem; border-top: 1px solid var(--border); color: var(--muted); font-size: 0.9rem; }
footer .foot-nav { display: flex; gap: 0.9rem; flex-wrap: wrap; margin: 0.6rem 0 0; }
footer .foot-nav a { color: var(--muted); text-decoration: none; font-size: 0.84rem; }
footer .foot-nav a:hover { color: var(--accent-ink); }

/* ---- progressive enhancement ----------------------------------------- */
html:not(.js) .js-only { display: none !important; }

/* ---- mobile ---------------------------------------------------------- */
@media (max-width: 640px) {
  main { padding: 2rem 1rem 3rem; }
  .picker-fields { flex-direction: column; align-items: stretch; gap: 0.55rem; }
  .picker-arrow { padding: 0; text-align: center; transform: rotate(90deg); }
}
`.trim();

// ---------------------------------------------------------------- beacon

// Beacon client (dossier § Components 3). Outbound links stay plain <a href>
// with no redirect, so they work with this script blocked and the target gets an
// ordinary referrer. sendBeacon survives the unload the click causes; delivery is
// still best-effort, so the click count is a floor.
//
// Two event types, and only two: `visit` on load and `click` on a delegated
// listener over [data-entry] links. Filter and copy interactions send nothing.
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

// Progressive enhancement: the have/need picker, the shelf and kind chips, and
// the install copy buttons. Sends nothing anywhere — the beacon is the only
// network client on this page, and it counts two events, neither of them here.
const ENHANCE_JS = `
(function () {
  var doc = document;
  doc.documentElement.className += ' js';

  function ready(fn) {
    if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', fn);
    else fn();
  }

  function list(sel) { return Array.prototype.slice.call(doc.querySelectorAll(sel)); }
  function any(map) { for (var k in map) { if (map[k]) return true; } return false; }

  ready(function () {
    var have = doc.getElementById('have');
    var need = doc.getElementById('need');
    var count = doc.getElementById('count');
    var clear = doc.getElementById('clear');
    var empty = doc.getElementById('no-matches');
    var cards = list('.card');
    var shelves = list('.shelf');
    var chips = list('.chip-btn');
    var total = cards.length;
    var nShelves = shelves.length;
    var shelfOn = {};
    var kindOn = {};

    function apply() {
      var a = have ? have.value.trim().toLowerCase() : '';
      var b = need ? need.value.trim().toLowerCase() : '';
      var shelfActive = any(shelfOn);
      var kindActive = any(kindOn);
      var shown = 0;
      cards.forEach(function (el) {
        var hay = el.getAttribute('data-search') || '';
        var ok = (!a || hay.indexOf(a) !== -1) && (!b || hay.indexOf(b) !== -1);
        if (ok && shelfActive) ok = !!shelfOn[el.getAttribute('data-shelf')];
        if (ok && kindActive) ok = !!kindOn[el.getAttribute('data-kind')];
        el.hidden = !ok;
        if (ok) shown++;
      });
      shelves.forEach(function (sec) {
        sec.hidden = !sec.querySelector('.card:not([hidden])');
      });
      if (count) {
        count.textContent = shown === total
          ? total + ' verdicts \\u00b7 ' + nShelves + ' shelves'
          : shown + ' of ' + total + ' verdicts match';
      }
      if (empty) empty.hidden = shown !== 0;
      if (clear) clear.hidden = !(a || b || shelfActive || kindActive);
    }

    chips.forEach(function (btn) {
      var map = btn.getAttribute('data-facet') === 'kind' ? kindOn : shelfOn;
      var key = btn.getAttribute('data-value');
      btn.addEventListener('click', function () {
        var on = !map[key];
        map[key] = on;
        btn.className = on ? 'chip-btn on' : 'chip-btn';
        btn.setAttribute('aria-pressed', on ? 'true' : 'false');
        apply();
      });
    });

    if (have) have.addEventListener('input', apply);
    if (need) need.addEventListener('input', apply);
    if (clear) {
      clear.addEventListener('click', function () {
        if (have) have.value = '';
        if (need) need.value = '';
        chips.forEach(function (btn) {
          var map = btn.getAttribute('data-facet') === 'kind' ? kindOn : shelfOn;
          map[btn.getAttribute('data-value')] = false;
          btn.className = 'chip-btn';
          btn.setAttribute('aria-pressed', 'false');
        });
        apply();
      });
    }

    var canCopy = !!(navigator.clipboard && navigator.clipboard.writeText);
    list('.copy').forEach(function (btn) {
      if (!canCopy) { btn.hidden = true; return; }
      btn.addEventListener('click', function () {
        var row = btn.closest ? btn.closest('.cmd') : null;
        var code = row ? row.querySelector('code') : null;
        if (!code) return;
        navigator.clipboard.writeText(code.textContent).then(function () {
          btn.textContent = 'copied';
          btn.className = 'copy js-only copied';
          setTimeout(function () {
            btn.textContent = 'copy';
            btn.className = 'copy js-only';
          }, 1200);
        }, function () {});
      });
    });

    apply();
  });
})();
`.trim();

// ---------------------------------------------------------------- index.html

function cmdRow(command, label) {
  return `<div class="cmd"><code>${esc(command)}</code><button type="button" class="copy js-only" aria-label="${esc(label)}">copy</button></div>`;
}

function renderCard(e, shelfSlug) {
  const search = esc(oneLine(`${e.x} ${e.y} ${e.tool} ${e.verdict}`).toLowerCase());
  const staleMark = isStale(e) ? ' stale' : '';
  const staleNote = isStale(e) ? ' · review due' : '';
  return `        <article class="card" id="${esc(e.id)}"
          data-x="${esc(oneLine(e.x).toLowerCase())}"
          data-y="${esc(oneLine(e.y).toLowerCase())}"
          data-tool="${esc(String(e.tool).toLowerCase())}"
          data-kind="${esc(e.kind)}"
          data-shelf="${esc(shelfSlug)}"
          data-search="${search}">
          <h3 class="pair">${esc(oneLine(e.x))}<span class="arrow">&rarr;</span>${esc(oneLine(e.y))}</h3>
          <p class="toolrow">
            <a class="tool" href="${esc(e.url)}" data-entry="${esc(e.id)}" rel="noopener">${esc(e.tool)}</a>
            <span class="kind kind-${esc(e.kind)}">${esc(e.kind)}</span>
          </p>
          <p class="verdict">${inline(e.verdict)}</p>
          <details class="more">
            <summary><span class="lbl-more">more</span><span class="lbl-less">less</span></summary>
            <p class="meta"><span class="label">Caveats</span>${inline(e.caveats)}</p>
            <p class="meta"><span class="label">Escalate</span>${inline(e.escalate)}</p>
          </details>
          ${cmdRow(oneLine(e.install), `Copy install command for ${e.tool}`)}
          <p class="cardfoot"><span class="verified${staleMark}">verified ${esc(e.verified)}${staleNote}</span></p>
        </article>`;
}

function renderShelf([category, list]) {
  const slug = slugify(category);
  return `    <section class="shelf" id="shelf-${slug}">
      <h2>${esc(category)}</h2>
      <div class="grid">
${list.map((e) => renderCard(e, slug)).join('\n')}
      </div>
    </section>`;
}

const shelfChips = sections
  .map(
    ([category]) =>
      `<button type="button" class="chip-btn" data-facet="shelf" data-value="${esc(slugify(category))}" aria-pressed="false">${esc(category)}</button>`
  )
  .join('\n        ');

const kindChips = KINDS.map(
  (k) => `<button type="button" class="chip-btn" data-facet="kind" data-value="${k}" aria-pressed="false">${k}</button>`
).join('\n        ');

const NAV = [
  ['#shelves', 'Shelves'],
  ['#for-agents', 'For agents'],
  ['#how-we-count', 'How we count'],
  ['#privacy', 'Privacy'],
  ['catalog.json', 'catalog.json'],
  ['llms.txt', 'llms.txt'],
  ['llms-full.txt', 'llms-full.txt'],
];

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
<title>${esc(TITLE)}</title>
<meta name="description" content="A curated directory of file-conversion tools at the use-case layer: which tool, when. Deterministic tool wherever it suffices; a model only where the target is judgment-defined.">
<link rel="icon" href="${FAVICON}">
<style>
${CSS}
</style>
<script>
${ENHANCE_JS}
</script>
</head>
<body>
<main>
  <header class="site-header">
    <a class="site-brand" href="https://lemon-agent.dev/"><span class="chip">${HOUSE}</span></a>
    <nav class="site-nav" aria-label="Primary">
${NAV.map(([href, label]) => `      <a href="${href}">${esc(label)}</a>`).join('\n')}
    </nav>
  </header>

  <div class="prose">
    <p class="kicker">${esc(KICKER)}</p>
    <h1>${SITE_NAME}</h1>
    <p class="strapline">${esc(STRAPLINE)}</p>

    <p class="stance">${esc(STANCE)}</p>
    <p class="note draft-note">Curation is an owner-taste surface. These ${entries.length} entries are drafts for review.</p>

    <div class="picker" id="shelves">
      <div class="picker-fields">
        <div class="field">
          <label for="have">I have…</label>
          <input id="have" type="search" autocomplete="off" placeholder="markdown · a scanned PDF · messy CSV">
        </div>
        <div class="picker-arrow" aria-hidden="true">&rarr;</div>
        <div class="field">
          <label for="need">I need…</label>
          <input id="need" type="search" autocomplete="off" placeholder="a PDF · clean UTF-8 · a transcript">
        </div>
      </div>
      <p class="count-line"><span id="count">${entries.length} verdicts · ${sections.length} shelves</span> <button type="button" class="clear-btn js-only" id="clear" hidden>clear</button></p>
      <div class="chip-rows js-only">
        <div class="chip-row">
          <span class="row-label">Shelves</span>
        ${shelfChips}
        </div>
        <div class="chip-row">
          <span class="row-label">Kind</span>
        ${kindChips}
        </div>
      </div>
    </div>
    <p class="note">Install one-liners assume <code>brew</code>, <code>npm</code>, <code>pip</code> or <code>uv</code> on your PATH; each card's copy button hands you the exact command, and <a href="catalog.json">catalog.json</a> carries the same strings machine-readable.</p>
    <p class="empty js-only" id="no-matches" hidden>No verdict matches that. Try a format name — pdf, csv, epub, docx.</p>
  </div>

${sections.map(renderShelf).join('\n')}

  <section class="prose" id="for-agents">
    <h2>For agents</h2>
    <p>This directory is machine-legible by design. The same verdicts a reader sees are published as files an agent can fetch in one request, with every field intact — no scraping, no HTML parsing, no key.</p>

    <div class="agent-row">
      ${cmdRow(`curl ${BASE}/catalog.json`, 'Copy catalog.json fetch command')}
      <p class="note">Structured entries — every field, including <code>install</code>.</p>
    </div>
    <div class="agent-row">
      ${cmdRow(`curl ${BASE}/llms.txt`, 'Copy llms.txt fetch command')}
      <p class="note">Compact index — one line per pair.</p>
    </div>
    <div class="agent-row">
      ${cmdRow(`curl ${BASE}/llms-full.txt`, 'Copy llms-full.txt fetch command')}
      <p class="note">Full verdicts, with caveats and escalate lines.</p>
    </div>

    <p>Links on this page are plain <code>href</code>s to the tool, with no redirect and no interstitial. There is no API and no MCP server, by design — the three files above are the whole machine surface.</p>
  </section>

  <section class="prose" id="how-we-count">
    <h2>How we count</h2>
    <p>This page runs a small script that reports two things: that the page loaded, and which outbound link was clicked. Nothing else is collected — filtering and copying send nothing — and links are plain links, so they work with the script blocked.</p>
    <p>The counting policy, stated plainly: ${esc(BOT_POLICY)}. Delivery of the click signal is best-effort, so the click number is a floor rather than a total.</p>
  </section>

  <section class="prose" id="privacy">
    <h2>Privacy</h2>
    <p>There are two stores here, and they have two different answers to a subject-rights request.</p>
    <p><strong>The beacon store</strong> holds a truncated, daily-salted hash — not an address, not an identifier that survives the day. The salt is overwritten with fresh random bytes at the first request of each UTC day, and the overwrite is the discard: once the salt is gone, nothing in the store is attributable to a requester. Raw rows are kept 90 days at most, then compacted to aggregates and deleted.</p>
    <p><strong>An IP blocklist</strong> exists for abuse defence. It is keyed on the address, is therefore attributable, and is purged on request; rows expire 90 days after last-seen.</p>
  </section>

  <footer>
    <p><span class="chip">${HOUSE}</span> ${SITE_NAME} — a ${HOUSE} field directory · built ${BUILD_DATE} · ${entries.length} verdicts, every one reviewed by a human.</p>
    <p>Provenance: mostly AI-generated, human-guided and reviewed. Verdicts are engineering judgment, not measurement. Entry set generated from <code>entries.yaml</code>.</p>
    <nav class="foot-nav" aria-label="Footer">
${NAV.map(([href, label]) => `      <a href="${href}">${esc(label)}</a>`).join('\n')}
    </nav>
  </footer>
</main>
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
  `# ${SITE_NAME} — which tool, when · a ${HOUSE} field directory`,
  '',
  `A curated directory of file-conversion tools at the use-case layer. The unit is the pair — what you have, what you need — not the tool: ${entries.length} pairs, each naming one tool worth reaching for, with the install line, the caveats that bite, and where a model is honestly warranted. Structured fields are in catalog.json alongside this file; the full verdicts, caveats and escalate lines are in llms-full.txt.`,
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

// ---------------------------------------------------------------- llms-full.txt

const llmsFull = [
  `# ${SITE_NAME} — which tool, when · a ${HOUSE} field directory`,
  '',
  `Site: ${BASE}`,
  `Generated: ${BUILD_DATE}`,
  `Source: entries.yaml — ${entries.length} verdicts across ${sections.length} shelves.`,
  '',
  `Editorial stance: ${STANCE}`,
  '',
  'Every verdict below is engineering judgment, not measurement. Curation is an',
  'owner-taste surface and these entries are drafts for review. The same fields are',
  'available as structured JSON in catalog.json.',
  '',
  ...sections.flatMap(([, list]) =>
    list.map((e) =>
      [
        `## ${oneLine(e.x)} -> ${oneLine(e.y)}`,
        `tool: ${e.tool}`,
        `kind: ${e.kind}`,
        `verdict: ${oneLine(e.verdict)}`,
        `install: ${oneLine(e.install)}`,
        `caveats: ${oneLine(e.caveats)}`,
        `escalate: ${oneLine(e.escalate)}`,
        `url: ${e.url}`,
        `verified: ${e.verified}`,
        '',
      ].join('\n')
    )
  ),
].join('\n');

// ---------------------------------------------------------------- emit

rmSync(DIST, { recursive: true, force: true });
mkdirSync(DIST, { recursive: true });
writeFileSync(join(DIST, 'index.html'), html);
writeFileSync(join(DIST, 'catalog.json'), `${JSON.stringify(catalog, null, 2)}\n`);
writeFileSync(join(DIST, 'llms.txt'), llms);
writeFileSync(join(DIST, 'llms-full.txt'), llmsFull);

console.log(`build: ${entries.length} entries on ${sections.length} shelves`);
for (const [category, list] of sections) console.log(`  ${category}: ${list.length}`);
console.log(`build: beacon URL ${BEACON_URL}`);
console.log(`build: site host ${BASE}`);
console.log(`build: stale entries ${stale.length}`);
console.log('build: wrote dist/index.html dist/catalog.json dist/llms.txt dist/llms-full.txt');
