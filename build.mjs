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

import { readFileSync, readdirSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
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

// The free tier, in one place — and as of 2026-08-19 it is OFF.
//
// This constant is what the STATIC surfaces advertise: the page, catalog.json,
// llms.txt and llms-full.txt. It is no longer what the Worker enforces. The
// Worker reads `env.FREE_TIER_DAILY` at runtime and treats that as the only
// authority, so a dashboard flip takes effect without a rebuild, and GET /check
// reports the runtime number rather than this one.
//
// WHY IT IS ZERO. Coinbase's Bazaar discovery index requires that an
// unauthenticated request answer 402. A free tier serves any fresh IP a 200,
// which fails the index's `returns_402` preflight — and it health-probes on an
// interval, so a free tier does not merely block listing, it gets an existing
// listing dropped. Discoverability beat the trial allowance.
//
// TO RE-ENABLE (all three, or the site lies about itself):
//   1. set this constant to N and `npm run build` — the static copy below is
//      written to render either state honestly;
//   2. set the Worker var FREE_TIER_DAILY = "N" (wrangler.toml [vars] or the
//      dashboard) — this is what actually enforces it;
//   3. redeploy the Worker AND the Pages site.
// And know the cost: with a free tier on, fresh-IP probers get a 200 and the
// service falls out of Bazaar discovery.
//
// OWNER-TUNABLE. When it is on it is deliberately severe: a free tier exists to
// let an agent try the thing, not to be a free service, and the caller key it is
// counted against (a daily-salted hash of the IP alone) is the cheapest
// spoof-resistance available — a fresh identity costs a fresh IP, not a fresh
// user-agent string.
const FREE_TIER_DAILY = 0;

// Every piece of copy below branches on this. Both branches are live code, not
// one branch and one comment: the generator has to be able to render either
// state truthfully, because the re-enable path above depends on it.
const FREE_TIER_ON = FREE_TIER_DAILY > 0;

const SITE_NAME = 'Toolshed';
const HOUSE = 'Lemon';
const KICKER = 'the Lemon';
const TITLE = `${SITE_NAME} — tools for agents · ${HOUSE}`;
// STRAPLINE and META_DESCRIPTION used to be here, with "$0.001" typed into both.
// They now live below the load, next to PRICE_PHRASE, because the figure is
// DERIVED from entries.yaml — see PRICE_RANGE. Typing a price into page copy is
// how a repricing ships a site that lies about itself for a week.

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
  // Subtitles are timed text for a video, so they shelve with the media rather
  // than with the data formats. It sits after the media rule above because that
  // one is about the media file itself; neither can match the other's phrasing.
  [/subtitle|subrip|webvtt/, 'Audio & video'],
  [/json|\bcsv\b|sqlite|yaml|xlsx|spreadsheet|\btoml\b|\bxml\b|ndjson/, 'Data & tabular'],
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
  // Ahead of the /tables/ rule below, which was written for the PDF entry and
  // would otherwise label an HTML page that happens to carry tables `pdf tables`.
  [/\bhtml\b.*\btables?\b/, 'html'],
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
  // AFTER /transcript/ on purpose: the speech entry's "Transcript (text/SRT/VTT)"
  // is a transcript that happens to name two container formats, not a subtitle
  // file. The two hosted subtitle entries name their format first.
  [/subrip|\bsrt\b/, 'srt'],
  [/webvtt|\bvtt\b/, 'vtt'],
  [/photo \/ video \/ pdf/, 'media file'],
  [/heic/, 'heic photos'],
  [/batch of source images/, 'images'],
  [/web-sized/, 'web images'],
  [/page images/, 'page images'],
  [/plain text|layout-preserved/, 'plain text'],
  // Before /ndjson/, which is the OR-list label the json-reshape entry wants
  // ("Flat JSON / NDJSON / CSV rows"). An entry whose whole subject is the
  // format spells it out in full and gets the format's own label.
  [/newline-delimited json/, 'ndjson'],
  [/ndjson/, 'json / ndjson'],
  [/audio file/, 'audio file'],
  [/mp3 or opus/, 'mp3 / opus'],
  // Before /\bmarkdown\b/: the input IS Markdown, but what the tool operates on
  // is the fence at the top of it, and `?from=frontmatter` is what an agent asks.
  [/frontmatter/, 'frontmatter'],
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
  [/\btoml\b/, 'toml'],
  [/\bxml\b/, 'xml'],
  [/\byaml\b/, 'yaml'],
  [/\bjson\b/, 'json'],
  [/\bcsv\b/, 'csv'],
  [/\bpdf\b/, 'pdf'],
];

// File extension used in each hosted card's example curl, keyed by the x label.
const SAMPLE_EXT = {
  markdown: 'md',
  html: 'html',
  json: 'json',
  yaml: 'yaml',
  csv: 'csv',
  ndjson: 'ndjson',
  toml: 'toml',
  xml: 'xml',
  srt: 'srt',
  vtt: 'vtt',
  // The input is a Markdown file; the fence at the top of it is only what the
  // tool reads. `input.frontmatter` would name a file nobody has.
  frontmatter: 'md',
};

// The Content-Type each hosted conversion answers with, keyed by the y label.
//
// This MUST agree with CONVERTERS[id].mimeType in worker/beacon.js: the Worker
// publishes that value inside the 402 envelope, and openapi.json publishes this
// one, so a disagreement is a lie a machine acts on. The suite asserts the two
// agree per tool rather than trusting this comment.
const RESPONSE_MIME = {
  html: 'text/html',
  markdown: 'text/markdown',
  json: 'application/json',
  yaml: 'application/yaml',
  csv: 'text/csv',
  ndjson: 'application/x-ndjson',
  toml: 'application/toml',
  // No registered media type exists for SubRip; `application/x-subrip` is what
  // ffmpeg, VLC and every player in practice use, so it is what we publish.
  srt: 'application/x-subrip',
  vtt: 'text/vtt',
  'plain text': 'text/plain',
};
const responseMime = (e) => RESPONSE_MIME[e._ylabel] || 'text/plain';

