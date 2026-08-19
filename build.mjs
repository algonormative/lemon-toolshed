#!/usr/bin/env node
// Toolshed build step.
//
// Reads entries.yaml and emits:
//   dist/index.html            — the page (picker, shelves, for-agents, notes)
//   dist/catalog.json          — every field, including the hosted/local blocks
//   dist/llms.txt              — one line per pair
//   dist/llms-full.txt         — full verdicts
//   worker/catalog.generated.js — the same catalog compiled into the API Worker,
//                                 so GET /check needs no fetch, no KV and no D1
//
// The read surface is static. The Pages project ships static assets and ZERO
// Functions (dossier § Limits): a Function re-opens the pages.dev twin's metered
// path. The conversion endpoints live in the Worker, not in Pages.
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

// Build-time constant. The hostname printed in the curl lines, and the host the
// Worker names as the `resource` in its x402 payment envelope.
// Override for the local demo: SITE_HOST=localhost:4173
const HOST_DEFAULT = 'toolshed.lemon-agent.dev';
const HOST = process.env.SITE_HOST || HOST_DEFAULT;
// A demo host has to print a command that actually works, so the scheme follows
// the host rather than being hard-coded to https.
const SCHEME = /^(localhost|127\.0\.0\.1|\[::1\])(:|$)/.test(HOST) ? 'http' : 'https';
const BASE = `${SCHEME}://${HOST}`;

// The Worker answers /convert and /check on the API host. In the local demo the
// page is served on one port and the Worker on another, so the printed curl
// lines have to point at the Worker rather than at the page.
// Override for the local demo: API_HOST=localhost:8787
const API_HOST = process.env.API_HOST || HOST;
const API_SCHEME = /^(localhost|127\.0\.0\.1|\[::1\])(:|$)/.test(API_HOST) ? 'http' : 'https';
const API_BASE = `${API_SCHEME}://${API_HOST}`;

// The free tier, in one place. This constant is the single source of truth for
// the number: it is printed on the page, published in catalog.json, llms.txt and
// llms-full.txt, AND compiled into worker/catalog.generated.js, which is where
// the Worker reads it to enforce the limit. Change it here and everything the
// site claims and everything it enforces move together.
//
// OWNER-TUNABLE. It is deliberately severe: a free tier exists to let an agent
// try the thing, not to be a free service, and the caller key it is counted
// against (a daily-salted hash of the IP alone) is the cheapest spoof-resistance
// available — a fresh identity costs a fresh IP, not a fresh user-agent string.
const FREE_TIER_DAILY = 3;

const SITE_NAME = 'Toolshed';
const HOUSE = 'Lemon';
const KICKER = 'the Lemon';
const STRAPLINE =
  'A collection of tools for agents — no install required. Privacy-first: no login, no credit card, ' +
  'no account. Every tool is free to try.';
const TITLE = `${SITE_NAME} — tools for agents · ${HOUSE}`;
const META_DESCRIPTION =
  `Conversion tools an agent can call over HTTP with nothing installed. No login, no credit card. ` +
  `Every tool is free to try — ${FREE_TIER_DAILY} conversions a day — then priced per call in USDC with x402.`;

// Refresh cadence is monthly (~4 h/month, dossier § Estimates). Entries whose
// `verified` date predates it are flagged in the build (dossier § Components 7).
const STALE_AFTER_DAYS = 35;

const KINDS = ['deterministic', 'model', 'hybrid'];
const KIND_SET = new Set(KINDS);
// `install` is required only when the entry has no `local:` block; see normalise().
const REQUIRED = ['id', 'x', 'y', 'tool', 'kind', 'verdict', 'url', 'caveats', 'escalate', 'verified'];

// The editorial stance. Plain sentences, published on the page and in the
// machine surfaces. Short on purpose — the page leads with what the thing is,
// not with an essay about it.
const STANCE =
  'Post a file to a hosted tool and read the converted file back — nothing to install. ' +
  'Where we do not host the job, the entry names the tool worth reaching for and what ' +
  'bites about it. We prefer the plain deterministic tool wherever one works, and a ' +
  'model only where the answer is a judgment call.';

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

