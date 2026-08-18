# Toolshed

**Toolshed** is a curated conversion-tool directory at the use-case layer: *which
tool, when.* The unit is the **pair** — what you have, what you need — not
the tool, which is the layer neither the awesome-lists (keyed by tool) nor the
per-tool review sites occupy. Each entry names one tool worth reaching for, an
install one-liner, the caveats that actually bite, and an `escalate` line saying
where a model is honestly warranted. The editorial stance is the deterministic
tool wherever it suffices, and a model only where the target is judgment-defined.
There are two surfaces: a human page — a have/need picker over a grid of shelved
verdict cards — and a machine surface (`catalog.json` + `llms.txt` +
`llms-full.txt`) for an agent arriving on a *have X, need Y* query.

Repo: `~/git/lemon-toolshed` (`chronick/lemon-toolshed`). It ships under the
**Lemon** house brand; the site name is **Toolshed**, and it lives at
`toolshed.lemon-agent.dev` on the measured zone.

Two honest caveats. **The curation is an owner-taste surface** — the 30 entries
in `entries.yaml` are drafts for review, not a finished list, and every verdict is
engineering judgment rather than measurement. **The instrument has a hole**: the
beacon counts script-executing clients, so the three machine files — the
differentiator — are fetched by clients that execute nothing and are invisible to
it. The available cross-check is zone-analytics request counts; whether a Free
zone breaks those out per path is unread. Serving the machine files through the
Worker to count them is rejected on purpose: it would put the differentiator on
the metered path, which is where a runaway client lands first.

Architecture of record: `tradewind/dossiers/conversion-tool-portfolio-dossier.md`
§ Architecture — 2026-08-18. Where this README and that section disagree, the
dossier wins.

## Layout

```text
entries.yaml       content tier — 30 draft entries, in git; review is a diff
build.mjs          build step — emits dist/{index.html,catalog.json,llms.txt,llms-full.txt}
worker/beacon.js   beacon Worker — POST /b, rungs 1 and 2, D1 write
worker/schema.sql  D1 schema — events / daily_aggregates / blocklist / salt / counters
wrangler.toml      Worker config; route and database_id filled in at deploy
```

The read surface is **static assets only, zero Functions**. The beacon is the
only metered path in the system.

## Local demo

```bash
npm install
npm run db:local                 # apply worker/schema.sql to the local D1
npm run build:demo               # BEACON_URL=http://localhost:8787/b SITE_HOST=localhost:4173
npm run dev:worker &             # beacon Worker on :8787 (miniflare, local D1)
npx serve dist -l 4173           # the page on :4173
```

Both build constants are env-overridable: `BEACON_URL` is what the inline beacon
posts to, and `SITE_HOST` is the hostname printed in the page's *For agents*
`curl` lines. `build:demo` defaults them to the local pair; either can be
overridden on the command line.

Open <http://localhost:4173>, click an outbound link, then read the events back:

```bash
npx wrangler d1 execute DB --local \
  --command "SELECT ts, type, id_hash, entry, ref_class FROM events ORDER BY ts DESC LIMIT 20;"
```

`npm run build` (no `BEACON_URL`) is the production build: the beacon URL is the
relative `/b`, which is what the deployed page must ship.

## Deploy runbook

Verbatim from the dossier hand-back. Nothing below has been run — no repo has
been created, nothing is deployed, no Cloudflare login has happened.

```text
DEPLOY, in order:
 1. Create repo. Entries file (30 draft entries for owner review) + build
    step emitting page, catalog.json, llms.txt, llms-full.txt, how-we-count
    note, privacy note. Every entry carries a `verified` date.
 2. Pages project from the repo, named `lemon-toolshed` — STATIC ASSETS
    ONLY, ZERO FUNCTIONS. A Function re-opens the pages.dev twin's metered
    path.
 3. Custom hostname on the lemon-agent.dev zone: toolshed.lemon-agent.dev.
    An off-zone deploy re-fails checklist item 2. The same hostname is the
    `SITE_HOST` build constant, so the *For agents* curl lines match it.
 4. D1: events / daily_aggregates / blocklist / salt.
 5. Beacon Worker, route POST <host>/b on the zone, D1 binding; the page
    addresses it by RELATIVE URL.
 6. Rate-limiting rule — the zone's one Free rule: path /b, 5 req / 10 s per
    IP, action block.
 7. Access-lock the production *.pages.dev twin (Pages Known-issues
    procedure).
 8. Configure the $25 billing alert; commit the route-disable runbook to the
    README.
 9. Link the directory from the measured umbrella surface.
10. Launch = beacon live. KC-CUR's 60-day clocks start that day.
```