// ---------------------------------------------------------------- aliases
//
// What an agent actually types. GET /check matched on a case-insensitive
// SUBSTRING of the prose `x`/`y` fields and nothing else, which meant
// `?from=markdown` worked and `?from=md`, `?from=.md` and `?from=text/markdown`
// all returned [] — the three forms a machine is most likely to have on hand,
// because they are what a filename and a Content-Type header carry. Verified
// live 2026-08-19 against toolshed.lemon-agent.dev: only the long prose word
// matched.
//
// So every entry gets an alias SET, compiled here, and /check answers on
// substring OR an exact alias hit. Keyed on the short label rather than on the
// prose field: the label is already the canonical short name for the format, so
// the table stays small and a new entry inherits its aliases for free.
//
// The label itself is always included, so the table only has to carry what the
// label does NOT already say. Normalisation (lowercase, leading dots stripped)
// happens in aliasesFor() and again in the Worker, so `.md`, `MD` and `md` are
// one key. MIME types keep their slash.
//
// MACHINE SURFACE ONLY: aliases go into catalog.json and the Worker's compiled
// catalog, never onto the page. A human reading a card does not need to be told
// that Markdown files end in .md.
const FORMAT_ALIASES = {
  markdown: ['md', 'mdown', 'text/markdown', 'text/x-markdown'],
  html: ['htm', 'text/html', 'application/xhtml+xml'],
  // NOT html/text/html: the input here is a LIVE page in a browser, not an HTML
  // file you can post. Aliasing it to `html` made `?from=html` offer an entry
  // that cannot take an HTML file, which is the exact mis-routing /check exists
  // to prevent.
  'rendered dom': ['dom', 'url', 'webpage'],
  json: ['application/json', 'text/json'],
  'json / ndjson': ['json', 'ndjson', 'jsonl', 'application/json', 'application/x-ndjson'],
  'metadata json': ['json', 'application/json'],
  yaml: ['yml', 'application/yaml', 'text/yaml', 'application/x-yaml'],
  csv: ['text/csv', 'application/csv'],
  // One JSON value per line. `jsonl` and `ldjson` are the two other names the
  // same file gets given, and both turn up in the wild as extensions.
  ndjson: ['jsonl', 'ldjson', 'application/x-ndjson', 'application/jsonl'],
  toml: ['application/toml', 'text/toml'],
  xml: ['application/xml', 'text/xml'],
  srt: ['subrip', 'application/x-subrip', 'text/srt'],
  vtt: ['webvtt', 'text/vtt'],
  // The file on disk is a .md, so the Markdown spellings have to hit too — an
  // agent holding a post with a `---` fence knows it as Markdown first.
  frontmatter: ['md', 'markdown', 'yaml frontmatter', 'text/markdown'],
  'clean csv': ['csv', 'text/csv'],
  'messy csv': ['csv', 'text/csv'],
  pdf: ['application/pdf'],
  'scanned pdf': ['pdf', 'application/pdf'],
  'digital-born pdf': ['pdf', 'application/pdf'],
  'searchable pdf': ['pdf', 'application/pdf'],
  'pdf tables': ['pdf', 'application/pdf'],
  'page images': ['png', 'jpeg', 'jpg', 'image/png'],
  docx: ['doc', 'word', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  'office docs': ['docx', 'xlsx', 'pptx', 'office'],
  xlsx: ['xls', 'excel', 'spreadsheet', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  epub: ['application/epub+zip', 'ebook'],
  'legacy ebook': ['mobi', 'azw3', 'ebook'],
  svg: ['image/svg+xml'],
  jpeg: ['jpg', 'image/jpeg'],
  png: ['image/png'],
  images: ['png', 'jpeg', 'jpg', 'image/png', 'image/jpeg'],
  'web images': ['webp', 'jpeg', 'jpg', 'image/webp'],
  'heic photos': ['heic', 'heif', 'image/heic'],
  mp4: ['video/mp4', 'h264', 'mov'],
  video: ['mp4', 'mov', 'mkv', 'video/mp4'],
  audio: ['wav', 'flac', 'aiff', 'audio/wav', 'audio/x-wav'],
  'audio file': ['wav', 'mp3', 'flac', 'audio/mpeg'],
  'mp3 / opus': ['mp3', 'opus', 'audio/mpeg', 'audio/opus'],
  'recorded speech': ['wav', 'mp3', 'audio/wav', 'audio/mpeg'],
  transcript: ['srt', 'vtt', 'text/vtt'],
  'plain text': ['txt', 'text', 'text/plain'],
  'utf-8': ['txt', 'text/plain'],
  sqlite: ['db', 'sqlite3', 'application/vnd.sqlite3'],
  'image of text': ['png', 'jpeg', 'jpg', 'image/png', 'image/jpeg'],
  'media file': ['mp4', 'jpeg', 'pdf', 'heic'],
};

// Lowercase, trimmed, leading dots stripped — so `.md`, `MD` and `md` collapse
// to one key. The Worker normalises the incoming query the same way; the two
// implementations have to agree, which is why the rule is this short.
const normaliseAlias = (s) => String(s).trim().toLowerCase().replace(/^\.+/, '');

const aliasesFor = (label) =>
  Array.from(new Set([label, ...(FORMAT_ALIASES[label] || [])].map(normaliseAlias))).filter(Boolean);

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

// What a hosted tool costs, in one phrase. With the free tier off there is only
// one fact to state, so the phrase is just the price.
const tierLabel = (hosted) => {
  if (isFree(hosted)) return FREE_TIER_ON ? `free, ${FREE_TIER_DAILY}/day cap` : 'free';
  return FREE_TIER_ON ? `${FREE_TIER_DAILY}/day free, then ${priceLabel(hosted.price)}` : priceLabel(hosted.price);
};

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
  e._xaliases = aliasesFor(e._xlabel);
  e._yaliases = aliasesFor(e._ylabel);
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
).sort((a, b) => a - b);

// The figure, in the shortest honest form: one price when the tools agree, the
// span when they do not. It is used everywhere the page and the machine files
// used to carry a typed "$0.001" — reprice a tool in entries.yaml and every one
// of those sentences moves with it, which is the whole point of deriving it.
//
// The span is a RANGE, not a hedge: "$0.005–$0.01" tells a caller what to budget
// for, where the old degraded phrasing ("a per-call price") told it nothing and
// sent it to /check to find out. Per-tool exactness still lives on each card,
// in catalog.json and in the 402 envelope.
const PRICE_RANGE = !priceAmounts.length
  ? 'a per-call price'
  : priceAmounts.length === 1
    ? `$${priceAmounts[0]}`
    : `$${priceAmounts[0]}–$${priceAmounts[priceAmounts.length - 1]}`;
const PRICE_PHRASE = priceAmounts.length ? `${PRICE_RANGE} in USDC via x402` : 'a per-call price in USDC via x402';

// Moved down from the top of the file so it can read PRICE_RANGE. Both strings
// state the price and neither types it.
const STRAPLINE = FREE_TIER_ON
  ? 'A collection of tools for agents — no install required. Privacy-first: no login, no credit card, ' +
    'no account. Every tool is free to try.'
  : `Tools for agents — no install, no login, no account, no card. Pay per call in USDC: ${PRICE_RANGE} a ` +
    'call over x402, where the payment is the auth.';
const META_DESCRIPTION = FREE_TIER_ON
  ? `Conversion tools an agent can call over HTTP with nothing installed. No login, no credit card. ` +
    `Every tool is free to try — ${FREE_TIER_DAILY} conversions a day — then priced per call in USDC with x402.`
  : `Conversion tools an agent can call over HTTP with nothing installed. No login, no account, no ` +
    `card — every call is priced per call in USDC with x402 (${PRICE_RANGE}), and the payment is the auth.`;

// The briefing an agent reads before deciding to call: what is sold, how a call
// is shaped, what a probe costs, and what the money does. Published as
// info["x-guidance"] in openapi.json (AgentCash discovery). Same derived figures
// as the rest of the copy — nothing here is typed twice, and nothing here says
// anything about who is buying.
const GUIDANCE = [
  `${SITE_NAME} sells ${hostedLive.length} hosted file conversions over plain HTTP: POST the raw input as the ` +
    'request body of /convert/{id} — no JSON wrapper, no multipart, 256 KB cap — and the converted file comes ' +
    'back as the response body of the same request. Nothing is queued: there is no job id, nothing to poll and ' +
    'no expiring link.',
  'GET /check is free, touches no store and lists every conversion with its id, price and tier, so you can find ' +
    'the id you need and what it costs without spending anything.',
  FREE_TIER_ON
    ? `The first ${FREE_TIER_DAILY} conversions per caller per UTC day are free; past that a call is a paid call ` +
      'at the price its operation states, and an unpaid one answers HTTP 402 carrying the full x402 quote.'
    : 'There is no account, no API key, no signup and no minimum. Every paid route answers an unpaid call with ' +
      'HTTP 402 carrying the full x402 quote — the v1 envelope in the body, the v2 envelope base64 in the ' +
      'PAYMENT-REQUIRED header — before the body is read or converted, so probing a price costs nothing and ' +
      'settles nothing.',
  `Prices are ${PRICE_PHRASE}, stated per tool in this document, in catalog.json and in the 402 itself; the quote ` +
    'you were handed is the amount that settles, because both come from one catalog.',
  'You are charged only for a conversion that is actually served — a 400, 413, 429 or 503 settles nothing.',
].join(' ');

const PRICING_LINE = FREE_TIER_ON
  ? `Every tool is free to try: ${FREE_TIER_DAILY} conversions a day, no login. ` +
    `Past that it's a paid call — ${PRICE_PHRASE}, with much higher limits.`
  : `Every call is a paid call — ${PRICE_PHRASE}. No account, no key, no card: the 402 is the ` +
    `front door, and the payment is the auth.`;

const SUMMARY = FREE_TIER_ON
  ? `${hostedEntries.length} hosted · ${localOnly.length} local references. ` +
    `${FREE_TIER_DAILY} free conversions a day on every hosted tool.`
  : `${hostedEntries.length} hosted · ${localOnly.length} local references. ` +
    `Every hosted call is priced per call — ${PRICE_PHRASE}.`;

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
/* Deliberately NOT uppercased, unlike .kind: the pill carries "x402" and the
   tool's own price, and shouting it as X402 misspells a protocol name. */
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

// One pill per fact. With the free tier on there are two — what it costs to try
// (nothing, FREE_TIER_DAILY a day) and what a call costs past that. With it off
// there is one fact, so the x402 price pill stands alone.
function pricePills(h) {
  if (h.status === 'planned') return '<span class="pill pill-planned">planned</span>';
  const paid = `<span class="pill pill-paid">$${esc(h.price.amount_usd)} x402</span>`;
  if (!FREE_TIER_ON) return isFree(h) ? '<span class="pill pill-free">free</span>' : paid;
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
  ['openapi.json', 'openapi.json'],
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
      <p class="note">Returns the matching pairs with their endpoint, price and status. <code>from</code> is matched against what you have, <code>to</code> against what you need — as a substring of the name, or as an extension or MIME type: <code>md</code>, <code>.md</code> and <code>text/markdown</code> all find the same tool. No parameters returns every hosted tool.</p>
    </div>
    <div class="agent-row">
      ${cmdRow(`curl -X POST "${API_BASE}/convert/md-html" --data-binary @README.md`, 'Copy the convert command')}
      <p class="note">Post the raw file as the body; the converted file comes back as the body. Input is capped at 256 KB. ${
        FREE_TIER_ON
          ? `The first ${FREE_TIER_DAILY} calls a day are free and say how many are left in <code>x-free-tier-remaining</code>; past that the answer is a <code>402</code> carrying an x402 envelope to pay against.`
          : 'An unpaid call answers <code>402</code> carrying an x402 envelope to pay against — or a <code>429</code> on a deployment with no receiving address configured.'
      }</p>
    </div>

    <h4>2. The whole catalog as files</h4>
    <div class="agent-row">
      ${cmdRow(`curl ${BASE}/catalog.json`, 'Copy catalog.json fetch command')}
      <p class="note">Structured entries — every field, including the hosted endpoint.</p>
    </div>
    <div class="agent-row">
      ${cmdRow(`curl ${BASE}/openapi.json`, 'Copy openapi.json fetch command')}
      <p class="note">OpenAPI 3.1 — every route, every response, including the <code>402</code>.</p>
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
      ${cmdRow('npx skills add algonormative/lemon-toolshed', 'Copy the skill install command')}
      <p class="note">Teaches an agent the check-then-convert habit, the 256 KB cap and the paid flow. Always-works fallback: copy <code>skills/toolshed/</code> from the repo into your agent's skills directory.</p>
    </div>

    <h4>4. MCP</h4>
    <div class="agent-row">
      ${cmdRow('claude mcp add toolshed -- npx -y github:algonormative/lemon-toolshed', 'Copy the MCP install command')}
      <p class="note">Three tools over stdio: <code>toolshed_check</code>, <code>toolshed_convert</code>, <code>toolshed_catalog</code>. From a local clone instead:</p>
      ${cmdRow('claude mcp add toolshed -- node /path/to/lemon-toolshed/mcp/server.mjs', 'Copy the local-clone MCP install command', 'cmd-sm')}
      <p class="note">Point it somewhere else with <code>TOOLSHED_URL</code>.</p>
    </div>

    <p>Links on this page are plain <code>href</code>s to the tool, with no redirect and no interstitial.</p>
  </section>

  <section class="prose" id="pay-with-usdc">
    <h2>Pricing, and paying with USDC</h2>
    <p>${esc(PRICING_LINE)}</p>
${
  FREE_TIER_ON
    ? `    <p>The free tier needs no account, no key and no wallet — just call the endpoint. Every free-tier answer carries an <code>x-free-tier-remaining</code> header saying how many of the day's ${FREE_TIER_DAILY} are left, and the count resets at midnight UTC. It is counted per caller, where a caller is an IP address: rotating your user-agent does not get you a second ${FREE_TIER_DAILY}.</p>
    <p>Past the free tier, a call answers <strong>HTTP 402</strong>, and the body of that 402 is an <a href="https://www.x402.org" rel="noopener">x402</a> envelope: it names the price, the asset — USDC on Base — and the <code>payTo</code> address the money should go to. That envelope is the whole negotiation.</p>`
    : `    <p>There is no trial and no sign-up, because there is nothing to sign up to. A call with no payment answers <strong>HTTP 402</strong> straight away, and the body of that 402 is an <a href="https://www.x402.org" rel="noopener">x402</a> envelope: it names the price, the asset — USDC on Base — and the <code>payTo</code> address the money should go to. That envelope is the whole negotiation, and it is the front door rather than a rejection.</p>
    <p><strong>USDC on Base or on Solana.</strong> The envelope's <code>accepts</code> array is the authority on which rails are live, and it can carry more than one entry — Base first, then Solana at the same price, since USDC is six decimals on both chains. Read the array and take the first entry you can pay rather than assuming there is exactly one.</p>
    <p>You are charged only for conversions that are actually served. A payment is verified before the conversion runs and settled after it is delivered, so input we cannot convert — a <code>400</code> — costs you nothing, and a body over the 256 KB cap is refused with a <code>413</code> before an envelope is even built.</p>`
}

    <p>Your agent needs two things to answer it:</p>
    <ol>
      <li>An <strong>x402-capable HTTP client</strong> — <code>x402-fetch</code>, the x402 SDK, or <a href="https://docs.cdp.coinbase.com/x402/welcome" rel="noopener">Coinbase AgentKit</a>.</li>
      <li>A <strong>wallet key holding USDC</strong> on one of the rails the envelope names — Base, or Solana where that entry is listed — which the client signs with.</li>
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

      2026-08-19: free tier retired in favour of 402-first discoverability.
      Coinbase's Bazaar index requires an unauthenticated request to answer 402
      and health-probes on an interval, so a free tier that serves fresh IPs a
      200 keeps the service out of the index — and drops it once listed. The
      mechanism is intact behind the FREE_TIER_DAILY env var; only the default
      changed.

      NOTE FOR EDITORS: this comment lives inside a JS template literal, so it
      must contain no backticks and no dollar-brace sequences.
    -->
    <div class="status-box">
${
  FREE_TIER_ON
    ? `      <p><span class="status-label">Honest status</span>The free tier is
      <strong>live and enforced</strong>, and payment is <strong>live and
      verified</strong>: a call past the free tier answers the <code>402</code>
      envelope above, and a payment presented against it is checked with the
      Coinbase CDP facilitator before the conversion is served — a verified call
      comes back with <code>x-payment-verified: true</code> and settles on Base
      immediately afterwards. If the facilitator cannot be reached, the call is
      served anyway and says so with <code>x-payment-error</code>: at ${PRICE_RANGE} a
      call the price is a signal, and an outage on our side should not turn a
      paying caller away.</p>`
    : `      <p><span class="status-label">Honest status</span>The free tier is
      <strong>switched off</strong>: every conversion is a paid call, priced per
      tool — ${PRICE_RANGE}, with the exact figure on each card and in the
      <code>402</code> envelope.
      Payment is <strong>live and verified</strong> — a payment presented
      against the <code>402</code> envelope above is checked with the Coinbase
      CDP facilitator before the conversion is served, a verified call comes
      back with <code>x-payment-verified: true</code>, and it settles on the rail
      it was paid on immediately afterwards. If the facilitator cannot be reached, the call is
      served anyway and says so with <code>x-payment-error</code>: at these
      prices the price is a signal, and an outage on our side should not turn a
      paying caller away.</p>`
}
    </div>
  </section>

  <section class="prose" id="how-we-count">
    <h2>How we count</h2>
    <p>This page runs a small script that reports two things: that the page loaded, and which outbound link was clicked. Nothing else is collected — filtering and copying send nothing — and links are plain links, so they work with the script blocked.</p>
    <p>Conversion calls are counted too: one row per call, recording that a call happened and which tool it used. The file you send is not stored and not logged.</p>
${
  FREE_TIER_ON
    ? `    <p>The free-tier counter is separate, and it is the one place a caller is identified across calls: it is keyed on a daily-salted hash of the IP address alone — no user-agent, so rotating one does not mint a fresh allowance — which makes it unlinkable across days once the salt is replaced, and it is kept on the same retention as every other counter here.</p>`
    : `    <p>One more counter is separate, and it is the one place a caller is identified across calls: a daily ceiling on served calls, there so a runaway client cannot bill us into a hole. It is keyed on a daily-salted hash of the IP address alone — no user-agent, so rotating one does not mint a fresh allowance — which makes it unlinkable across days once the salt is replaced, and it is kept on the same retention as every other counter here. An unpaid call never reaches it: the <code>402</code> is answered before anything is read or written.</p>
    <p>Paid calls also write a settlements row — which tool, the paying wallet address, the amount, whether it verified and settled, and the transaction hash. A payer address is public on-chain data, but we hold a copy, so it is named here rather than left to be discovered.</p>`
}
    <p>Here is the counting policy in full: ${esc(BOT_POLICY)}. Click delivery is best-effort, so the click number is a floor rather than a total.</p>
  </section>

  <section class="prose" id="privacy">
    <h2>Privacy</h2>
    <p>There are ${FREE_TIER_ON ? 'two' : 'three'} stores here, and they answer a "what do you hold on me" request differently.</p>
    <p><strong>The counting store</strong> holds a short hash, not an address. The hash is salted with random bytes that are replaced at the first request of each UTC day, and replacing them is the deletion: once the old salt is gone, nothing in the store points back to anyone. Rows are kept 90 days at most, then reduced to daily totals and deleted. Files you send to a conversion endpoint are never written to it. ${
      FREE_TIER_ON
        ? 'The free-tier counter lives in the same store under the same rules — a daily-salted hash of the IP alone, one row per caller per day, pruned on the same 90-day chore.'
        : 'The daily ceiling on served calls lives in the same store under the same rules — a daily-salted hash of the IP alone, one row per caller per day, pruned on the same 90-day chore.'
    }</p>
${
  FREE_TIER_ON
    ? ''
    : `    <p><strong>The settlements ledger</strong> is the one store that holds something durable about a person: one row per payment attempt, recording the tool, the paying wallet address, the amount, whether verification and settlement succeeded, and the transaction hash. Those addresses are public on-chain data — a payment is a public act — but we hold them, and they are not salted away nightly, because a payment ledger you cannot reconcile is not a ledger.</p>\n`
}    <p><strong>An IP blocklist</strong> exists to stop abuse. It is keyed on the address, so it does identify a requester, and we delete an address on request; rows expire 90 days after they were last seen.</p>
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
  // What GET /check will also match this entry on, beyond a substring of x/y.
  // Published so an agent can see the accepted spellings rather than guess them.
  x_aliases: e._xaliases,
  y_aliases: e._yaliases,
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
    openapi: `${BASE}/openapi.json`,
    // The number the STATIC surfaces advertise. GET /check reports what the
    // Worker actually enforces at runtime, which is authoritative if they ever
    // disagree — see the FREE_TIER_DAILY note in build.mjs.
    free_tier_daily: FREE_TIER_DAILY,
    note: FREE_TIER_ON
      ? `Entries with a hosted block run on our server. Every one is free to try — ${FREE_TIER_DAILY} conversions ` +
        'per caller (per IP) per UTC day, reported in an x-free-tier-remaining header — and priced per call past ' +
        'that: HTTP 402 with an x402 envelope naming a live USDC address on Base. A payment presented against that ' +
        'envelope is verified with the Coinbase CDP facilitator before the conversion is served, and settles on Base ' +
        'immediately afterwards. x402 v1 and v2 are both served from that one 402 — v1 in the body, v2 base64 in a ' +
        'PAYMENT-REQUIRED response header. Entries without a hosted block are local-only references.'
      : 'Entries with a hosted block run on our server, and every one is a paid call — there is no free tier. An ' +
        'unauthenticated POST answers HTTP 402 immediately, carrying an x402 envelope that names a live USDC ' +
        'address and the per-call price. Payment is in USDC on Base or on Solana: the envelope\'s accepts array ' +
        'lists the rails that are live, Base first, at the same price on either — read it rather than assuming a ' +
        'single entry. A payment presented against that envelope is verified with the Coinbase CDP facilitator ' +
        'before the conversion is served, and settles on the rail it was paid on immediately afterwards. You ' +
        'are charged only for conversions that are actually served: a 400 on input we cannot convert settles ' +
        'nothing. x402 v1 and v2 are both served from that one 402 — v1 in the body, v2 base64 in a ' +
        'PAYMENT-REQUIRED response header. Entries without a hosted block are local-only references.',
  },
  entries: entries.map(catalogEntry),
};