// Short labels for the two picker dropdowns. Ordered rules, first match wins,
// matched against the lowercased field — the same idiom as CATEGORY_RULES, and
// for the same reason: the mechanical derivation (strip parentheticals, lowercase)
// leaves labels like "live dom in a browser or headless page" that nobody wants
// in a <select>. Several source phrasings deliberately collapse onto one label.
// Anything that falls through gets the mechanical form and a build warning, so
// this table stays honest as entries are added.
const LABEL_RULES = [
  [/mojibake|legacy encoding/, 'legacy encoding'],
  [/legacy ebook|mobi/, 'legacy ebook'],
  [/scanned/, 'scanned pdf'],
  [/digital-born/, 'digital-born pdf'],
  [/searchable pdf/, 'searchable pdf'],
  [/tables/, 'pdf tables'],
  [/docx\/xlsx\/pptx/, 'office docs'],
  [/messy document/, 'messy document'],
  [/messy csv/, 'messy csv'],
  [/clean, validated utf-8 csv/, 'clean csv'],
  [/clean utf-8/, 'utf-8'],
  [/image of text/, 'image of text'],
  [/recorded speech/, 'recorded speech'],
  [/live dom/, 'rendered dom'],
  [/structured records/, 'structured records'],
  [/structured metadata/, 'metadata json'],
  [/transcript/, 'transcript'],
  [/photo \/ video \/ pdf/, 'media file'],
  [/heic/, 'heic photos'],
  [/batch of source images/, 'images'],
  [/web-sized/, 'web images'],
  [/page images/, 'page images'],
  [/plain text|layout-preserved/, 'plain text'],
  [/ndjson/, 'json / ndjson'],
  [/audio file/, 'audio file'],
  [/mp3 or opus/, 'mp3 / opus'],
  [/\bmarkdown\b/, 'markdown'],
  [/\bhtml\b/, 'html'],
  [/\bdocx\b/, 'docx'],
  [/\bepub\b/, 'epub'],
  [/\bxlsx\b/, 'xlsx'],
  [/\bsvg\b/, 'svg'],
  [/\bjpeg\b/, 'jpeg'],
  [/\bpng\b/, 'png'],
  [/\bmp4\b|h\.264/, 'mp4'],
  [/\bwav\b|flac|arbitrary audio/, 'audio'],
  [/\bvideo\b/, 'video'],
  [/sqlite/, 'sqlite'],
  [/\byaml\b/, 'yaml'],
  [/\bjson\b/, 'json'],
  [/\bcsv\b/, 'csv'],
  [/\bpdf\b/, 'pdf'],
];

// File extension used in each hosted card's example curl, keyed by the x label.
const SAMPLE_EXT = { markdown: 'md', html: 'html', json: 'json', yaml: 'yaml', csv: 'csv' };

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

const labelWarnings = [];

// The mechanical fallback: lowercase, drop parentheticals and trailing noise.
function mechanicalLabel(field) {
  return oneLine(String(field))
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[—–]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[.,;:]+$/, '')
    .trim();
}

function labelOf(field, entryId, which) {
  const hay = oneLine(String(field)).toLowerCase();
  for (const [re, label] of LABEL_RULES) if (re.test(hay)) return label;
  const fallback = mechanicalLabel(field);
  labelWarnings.push(`${entryId}: no LABEL_RULES match for ${which} "${oneLine(field)}" — using "${fallback}"`);
  return fallback;
}

const priceLabel = (price) =>
  price === 'free' ? 'free' : `$${price.amount_usd}/call · x402`;

const isFree = (hosted) => hosted && hosted.price === 'free';

// What a hosted tool costs, in one phrase: the free tier first, because that is
// what a caller meets first.
const tierLabel = (hosted) =>
  isFree(hosted)
    ? `free, ${FREE_TIER_DAILY}/day cap`
    : `${FREE_TIER_DAILY}/day free, then ${priceLabel(hosted.price)}`;

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

  // `local:` is the new home for the install one-liner. A bare top-level
  // `install:` is the older form and still works — it is read as local.install,
  // so entries written before the split need no edit.
  const localInstall = (e.local && e.local.install) || e.install;
  if (!localInstall || !String(localInstall).trim()) {
    problems.push(`${e.id}: needs an install one-liner — either "install:" or "local: { install: ... }"`);
  }
  e._local = localInstall
    ? { tool: String((e.local && e.local.tool) || e.tool), install: oneLine(localInstall) }
    : null;

  // `hosted:` is optional. Present means we run the conversion ourselves.
  e._hosted = null;
  if (e.hosted) {
    const h = e.hosted;
    const wantPath = `/convert/${e.id}`;
    if (h.path !== wantPath) problems.push(`${e.id}: hosted.path "${h.path}" must be "${wantPath}"`);
    if (h.status !== 'live' && h.status !== 'planned') {
      problems.push(`${e.id}: hosted.status "${h.status}" is not live|planned`);
    }
    let price;
    if (h.price === 'free') {
      price = 'free';
    } else if (h.price && typeof h.price === 'object' && typeof h.price.amount_usd === 'number') {
      if (!(h.price.amount_usd > 0)) problems.push(`${e.id}: hosted.price.amount_usd must be > 0`);
      price = { amount_usd: h.price.amount_usd, scheme: String(h.price.scheme || 'exact') };
    } else {
      problems.push(`${e.id}: hosted.price must be "free" or { amount_usd, scheme }`);
      price = 'free';
    }
    // free_tier_daily rides along on every hosted entry, so catalog.json, the
    // Worker's compiled catalog and therefore GET /check all state the tier
    // rule per tool instead of leaving a reader to find it in prose.
    e._hosted = { path: wantPath, price, status: h.status, free_tier_daily: FREE_TIER_DAILY };
  }

  e._xlabel = labelOf(e.x, e.id, 'x');
  e._ylabel = labelOf(e.y, e.id, 'y');
}

