# Toolshed

**A collection of tools for agents — no install required.** Privacy-first: no
login, no credit card. Pay per call with USDC; many tools are free.

An agent posts a file to an HTTP endpoint and gets the converted file back.
Priced tools answer HTTP 402 with an x402 envelope (USDC on Base); everything
else just answers.

Not everything is hosted. Where we do not run the conversion ourselves, the
entry is a **reference**: it names the tool worth reaching for, the caveats that
actually bite, and an `escalate` line saying where a model is honestly
warranted. So the catalog has two kinds of entry, and each one says which it is.
The install one-liner for a reference tool lives in `entries.yaml`,
`catalog.json` and `llms-full.txt` — deliberately **not** on the page, which is
about tools you do not have to install.

The unit is the **pair** — what you have, what you need. There are four ways in:

- **HTTP, first and always**: `GET /check` to see what exists,
  `POST /convert/<id>` to run it. This is the whole API.
- **Agents** install the skill (`npx skills add chronick/lemon-toolshed`) or add
  the MCP server (`claude mcp add toolshed -- npx -y github:chronick/lemon-toolshed`).
  Both are conveniences over the same HTTP surface.
- **Machines without an agent** fetch `catalog.json`, `llms.txt` or
  `llms-full.txt` — the whole catalog in one request.
- **People** get a page: pick what you have and what you need from two
  dropdowns, and read the cards.

Repo: `~/git/lemon-toolshed` (`chronick/lemon-toolshed`). It ships under the
**Lemon** house brand; the site name is **Toolshed**, and it lives at
`toolshed.lemon-agent.dev` on the measured zone.

Three honest caveats:

- **The curation is owner taste.** The 33 entries in `entries.yaml` are drafts
  for review, not a finished list, and every verdict is engineering judgment
  rather than measurement.