// ---------------------------------------------------------------- llms.txt

const hostedLine = (e) =>
  e._hosted ? `hosted ${e._hosted.status}, ${tierLabel(e._hosted)}, at POST ${e._hosted.path}` : 'local only';

const TIER_LINES = FREE_TIER_ON
  ? [
      `Tiers: every hosted tool is free to try — ${FREE_TIER_DAILY} conversions per caller per UTC day, no login —`,
      `  and priced per call past that. A caller is an IP address (rotating the user-agent does not reset it);`,
      `  every free-tier response carries x-free-tier-remaining: <n>, and the count resets at midnight UTC.`,
    ]
  : [
      `Tiers: there is no free tier. Every hosted call is a paid call, priced per call, and an`,
      `  unauthenticated POST answers HTTP 402 immediately with the envelope to pay against — the 402`,
      `  is the front door, not a rejection. You are charged only for conversions actually served.`,
    ];

const PAYMENT_LINES = FREE_TIER_ON
  ? [
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
      `  x402 v1 + v2 dual-stack: the same 402 carries the v1 envelope in the body and the v2 envelope`,
      `  base64 in a PAYMENT-REQUIRED response header; pay with X-PAYMENT (v1) or PAYMENT-SIGNATURE (v2).`,
    ]
  : [
      `Payment: an unpaid call answers HTTP 402 with an x402 envelope — exact scheme, USDC on Base or`,
      `  on Solana — naming the price, the payTo address and an outputSchema describing the request`,
      `  body and the response. The accepts array lists the rails that are live, Base first, at the`,
      `  same price on either (USDC is 6 decimals on both chains); take the first entry you can pay`,
      `  rather than assuming there is exactly one. No accounts, no keys, per-call pricing. Pay with`,
      `  an x402-capable client (x402-fetch, the x402 SDK, Coinbase AgentKit) holding a wallet key`,
      `  with USDC on one of those rails; it signs and retries with an X-PAYMENT header. The payment`,
      `  is verified with the Coinbase CDP facilitator before the conversion is served: a verified`,
      `  call comes back with x-payment-verified: true and settles on the rail it was paid on`,
      `  immediately afterwards; a payment the facilitator rejects gets the 402 again with an`,
      `  invalidReason and no conversion; and if the facilitator cannot be reached the call is served`,
      `  anyway, saying so with x-payment-verified: false and x-payment-error. Settlement is queued only`,
      `  for a conversion that was actually served, so a 400 on input we cannot convert is never charged,`,
      `  and a body over the 256 KB cap is refused with 413 before an envelope is built. On a deployment`,
      `  with no receiving address configured, calls answer HTTP 429 instead of 402.`,
      `  x402 v1 + v2 dual-stack: the same 402 carries the v1 envelope in the body and the v2 envelope`,
      `  base64 in a PAYMENT-REQUIRED response header; pay with X-PAYMENT (v1) or PAYMENT-SIGNATURE (v2).`,
    ];