if (problems.length) {
  console.error('build: entries.yaml failed validation');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
for (const w of labelWarnings) console.warn(`build: LABEL — ${w}`);

// Staleness surfacing (dossier § Components 7). No entry is dropped; the build
// says which verdicts are due for the refresh pass, and the page marks them.
const stale = entries.filter((e) => daysSince(e.verified) > STALE_AFTER_DAYS);
for (const e of stale) {
  console.warn(`build: STALE — ${e.id} verified ${e.verified} (${daysSince(e.verified)} days ago)`);
}
const isStale = (e) => daysSince(e.verified) > STALE_AFTER_DAYS;

// Group by X-category. Hosted-live entries sort first inside a shelf; everything
// else keeps source order.
const grouped = new Map(CATEGORY_ORDER.map((c) => [c, []]));
for (const e of entries) grouped.get(categoryOf(e)).push(e);
const liveRank = (e) => (e._hosted && e._hosted.status === 'live' ? 0 : e._hosted ? 1 : 2);
for (const list of grouped.values()) {
  list.forEach((e, i) => {
    e._order = i;
  });
  list.sort((a, b) => liveRank(a) - liveRank(b) || a._order - b._order);
}
const sections = CATEGORY_ORDER.map((c) => [c, grouped.get(c)]).filter(([, list]) => list.length);

const hostedEntries = entries.filter((e) => e._hosted);
const hostedLive = hostedEntries.filter((e) => e._hosted.status === 'live');
const localOnly = entries.filter((e) => !e._hosted);

// The one pricing sentence the whole site repeats — page, machine files, README.
// The price is DERIVED from entries.yaml rather than typed here a second time:
// when every priced tool costs the same, the sentence names the figure; price
// them differently and the phrasing degrades honestly instead of lying.
const priceAmounts = Array.from(
  new Set(hostedEntries.filter((e) => !isFree(e._hosted)).map((e) => e._hosted.price.amount_usd))
);
const PRICE_PHRASE =
  priceAmounts.length === 1 ? `$${priceAmounts[0]} in USDC via x402` : 'a per-call price in USDC via x402';
const PRICING_LINE =
  `Every tool is free to try: ${FREE_TIER_DAILY} conversions a day, no login. ` +
  `Past that it's a paid call — ${PRICE_PHRASE}, with much higher limits.`;

const SUMMARY =
  `${hostedEntries.length} hosted · ${localOnly.length} local references. ` +
  `${FREE_TIER_DAILY} free conversions a day on every hosted tool.`;

const BUILD_DATE = new Date().toISOString().slice(0, 10);

const uniqueSorted = (values) => Array.from(new Set(values)).sort((a, b) => a.localeCompare(b));
const xLabels = uniqueSorted(entries.map((e) => e._xlabel));
const yLabels = uniqueSorted(entries.map((e) => e._ylabel));

const sampleFor = (e) => `input.${SAMPLE_EXT[e._xlabel] || 'txt'}`;
const convertCurl = (e) => `curl -X POST "${API_BASE}${e._hosted.path}" --data-binary @${sampleFor(e)}`;

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
h4 { font-size: 0.95rem; font-weight: 700; margin: 1.6rem 0 0.4rem; }

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
.strapline { color: var(--muted); margin: 0 0 1rem; font-size: 1.08rem; }
/* The standing offer. Marked, not shouted — a rule down the side is enough to
   make it the second thing read after the name. */
.pricing-line {
  margin: 0 0 1.6rem; font-size: 1.02rem;
  padding-left: 0.85rem; border-left: 3px solid var(--accent);
}
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
.field select, .field input {
  font: inherit; font-size: 0.98rem; width: 100%; min-width: 0;
  padding: 0.55rem 0.7rem;
  color: var(--ink); background: var(--card);
  border: 1px solid var(--border); border-radius: 6px;
}
.field select:focus, .field input:focus { outline: 2px solid var(--accent); outline-offset: 1px; border-color: var(--accent-hover); }
.picker-arrow {
  color: var(--accent-ink); font-size: 2rem; line-height: 1; padding-bottom: 0.4rem;
  flex: 0 0 auto; user-select: none;
}
.search-field { margin: 0.7rem 0 0; }
.search-field label { display: block; }
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
.summary {
  margin: 1.5rem 0 0; font-weight: 700;
  font-family: ui-monospace, Menlo, Monaco, Consolas, monospace; font-size: 0.86rem;
  color: var(--accent-ink);
}

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
/* Hosted-live cards carry a subtle tint, so the tools we actually run read
   differently from the tools we only point at. */
.card.is-hosted { background: var(--accent-soft); border-color: var(--accent-hover); }
.card:hover, .card:target {
  border-color: var(--accent-hover);
  background: var(--accent-soft);
  background: color-mix(in srgb, var(--accent-soft) 55%, transparent);
}
.card.is-hosted:hover, .card.is-hosted:target { background: var(--accent-soft); }
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

/* ---- hosted row ------------------------------------------------------ */
.hostedrow {
  margin: 0 0 0.5rem;
  display: flex; align-items: baseline; gap: 0.4rem; flex-wrap: wrap;
}
/* Deliberately NOT uppercased, unlike .kind: the pill carries "x402" and
   "$0.001/call", and shouting them as X402 misspells a protocol name. */
.pill {
  flex: 0 0 auto;
  font-size: 0.68rem; font-weight: 700; letter-spacing: 0.04em;
  font-family: ui-monospace, Menlo, Monaco, Consolas, monospace;
  padding: 0.12em 0.55em; border-radius: 3px;
}
.pill-free { background: var(--accent); color: var(--chip-ink); }
.pill-paid { background: transparent; color: var(--accent-ink); border: 1px solid var(--accent-hover); }
.pill-planned { background: transparent; color: var(--muted); border: 1px dashed var(--border); }

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
.cmd code {
  flex: 1 1 auto; min-width: 0;
  background: none; color: var(--term-ink); padding: 0;
  font-size: 0.8rem; white-space: pre; overflow-x: auto;
}
.cmd-sm { padding: 0.3rem 0.4rem 0.3rem 0.6rem; margin-bottom: 0.4rem; }
.cmd-sm code { font-size: 0.74rem; }
/* Multi-line snippets: the copy button rides at the top rather than floating in
   the vertical middle of eight lines of code. */
.cmd-block { align-items: flex-start; }
.cmd-block code { white-space: pre; line-height: 1.55; }
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

/* The verified line is pushed to the card's bottom, so a grid row of cards
   lines its footers up regardless of how long each verdict runs. */
.cardfoot {
  margin: auto 0 0; padding-top: 0.6rem; border-top: 1px solid var(--border);
  font-size: 0.85rem;
}
.verified { color: var(--muted); font-family: ui-monospace, Menlo, Monaco, Consolas, monospace; font-size: 0.74rem; }
.verified.stale { color: var(--accent-hover); font-weight: 700; }

/* ---- for agents ------------------------------------------------------ */
.agent-row { margin: 0 0 1.1rem; }
.agent-row .note { margin: -0.35rem 0 0; }

/* ---- honest-status box ----------------------------------------------- */
/* Reserved for statements about what is NOT built. Dashed, not filled — it is
   a caveat, not a feature callout. */
.status-box {
  margin: 1.4rem 0 0; padding: 0.85rem 1rem;
  border: 1px dashed var(--accent-hover); border-radius: 8px;
  background: var(--accent-soft);
  font-size: 0.94rem;
}
.status-box p { margin: 0; }
.status-box .status-label {
  display: block; margin-bottom: 0.25rem;
  color: var(--accent-ink);
  font-family: ui-monospace, Menlo, Monaco, Consolas, monospace;
  font-size: 0.7rem; letter-spacing: 0.1em; text-transform: uppercase; font-weight: 700;
}

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

// Progressive enhancement: the have/need dropdowns, the search box, the shelf
// and kind chips, and the copy buttons. Sends nothing anywhere — the beacon is
// the only network client on this page, and it counts two events, neither here.
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
    var q = doc.getElementById('q');
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
      var a = have ? have.value : '';
      var b = need ? need.value : '';
      var text = q ? q.value.trim().toLowerCase() : '';
      var shelfActive = any(shelfOn);
      var kindActive = any(kindOn);
      var shown = 0;
      cards.forEach(function (el) {
        var ok = (!a || el.getAttribute('data-xlabel') === a) &&
                 (!b || el.getAttribute('data-ylabel') === b);
        if (ok && text) ok = (el.getAttribute('data-search') || '').indexOf(text) !== -1;
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
          ? total + ' tools \\u00b7 ' + nShelves + ' shelves'
          : shown + ' of ' + total + ' tools match';
      }
      if (empty) empty.hidden = shown !== 0;
      if (clear) clear.hidden = !(a || b || text || shelfActive || kindActive);
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

    if (have) have.addEventListener('change', apply);
    if (need) need.addEventListener('change', apply);
    if (q) q.addEventListener('input', apply);
    if (clear) {
      clear.addEventListener('click', function () {
        if (have) have.value = '';
        if (need) need.value = '';
        if (q) q.value = '';
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

function cmdRow(command, label, extraClass = '') {
  const cls = extraClass ? `cmd ${extraClass}` : 'cmd';
  return `<div class="${cls}"><code>${esc(command)}</code><button type="button" class="copy js-only" aria-label="${esc(label)}">copy</button></div>`;
}

// The worked example in the pricing section. Deliberately short: two imports, an
// account, the wrapper, one call. Every hosted tool is priced past the free tier,
// and the 402 it answers is verified with the CDP facilitator and settled on
// Base — so the snippet is runnable rather than illustrative.
const X402_SNIPPET = [
  'import { wrapFetchWithPayment } from "x402-fetch";',
  'import { privateKeyToAccount } from "viem/accounts";',
  '',
  'const account = privateKeyToAccount(process.env.WALLET_PRIVATE_KEY);',
  'const pay = wrapFetchWithPayment(fetch, account);   // handles the 402 + retry',
  '',
  `const res = await pay("${API_BASE}/convert/html-markdown",`,
  '  { method: "POST", body: "<h1>Hello</h1>" });',
  'console.log(await res.text());',
].join('\n');

// Two pills, because there are two facts and the first one is the offer: what it
// costs to try (nothing, FREE_TIER_DAILY a day) and what a call costs past that.
function pricePills(h) {
  if (h.status === 'planned') return '<span class="pill pill-planned">planned</span>';
  const free = `<span class="pill pill-free">${FREE_TIER_DAILY}/day free</span>`;
  if (isFree(h)) return free;
  return `${free}
            <span class="pill pill-paid">$${esc(h.price.amount_usd)} x402</span>`;
}

function hostedBlock(e) {
  const h = e._hosted;
  if (!h) return '';
  const planned = h.status === 'planned';
  // The kind chip is NOT repeated here — the tool row below carries it on every
  // card, hosted or not.
  const row = `          <p class="hostedrow">
            ${pricePills(h)}
          </p>`;
  if (planned) return `${row}\n          <p class="note">Not live yet — the tool below is the one to reach for meanwhile.</p>`;
  return `${row}\n          ${cmdRow(convertCurl(e), `Copy the convert command for ${oneLine(e.x)} to ${oneLine(e.y)}`)}`;
}

// The base tool behind the entry: its name, linked to its own site. This is the
// page's ONLY outbound link per card, and the only [data-entry] element — which
// is exactly what the beacon's delegated click listener counts. No install
// command is printed anywhere on the page; the strings live on in catalog.json
// and llms-full.txt for machines that want them.
function toolRow(e) {
  const label = e._local ? e._local.tool : e.tool;
  return `          <p class="toolrow">
            <a class="tool" href="${esc(e.url)}" data-entry="${esc(e.id)}" rel="noopener">${esc(label)}</a>
            <span class="kind kind-${esc(e.kind)}">${esc(e.kind)}</span>
          </p>`;
}

function renderCard(e, shelfSlug) {
  const search = esc(oneLine(`${e.x} ${e.y} ${e._xlabel} ${e._ylabel} ${e.tool} ${e.verdict}`).toLowerCase());
  const staleMark = isStale(e) ? ' stale' : '';
  const staleNote = isStale(e) ? ' · review due' : '';
  const hostedState = e._hosted ? e._hosted.status : 'no';
  const cardClass = e._hosted && e._hosted.status === 'live' ? 'card is-hosted' : 'card';
  return `        <article class="${cardClass}" id="${esc(e.id)}"
          data-x="${esc(oneLine(e.x).toLowerCase())}"
          data-y="${esc(oneLine(e.y).toLowerCase())}"
          data-xlabel="${esc(e._xlabel)}"
          data-ylabel="${esc(e._ylabel)}"
          data-tool="${esc(String(e.tool).toLowerCase())}"
          data-kind="${esc(e.kind)}"
          data-hosted="${esc(hostedState)}"
          data-shelf="${esc(shelfSlug)}"
          data-search="${search}">
          <h3 class="pair">${esc(oneLine(e.x))}<span class="arrow">&rarr;</span>${esc(oneLine(e.y))}</h3>
${hostedBlock(e)}
${toolRow(e)}
          <p class="verdict">${inline(e.verdict)}</p>
          <details class="more">
            <summary><span class="lbl-more">more</span><span class="lbl-less">less</span></summary>
            <p class="meta"><span class="label">Caveats</span>${inline(e.caveats)}</p>
            <p class="meta"><span class="label">Escalate</span>${inline(e.escalate)}</p>
          </details>
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

const optionList = (labels) =>
  ['<option value="">anything</option>', ...labels.map((l) => `<option value="${esc(l)}">${esc(l)}</option>`)].join(
    '\n            '
  );

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
  ['#pay-with-usdc', 'Pricing'],
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
<meta name="description" content="${esc(META_DESCRIPTION)}">
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
    <p class="pricing-line">${esc(PRICING_LINE)}</p>

    <p class="stance">${esc(STANCE)}</p>
    <p class="note draft-note">Curation is an owner-taste surface. These ${entries.length} entries are drafts for review.</p>

    <div class="picker" id="shelves">
      <div class="picker-fields">
        <div class="field">
          <label for="have">I have…</label>
          <select id="have">
            ${optionList(xLabels)}
          </select>
        </div>
        <div class="picker-arrow" aria-hidden="true">&rarr;</div>
        <div class="field">
          <label for="need">I need…</label>
          <select id="need">
            ${optionList(yLabels)}
          </select>
        </div>
      </div>
      <div class="field search-field">
        <label for="q">Or search everything</label>
        <input id="q" type="search" autocomplete="off" placeholder="pandoc · loudness · footnotes">
      </div>
      <p class="count-line"><span id="count">${entries.length} tools · ${sections.length} shelves</span> <button type="button" class="clear-btn js-only" id="clear" hidden>clear</button></p>
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
      <p class="summary">${esc(SUMMARY)}</p>
    </div>
    <p class="note">Hosted tools need nothing installed — post the file, read the answer. <a href="catalog.json">catalog.json</a> carries every entry machine-readable.</p>
    <p class="empty js-only" id="no-matches" hidden>Nothing matches that pair. Try a broader option, or clear the filters.</p>
  </div>

${sections.map(renderShelf).join('\n')}

  <section class="prose" id="for-agents">
    <h2>For agents — call it</h2>
    <p>Plain HTTP is the whole API; the skill and the MCP server are conveniences on top of it. Nothing here needs an account or a key.</p>

    <h4>1. Check what is available, then convert</h4>
    <div class="agent-row">
      ${cmdRow(`curl "${API_BASE}/check?from=markdown&to=html"`, 'Copy the availability check command')}
      <p class="note">Returns the matching pairs with their endpoint, price, free-tier allowance and status. <code>from</code> is matched against what you have, <code>to</code> against what you need. No parameters returns every hosted tool.</p>
    </div>
    <div class="agent-row">
      ${cmdRow(`curl -X POST "${API_BASE}/convert/md-html" --data-binary @README.md`, 'Copy the convert command')}
      <p class="note">Post the raw file as the body; the converted file comes back as the body. Input is capped at 256 KB. The first ${FREE_TIER_DAILY} calls a day are free and say how many are left in <code>x-free-tier-remaining</code>; past that the answer is a <code>402</code> carrying an x402 envelope to pay against.</p>
    </div>

    <h4>2. The whole catalog as files</h4>
    <div class="agent-row">
      ${cmdRow(`curl ${BASE}/catalog.json`, 'Copy catalog.json fetch command')}
      <p class="note">Structured entries — every field, including the hosted endpoint.</p>
    </div>
    <div class="agent-row">
      ${cmdRow(`curl ${BASE}/llms.txt`, 'Copy llms.txt fetch command')}
      <p class="note">Compact index — one line per pair.</p>
    </div>
    <div class="agent-row">
      ${cmdRow(`curl ${BASE}/llms-full.txt`, 'Copy llms-full.txt fetch command')}
      <p class="note">Full verdicts, with caveats and escalate lines.</p>
    </div>

    <h4>3. Install the skill</h4>
    <div class="agent-row">
      ${cmdRow('npx skills add chronick/lemon-toolshed', 'Copy the skill install command')}
      <p class="note">Teaches an agent the check-then-convert habit, the 256 KB cap and the paid flow. Always-works fallback: copy <code>skills/toolshed/</code> from the repo into your agent's skills directory.</p>
    </div>

    <h4>4. MCP</h4>
    <div class="agent-row">
      ${cmdRow('claude mcp add toolshed -- npx -y github:chronick/lemon-toolshed', 'Copy the MCP install command')}
      <p class="note">Three tools over stdio: <code>toolshed_check</code>, <code>toolshed_convert</code>, <code>toolshed_catalog</code>. From a local clone instead:</p>
      ${cmdRow('claude mcp add toolshed -- node /path/to/lemon-toolshed/mcp/server.mjs', 'Copy the local-clone MCP install command', 'cmd-sm')}
      <p class="note">Point it somewhere else with <code>TOOLSHED_URL</code>.</p>
    </div>

    <p>Links on this page are plain <code>href</code>s to the tool, with no redirect and no interstitial.</p>
  </section>

  <section class="prose" id="pay-with-usdc">
    <h2>Pricing, and paying with USDC</h2>
    <p>${esc(PRICING_LINE)}</p>
    <p>The free tier needs no account, no key and no wallet — just call the endpoint. Every free-tier answer carries an <code>x-free-tier-remaining</code> header saying how many of the day's ${FREE_TIER_DAILY} are left, and the count resets at midnight UTC. It is counted per caller, where a caller is an IP address: rotating your user-agent does not get you a second ${FREE_TIER_DAILY}.</p>
    <p>Past the free tier, a call answers <strong>HTTP 402</strong>, and the body of that 402 is an <a href="https://www.x402.org" rel="noopener">x402</a> envelope: it names the price, the asset — USDC on Base — and the <code>payTo</code> address the money should go to. That envelope is the whole negotiation.</p>

    <p>Your agent needs two things to answer it:</p>
    <ol>
      <li>An <strong>x402-capable HTTP client</strong> — <code>x402-fetch</code>, the x402 SDK, or <a href="https://docs.cdp.coinbase.com/x402/welcome" rel="noopener">Coinbase AgentKit</a>.</li>
      <li>A <strong>wallet key holding USDC on Base</strong>, which the client signs with.</li>
    </ol>

    <p>The client reads the envelope, signs a payment for the named amount, and retries the same request with an <code>X-PAYMENT</code> header. No login, no card, no account — the payment <em>is</em> the auth.</p>

    <h4>Example — JavaScript, with <code>x402-fetch</code></h4>
    <div class="agent-row">
      ${cmdRow(X402_SNIPPET, 'Copy the x402-fetch example', 'cmd-block')}
      <p class="note">The wrapper does the 402 handling and the retry; your code just awaits a response. Never paste a private key or a seed phrase into a chat — the key belongs in the environment your client runs in.</p>
    </div>

    <!--
      HONEST STATUS. Flipped 2026-08-18, after a real x402 payment verified and
      settled on Base (tx 0xe2c8bb8d..., settlements row verify_ok = 1,
      settle_ok = 1). The standing rule is the same in reverse: if settlement
      ever breaks, this box goes back to naming what is broken.

      NOTE FOR EDITORS: this comment lives inside a JS template literal, so it
      must contain no backticks and no dollar-brace sequences.
    -->
    <div class="status-box">
      <p><span class="status-label">Honest status</span>The free tier is
      <strong>live and enforced</strong>, and payment is <strong>live and
      verified</strong>: a call past the free tier answers the <code>402</code>
      envelope above, and a payment presented against it is checked with the
      Coinbase CDP facilitator before the conversion is served — a verified call
      comes back with <code>x-payment-verified: true</code> and settles on Base
      immediately afterwards. If the facilitator cannot be reached, the call is
      served anyway and says so with <code>x-payment-error</code>: at $0.001 the
      price is a signal, and an outage on our side should not turn a paying
      caller away.</p>
    </div>
  </section>

  <section class="prose" id="how-we-count">
    <h2>How we count</h2>
    <p>This page runs a small script that reports two things: that the page loaded, and which outbound link was clicked. Nothing else is collected — filtering and copying send nothing — and links are plain links, so they work with the script blocked.</p>
    <p>Conversion calls are counted too: one row per call, recording that a call happened and which tool it used. The file you send is not stored and not logged.</p>
    <p>The free-tier counter is separate, and it is the one place a caller is identified across calls: it is keyed on a daily-salted hash of the IP address alone — no user-agent, so rotating one does not mint a fresh allowance — which makes it unlinkable across days once the salt is replaced, and it is kept on the same retention as every other counter here.</p>
    <p>Here is the counting policy in full: ${esc(BOT_POLICY)}. Click delivery is best-effort, so the click number is a floor rather than a total.</p>
  </section>

  <section class="prose" id="privacy">
    <h2>Privacy</h2>
    <p>There are two stores here, and they answer a "what do you hold on me" request differently.</p>
    <p><strong>The counting store</strong> holds a short hash, not an address. The hash is salted with random bytes that are replaced at the first request of each UTC day, and replacing them is the deletion: once the old salt is gone, nothing in the store points back to anyone. Rows are kept 90 days at most, then reduced to daily totals and deleted. Files you send to a conversion endpoint are never written to it. The free-tier counter lives in the same store under the same rules — a daily-salted hash of the IP alone, one row per caller per day, pruned on the same 90-day chore.</p>
    <p><strong>An IP blocklist</strong> exists to stop abuse. It is keyed on the address, so it does identify a requester, and we delete an address on request; rows expire 90 days after they were last seen.</p>
  </section>

  <footer>
    <p><span class="chip">${HOUSE}</span> ${SITE_NAME} — a ${HOUSE} field directory · built ${BUILD_DATE} · ${entries.length} entries, drafts under owner review.</p>
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

const catalogEntry = (e) => ({
  id: e.id,
  x: oneLine(e.x),
  y: oneLine(e.y),
  xlabel: e._xlabel,
  ylabel: e._ylabel,
  tool: e.tool,
  kind: e.kind,
  verdict: oneLine(e.verdict),
  hosted: e._hosted,
  local: e._local,
  install: e._local ? e._local.install : null, // retained for older readers
  url: e.url,
  caveats: oneLine(e.caveats),
  escalate: oneLine(e.escalate),
  verified: e.verified,
});

const catalog = {
  generated: new Date().toISOString(),
  source: 'entries.yaml',
  api: {
    base: API_BASE,
    check: `${API_BASE}/check?from=<what you have>&to=<what you need>`,
    convert: `${API_BASE}/convert/<id>`,
    free_tier_daily: FREE_TIER_DAILY,
    note:
      `Entries with a hosted block run on our server. Every one is free to try — ${FREE_TIER_DAILY} conversions ` +
      'per caller (per IP) per UTC day, reported in an x-free-tier-remaining header — and priced per call past ' +
      'that: HTTP 402 with an x402 envelope naming a live USDC address on Base. A payment presented against that ' +
      'envelope is verified with the Coinbase CDP facilitator before the conversion is served, and settles on Base ' +
      'immediately afterwards. Entries without a hosted block are local-only references.',
  },
  entries: entries.map(catalogEntry),
};

// ---------------------------------------------------------------- llms.txt

const hostedLine = (e) =>
  e._hosted ? `hosted ${e._hosted.status}, ${tierLabel(e._hosted)}, at POST ${e._hosted.path}` : 'local only';

const API_HEADER = [
  `Availability check: GET ${API_BASE}/check?from=<what you have>&to=<what you need>`,
  `  Field-bound substring match, case-insensitive: from is matched against the "have" side only,`,
  `  to against the "need" side only. No parameters returns every hosted tool.`,
  `Convert: POST ${API_BASE}/convert/<id> with the raw file as the body (256 KB cap).`,
  `  The converted file comes back as the body, with the right Content-Type.`,
  `Tiers: every hosted tool is free to try — ${FREE_TIER_DAILY} conversions per caller per UTC day, no login —`,
  `  and priced per call past that. A caller is an IP address (rotating the user-agent does not reset it);`,
  `  every free-tier response carries x-free-tier-remaining: <n>, and the count resets at midnight UTC.`,
  `Payment: past the free tier a call answers HTTP 402 with an x402 envelope — exact scheme, USDC`,
  `  on Base — naming the price and the payTo address. No accounts, no keys, per-call pricing. Pay`,
  `  with an x402-capable client (x402-fetch, the x402 SDK, Coinbase AgentKit) holding a wallet key`,
  `  with USDC on Base; it signs and retries with an X-PAYMENT header. The payment is verified with`,
  `  the Coinbase CDP facilitator before the conversion is served: a verified call comes back with`,
  `  x-payment-verified: true and settles on Base immediately afterwards; a payment the facilitator`,
  `  rejects gets the 402 again with an invalidReason and no conversion; and if the facilitator`,
  `  cannot be reached the call is served anyway, saying so with x-payment-verified: false and`,
  `  x-payment-error. Inside the free tier nothing is checked or charged. On a deployment with no`,
  `  receiving address configured, over-tier calls answer HTTP 429 with a Retry-After, not a 402.`,
  `Skill: npx skills add chronick/lemon-toolshed`,
  `MCP: claude mcp add toolshed -- npx -y github:chronick/lemon-toolshed`,
  `  Tools: toolshed_check, toolshed_convert, toolshed_catalog. Base URL via TOOLSHED_URL.`,
];

const llms = [
  `# ${SITE_NAME} — tools for agents · a ${HOUSE} field directory`,
  '',
  `Tools an agent can call over HTTP with nothing installed, plus local-only references for the jobs we do not host. ${SUMMARY} The unit is the pair — what you have, what you need. Structured fields are in catalog.json alongside this file; the full verdicts, caveats and escalate lines are in llms-full.txt.`,
  '',
  ...API_HEADER,
  '',
  `Editorial stance: ${STANCE}`,
  '',
  ...sections.flatMap(([category, list]) => [
    `## ${category}`,
    ...list.map(
      (e) =>
        `${oneLine(e.x)} -> ${oneLine(e.y)} [${e.id}]: ${hostedLine(e)}; local ${e._local.tool} (${e.kind}) — ${firstSentence(e.verdict)} — ${e.url}`
    ),
    '',
  ]),
].join('\n');

// ---------------------------------------------------------------- llms-full.txt

const llmsFull = [
  `# ${SITE_NAME} — tools for agents · a ${HOUSE} field directory`,
  '',
  `Site: ${BASE}`,
  `API: ${API_BASE}`,
  `Generated: ${BUILD_DATE}`,
  `Source: entries.yaml — ${entries.length} entries across ${sections.length} shelves. ${SUMMARY}`,
  '',
  ...API_HEADER,
  '',
  `Editorial stance: ${STANCE}`,
  '',
  'Every verdict below is engineering judgment, not measurement. Curation is an',
  "owner-taste surface and these entries are drafts for review. The same fields are",
  'available as structured JSON in catalog.json.',
  '',
  ...sections.flatMap(([, list]) =>
    list.map((e) =>
      [
        `## ${oneLine(e.x)} -> ${oneLine(e.y)}`,
        `id: ${e.id}`,
        `hosted: ${e._hosted ? 'yes' : 'no'}`,
        ...(e._hosted
          ? [
              `hosted_path: POST ${e._hosted.path}`,
              `hosted_price: ${priceLabel(e._hosted.price)}`,
              `hosted_free_tier: ${e._hosted.free_tier_daily} conversions per caller per UTC day`,
              `hosted_status: ${e._hosted.status}`,
            ]
          : []),
        `local_tool: ${e._local.tool}`,
        `local_install: ${e._local.install}`,
        `kind: ${e.kind}`,
        `verdict: ${oneLine(e.verdict)}`,
        `caveats: ${oneLine(e.caveats)}`,
        `escalate: ${oneLine(e.escalate)}`,
        `url: ${e.url}`,
        `verified: ${e.verified}`,
        '',
      ].join('\n')
    )
  ),
].join('\n');

// ---------------------------------------------------------------- worker catalog

// The Worker answers GET /check out of this file. Compiling the catalog into the
// bundle is what keeps /check off D1, off KV and off any fetch — it is a pure
// in-memory filter, which is why it is exempt from the rate-limit rungs.
const workerCatalog = `// GENERATED by build.mjs from entries.yaml. Do not edit — run \`npm run build\`.
//
// Compiled into the Worker bundle so GET /check needs no fetch, no KV and no D1.
// Regenerate and commit this file whenever entries.yaml changes, because
// \`wrangler deploy\` reads it from disk.

export const SITE_BASE = ${JSON.stringify(BASE)};

// The free tier, compiled in from build.mjs so the number the site advertises and
// the number the Worker enforces are the same number. OWNER-TUNABLE in build.mjs.
export const FREE_TIER_DAILY = ${FREE_TIER_DAILY};

export const CATALOG = ${JSON.stringify(
  entries.map((e) => ({
    id: e.id,
    x: oneLine(e.x),
    y: oneLine(e.y),
    hosted: e._hosted,
    local: e._local,
    url: e.url,
  })),
  null,
  2
)};
`;

// ---------------------------------------------------------------- emit

rmSync(DIST, { recursive: true, force: true });
mkdirSync(DIST, { recursive: true });
writeFileSync(join(DIST, 'index.html'), html);
writeFileSync(join(DIST, 'catalog.json'), `${JSON.stringify(catalog, null, 2)}\n`);
writeFileSync(join(DIST, 'llms.txt'), llms);
writeFileSync(join(DIST, 'llms-full.txt'), llmsFull);
writeFileSync(join(ROOT, 'worker', 'catalog.generated.js'), workerCatalog);

console.log(`build: ${entries.length} entries on ${sections.length} shelves`);
for (const [category, list] of sections) console.log(`  ${category}: ${list.length}`);
console.log(`build: ${SUMMARY} ${hostedLive.length} hosted live`);
for (const e of hostedLive) console.log(`  POST ${e._hosted.path} — ${tierLabel(e._hosted)}`);
console.log(`build: beacon URL ${BEACON_URL}`);
console.log(`build: site host ${BASE}`);
console.log(`build: api host ${API_BASE}`);
if (HOST !== HOST_DEFAULT) {
  console.warn(
    `build: WARNING — worker/catalog.generated.js now carries SITE_BASE ${BASE}, not the production host. ` +
      'Run `npm run build` with no overrides before committing or deploying.'
  );
}
console.log(`build: stale entries ${stale.length}`);
console.log('build: wrote dist/index.html dist/catalog.json dist/llms.txt dist/llms-full.txt worker/catalog.generated.js');