- **Payment is not enforced yet.** The priced endpoint answers a spec-valid 402
  when `PAYTO` is set, but nothing verifies settlement, so it serves the
  conversion anyway. See [Payment (x402)](#payment-x402) — this is deliberate,
  and it is stated in the response headers rather than hidden.
- **The visit counter has a hole.** The beacon counts script-executing clients,
  so the machine files are fetched by clients that execute nothing and stay
  invisible to it. Conversion calls *are* counted, because they go through the
  Worker. The available cross-check for the files is zone-analytics request
  counts; whether a Free zone breaks those out per path is unread.

Architecture of record: `tradewind/dossiers/conversion-tool-portfolio-dossier.md`
§ Architecture — 2026-08-18. Where this README and that section disagree, the
dossier wins.

## Layout

```text
entries.yaml                content tier — 33 draft entries, in git; review is a diff
build.mjs                   build step — emits dist/ and worker/catalog.generated.js
worker/beacon.js            the API Worker — /b, /check, /convert/*
worker/catalog.generated.js GENERATED from entries.yaml; committed, because deploy reads it
worker/schema.sql           D1 schema — events / daily_aggregates / blocklist / salt / counters
mcp/server.mjs              the MCP server — thin stdio wrapper over the HTTP API
skills/toolshed/SKILL.md    the agent skill — check availability, convert, x402
scripts/test-live.mjs       live smoke test + cost estimate; zero deps
wrangler.toml               Worker config; routes are live, database_id filled in at deploy
```

The read surface is still **static assets only, zero Functions**. The Worker is
the only metered path, and it now carries conversions as well as the beacon.

### Entry shape

Two optional blocks decide what an entry is:

```yaml
hosted:                      # present = we run this conversion
  path: "/convert/md-html"   # must equal /convert/ + the entry id
  price: free                # or { amount_usd: 0.001, scheme: exact }
  status: live               # or planned

local:                       # how to run it yourself
  tool: pandoc               # optional; defaults to the top-level `tool`
  install: "brew install pandoc"
```

No `hosted:` block means a local-only reference entry. A bare top-level
`install:` still works and is read as `local.install`, so entries written before
the split need no edit. The build fails if `hosted.path` and the id disagree.

## Worker dependencies

The Worker imports `marked`, `js-yaml`, `turndown` and `@mixmark-io/domino`.
Wrangler bundles npm dependencies natively — there is no build step to
configure — but `npm ci` has to have run before `wrangler deploy`.

One non-obvious bit: Turndown's browser build reaches for a global `document`
that workerd does not have. `worker/beacon.js` therefore parses HTML with domino
and hands Turndown the resulting element, which skips Turndown's own parser. Do
not "simplify" that back to `turndown(htmlString)` — it throws at runtime, not
at build time.

## Local demo

```bash
npm install
npm run db:local                 # apply worker/schema.sql to the local D1
npm run build:demo               # points the page and the curl lines at localhost
npm run dev:worker &             # the Worker on :8787 (miniflare, local D1)
npx serve dist -l 4173           # the page on :4173
```

Three build constants are env-overridable: `BEACON_URL` (what the inline beacon
posts to), `SITE_HOST` (the hostname printed in the page's file `curl` lines,
and the `resource` the Worker names in its x402 envelope) and `API_HOST` (the
host printed in the `/check` and `/convert` `curl` lines — a different port in
the demo, the same host in production). `build:demo` defaults all three to the
local pair.

Exercise the API:

```bash
curl "http://localhost:8787/check?from=markdown&to=html"
curl -X POST "http://localhost:8787/convert/md-html" --data-binary @README.md
curl -sD- -o/dev/null -X POST http://localhost:8787/convert/html-markdown --data-binary '<h1>hi</h1>'

node scripts/test-live.mjs http://localhost:8787   # the whole surface at once
```

Open <http://localhost:4173>, click an outbound link, then read the events back:

```bash
npx wrangler d1 execute DB --local \
  --command "SELECT ts, type, id_hash, entry, ref_class FROM events ORDER BY ts DESC LIMIT 20;"
```

`npm run build` with no overrides is the production build: the beacon URL is the
relative `/b`, and `worker/catalog.generated.js` carries the production
`SITE_BASE`. **Always re-run it before committing or deploying** — a
`build:demo` run leaves localhost in the generated file, and the build prints a
warning saying so.

## Deploy runbook

Verbatim from the dossier hand-back. Nothing below has been run — no repo has
been created, nothing is deployed, no Cloudflare login has happened.

```text
DEPLOY, in order:
 1. Create repo. Entries file (33 draft entries for owner review) + build
    step emitting page, catalog.json, llms.txt, llms-full.txt, how-we-count
    note, privacy note. Every entry carries a `verified` date.
 2. Pages project from the repo, named `lemon-toolshed` — STATIC ASSETS
    ONLY, ZERO FUNCTIONS. A Function re-opens the pages.dev twin's metered
    path.
 3. Custom hostname on the lemon-agent.dev zone: toolshed.lemon-agent.dev.
    An off-zone deploy re-fails checklist item 2. The same hostname is the
    `SITE_HOST` build constant, so the curl lines and the x402 `resource`
    match it.
 4. D1: events / daily_aggregates / blocklist / salt.
 5. API Worker, routes /b + /check + /convert/* on the zone, D1 binding; the
    page addresses the beacon by RELATIVE URL.
 6. Rate-limiting rule — the zone's one Free rule: 5 req / 10 s per IP,
    action block, over /b AND /convert/* (expression below). NOT /check.
 7. Access-lock the production *.pages.dev twin (Pages Known-issues
    procedure).
 8. Configure the $25 billing alert; commit the route-disable runbook to the
    README.
 9. Link the directory from the measured umbrella surface.
10. Launch = beacon live. KC-CUR's 60-day clocks start that day.
```

**Step 6, the rung-0 expression.** The original rule matched `/b` alone. It has
to be widened, because `/convert/*` executes rungs 1 and 2 *inside* the Worker —
a request they reject is already billed, and a conversion costs more CPU than a
beacon does. `/check` is deliberately left out: it touches no D1 and does no
work, so it stays cheap and open.

```text
(http.host eq "toolshed.lemon-agent.dev" and
 (http.request.uri.path eq "/b" or starts_with(http.request.uri.path, "/convert/")))
```

Commands for steps 4–5, once the owner has picked the hostname:

```bash
npm ci                                                  # wrangler bundles the Worker's deps
npm run build                                           # regenerates worker/catalog.generated.js
npx wrangler d1 create lemon_toolshed                   # copy the id into wrangler.toml
npx wrangler d1 execute DB --remote --file worker/schema.sql
npx wrangler deploy                                     # routes are live in wrangler.toml
node scripts/test-live.mjs                              # smoke-test the deployed API
```

**The routes, and the one counter-intuitive bit.** `wrangler.toml` carries them
live:

```toml
routes = [
  { pattern = "toolshed.lemon-agent.dev/b", zone_name = "lemon-agent.dev" },
  { pattern = "toolshed.lemon-agent.dev/check*", zone_name = "lemon-agent.dev" },
  { pattern = "toolshed.lemon-agent.dev/convert/*", zone_name = "lemon-agent.dev" }
]
```

`/check*` carries a wildcard and `/b` does not, on purpose. Per the Workers
routing docs, *"route pattern matching considers the entire request URL,
including the query parameter string"*, and *"route patterns may not contain
query parameters"* — so a bare `toolshed.lemon-agent.dev/check` would match
`/check` and **miss** `/check?from=markdown&to=html`, which is every real call.
A `/check?*` pattern is not the fix either; it is invalid. A terminal wildcard
is the only form that catches both. `/convert/*` already ends in one; `/b` is
POSTed with no query string, so it stays exact.

Build output for step 2 is `dist/`, produced by `npm run build`. Pages build
command: `npm ci && npm run build`; output directory: `dist`.

## Installing it in an agent

Plain HTTP needs no install at all — `curl` the two endpoints. The two surfaces
below are conveniences over exactly that API, and neither adds a capability the
HTTP surface lacks.

### The skill

```bash
npx skills add chronick/lemon-toolshed
```

`skills/toolshed/SKILL.md` follows the `skills/<name>/` convention, so the repo
slug is the whole argument. Always-works fallback — copy the directory in:

```bash
cp -r skills/toolshed ~/.claude/skills/
```

### The MCP server

```bash
claude mcp add toolshed -- npx -y github:chronick/lemon-toolshed

# or from a local clone, no network fetch:
claude mcp add toolshed -- node /path/to/lemon-toolshed/mcp/server.mjs
```

`mcp/server.mjs` is a thin stdio wrapper: every tool is one `fetch` against the
public API, and it holds no state, no key and no wallet. Three tools:

| tool | arguments | does |
| --- | --- | --- |
| `toolshed_check` | `from?`, `to?` | `GET {BASE}/check` |
| `toolshed_convert` | `tool_id`, `input` | `POST {BASE}/convert/{tool_id}`, returns the converted text |
| `toolshed_catalog` | — | `GET {BASE}/llms.txt` |

`BASE` is `TOOLSHED_URL`, defaulting to `https://toolshed.lemon-agent.dev`. On a
`402`, `toolshed_convert` does not swallow the envelope: it returns a readable
explanation quoting the price, the asset and the `payTo` address, says what an
x402 client would do with it, and states that settlement is not switched on yet.

Dependencies: `@modelcontextprotocol/sdk` (exact-pinned) and Node 18+ for global
`fetch`. The `bin` entry plus the shebang are what make
`npx -y github:chronick/lemon-toolshed` run the server directly.

Smoke-test it with no network — initialize, then list the tools:

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
  | node mcp/server.mjs
```

## Payment (x402)

The priced endpoint is `POST /convert/html-markdown` at $0.001 a call. It is the
demonstration pair: one priced tool so there is a working x402 flow to point at,
with everything else free.

Two environment variables, both unset by default:

| var | read? | effect |
| --- | --- | --- |
| `PAYTO` | yes | the receiving address (USDC on Base) named in the 402 envelope |
| `FACILITATOR_URL` | **not yet** | reserved; settlement verification is unbuilt |

Behaviour, exactly as implemented:

| `PAYTO` | `X-PAYMENT` sent? | response |
| --- | --- | --- |
| unset | either | **200**, the conversion, header `x-pricing: pending` |
| set | no | **402**, a spec-valid x402 v1 envelope |
| set | yes | **200**, the conversion, `x-pricing: pending` + `x-payment-verified: false` |

The third row is the honest one. Verifying a payment needs a facilitator; there
isn't one wired up, and the Worker will not pretend to have checked something it
cannot check. It says so in a header rather than silently accepting the call as
paid. **Full enforcement lands with the facilitator** — until then, treat
`PAYTO` as a way to exercise the 402 flow, not as revenue.

The page publishes the same thing in plain language under **How to get my agent
to pay with USDC?** — what the 402 carries, the two things an agent needs (an
x402-capable HTTP client and a wallet key holding USDC on Base), a copy-able
`x402-fetch` example, and an honest-status box saying pricing is not enforced
yet. The MCP server's `toolshed_convert` says the same on a 402 rather than
returning a bare error.

The envelope (`x402Version: 1`) advertises `scheme: exact`, `network: base` and
`asset` = USDC on Base (`0x8335…2913`). `maxAmountRequired` is in atomic units,
6 decimals, so $0.001 is `"1000"`. The price lives in `entries.yaml` and the
atomic conversion happens in the Worker, so changing the price is a one-line
content edit.

Set it for a local test without editing the file:

```bash
npx wrangler dev --local --port 8787 --var PAYTO:0xTEST
```

## Shutdown runbook

There is **no preventive spend cap** on Workers. The controls are detective: a
$25 billing alert (step 8) plus this runbook.

What a shutdown costs is no longer only metrics. The read surface is unmetered
static Pages, so the page, the catalog files and every outbound link keep
working — but the **hosted conversions go with the Worker**, and so does
`/check`. Agents get connection failures, not a graceful answer. If the burn is
coming from one conversion rather than all of them, prefer the narrow option:

```bash
# Option A (narrow) — set the offending entry's hosted.status to `planned` in
# entries.yaml, then rebuild and redeploy. The route stops answering, the page
# says "planned", and the rest of the shed stays up.
npm run build && npx wrangler deploy

# Option B — remove the /convert route only: drop that line from routes = [...]
# in wrangler.toml, keeping the beacon and /check alive, then
npx wrangler deploy

# Option C — remove all routes and redeploy: comment out routes = [...] in
# wrangler.toml, then
npx wrangler deploy

# Option D — delete the Worker outright (fastest; loses the beacon, /check and
# every hosted conversion)
npx wrangler delete --name lemon-toolshed-beacon

# Option E — dashboard: Workers & Pages → lemon-toolshed-beacon → Settings →
# Domains & Routes → remove the routes.
```

Exposure while the alert is unanswered is roughly the $25 threshold plus burn ×
response latency: at 1,000 req/s sustained, ≈$26 at same-day response, ≈$78 at
two days.

## Operator queries (KC-CUR)

There is no admin page — an admin page is an auth surface, and this design's
whole argument is that it has none. KC-CUR is read with `wrangler d1 execute`.
Swap `--remote` for `--local` against the demo database.

**Daily visits, outbound clicks and conversions.** Visits and clicks come from
the same script-executing population; conversions come from anything that can
make an HTTP request, which is the point:

```bash
npx wrangler d1 execute DB --remote --command "
  SELECT date(ts, 'unixepoch') AS day,
         SUM(type = 'visit')    AS visits,
         SUM(type = 'click')    AS clicks,
         SUM(type = 'convert')  AS conversions,
         COUNT(DISTINCT id_hash) AS identifiers
  FROM events
  GROUP BY day
  ORDER BY day DESC
  LIMIT 60;"
```

**Which tools actually get called** — the demand signal that decides what to
host next, and the evidence that re-opens the deferred MCP surface:

```bash
npx wrangler d1 execute DB --remote --command "
  SELECT entry,
         SUM(type = 'convert') AS conversions,
         SUM(type = 'click')   AS clicks
  FROM events WHERE entry IS NOT NULL
  GROUP BY entry ORDER BY conversions DESC, clicks DESC LIMIT 40;"
```

**Compacted history**, for days whose raw rows have been pruned:

```bash
npx wrangler d1 execute DB --remote --command "
  SELECT day, metric, value FROM daily_aggregates ORDER BY day DESC LIMIT 120;"
```

### Retention chores

The Worker exports no `scheduled` handler — zero crons for the MVP by design.
Lazy salt rotation needs none; the two retention promises published in the
page's privacy note are enforced here, by hand, on the refresh cadence.

**Compact, then prune raw events at 90 days** (run compaction first — the prune
is what makes the aggregate the only remaining record):

```bash
npx wrangler d1 execute DB --remote --command "
  INSERT INTO daily_aggregates (day, metric, value)
  SELECT date(ts, 'unixepoch'),
         'visits',
         COUNT(*)
  FROM events WHERE type = 'visit' GROUP BY 1
  ON CONFLICT(day, metric) DO UPDATE SET value = excluded.value;

  INSERT INTO daily_aggregates (day, metric, value)
  SELECT date(ts, 'unixepoch'), 'clicks', COUNT(*)
  FROM events WHERE type = 'click' GROUP BY 1
  ON CONFLICT(day, metric) DO UPDATE SET value = excluded.value;

  INSERT INTO daily_aggregates (day, metric, value)
  SELECT date(ts, 'unixepoch'), 'conversions', COUNT(*)
  FROM events WHERE type = 'convert' GROUP BY 1
  ON CONFLICT(day, metric) DO UPDATE SET value = excluded.value;

  DELETE FROM events WHERE ts < strftime('%s', 'now', '-90 days');"
```

**Blocklist expiry — enforced in the operator query, not by a cron.** Rows
expire 90 days after last-seen; a subject-rights purge is the same `DELETE`
keyed on the address:

```bash
npx wrangler d1 execute DB --remote --command "
  DELETE FROM blocklist WHERE last_seen < strftime('%s', 'now', '-90 days');"

# purge on request
npx wrangler d1 execute DB --remote --command "
  DELETE FROM blocklist WHERE ip = '203.0.113.9';"
```

The events store has no equivalent purge, and that is the point: it holds a
truncated daily-salted hash and nothing attributable to a requester once the
salt has rotated. That is true of conversion rows as well as beacon rows — and
the conversion input was never written in the first place.

## Limits, as built

| rung | where | control | failure mode |
|---|---|---|---|
| 0 | Cloudflare edge | rate-limiting rule on `/b` **and** `/convert/*`, 5 req / 10 s per IP, block | shared-IP undercount, recorded as a measurement cost |
| 1 | Worker | 100 events / identifier / UTC day, over `/b` and `/convert/*` together | honest runaway client stops counting and stops converting; UA rotation still mints fresh identifiers |
| 2 | Worker | 200,000 events / UTC day, fail-closed before insert | metrics loss and no conversions for the rest of the day |
| 3 | — | none; priced, not bounded — $2.49/day at 100 req/s, $25.82/day at 1,000 req/s | detective only: $25 alert + shutdown runbook |

Rung 0 is configured in the dashboard (deploy step 6), not in this repo. It is
the zone's only Free rate-limiting rule, so a second instrumented house surface
on `lemon-agent.dev` contends for it. **Its expression must cover `/convert/*`
as well as `/b`** — the expression is in the deploy runbook above.

Rungs 1 and 2 execute inside the Worker, so a request they reject is already
billed. CPU is metered separately from requests, which is why
`worker/beacon.js` checks method, path and body size before it reads a body,
hashes anything, touches D1, or runs a conversion.

**Rungs 1 and 2 share one set of counters across all three routes.** A
conversion writes an `events` row exactly like a beacon event does, because the
rungs count rows: a conversion that wrote nothing would not be rate-limited at
all. Two consequences worth knowing before launch:

- The per-identifier budget is **100 events a day total**, not 100 of each. A
  caller that loads the page and then makes 99 conversions is done for the day.
  If conversion demand turns out to be real, this is the first number to split.
- Daily visit counts now include callers who never load the page, so the
  `type` column is what separates them. The operator queries above already do.

`GET /check` is the exception: no D1, no row, no rung. It is a pure in-memory
filter over the catalog compiled into the bundle, so it stays cheap and open.

### Failing closed on `/convert`

`/b` and `/convert` disagree on purpose about what to do when the store is
unreachable. `/b` drops the event silently — metrics loss is the acceptable
failure. `/convert` answers **503**. Failing open on a metered endpoint is
precisely the runaway-cost scenario rung 3 has no mechanism for, so an
unavailable limiter means no conversions rather than unlimited ones.

## Count integrity and privacy, as published

The bot policy is on the page verbatim: *the count is script-executing clients
minus self-declared bots; thresholds are set so crawler residue does not clear
them alone; no claim to perfect human detection is made.* Self-declared bot
user-agents are dropped before any write. That filter applies to `/b`; a
conversion call is counted whatever its user-agent claims, because it is a real
call rather than an audience measurement.

Two stores, two subject-rights answers, both stated on the page: the counting
store holds a truncated daily-salted hash and nothing attributable once the salt
rotates; the IP blocklist is attributable and is purged on request.

**Conversion inputs are never stored.** The `events` row records that a call
happened, which tool it used, and the day-scoped hash — never the body. The page
says so in *How we count* and again in *Privacy*.

One dependency of the anonymization argument is flagged in the dossier and
unresolved here: *whether D1's own point-in-time restore retains overwritten
rows* is unread. If it does, the salt's ≤24 h window is really as long as the
restore horizon, and the fallback is to hold the salt outside the restorable
store. A derived salt (`HMAC(secret, date)`) is not the fallback — it is
recomputable forever, which is the negation of discarded-at-rotation.

## Maintenance

The refresh pass is ~4 h/month: re-check the verdicts, bump `verified`, and open
a PR. `build.mjs` prints a `STALE` warning for any entry whose `verified` date is
more than 35 days old and marks it *review due* on the page, so staleness is
visible in the build rather than discovered by a reader.

The smoke test now exists: `scripts/test-live.mjs` posts a known payload to
every hosted endpoint and asserts a distinctive substring came back, so a rotted
converter shows up as a red row rather than as a broken product.

```bash
node scripts/test-live.mjs                        # production
node scripts/test-live.mjs http://localhost:8787  # against wrangler dev --local
```

It covers `GET /check` with and without parameters, all five happy-path
conversions, a malformed-input `400`, a `413` at 300 KB, and a `POST /b` visit —
then prints a PASS/FAIL table and exits non-zero on any failure. Zero
dependencies; Node 18+ for global `fetch`. A run writes ~8 event rows against
the caller's rung-1 budget of 100/day.

A priced endpoint answering `402` is reported as a pass, not a failure: once
`PAYTO` is set, the envelope *is* the correct response.

After the table it prints a **cost estimate** from named constants with the
arithmetic shown — Workers requests and CPU, D1 rows written, the assumed 2 ms
per conversion — the cost of the run just made (≈ $0, every meter inside its
allowance), and a table of monthly cost at 1k / 10k / 100k / 1M calls a day.
Requests are the allowance that cracks first, at roughly 333k calls/day
(10M req/mo); at 1M calls/day the metered charge is about $16.60/month on top of
the flat plan fee. Everything there is labelled *list prices as of 2026-08-18*
and needs re-reading, not trusting, after any Cloudflare repricing.

One piece of automation is still **not built**: a CI link-check over every
`url`.

Adding a hosted tool is four steps: add the `hosted:` block in `entries.yaml`,
add the matching entry to `CONVERTERS` in `worker/beacon.js`, run `npm run build`
(which regenerates `worker/catalog.generated.js`), and deploy. The build fails
if `hosted.path` and the entry id disagree; the Worker answers `501` if an entry
is listed `live` with no implementation behind it.