const API_HEADER = [
  `Availability check: GET ${API_BASE}/check?from=<what you have>&to=<what you need>`,
  `  Field-bound match, case-insensitive: from is matched against the "have" side only, to against`,
  `  the "need" side only. A parameter matches on a substring of the prose name OR on an exact`,
  `  alias — extensions and MIME types both work, with or without a leading dot (md, .md,`,
  `  text/markdown, yml, .yaml, text/html). Every match carries its own x_aliases and y_aliases, so`,
  `  the accepted spellings can be read rather than guessed. No parameters returns every hosted tool.`,
  `Convert: POST ${API_BASE}/convert/<id> with the raw file as the body (256 KB cap).`,
  `  The converted file comes back as the body, with the right Content-Type.`,
  ...TIER_LINES,
  ...PAYMENT_LINES,
  `OpenAPI: ${BASE}/openapi.json`,
  `Skill: npx skills add algonormative/lemon-toolshed`,
  `MCP: claude mcp add toolshed -- npx -y github:algonormative/lemon-toolshed`,
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
              // Stated only when there IS one. A "hosted_free_tier: 0" line
              // reads as a broken template rather than as a fact.
              ...(e._hosted.free_tier_daily > 0
                ? [`hosted_free_tier: ${e._hosted.free_tier_daily} conversions per caller per UTC day`]
                : []),
              `hosted_status: ${e._hosted.status}`,
            ]
          : []),
        `aliases_from: ${e._xaliases.join(', ')}`,
        `aliases_to: ${e._yaliases.join(', ')}`,
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