Commands for steps 4–5, once the owner has picked the hostname:

```bash
npx wrangler d1 create lemon_toolshed                   # copy the id into wrangler.toml
npx wrangler d1 execute DB --remote --file worker/schema.sql
# uncomment the routes = [...] block in wrangler.toml, then:
npx wrangler deploy
```

Build output for step 2 is `dist/`, produced by `npm run build`. Pages build
command: `npm ci && npm run build`; output directory: `dist`.

## Shutdown runbook

There is **no preventive spend cap** on Workers. The controls are detective: a
$25 billing alert (step 8) plus this runbook. Disabling the route costs metrics
and nothing else — the read surface is unmetered static Pages, so the directory
stays up and the links keep working.

```bash
# Option A — remove the route and redeploy: comment out routes = [...] in
# wrangler.toml, then
npx wrangler deploy

# Option B — delete the Worker outright (fastest, loses nothing but the beacon)
npx wrangler delete --name lemon-toolshed-beacon

# Option C — dashboard: Workers & Pages → lemon-toolshed-beacon → Settings →
# Domains & Routes → remove the /b route.
```

Exposure while the alert is unanswered is roughly the $25 threshold plus burn ×
response latency: at 1,000 req/s sustained, ≈$26 at same-day response, ≈$78 at
two days.

## Operator queries (KC-CUR)

There is no admin page — an admin page is an auth surface, and this design's
whole argument is that it has none. KC-CUR is read with `wrangler d1 execute`.
Swap `--remote` for `--local` against the demo database.

**Daily visits and outbound clicks** (the two legs, over the same
script-executing population):

```bash
npx wrangler d1 execute DB --remote --command "
  SELECT date(ts, 'unixepoch') AS day,
         SUM(type = 'visit')   AS visits,
         SUM(type = 'click')   AS clicks,
         COUNT(DISTINCT id_hash) AS identifiers
  FROM events
  GROUP BY day
  ORDER BY day DESC
  LIMIT 60;"
```

**Which pairs get clicked** — the only evidence that re-opens the deferred MCP
surface:

```bash
npx wrangler d1 execute DB --remote --command "
  SELECT entry, COUNT(*) AS clicks
  FROM events WHERE type = 'click' AND entry IS NOT NULL
  GROUP BY entry ORDER BY clicks DESC LIMIT 30;"
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

The beacon store has no equivalent purge, and that is the point: it holds a
truncated daily-salted hash and nothing attributable to a requester once the
salt has rotated.

## Limits, as built

| rung | where | control | failure mode |
|---|---|---|---|
| 0 | Cloudflare edge | rate-limiting rule on `/b`, 5 req / 10 s per IP, block | shared-IP undercount, recorded as a measurement cost |
| 1 | Worker | 100 events / identifier / UTC day | honest runaway client stops counting; UA rotation still mints fresh identifiers |
| 2 | Worker | 200,000 events / UTC day, fail-closed before insert | metrics loss for the rest of the day |
| 3 | — | none; priced, not bounded — $2.49/day at 100 req/s, $25.82/day at 1,000 req/s | detective only: $25 alert + shutdown runbook |

Rung 0 is configured in the dashboard (deploy step 6), not in this repo. It is
the zone's only Free rate-limiting rule, so a second instrumented house surface
on `lemon-agent.dev` contends for it.

Rungs 1 and 2 execute inside the Worker, so a request they reject is already
billed. CPU is metered separately from requests, which is why `worker/beacon.js`
checks method, path and body size before it reads a body, hashes anything, or
touches D1.

## Count integrity and privacy, as published

The bot policy is on the page verbatim: *the count is script-executing clients
minus self-declared bots; thresholds are set so crawler residue does not clear
them alone; no claim to perfect human detection is made.* Self-declared bot
user-agents are dropped before any write.

Two stores, two subject-rights answers, both stated on the page: the beacon
store holds a truncated daily-salted hash and nothing attributable once the salt
rotates; the IP blocklist is attributable and is purged on request.

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
visible in the build rather than discovered by a reader. A CI link-check over
every `url` is the other half of that automation and is **not built yet**.