// ---------------------------------------------------------------- openapi.json
//
// A real OpenAPI 3.1 description of the API, emitted as a static file.
//
// x402scan and friends look for it at GET {origin}/openapi.json. dist/ is served
// by Pages AT the origin, so writing the file is the whole implementation: a
// real file beats the SPA fallback that currently answers unknown paths.
//
// It describes what the Worker actually does, including the failure modes. An
// OpenAPI document that lists only the 200 is worse than none — the 402 is the
// interesting response here, and it is the one a machine has to handle.

const X402_ENVELOPE_SCHEMA = {
  type: 'object',
  description: 'An x402 v1 payment requirements envelope — the terms to pay against.',
  required: ['scheme', 'network', 'maxAmountRequired', 'resource', 'payTo', 'asset'],
  properties: {
    scheme: { type: 'string', enum: ['exact'] },
    network: {
      type: 'string',
      enum: ['base', 'solana'],
      description:
        'The chain this entry is payable on, in x402 v1 spelling. Read it rather than assuming: ' +
        '`accepts` can carry more than one entry, and `asset`, `payTo` and `extra` all change with it.',
    },
    maxAmountRequired: {
      type: 'string',
      description:
        'Price in atomic units of `asset`. USDC has 6 decimals, so "2000" is $0.002. Each tool ' +
        'names its own amount; do not assume one price across the API.',
      examples: ['5000'],
    },
    resource: { type: 'string', format: 'uri', description: 'The URL being paid for.' },
    description: { type: 'string' },
    mimeType: { type: 'string', description: 'Content type of the conversion this pays for.' },
    payTo: { type: 'string', description: 'The receiving address.' },
    maxTimeoutSeconds: { type: 'integer', examples: [60] },
    asset: {
      type: 'string',
      description:
        'USDC, on the network this entry names — the Base contract on `base`, the SPL mint on ' +
        '`solana`. Six decimals on both, so one price serves either rail.',
      examples: ['0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'],
    },
    extra: {
      type: 'object',
      description:
        'Per-network signing detail, and its contents depend on `network`. On `base` it is the ' +
        "EIP-712 domain the client signs over — USDC's on-chain name() is \"USD Coin\", which is " +
        'not its ticker, and a client that signs over the wrong domain produces a payment the ' +
        'facilitator cannot recover. On `solana` it is instead { feePayer }, the account that pays ' +
        'the transaction fee; there is no EIP-712 domain to sign on that rail.',
      properties: {
        name: { type: 'string' },
        version: { type: 'string' },
        feePayer: { type: 'string', description: 'Solana only. The fee-paying account.' },
      },
    },
    outputSchema: {
      type: 'object',
      description: 'How to call the resource and what comes back. `input.discoverable` marks it for indexing.',
      properties: {
        input: {
          type: 'object',
          properties: {
            type: { type: 'string', enum: ['http'] },
            method: { type: 'string', enum: ['POST'] },
            discoverable: { type: 'boolean' },
            bodyType: { type: 'string' },
            description: { type: 'string' },
          },
        },
        output: {
          type: 'object',
          properties: { type: { type: 'string' }, description: { type: 'string' } },
        },
      },
    },
  },
};

const ERROR_SCHEMA = {
  type: 'object',
  required: ['error'],
  properties: { error: { type: 'string', description: 'A plain sentence naming what went wrong.' } },
};

const paymentRequiredResponse = {
  description:
    'Payment required, in both x402 protocol versions at once. The body is the x402 v1 envelope; ' +
    'pay it with a v1 client and retry the same request with an X-PAYMENT header. The same 402 ' +
    'also carries the x402 v2 envelope, base64, in the PAYMENT-REQUIRED response header — that is ' +
    'where a v2 client looks, and it pays with a PAYMENT-SIGNATURE header. A body that also ' +
    'carries `invalidReason` means a payment WAS presented and the facilitator rejected it — ' +
    'retrying the same payload will fail identically.',
  headers: {
    'PAYMENT-REQUIRED': {
      description:
        'The x402 v2 PaymentRequired envelope, base64-encoded JSON: { x402Version: 2, resource, ' +
        'accepts, extensions.bazaar }. The same rails at the same prices as the v1 body, in v2 ' +
        'spelling — `amount` instead of `maxAmountRequired`, CAIP-2 networks (`eip155:8453` for ' +
        '`base`, `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp` for `solana`), and the outputSchema ' +
        'moved into extensions.bazaar. Entry i here is entry i of the v1 body.',
      schema: { type: 'string' },
    },
  },
  content: {
    'application/json': {
      schema: {
        type: 'object',
        required: ['x402Version', 'accepts'],
        properties: {
          x402Version: { type: 'integer', enum: [1] },
          error: { type: 'string' },
          invalidReason: { type: 'string' },
          invalidMessage: { type: ['string', 'null'] },
          accepts: {
            type: 'array',
            minItems: 1,
            description:
              'The rails this call can be paid on, best first. Usually USDC on Base; a deployment ' +
              'with the Solana rail configured offers USDC on Solana as a second entry at the same ' +
              'price. Take the first entry you can pay — do not assume there is exactly one.',
            items: X402_ENVELOPE_SCHEMA,
          },
        },
      },
    },
  },
};

// ---------------------------------------------------------------- x-payment-info
//
// AgentCash/Poncho routes a paid tool call from a desktop agent to an x402
// seller whose GET /openapi.json carries `info["x-guidance"]` and, on every paid
// operation, `x-payment-info` (their discovery spec, read 2026-09-02). Both are
// rendered from the SAME catalog the 402 envelope is built from — a price typed
// into a discovery document a second time is a rate card that goes stale
// silently, which is the exact failure PRICE_RANGE exists to prevent.

// USDC's 6 decimals — the same base the Worker's atomicAmount() rounds to, so
// the decimal published here and the atomic amount that settles cannot disagree.
const USD_DECIMALS = 6;

// Decimal USD as a plain string, rendered THROUGH the atomic amount rather than
// by stringifying the float: String(0.0000012) is "1.2e-6", and a price in
// exponent notation is one no discovery parser will read.
const usdDecimal = (usd) => {
  const digits = String(Math.round(usd * 10 ** USD_DECIMALS)).padStart(USD_DECIMALS + 1, '0');
  const frac = digits.slice(-USD_DECIMALS).replace(/0+$/, '');
  return frac ? `${digits.slice(0, -USD_DECIMALS)}.${frac}` : digits.slice(0, -USD_DECIMALS);
};

// Every hosted tool here is flat-priced, so the mode is `fixed`. No `mpp`
// protocol object (there is no MPP runtime on this Worker) and no
// x-discovery.ownershipProofs (the format is undocumented — inventing one would
// be a claim we cannot back).
const paymentInfo = (hosted) => ({
  protocols: [{ x402: {} }],
  price: { mode: 'fixed', currency: 'USD', amount: usdDecimal(hosted.price.amount_usd) },
});

const convertPaths = Object.fromEntries(
  hostedLive.map((e) => [
    e._hosted.path,
    {
      post: {
        operationId: `convert_${e.id.replace(/-/g, '_')}`,
        summary: `${oneLine(e.x)} to ${oneLine(e.y)}`,
        description:
          `${firstSentence(e.verdict)} POST the raw file as the request body — no JSON wrapper, no ` +
          `multipart — and the converted file comes back as the response body. Input is capped at ` +
          `256 KB. ${
            FREE_TIER_ON
              ? `The first ${FREE_TIER_DAILY} calls per caller per UTC day are free; past that a call is priced at ${priceLabel(e._hosted.price)}.`
              : `Every call is priced at ${priceLabel(e._hosted.price)}; a call with no X-PAYMENT header answers 402 with the envelope to pay against.`
          }`,
        tags: ['convert'],
        // The AgentCash discovery block, on the paid operations only — a free
        // tool has nothing to quote, and a route that advertises a price it does
        // not charge is the same lie as one that hides the price it does.
        ...(isFree(e._hosted) ? {} : { 'x-payment-info': paymentInfo(e._hosted) }),
        parameters: [
          {
            name: 'X-PAYMENT',
            in: 'header',
            required: false,
            description:
              'A base64-encoded x402 v1 payment payload, signed against the envelope in the 402 body.',
            schema: { type: 'string' },
          },
          {
            name: 'PAYMENT-SIGNATURE',
            in: 'header',
            required: false,
            description:
              'The x402 v2 equivalent: a base64-encoded v2 payment payload, signed against the ' +
              'envelope in the 402 PAYMENT-REQUIRED header. Send one header or the other, not both.',
            schema: { type: 'string' },
          },
        ],
        requestBody: {
          required: true,
          description: `The raw ${oneLine(e.x)} file, as the body. Up to 256 KB.`,
          content: { 'text/plain': { schema: { type: 'string' } } },
        },
        responses: {
          200: {
            description: `The converted ${oneLine(e.y)} file.`,
            headers: {
              'x-payment-verified': {
                description: 'true when the payment was checked with the facilitator before serving.',
                schema: { type: 'string', enum: ['true', 'false'] },
              },
              'x-payment-error': {
                description: 'Present when the call was served WITHOUT its payment being verified.',
                schema: { type: 'string' },
              },
            },
            content: { [responseMime(e)]: { schema: { type: 'string' } } },
          },
          400: {
            description:
              'The input could not be converted. Never charged: settlement is queued only for a ' +
              'conversion that was actually served.',
            content: { 'application/json': { schema: ERROR_SCHEMA } },
          },
          402: paymentRequiredResponse,
          413: {
            description: 'The body is larger than the 256 KB cap. Refused on the declared size, before any work.',
            content: { 'application/json': { schema: ERROR_SCHEMA } },
          },
          429: {
            description:
              'Either this deployment has no receiving address configured (nothing to pay, so nothing ' +
              'to offer), or the per-caller daily ceiling on served calls is reached.',
            content: { 'application/json': { schema: ERROR_SCHEMA } },
          },
          503: {
            description: 'The rate-limit store is unreachable. /convert fails closed rather than open.',
            content: { 'application/json': { schema: ERROR_SCHEMA } },
          },
        },
      },
    },
  ])
);

const openapi = {
  openapi: '3.1.0',
  info: {
    title: `${SITE_NAME} — tools for agents`,
    version: BUILD_DATE,
    summary: 'Hosted file conversions an agent can call over HTTP with nothing installed.',
    description:
      `${STANCE}\n\n` +
      (FREE_TIER_ON
        ? `Every hosted tool is free to try — ${FREE_TIER_DAILY} conversions per caller per UTC day — and priced per call past that.`
        : 'Every hosted call is a paid call. There is no account and no key: a call with no payment ' +
          'answers HTTP 402 with an x402 envelope, and paying it is the whole authentication story. ' +
          'You are charged only for conversions that are actually served.') +
      `\n\nThe same catalog is published as ${BASE}/catalog.json, ${BASE}/llms.txt and ${BASE}/llms-full.txt.`,
    // Free prose for an agent deciding whether and how to call — AgentCash reads
    // this key, and a human reading the document gets the same briefing. Every
    // figure in it is DERIVED (tool count, price span) rather than typed, so a
    // repricing moves it. It describes the mechanism and nothing about demand.
    'x-guidance': GUIDANCE,
    // The registries key ownership verification on this address (x402scan told
    // us so verbatim when we registered). Owner-chosen 2026-08-19.
    contact: { name: HOUSE, email: 'support@lemon-agent.dev', url: 'https://lemon-agent.dev' },
    license: { name: 'Proprietary', identifier: 'LicenseRef-Proprietary' },
  },
  servers: [{ url: API_BASE, description: 'Production' }],
  tags: [
    { name: 'catalog', description: 'What this service can convert.' },
    { name: 'convert', description: 'The hosted conversions. Priced per call in USDC via x402.' },
  ],
  paths: {
    '/check': {
      get: {
        operationId: 'check',
        summary: 'List the conversions available for a pair.',
        description:
          'Field-bound match: `from` is tested against the "have" side only, `to` against the "need" ' +
          'side only. Each parameter matches on a case-insensitive substring of the prose name OR on ' +
          'an exact alias, so extensions and MIME types work with or without a leading dot — `md`, ' +
          '`.md`, `text/markdown`. With no parameters the answer is every hosted tool. Touches no ' +
          'store, so it is exempt from every rate limit and costs nothing.',
        tags: ['catalog'],
        parameters: [
          {
            name: 'from',
            in: 'query',
            required: false,
            description: 'What you have. Max 64 characters.',
            schema: { type: 'string', maxLength: 64 },
            examples: {
              prose: { value: 'markdown' },
              extension: { value: 'md' },
              dotted: { value: '.md' },
              mime: { value: 'text/markdown' },
            },
          },
          {
            name: 'to',
            in: 'query',
            required: false,
            description: 'What you need. Max 64 characters.',
            schema: { type: 'string', maxLength: 64 },
            examples: { prose: { value: 'html' }, mime: { value: 'text/html' } },
          },
        ],
        responses: {
          200: {
            description: 'The matching entries. An empty `matches` array is a valid answer, not an error.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['query', 'matches'],
                  properties: {
                    query: {
                      type: 'object',
                      properties: {
                        from: { type: ['string', 'null'] },
                        to: { type: ['string', 'null'] },
                      },
                    },
                    matches: {
                      type: 'array',
                      items: {
                        type: 'object',
                        required: ['id', 'x', 'y', 'hosted', 'local', 'url'],
                        properties: {
                          id: { type: 'string', description: 'The id to POST to /convert/{id}.' },
                          x: { type: 'string', description: 'What it takes, in prose.' },
                          y: { type: 'string', description: 'What it produces, in prose.' },
                          hosted: {
                            type: ['object', 'null'],
                            description: 'Null for a local-only reference — there is no endpoint to call.',
                            properties: {
                              path: { type: 'string' },
                              status: { type: 'string', enum: ['live', 'planned'] },
                              free_tier_daily: {
                                type: 'integer',
                                description:
                                  'Free conversions per caller per UTC day, as the Worker enforces it ' +
                                  'right now. 0 means every call is a paid call.',
                              },
                              price: {
                                oneOf: [
                                  { type: 'string', enum: ['free'] },
                                  {
                                    type: 'object',
                                    properties: {
                                      amount_usd: { type: 'number' },
                                      scheme: { type: 'string' },
                                    },
                                  },
                                ],
                              },
                            },
                          },
                          local: {
                            type: ['object', 'null'],
                            description: 'The tool to run yourself instead.',
                            properties: { tool: { type: 'string' }, install: { type: 'string' } },
                          },
                          url: { type: 'string', format: 'uri' },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
          400: {
            description: 'A parameter is longer than 64 characters.',
            content: { 'application/json': { schema: ERROR_SCHEMA } },
          },
          405: {
            description: 'GET only.',
            content: { 'application/json': { schema: ERROR_SCHEMA } },
          },
        },
      },
    },
    ...convertPaths,
  },
};

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

// The free tier as the STATIC surfaces advertise it. The Worker does NOT enforce
// this number — it reads env.FREE_TIER_DAILY at runtime and treats that as the
// only authority, so a dashboard flip takes effect without a rebuild. This
// export exists so the build constant and the deployed bundle stay legible to
// each other, and so the suite can assert on what was compiled in.
// OWNER-TUNABLE in build.mjs.
export const FREE_TIER_DAILY = ${FREE_TIER_DAILY};

// \`xa\`/\`ya\` are the /check alias sets — already normalised (lowercase, no
// leading dot), so the Worker only has to normalise the incoming query.
// Short keys because this object ships in the Worker bundle.
export const CATALOG = ${JSON.stringify(
  entries.map((e) => ({
    id: e.id,
    x: oneLine(e.x),
    y: oneLine(e.y),
    xa: e._xaliases,
    ya: e._yaliases,
    hosted: e._hosted,
    local: e._local,
    url: e.url,
  })),
  null,
  2
)};
`;

// ---------------------------------------------------------------- emit

// robots.txt: allow everything. It exists so a prober gets a real 200 with a
// real answer instead of the SPA fallback, which is indistinguishable from a
// misconfigured site to anything that checks.
const robots = ['User-agent: *', 'Allow: /', '', `Sitemap: ${BASE}/`, ''].join('\n');

rmSync(DIST, { recursive: true, force: true });
mkdirSync(DIST, { recursive: true });
writeFileSync(join(DIST, 'index.html'), html);
writeFileSync(join(DIST, 'catalog.json'), `${JSON.stringify(catalog, null, 2)}\n`);
writeFileSync(join(DIST, 'openapi.json'), `${JSON.stringify(openapi, null, 2)}\n`);
writeFileSync(join(DIST, 'robots.txt'), robots);
writeFileSync(join(DIST, 'llms.txt'), llms);
writeFileSync(join(DIST, 'llms-full.txt'), llmsFull);
writeFileSync(join(ROOT, 'worker', 'catalog.generated.js'), workerCatalog);

// dist/_routes.json — the paths that invoke functions/[[path]].js.
//
// The Pages ASSET layer 403s Python-stdlib user agents (`error code: 1010`)
// while code paths do not, so the machine surfaces have to be served from code.
// `_routes.json` is the documented way to keep that bounded: ONLY an `include`
// path invokes a Function, everything else is static at zero invocations — so
// index.html, the browser surface and the volume, stays off the metered path
// and the runbook's "a Function re-opens the twin's metered path" concern is
// capped at the machine files.
// The list is DERIVED from what this build just wrote, so a surface added later
// (sitemap.xml, skill.md) is covered without editing anything here.
const WELL_KNOWN = '.well-known/';
const distFiles = [];
(function walk(dir, prefix) {
  const entriesHere = readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name)
  );
  for (const dirent of entriesHere) {
    if (dirent.isDirectory()) walk(join(dir, dirent.name), `${prefix}${dirent.name}/`);
    else distFiles.push(`${prefix}${dirent.name}`);
  }
})(DIST, '');

const routes = {
  version: 1,
  include: [
    // index.html is the browser surface: static, free, and it passes the
    // integrity check. _routes.json is config. Anything under .well-known/ is
    // covered by the glob instead — which is listed whether the tree exists yet
    // or not, for the discovery and registry-verification files landing there.
    ...distFiles
      .filter((f) => f !== 'index.html' && f !== '_routes.json' && !f.startsWith(WELL_KNOWN))
      .map((f) => `/${f}`),
    `/${WELL_KNOWN}*`,
  ].sort(),
  exclude: [],
};
writeFileSync(join(DIST, '_routes.json'), `${JSON.stringify(routes, null, 2)}\n`);

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
console.log(
  FREE_TIER_ON
    ? `build: FREE TIER ON — static copy advertises ${FREE_TIER_DAILY}/day free. The Worker enforces ` +
        'env.FREE_TIER_DAILY, so set that var too or the site claims a tier it does not honour. ' +
        'WARNING: a free tier serves fresh IPs a 200, which drops this service from Bazaar discovery.'
    : 'build: FREE TIER OFF — every hosted call is a paid call; static copy says so. The Worker ' +
        'enforces env.FREE_TIER_DAILY (unset = off).'
);
console.log(
  'build: wrote dist/index.html dist/catalog.json dist/openapi.json dist/robots.txt dist/llms.txt ' +
    'dist/llms-full.txt dist/_routes.json worker/catalog.generated.js'
);
console.log(`build: Pages Function routes ${routes.include.join(' ')}`);
