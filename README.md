# Toolshed

**A collection of tools for agents — no install required.** Privacy-first: no
login, no credit card, no account.

**Every hosted tool is a paid call, priced per tool: $0.005 for a conversion
between two structured text formats, $0.01 for the ones that build a DOM or a
document tree (the HTML tools and the XML reader). Paid in USDC via x402. There
is no free tier — the 402 is the front door, and the payment is the auth.**

An agent posts a file to an HTTP endpoint and gets the converted file back. A
call carrying no payment answers HTTP 402 on the *first* request, and that 402
carries an x402 envelope (USDC on Base) naming a live receiving address — in
**both protocol versions at once** since 2026-08-19: v1 in the body, v2 base64
in a `PAYMENT-REQUIRED` response header. Or HTTP 429 on a deployment with no
receiving address configured (`PAYTO` unset). A payment presented against that envelope is
verified with the Coinbase CDP facilitator before the conversion is served, and
settled on Base immediately afterwards. **You are only charged for conversions
that are actually served**: a `400` on input we cannot convert settles nothing,
and a body over the 256 KB cap is refused with a `413` before an envelope is
even built.

The free tier was **retired on 2026-08-19**, in exchange for discoverability —
see [Discoverability (Bazaar)](#discoverability-bazaar). The mechanism survives
behind the `FREE_TIER_DAILY` env var and is off by default;
[Re-enabling the free tier](#re-enabling-the-free-tier) is the runbook, and
says what turning it back on costs.

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
- **Payment is live; exactly two real payments have settled, both ours.**
  Every call is a paid call, and a spec-valid 402 is issued on the first
  unauthenticated request (`PAYTO` is set — live since 2026-08-18). A payment
  presented against it is verified and settled with the Coinbase
  CDP facilitator. Proven end to end twice: 2026-08-18 over x402 **v1**
  (tx `0xe2c8bb8d…`) and 2026-08-19 over x402 **v2** with the real
  `@x402/fetch` client (tx `0x4832d1ee…`) — both `verify_ok = 1`,
  `settle_ok = 1`, both made by us, not by a stranger. Two honest
  caveats: **no third party has paid yet**, so nothing is known about how a
  wallet we did not build behaves against this envelope, and an unreachable
  facilitator serves the call *unverified* rather than refusing it. See
  [Settlement (live)](#settlement-live) and
  [Pricing and payment (x402)](#pricing-and-payment-x402) — all of it is
  stated in the response headers rather than hidden.
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
worker/schema.sql           D1 schema — events / daily_aggregates / blocklist / salt / counters / convert_quota / settlements
mcp/server.mjs              the MCP server — thin stdio wrapper over the HTTP API
skills/toolshed/SKILL.md    the agent skill — check availability, convert, x402
test/                       the e2e suite — `npm test`, local only; see § Testing
scripts/test-live.mjs       the wide live probe + cost estimate; serves no conversions, spends nothing
scripts/create-test-buyer.mjs  OWNER ONLY — makes a throwaway buyer key (.buyer.env)
scripts/pay-test.mjs        OWNER ONLY — SPENDS REAL USDC; one paid call end to end
wrangler.toml               Worker config; routes are live, database_id filled in at deploy
```

The read surface is still **static assets only, zero Functions**. The Worker is
the only metered path, and it now carries conversions as well as the beacon.

### Entry shape

Two optional blocks decide what an entry is:

```yaml
hosted:                      # present = we run this conversion
  path: "/convert/md-html"   # must equal /convert/ + the entry id
  price:                     # what every call costs
    amount_usd: 0.005        # (see the note on `price: free` below)
    scheme: exact
  status: live               # or planned

local:                       # how to run it yourself
  tool: pandoc               # optional; defaults to the top-level `tool`
  install: "brew install pandoc"
```

No `hosted:` block means a local-only reference entry. A bare top-level
`install:` still works and is read as `local.install`, so entries written before
the split need no edit. The build fails if `hosted.path` and the id disagree.

**`price: free` is accepted by the build and is currently a dead end.** Every
hosted entry is priced, and nothing exercises the other branch: `overQuota()`
skips building an envelope when the price is `free`, so with the tier off such an
entry would answer the no-receiving-address 429 to every call — the wrong
sentence for what is actually a free tool. The page would meanwhile render it as
`free`. Nothing is broken today because no entry uses it; it is named here so the
next person to reach for it knows it needs the Worker changed first.

**The free tier is not a per-entry field, and it is not on.** `FREE_TIER_DAILY`
in `build.mjs` is **0**, and that constant now drives only the *static*
surfaces: it is stamped onto every hosted entry as `hosted.free_tier_daily`, so
it reaches `catalog.json`, `llms.txt` and `llms-full.txt`, and it is exported
into `worker/catalog.generated.js` so the compiled bundle stays legible.

**The Worker does not read it.** The only runtime authority is the
`FREE_TIER_DAILY` *env var*, read per request by `freeTierDaily()` in
`worker/beacon.js`; unset means 0 means no free tier. `GET /check` reports that
runtime value rather than the compiled one, so flipping the var in a dashboard
shows up immediately with no rebuild. The two halves can therefore disagree —
which is the price of a dashboard flip taking effect at once, and why
[Re-enabling the free tier](#re-enabling-the-free-tier) is a runbook with three
steps rather than one.

## Worker dependencies

The Worker imports `marked`, `js-yaml`, `turndown` and `@mixmark-io/domino`.
Wrangler bundles npm dependencies natively — there is no build step to
configure — but `npm ci` has to have run before `wrangler deploy`.

**That list did not grow when settlement landed.** The facilitator is two REST
calls and one Ed25519 JWT, and workerd signs Ed25519 natively, so verification
and settlement add **no production dependency** — see
[Settlement (live)](#settlement-live) for the reasoning and what was rejected.
`viem` and `x402-fetch` are devDependencies used only by the buyer test kit and
by one test; neither reaches the bundle.

One non-obvious bit: Turndown's browser build reaches for a global `document`
that workerd does not have. `worker/beacon.js` therefore parses HTML with domino
and hands Turndown the resulting element, which skips Turndown's own parser. Do
not "simplify" that back to `turndown(htmlString)` — it throws at runtime, not
at build time.

A second one, in the same function: `turndown.remove(['script', 'style',
'noscript'])`. Turndown's default rule emits the **text** of any element it has
no rule for, so without that line a saved page — this entry's stated input —
came back with its analytics snippet, its JSON-LD block and its inline CSS
sitting in the prose. It only ever showed for tags **inside** the body; a
leading `<script>` is hoisted into `<head>` by the parser and never reaches
`doc.body`, so a one-tag spot check looks clean. Covered by
`test/convert-html-markdown.test.mjs`.

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

Verbatim from the dossier hand-back (2026-08-18), preserved as provenance. At
hand-back time nothing below had been run; since then every step has been
executed and the service is live at toolshed.lemon-agent.dev — read the list
as the record of how it got there, with the deviations noted after it.

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
 4. D1: events / daily_aggregates / blocklist / salt / counters / convert_quota.
 5. API Worker, routes /b + /check + /convert/* on the zone, D1 binding; the
    page addresses the beacon by RELATIVE URL.
 6. Edge abuse control — OWNER-VERIFIED 2026-08-18: the dashboard gates
    rate-limiting rules behind a higher plan for this account, so the edge
    rate rule is DROPPED from this runbook. The deployed in-Worker tiers
    (5,000 served calls/day per IP-hash, 100/day beacon identifier, 200k/day
    global fail-closed) are the abuse bound, the $25 Usage-Based Billing
    notification (step 8 — free on every plan) is the bill bound, and the
    reactive edge control is a free WAF CUSTOM rule when the blocklist
    identifies abusers: expression `(ip.src in {<addresses>})`, action
    Block — blocks at the edge BEFORE billing. Populate it from the
    blocklist table (operator query below).
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

### Migration — the conversion-quota table (existing databases)

`worker/schema.sql` is all `CREATE TABLE IF NOT EXISTS`, so re-running the whole
file is safe. But the production database already exists, and the per-caller
conversion counter needs one new table, so **run this before deploying a Worker
that meters conversions** — the Worker fails closed, and a missing table means
503s, not unmetered conversions. `convert_quota` is what `PAID_DAILY` (the
runaway bound on served calls) is claimed against, so it is required whether or
not a free tier is configured:

```bash
npx wrangler d1 execute DB --remote --command "CREATE TABLE IF NOT EXISTS convert_quota (day TEXT, ip_hash TEXT, used INTEGER, PRIMARY KEY (day, ip_hash));"
```

### Migration — the settlements table (existing databases)

Settlement verification adds one more table. **Run this before deploying a
Worker that verifies payments:**

```bash
npx wrangler d1 execute DB --remote --command "CREATE TABLE IF NOT EXISTS settlements (ts INTEGER, tool TEXT, payer TEXT, amount TEXT, verify_ok INTEGER, settle_ok INTEGER, tx_hash TEXT, error TEXT);"
```

Unlike `convert_quota`, a missing `settlements` table does **not** take the
endpoint down: the ledger write is deliberately best-effort, so a forgotten
migration degrades to "payments work, nothing is recorded" rather than to 503s.
That is the safer failure, and it is also the easier one to miss — so run the
migration, then check it landed:

```bash
npx wrangler d1 execute DB --remote --command "SELECT name FROM sqlite_master WHERE name = 'settlements';"
```

Equivalently, `npx wrangler d1 execute DB --remote --file worker/schema.sql`
re-applies everything and creates only what is missing. Swap `--remote` for
`--local` to do the same to the demo database. Verify:

```bash
npx wrangler d1 execute DB --remote --command "SELECT name FROM sqlite_master WHERE name = 'convert_quota';"
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

`BASE` is `TOOLSHED_URL`, defaulting to `https://toolshed.lemon-agent.dev`.
Neither refusal is swallowed. On a `402`, `toolshed_convert` returns a readable
explanation quoting the price, the asset, the `payTo` address and the resource,
says what an x402 client would do with it, and states that payments are verified
with the CDP facilitator and settled — including what a `402` carrying an
`invalidReason` means, which is that a payment was rejected and resending the
same payload will fail the same way. On a `429` it tells the two forms apart by
what the body says and gives opposite advice for each: a deployment with no
receiving address is a misconfiguration, so retrying changes nothing ever and
there is no `Retry-After` to wait on; the per-caller daily ceiling is a runaway
bound that resets, quoted with the reset time in hours, and it says plainly that
a different user-agent will not help because the counter is keyed on the IP.

**The MCP server holds no free-tier number of its own.** It reads
`hosted.free_tier_daily` from `/check` and the `x-free-tier-remaining` header
from a response, and prints only what the service reported — the hosted service
publishes 0, and the header is absent there entirely. On a deployment that *has*
enabled a tier, a successful call comes back clean unless the header says
`LOW_TIER_WARN` (**1**) or fewer are left, in which case it carries a one-line
warning. A flat number rather than a fraction, because the tier's width is a
per-deployment setting this file cannot know. A verified paid call, and a call
served without verification because the facilitator was unreachable, each carry
their own one-liner too.

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

## Pricing and payment (x402)

**Every hosted tool is priced, and none of them has a trial.** A call costs
**$0.005 or $0.01 in USDC on Base** depending on the tool, negotiated with x402
— and the call that gets asked is the first one, not the fourth.

**Prices stopped being uniform on 2026-08-30.** Two bands, and the split is what
a call costs us to run: $0.005 for a parse-and-re-emit between two structured
text formats, $0.01 for anything that has to build a DOM or a full document tree
first. The figure lives in `entries.yaml` per entry and NOWHERE else — build.mjs
derives the site's pricing sentence from those numbers (a single price when they
agree, a range when they do not), the Worker reads each price out of the
compiled catalog, and the 402 envelope quotes the tool that was actually asked
for. Reprice a tool by editing one number and rebuilding.

### The free tier, retired

Until 2026-08-19 the first three conversions per caller per UTC day were served
for nothing. They are not any more, and the reason is discoverability rather
than money: Coinbase's Bazaar index requires that an unauthenticated request
answer 402, and it **health-probes on an interval** — so a tier that hands any
fresh IP a 200 does not merely fail the listing preflight, it drops a listing
that already exists. Discoverability beat the trial allowance. See
[Discoverability (Bazaar)](#discoverability-bazaar).

**The mechanism was kept; only the default changed.** Setting the Worker var
`FREE_TIER_DAILY = "N"` restores exactly the old behaviour — N calls per caller
per UTC day simply served, with an `x-free-tier-remaining` header, and the 402
or 429 moving to call N + 1. Phase 1 of `npm test` boots a worker with it on and
keeps every assertion the tier ever had, so the path stays tested rather than
rotting into dead env-gated code. [Re-enabling the free
tier](#re-enabling-the-free-tier) is the runbook, and it names the cost.

### x402 v2 — dual-stack, from 2026-08-19

**Both protocol versions are served from the same 402, and neither client sees
the other's.** The v1 envelope is the response BODY, exactly as it was. The v2
envelope is base64 JSON in a `PAYMENT-REQUIRED` **response header**, which is
where a v2 client looks first and a v1 client never looks at all.

| | x402 v1 | x402 v2 |
| --- | --- | --- |
| **envelope** | the 402's JSON body | `PAYMENT-REQUIRED` response header, base64 |
| **payment** | `X-PAYMENT` request header | `PAYMENT-SIGNATURE` request header |
| **price field** | `maxAmountRequired` | `amount` |
| **network** | `base` | `eip155:8453` (CAIP-2 — the colon is required) |
| **resource** | a URL string inside `accepts[0]` | a top-level object: `url`, `method`, `description`, `mimeType`, `tags`, `serviceName` |
| **discovery** | `accepts[0].outputSchema` | `extensions.bazaar` — `{ info, schema }` |
| **facilitator** | same two endpoints, same `{ x402Version, paymentPayload, paymentRequirements }` body | ditto, with `x402Version: 2` and the v2 shapes inside |

**The gate this clears.** Coinbase's Bazaar validator passes `returns_402` as of
2026-08-19 and then refuses the listing with *"Endpoint uses x402 v1 — upgrade
to x402 v2 to be discoverable."* The 402 was never the problem; the version was.

**Which version an inbound payment is, is read out of the payload's
`x402Version` field, not out of the header it arrived in.** That is what the
facilitator's own client keys on, and it survives a client that puts a v2
payload under the old header name. The version then decides the shape of both
the verify and the settle body — a v2 payload checked against a v1 envelope
verifies as invalid however good the payment was, so the mock facilitator in the
suite shape-checks every call against its declared version and answers `400` on
a mismatch.

**One construction point, still.** `paymentRequirements()` builds the v1 object;
`requirementsV2()`, `resourceInfoV2()` and `bazaarExtension()` are *projections*
of it. The two envelopes cannot disagree about price, `payTo`, asset or resource
because there is nothing for them to disagree with, and the suite asserts the
agreement field by field anyway.

**No configuration changed.** No new env var, no new endpoint, no new
dependency in the Worker bundle. `@x402/fetch` and `@x402/evm` (2.23.0) are
devDependencies, used only as the suite's v2 positive control.

**What is deliberately absent: `PAYMENT-RESPONSE`.** In v2 that header is a
settlement *receipt*, and this Worker has none to give at the moment it answers
— settlement is queued behind the response so a buyer is never charged for a
conversion that was not served. Emitting `success: true` before anything settled
would be the first fake thing this service says. `@x402/fetch` reads the receipt
inside a `try`/`catch` and carries on without one; the v2 positive control in
`test/x402-settlement.test.mjs` is the evidence that its absence costs a real
client nothing. What a caller gets instead is `x-payment-verified: true` — the
claim we can actually support.

**Two fields that are not in `@x402/core`'s schema.** `resource.method` is
carried because the live v2 sellers already in the index carry it (observed on
x402scan's own paid API, 2026-08-19) and a POST-only resource that does not say
so is a listing an agent calls wrong; zod strips what it does not know, so it is
inert for a v2 client and legible to a crawler, and the same fact is stated
again schema-legally as `extensions.bazaar.info.input.method`. `serviceName` and
`tags` *are* in `@x402/core` 2.23.0's `ResourceInfoSchema` (32-character
printable ASCII, at most 5 tags) though not in the older published spec text.

### The caller key

The counter itself did not go anywhere. `convert_quota` is what `PAID_DAILY` —
the runaway bound of 5,000 **served** calls per caller per UTC day — is claimed
against, and an env-enabled free tier claims against the same row with the same
key. So the key still matters, and the reasoning behind it is unchanged:

| | |
| --- | --- |
| **counted per** | `hash(daily salt + IP)` — the IP address **alone** |
| **not counted per** | user-agent, header set, TLS fingerprint, anything else spoofable for free |
| **window** | one UTC day; the counter resets at midnight UTC |
| **stored as** | one D1 row, `convert_quota(day, ip_hash, used)` |
| **claimed for** | calls that are actually SERVED. An unpaid 402 never reaches it |
| **reported as** | `x-free-tier-remaining: <n>`, only on a deployment that enabled a tier. Absent in production — and absent is not zero |

Deliberately **no user-agent in the key**. Including it is the obvious mistake:
a UA string is a header a caller writes, so a UA-keyed counter is an infinite
one for anyone who can type. Keying on the IP alone means a second identity
costs a second address — not free, and that is the whole point. It is not
unspoofable (proxy pools exist, and shared NAT undercounts real people in the
other direction); it is the cheapest control that makes the abuse cost more than
the abuse is worth at these prices.

The claim is spendable per call, not read-then-written: `claimConvertQuota()`
upserts with a guard — `ON CONFLICT … DO UPDATE SET used = used + 1 WHERE used <
ceiling RETURNING used` — so the check and the spend are one statement and
cannot race apart across isolates. No row back means the ceiling was already
reached.

### Environment variables

| var | read? | effect |
| --- | --- | --- |
| `PAYTO` | yes | the receiving address (USDC on Base) named in the 402 envelope. **Unset = there is nowhere to pay**, so unpaid calls answer 429 instead of 402. |
| `FREE_TIER_DAILY` | yes | free conversions per caller per UTC day. **Unset = 0 = off**, which is the production default. This var is the **only runtime authority** — the Worker does not read the compiled constant — so setting it takes effect on the next request and `GET /check` reports it immediately, with no rebuild. Anything unparseable, negative or below 1 reads as 0: a misconfigured var must fail towards charging, never towards giving the service away. |
| `FACILITATOR_URL` | yes | the x402 facilitator base URL. Defaults to `https://api.cdp.coinbase.com/platform/v2/x402`; overridden only by the test suite, which points it at a local mock. |
| `CDP_API_KEY_ID` | yes | CDP API key id. A **Worker secret**, not a var. |
| `CDP_API_KEY_SECRET` | yes | CDP API key secret (base64 Ed25519). A **Worker secret**. Without both keys nothing can be verified, and paid calls are served with `x-payment-error: facilitator-unconfigured`. |
| `TELEGRAM_BOT_TOKEN` | yes | owner alerts. A **Worker secret**. Unset = no Telegram channel. See [Payment alerts](#payment-alerts). |
| `TELEGRAM_CHAT_ID` | yes | owner alerts. A **Worker secret**. Unset = no Telegram channel. |
| `TELEGRAM_API_BASE` | yes | optional override of the Telegram API root, default `https://api.telegram.org`. Only the test suite sets it, to reach a local mock. |
| `ALERT_EMAIL_TO` | yes | owner alerts by email. A **Worker secret**, and it must be a **verified Email Routing destination** on the zone. Unset = no email channel. |
| `HOUSE_PAYERS` | yes | comma-separated wallet addresses whose payments read as a 🧪 test rather than a 🍋💰 sale. Compared lowercased. Non-secret: these are public chain addresses, and it lives in `wrangler.toml`. |

**`FREE_TIER_DAILY` is only half the switch.** It is what the *Worker* enforces;
the *static* copy — the page, `catalog.json`, `llms.txt`, `llms-full.txt`,
`openapi.json` — is generated from the separate `FREE_TIER_DAILY` constant in
`build.mjs`, which is `0`. Set one without the other and the site advertises a
tier it does not honour, or honours one it does not advertise.
[Re-enabling the free tier](#re-enabling-the-free-tier) moves both.

Set the two secrets with `wrangler secret put`, never in `wrangler.toml`:

```bash
npx wrangler secret put CDP_API_KEY_ID
npx wrangler secret put CDP_API_KEY_SECRET
```

### Behaviour, exactly as implemented

**The reject order on `POST /convert/<id>` is method → unknown id →
unimplemented → declared size → 402**, and the last two are in that order on
purpose: rejecting on a declared `content-length` is cheaper than constructing
an envelope, so a caller sending 300 KB is told the size is the problem rather
than asked to pay for a call that could never have run.

| checked | when it fires | answer |
| --- | --- | --- |
| method | anything but `POST` | **405** + `Allow: POST` |
| id | no hosted entry with that id | **404**, pointing at `GET /check` |
| implementation | listed `live` with no converter behind it | **501** |
| declared size | `content-length` over 256 KB | **413** — before the envelope, before any D1, before the body is read |

Past those guards, the answer is the paywall, and **it is the first call, not
the fourth**:

| `PAYTO` | `X-PAYMENT` | facilitator says | response |
| --- | --- | --- | --- |
| set | no | *not asked* | **402**, a spec-valid x402 v1 envelope for that tool. **No salt read, no quota claim, no D1 write of any kind** |
| set | malformed | *not asked* | **402** + `invalidReason: malformed_payment_header` — nothing decodable to send |
| set | yes | `isValid` | **200**, the conversion, `x-payment-verified: true`, and settlement runs after the response |
| set | yes | not valid | **402** + the envelope + `invalidReason` — no conversion served, and nothing settles |
| set | yes | *unreachable* | **200**, `x-payment-verified: false` + `x-payment-error` + `x-pricing: pending` — served unverified, recorded |
| set | yes | `isValid`, but the input will not convert | **400** — verified and **never settled**, so not charged |
| set | yes | `isValid`, past 5,000 served calls today | **429** + `Retry-After` — the runaway bound, not a price gate |
| unset | either | *not asked* | **429** naming the missing receiving address, `free_tier_daily: 0`, and **no `Retry-After`** |
| either | either | — | **503** when the rate-limit store is unreachable. `/convert` fails closed |

Four rows deserve saying out loud:

- **The 402 is the cheapest answer this Worker gives.** With no tier configured
  and no payment presented there is nothing to meter — no allowance to claim, no
  identity to derive — so the envelope goes out before the store is touched at
  all. `test/tier-off.test.mjs` measures that as row counts across `events`,
  `convert_quota` and `settlements` before and after five probes, rather than as
  a reading of the code. It is what makes the endpoint safe to hand to an indexer
  that will ask forever, for free.
- **Rung 2 is deliberately not consulted on the 402 path.** The global
  fail-closed counter is a bound on D1 writes, and this path performs none;
  making a doomsday day answer 503 instead of 402 would trade a free, correct
  answer for an expensive, wrong one.
- **You are only charged for conversions that are actually served.** Settlement
  is queued only after the converter returns, and every exit between the payment
  check and that point is a 4xx. Verify-yes / settle-no leaves the signed
  EIP-3009 authorization simply unused — an authorization moves nothing until
  someone submits it, and nobody does — so a buyer whose input we could not
  convert is not billed. This was already the ordering and needed no code change;
  what is new is the named regression test and its positive control in
  `test/x402-settlement.test.mjs`. It mattered less when a free tier absorbed most
  malformed input; with every call paid, a 400 that billed would be the service's
  worst behaviour.
- **An unreachable facilitator serves the call.** Availability-first, and it is
  a deliberate trade: at these prices the price is a signal, and turning paying
  callers away because *our* dependency is down is the worse failure. Every one
  of these is written to `settlements` with the precise reason, so the choice is
  auditable rather than invisible. If that table fills up with
  `facilitator-*` rows, the dependency is broken and revenue is quietly zero —
  see [Operator queries](#operator-queries-kc-cur).

**The 429s are not one refusal**, and the two on the payment path want opposite
advice:

| form | body | `Retry-After` |
| --- | --- | --- |
| no `PAYTO` | `{"error": "this conversion is a paid call, and this deployment has no receiving address configured", "free_tier_daily": 0, "paid_tier": …, "retry": "not until this deployment configures a receiving address"}` | **none** |
| `PAID_DAILY` reached | `{"error": "the daily conversion ceiling for this caller is reached", "retry": "tomorrow UTC"}` | seconds to the next UTC midnight |
| rung 2 tripped | `{"error": "daily call limit reached"}` | none — see [Limits](#limits-as-built) |

The missing `Retry-After` on the first is the point of it. Waiting does not fix
a misconfiguration, and a header saying otherwise is a lie a client obeys — it
would come back at midnight, nightly, forever. The second genuinely resets, so it
says when. The third is the global fail-closed bound and is reachable only on a
call that got past the paywall — an unpaid 402 never consults it, because it
writes nothing.

**The paid ceiling answers 429, not 402.** `PAID_DAILY` (5,000/day per caller,
in `worker/beacon.js`, owner-tunable) is a runaway bound rather than a quota to
advertise — so it is deliberately absent from the catalog and the page. A caller
that already paid cannot buy its way past it, and answering "pay to continue"
would be a lie; it gets the plain rate-limit answer with a `Retry-After`. It is
claimed only *after* the facilitator returns `isValid` — *changed 2026-08-18*,
when the mere **presence** of an `X-PAYMENT` header still unlocked it, which let
any caller who could type a header buy a 500× higher ceiling for nothing.

And the invariant that has not changed: **nothing is ever fake-verified.**
`x-payment-verified: true` appears only after a facilitator round trip that
returned `isValid`. There is no code path that infers it from a header.

#### `env FREE_TIER_DAILY=N`

With the var set, the legacy matrix applies and **the paywall moves to call
N + 1**. The first N calls per caller per UTC day are simply served, carrying
`x-free-tier-remaining: <n>`; a payment presented inside the tier is neither
checked nor charged and the response says so with `x-payment-verified: false`;
and with `PAYTO` unset, call N + 1 gets the legacy 429 body — `{"error": "free
tier is N conversions per day per caller", "free_tier_daily": N, …}` — with a
`Retry-After` to the next UTC midnight, byte for byte as before.

The ordering rule behind it is the same one it always was, expressed as control
flow rather than as a promise: **the free allowance is claimed first**, before
anything looks at `X-PAYMENT`, so a caller with allowance left is never verified
and never billed, and the facilitator is not called at all.
`test/x402-settlement.test.mjs` asserts that as **zero** calls to the
facilitator rather than as a header.

The page publishes the same thing in plain language under **Pricing, and paying
with USDC** — that there is no trial and nothing to sign up to, what the 402
carries, that you are charged only for served conversions, the two things an
agent needs (an x402-capable HTTP client and a wallet key holding USDC on Base),
a copy-able `x402-fetch` example, and an honest-status box. The MCP server's
`toolshed_convert` explains both a 402 and a 429 rather than returning a bare
error.

The envelope (`x402Version: 1`) advertises `scheme: exact`, `network: base` and
`asset` = USDC on Base (`0x8335…2913`). `maxAmountRequired` is in atomic units,
6 decimals, so $0.005 is `"5000"` and $0.01 is `"10000"`. The price lives in
`entries.yaml` PER ENTRY and the atomic conversion happens in the Worker, so
changing a price is a one-line content edit — and no client should assume one
figure across the API.

Set it for a local test without editing the file. Nothing has to be spent first
— the very first call answers the envelope:

```bash
npx wrangler dev --local --port 8787 --var PAYTO:0xTEST
curl -isX POST http://localhost:8787/convert/md-html --data-binary '# hi'
```

To exercise the *other* configuration locally, add the tier var — and clear the
counter between runs, because it is per caller per UTC day:

```bash
npx wrangler dev --local --port 8787 --var PAYTO:0xTEST --var FREE_TIER_DAILY:3
npx wrangler d1 execute DB --local --command "DELETE FROM convert_quota;"
```

### Re-enabling the free tier

Three steps, and all three or the site lies about itself — the Worker and the
static copy read different sources on purpose, so that a dashboard flip can take
effect without a rebuild:

1. **Set the Worker var** `FREE_TIER_DAILY = "N"` — uncomment it in
   `wrangler.toml`'s `[vars]` block, or set it in the dashboard. This is what
   actually enforces the tier, and it takes effect on the next request.
2. **Set the build constant** `FREE_TIER_DAILY` in `build.mjs` to the same `N`,
   then `npm run build`. This is what the page, `catalog.json`, `llms.txt`,
   `llms-full.txt` and `openapi.json` advertise. Every piece of that copy
   branches on the constant, so both states render honestly; the build prints
   which one it just wrote.
3. **Redeploy both** — `npx wrangler deploy` for the Worker *and* the Pages site
   for the static surfaces. One without the other is the drift step 1 and 2
   exist to avoid.

`GET /check` reports the runtime value throughout, so it is the field to check
after step 1 and the tie-breaker if the two halves ever disagree.

> **The cost, which is not obvious.** A free tier serves any fresh IP a **200**,
> and that fails the `returns_402` preflight Coinbase's Bazaar index runs. The
> index **health-probes on an interval**, so this does not merely block a new
> listing — it **delists an existing one**. Turning the tier back on trades
> discovery for a trial allowance, which is precisely the trade that was made in
> the other direction on 2026-08-19.

## Discoverability (Bazaar)

The 402-first shape is not an aesthetic preference. Coinbase's **Bazaar** is a
discovery index of x402 resources, and it lists a resource by probing it: an
unauthenticated request has to come back **402**, carrying a spec-valid envelope
whose `outputSchema.input.discoverable` is `true`. Nothing else on this service
is a marketing surface for machines; this is.

Validate a deployed resource:

```bash
curl -X POST https://api.cdp.coinbase.com/platform/v2/x402/validate \
  -d '{"resource":"https://toolshed.lemon-agent.dev/convert/md-html","method":"POST"}'
```

It checks three things: that the resource answers 402 to an unauthenticated
request, that the envelope is spec-valid, and that
`outputSchema.input.discoverable` is set. **It probes PUBLIC URLs**, so it
cannot be pointed at `wrangler dev` and cannot run in the local suite. The split
is deliberate: the envelope's *shape* — `outputSchema`, `discoverable` inside
`input`, per-tool `mimeType`, descriptions under the facilitator's 500-character
limit — is asserted locally in `test/tier-off.test.mjs` and `test/x402.test.mjs`,
and the validator is a **post-deploy re-check** against the real origin.
`npm run test:live:full` asserts the same envelope shape against production
without spending anything.

Two details that are silent when wrong:

- **`discoverable` lives inside `outputSchema.input`.** Hoisting it to the top
  level of the envelope produces something that is still spec-shaped and still
  passes every other assertion — and is simply never indexed.
- **These are v1 field names**, copied from a resource already carrying an x402
  v1 listing.

**The v2 gate, 2026-08-19.** `returns_402` started passing and the validator
then refused anyway: *"Endpoint uses x402 v1 — upgrade to x402 v2 to be
discoverable."* So the same 402 now also carries the v2 envelope in a
`PAYMENT-REQUIRED` response header, with `outputSchema` re-expressed as
`extensions.bazaar`. The v1 body is untouched — see
[x402 v2 — dual-stack](#x402-v2--dual-stack-from-2026-08-19) for the whole
mapping and for what a facilitator does with the bazaar block.

Indexing is **automatic after one settled paid call**. The settle body carries
`resource`, which is how the Bazaar attaches a settlement to a listing — and
because an x402 client is not obliged to echo `resource` back (`x402-fetch` does
not), `settleAndRecord()` fills it in from the envelope's own value. It is spread
in rather than assigned, so a client that *did* send one keeps its own, and it is
deliberately absent from the **verify** call: verify is the signature check and
must see byte-for-byte what arrived. `resource` is envelope metadata and is not
covered by the EIP-712 signature, so adding it at settle time cannot invalidate
anything.

Two static files support the same job, both written by `npm run build` into
`dist/` and served by Pages **at the origin**, where a real file beats the SPA
fallback:

| file | why |
| --- | --- |
| `/openapi.json` | OpenAPI 3.1 — `x402scan` and friends expect it at exactly `GET {origin}/openapi.json`. It describes `GET /check` and one `POST /convert/{id}` per live tool, with the 200, 400, 402, 413, 429 and 503, and the x402 envelope schema. A document that listed only the 200 would be worse than none: the 402 is the interesting response |
| `/robots.txt` | allow all. It exists so a prober gets a real 200 rather than the SPA fallback, which is indistinguishable from a misconfigured site to anything that checks |

Both are linked from the site nav and the footer. A test asserts that the 200
content type `openapi.json` documents equals the `mimeType` the live envelope
advertises, per tool — the two are generated by different files and can drift,
and a machine that reads one and calls the other has no way to tell which is
wrong.

## Settlement (live)

A payment presented against the 402 envelope is **checked before the conversion
is served and settled on chain immediately afterwards**, through the Coinbase CDP
facilitator.

> **Status.** Live and proven with real money, in both protocol versions. On
> **2026-08-18** a real payment in real USDC on Base verified and settled
> through the CDP facilitator over x402 **v1** (tx `0xe2c8bb8d…`), and on
> **2026-08-19** a second one over x402 **v2** via the real `@x402/fetch`
> client (tx `0x4832d1ee…`) — the v2 settlement also answers the one question
> the local suite could not: the CDP facilitator accepts `x402Version: 2`
> verify/settle bodies in production. Both rows `verify_ok = 1`,
> `settle_ok = 1`; both settlements on record are **our own test calls**; no
> third party has paid yet. Everything below is additionally covered against a
> strict per-version mock facilitator and against real v1 (`x402-fetch`) and
> v2 (`@x402/fetch`) clients signing real EIP-3009 authorizations.

### The shape of it

```text
caller ──POST /convert/x, X-PAYMENT──▶ Worker
                                        │  PAYTO set? (and no free tier to claim)
                                        ▼
                                      POST <facilitator>/verify     (2 s cap)
                                        │
                        isValid ────────┼──────── not valid ──▶ 402 + invalidReason
                                        ▼
                              200 + x-payment-verified: true
                                        │  (response is already sent)
                                        ▼
                                      POST <facilitator>/settle    ctx.waitUntil
                                        ▼
                                      INSERT INTO settlements
```

`verify` is on the critical path, so it has a hard **2-second** cap and its
failure is an availability decision, not a payment decision. `settle` runs after
the response in `ctx.waitUntil`, because the caller paid for a conversion, not
for a chain confirmation. A settlement that fails after a good verify is the
accepted exposure: one conversion served for its price that never arrived,
recorded as `settle_ok = 0`.

### The endpoints, and what we send

| | |
| --- | --- |
| **base URL** | `https://api.cdp.coinbase.com/platform/v2/x402` (`FACILITATOR_URL`) |
| **verify** | `POST <base>/verify` |
| **settle** | `POST <base>/settle` |
| **body** | `{ x402Version, paymentPayload, paymentRequirements }` |
| **auth** | `Authorization: Bearer <CDP JWT>` |
| **verify →** | `{ isValid, invalidReason, invalidMessage, payer }` |
| **settle →** | `{ success, errorReason, transaction, network, payer }` |

`paymentPayload` is the caller's payment header, base64-decoded — `X-PAYMENT`
for v1, `PAYMENT-SIGNATURE` for v2. `paymentRequirements` is **the same object
the 402 envelope advertised**, in the version the payload declared: the v1
object built by `paymentRequirements()`, or its v2 projection from
`requirementsV2()`. Both because the client signs against what the envelope said
and the facilitator recovers that signature from what we send. Any field that
differs between the two — including the version — turns a perfectly good payment
into `invalid_exact_evm_payload_signature`. The suite asserts that identity
field-for-field rather than trusting the shared call site.

There is **no separate v2 endpoint**. Confirmed twice: `@x402/core` 2.23.0's
`HTTPFacilitatorClient` sends the identical three-field body for v1 and v2
alike, and CDP's own reference pages for `/platform/v2/x402/{verify,settle}`
document `x402Version` as `1 | 2` with no second route. The `v2` in that path is
CDP's platform API version and has nothing to do with the protocol version.

The one field the **settle** payload carries that the verify payload does not is
`resource`, filled in from the envelope when the client omitted it. See
[Discoverability (Bazaar)](#discoverability-bazaar) for why it is there, and why
verify is deliberately left untouched.

### `outputSchema` — what makes a resource indexable

The envelope carries a per-tool `outputSchema`, in v1 field names:

```json
"outputSchema": {
  "input":  { "type": "http", "method": "POST", "discoverable": true,
              "bodyType": "text",
              "description": "the raw Markdown file as the request body, up to 256 KB" },
  "output": { "type": "string",
              "description": "the converted HTML file as the response body (text/html)" }
}
```

The formats come from `inputFormat` / `outputFormat` on each `CONVERTERS` entry,
so a new hosted tool describes itself. It says `bodyType: "text"` and describes
the body in a sentence because that is what these tools actually take — a raw
file, not a JSON object of named fields; inventing an input object would
advertise a calling convention that fails on first use. Descriptions are asserted
at **≤ 500 characters**, which is the facilitator's limit: an over-long
description is not a cosmetic problem, it is an unpayable envelope.

In v2 the same facts live in `extensions.bazaar`, projected from this object:

```json
"extensions": { "bazaar": {
  "info": { "input":  { "type": "http", "method": "POST", "bodyType": "text",
                        "body": "# Title\n\nSome **bold** text.\n" },
            "output": { "type": "text", "format": "text/html" } },
  "schema": { "$schema": "https://json-schema.org/draft/2020-12/schema", "...": "..." }
} }
```

Three differences that are not cosmetic. `discoverable` is **gone** — that was
v1's opt-in flag, and in v2 the presence of the extension *is* the opt-in.
`info.input.body` is a **worked example**, a real request body rather than a
description of one, because POST is a body method in the bazaar input union; it
comes from a `sample` on each `CONVERTERS` entry, and the suite pays for every
one of them and requires a `200`, because an example that `400`s is worse than
no example. And `schema` is **required**: the bazaar spec says a facilitator
MUST validate `info` against it before cataloguing, so a schema that does not
admit its own info is a silent delisting — the suite compiles it with `ajv` and
checks both that the info passes and that a wrong info fails.

### The dependency decision: no new production dependency

The obvious route is `@coinbase/x402` (its `facilitator` config) plus `x402`'s
`useFacilitator`. **We call the two REST endpoints directly instead**, and add
**zero** production dependencies. Reasoning:

- `@coinbase/x402` is ~40 lines of glue whose real job is minting a JWT. It
  depends on `@coinbase/cdp-sdk`, `viem`, `zod` and `@x402/core` — all of which
  would land in the Worker bundle for one Ed25519 signature.
- The signature itself is native in workerd. `crypto.subtle.importKey('jwk', …,
  { name: 'Ed25519' })` and `crypto.subtle.sign('Ed25519', …)` were **measured
  working** in `wrangler dev --local` before any of this was written.
- `jose` would also have worked and is the documented fallback, but it is still
  a dependency for something WebCrypto already does.
- The two request bodies are three fields each, and they are pinned by tests
  against a mock that asserts them field for field.

So `cdpAuthHeader()` in `worker/beacon.js` mints the same JWT
`@coinbase/cdp-sdk`'s `buildEdwardsJWT` does — read from its source, not from
memory:

| | |
| --- | --- |
| **header** | `{ alg: "EdDSA", kid: <key id>, typ: "JWT", nonce: <16 random bytes, hex> }` |
| **claims** | `{ sub: <key id>, iss: "cdp", uris: ["POST api.cdp.coinbase.com/platform/v2/x402/verify"], iat, nbf, exp }` |
| **lifetime** | 120 seconds |
| **key** | `CDP_API_KEY_SECRET` is base64 of 64 bytes — a 32-byte Ed25519 seed then its 32-byte public key — imported as an OKP JWK |

Two details that are easy to get wrong: the claim is **`uris`** (plural, an
array), not `uri` — the CDP docs page shows `uri`, the SDK sends `uris`, and the
SDK is what the facilitator actually accepts. And the token is **bound to one
endpoint**, so a `/verify` token cannot be replayed at `/settle`.

**Only the modern Ed25519 key format is supported.** If `CDP_API_KEY_SECRET` is
a PEM EC key (the older format, starting `-----BEGIN EC PRIVATE KEY-----`), the
JWT will not mint and every paid call is served with
`x-payment-error: facilitator-unconfigured`. Issue a new Secret API Key.

### The `extra` field — a bug this work found

The 402 envelope now carries:

```json
"extra": { "name": "USD Coin", "version": "2" }
```

This is the EIP-712 domain the payer signs the `TransferWithAuthorization` over,
and **omitting it silently breaks every real payment**. x402's client reads
`paymentRequirements.extra?.name` with *no fallback*, while the verifier falls
back to its own per-chain table — so an envelope without `extra` makes the
client sign over `name: undefined`, the verifier check against `"USD Coin"`, and
the payment come back `invalid_exact_evm_payload_signature`. Every previous
envelope assertion passed while this was broken, which is exactly why the suite
now drives a real client (below).

Note `"USD Coin"`, not `"USDC"`: on Base mainnet the token's `name()` differs
from its ticker, and the EIP-712 domain uses the name. (On Base *Sepolia* it is
`"USDC"` — if this ever runs on testnet, that value changes.)

### Response headers on the payment path

| header | meaning |
| --- | --- |
| `x-payment-verified: true` | the facilitator returned `isValid`. Never inferred from a header |
| `x-payment-verified: false` | nothing was checked — see `x-payment-error` |
| `x-payment-error: facilitator-unreachable` | timeout, network failure, or a non-200 from the facilitator |
| `x-payment-error: facilitator-unconfigured` | no CDP credentials on this Worker. Operator fault, not caller fault |
| `x-pricing: pending` | served without a verified payment |

On the **402** rather than on a served call, two more: `PAYMENT-REQUIRED`
carrying the base64 v2 envelope, and `cache-control: no-store`, because an
envelope is per-request and a cached 402 hands the next caller someone else's
terms. There is deliberately no `PAYMENT-RESPONSE` — see
[x402 v2 — dual-stack](#x402-v2--dual-stack-from-2026-08-19).

The **ledger** keeps the precise reason (`facilitator-timeout`,
`facilitator-http-503`, …) because that is what you debug from; the **header**
keeps a small stable vocabulary because that is what a client branches on.

### Reading the ledger

```bash
# the last few payment attempts
npx wrangler d1 execute DB --remote \
  --command "SELECT ts, tool, payer, amount, verify_ok, settle_ok, tx_hash, error FROM settlements ORDER BY ts DESC LIMIT 20;"

# money that actually landed
npx wrangler d1 execute DB --remote \
  --command "SELECT COUNT(*) AS settled, SUM(CAST(amount AS INTEGER))/1000000.0 AS usd FROM settlements WHERE settle_ok = 1;"

# the alarm: served but never paid for
npx wrangler d1 execute DB --remote \
  --command "SELECT error, COUNT(*) AS n FROM settlements WHERE verify_ok = 0 GROUP BY error ORDER BY n DESC;"
```

`settlements` rows are **kept**, not pruned on the 90-day chore: `payer` is an
address its owner revealed by paying and `tx_hash` is public chain data, so
neither is covered by the daily-salt discard the other tables rely on — and they
are the revenue record.

### The buyer test kit — proving it with real money

Two scripts, both **owner-only**. Nothing in `npm test` touches them, and
`pay-test.mjs` refuses to run without `--yes`.

```bash
# 1. make a throwaway key (writes .buyer.env, chmod 600, gitignored)
npm run buyer:create

# 2. fund the printed ADDRESS with ~$1 USDC on Base.
#    NETWORK MUST BE BASE. The key needs no ETH — the `exact` scheme pays with
#    a signed EIP-3009 authorization and the FACILITATOR submits the transaction.

# 3. see what would happen, spending nothing
npm run buyer:pay -- --dry-run

# 4. the real thing
npm run buyer:pay -- --yes
```

**What step 4 actually costs:** one payment at the target tool's price ($0.005
for `md-html`), and there is no free
tier to burn through to reach it — the first call answers 402 and the script
pays immediately. It makes one unpaid probe first, purely to read the envelope
it is about to sign against, and refuses to spend anything if that envelope is
wrong (bad `extra`, missing `outputSchema.input.discoverable`, an over-long
description); every problem is printed together rather than one per redeploy.
Then it signs, pays, and prints the status, `x-payment-verified`, and where to
confirm the money moved.

It then makes **one more signed call with malformed input**, to check the
"charged only for served conversions" claim against the real facilitator: a
correct Worker answers 400 and settles nothing, so that probe costs $0.000. If it
costs the tool's price it has found the bug it went looking for.
`--skip-400-check` opts out; worst case for a whole run is two calls' worth. If the deployment it is pointed at
answers 200 to the unpaid probe — a free tier is enabled — the script stops
rather than burning through the tier to reach the paid path.

The key in `.buyer.env` is a **plaintext private key on disk**. That is fine for
a key holding a dollar and catastrophic for one holding anything else — fund it
with the minimum that proves the path, and treat the file as burnable.

### The honest-status box

**Flipped 2026-08-18**, after all three criteria were met by a real payment:

1. `npm run buyer:pay -- --yes` returned **200** with `x-payment-verified: true`.
2. A `settlements` row carried `verify_ok = 1`, `settle_ok = 1` and a real
   `tx_hash` (`0xe2c8bb8d…`).
3. The payment landed at the `PAYTO` address. (It was $0.001 then; the tools
   were repriced to $0.005/$0.01 on 2026-08-30.)

**Rewritten 2026-08-19** when the tier was retired. The box now says, on the
free-tier-off branch, that the free tier is **switched off** — every conversion
is a paid call, priced per tool — and that payment is **live and verified**: a payment
presented against the 402 envelope is checked with the Coinbase CDP facilitator
before the conversion is served, a verified call comes back with
`x-payment-verified: true`, and it settles on Base immediately afterwards. If the
facilitator cannot be reached, the call is served anyway and says so with
`x-payment-error` — at these prices the price is a signal, and an outage on our side
should not turn a paying caller away.

**The rule holds in reverse, and that is the part worth keeping**: if settlement
ever breaks — a run of `verify_ok = 0` in `settlements`, a facilitator outage
that stops being transient, a revoked CDP key — the box goes back to naming what
is broken, before anything else is fixed. "The code is written and the tests
pass" is not the same claim as "money has moved", and the box exists to not blur
the two in either direction.

The copy lives in `<div class="status-box">` in `build.mjs`, in **both**
branches of `FREE_TIER_ON` — live code, not one branch and one comment, because
the re-enable runbook depends on the generator being able to render either state
truthfully. The comment above it keeps the 2026-08-18 flip record and appends the
2026-08-19 retirement.

## Payment alerts

The `settlements` table is a perfect record that nobody reads at 3am. These are
the push half: a **Telegram** message and an **email** when money moves.

### What fires, and what deliberately does not

| event | alert |
| --- | --- |
| verified payment, settled | 🍋💰 `THIRD PARTY PAID — $0.005 md-html — payer 0x… — tx 0x… — settled` |
| verified payment, from a wallet in `HOUSE_PAYERS` | 🧪 `test settlement — …` — same facts, quiet framing |
| verified payment, settlement **failed** | the same message ending `SETTLE FAILED (<reason>)`. Verified means the caller was served, so this is money owed that did not arrive |
| **served without verification** | ⚠️ `SERVED WITHOUT VERIFICATION — … — x-payment-error: <reason>`. Visually distinct because it is a different problem: the conversion went out and **nobody paid** |
| unpaid 402 | **nothing** |
| malformed `X-PAYMENT` / `PAYMENT-SIGNATURE` | **nothing** |
| facilitator-rejected payment | **nothing** |
| free-tier serve (when a tier is enabled) | **nothing** |

The four silences are the design, not an omission. This service is on a public
discovery index and is scanned continuously; an alert that fires on someone
*failing* to pay would page all day and train the owner to swipe it away, which
is the only way this feature can genuinely fail. **Only verified money, and the
one case where money should have been taken and was not.**

The house/third-party split matters for the same reason: if the owner's own
test buys and a stranger's purchase produced the same message, the loud
one would stop meaning anything.

### It cannot affect the caller

Every alert runs inside the existing `ctx.waitUntil` settlement flow — **after**
the response has shipped — and each channel is independently `try`/`catch`ed. A
dead Telegram, a revoked token, an unverified email destination or a missing
binding costs a notification and nothing else. The suite asserts exactly this:
a Telegram endpoint answering 500, and an unreachable one, both leave the
conversion **200** and the `settlements` row intact.

**There are no retries**, on purpose. An alert is not a ledger — `settlements`
is the source of truth and [Reading the ledger](#reading-the-ledger) is what
reconciles money. A retry loop would buy duplicate pings on a flaky network and
still lose the alert in a real outage.

A channel with **no config is skipped before any network call**, so unset is a
working state: a deployment that never sets these secrets behaves exactly as
this Worker did before alerts existed.

### Configuration

| name | kind | effect |
| --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | **secret** | the bot to send as. Unset = no Telegram channel |
| `TELEGRAM_CHAT_ID` | **secret** | where to send. Unset = no Telegram channel |
| `ALERT_EMAIL_TO` | **secret** | recipient. Must be a **verified Email Routing destination** on the zone. Unset = no email channel |
| `ALERT_EMAIL` | `[[send_email]]` binding | declared unrestricted in `wrangler.toml`. Absent (no Email Routing on the account) = no email channel |
| `HOUSE_PAYERS` | var | comma-separated wallet addresses that read as 🧪 instead of 🍋💰. Compared lowercased. Non-secret — public chain addresses |
| `TELEGRAM_API_BASE` | var | optional override, default `https://api.telegram.org`. Only the test suite sets it, to reach a local mock — the same pattern as `FACILITATOR_URL` |

The two Telegram secrets:

```bash
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_CHAT_ID
```

**Finding the chat id.** Message the bot once from the account that should
receive alerts — a bot cannot open a conversation — then read the id back:

```bash
curl -s "https://api.telegram.org/bot<TOKEN>/getUpdates" | jq '.result[].message.chat.id'
```

A personal chat id is a positive integer; a group is negative (`-100…`). If
`result` is empty, the bot has not been messaged yet, or the message predates
the bot being started.

### Email, and the DNS caveat

```bash
npx wrangler secret put ALERT_EMAIL_TO
```

Mail goes out **from** `Toolshed <alerts@lemon-agent.dev>` through Cloudflare's
`send_email` binding. Two constraints, both enforced by Cloudflare rather than
by this Worker:

- the **from** address must be on a zone in the account, and
- the **to** address must be a **verified Email Routing destination** — the
  owner has to click the confirmation link Cloudflare emails, once.

The binding is declared **unrestricted** (no `destination_address` in
`wrangler.toml`) so that the owner's personal inbox never appears in this public
repo; the recipient comes from the secret instead. Cloudflare still enforces the
verified-destination rule, so unrestricted is not unlimited.

> **Status (2026-08-19): the email channel is dormant on this deployment, and
> that is a product mismatch, not a bug.** `send_email` only works on zones
> whose MX is Cloudflare Email Routing, and `lemon-agent.dev`'s email is hosted
> on **Protonmail** (Proton MX + SPF, verified with `dig MX` the day the
> channel shipped — a live-fire test rang Telegram and silently skipped email,
> exactly as the try/catch design intends). The code stays: it costs nothing,
> no-ops cleanly, and lights up on its own if the zone ever moves to Email
> Routing. Until then, **Telegram is the alert channel**, and inbound mail to
> `support@lemon-agent.dev` (registry verification etc.) lands in Proton.

**Until Email Routing and its DNS records are live, the email channel silently
no-ops** — the binding call throws, it is caught, and the Telegram ping is
unaffected. That is the intended state during setup, not a fault to chase.

The raw message is a hand-rolled minimal RFC 5322: `From`, `To`, `Subject`,
`Date`, `Message-ID`, `MIME-Version`, `Content-Type`, CRLF throughout, and the
subject carried as RFC 2047 base64 encoded-words because the headline contains
emoji and a raw non-ASCII byte in a header is not legal. No MIME library — the
same no-new-production-dependency argument that keeps `@coinbase/x402` out of
the [facilitator path](#the-dependency-decision-no-new-production-dependency).
`wrangler dev --local` implements `send_email` and **parses** what it is handed,
rejecting a message with no `Message-ID` or a `From` that disagrees with the
envelope sender — so `test/alerts.test.mjs` reads the generated `.eml` back and
asserts on the real bytes.

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

**Per-caller conversion pressure.** `convert_quota` holds one row per caller per
day counting calls that were actually **served**, so with the free tier off this
is a table of paying callers. `hit_the_ceiling` counts callers that reached
`PAID_DAILY` — a runaway bound, so a non-zero number is a caller worth looking
at rather than a pricing signal (the `5000` in this query has to match
`PAID_DAILY` in `worker/beacon.js`). On a deployment that has enabled a free
tier, the same query against the tier width is what says whether it is the right
width:

```bash
npx wrangler d1 execute DB --remote --command "
  SELECT day,
         COUNT(*)           AS callers,
         SUM(used)          AS conversions,
         SUM(used >= 5000)  AS hit_the_ceiling,
         MAX(used)          AS busiest_caller
  FROM convert_quota
  GROUP BY day ORDER BY day DESC LIMIT 30;"
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

  DELETE FROM events WHERE ts < strftime('%s', 'now', '-90 days');

  DELETE FROM convert_quota WHERE day < date('now', '-90 days');"
```

Only today's `convert_quota` row is ever read, so pruning it is free of
consequences — it is kept the 90 days purely so the per-caller pressure query
above has a history to plot.

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
the conversion input was never written in the first place. `convert_quota` holds
the same kind of thing (a day-scoped hash of the IP alone, plus a count) under
the same argument.

## Limits, as built

| rung | where | control | failure mode |
|---|---|---|---|
| 0 | Cloudflare edge | REACTIVE — free WAF custom rule blocking blocklist IPs (`ip.src in {…}`), populated from the `blocklist` table; the planned rate-limiting rule is unavailable on this account's plan (owner-verified 2026-08-18) | nothing blocks a first-seen IP at the edge; the in-Worker tiers below are the standing bound, and abuse is blocked at the edge only after it is identified |
| 1 | Worker | 100 events / identifier / UTC day — **`/b` only**; convert rows are excluded from the count | honest runaway client stops being counted; UA rotation still mints fresh identifiers, which is a measurement cost, not a spend |
| 1c | Worker | **5,000 SERVED conversions / caller / UTC day** (`PAID_DAILY`), claimed only once a payment has been **verified** by the facilitator (changed 2026-08-18 — presenting a header is no longer enough). Optionally, `env FREE_TIER_DAILY = N` puts a free tier of N/caller/day on the same counter and the same key; unset (the default) means no tier | unpaid callers get 402 (or 429 with no `PAYTO`) without touching this counter at all; a caller past the ceiling gets 429 + `Retry-After`. The key is the IP hash, so UA rotation does **not** mint a fresh allowance |
| 2 | Worker | 200,000 events / UTC day, fail-closed before insert | metrics loss and no conversions for the rest of the day |
| 3 | — | none; priced, not bounded — $2.49/day at 100 req/s, $25.82/day at 1,000 req/s | detective only: $25 alert + shutdown runbook |

Rung 0 is configured in the dashboard, not in this repo — and it is the
REACTIVE control the table says it is: a free WAF custom rule blocking IPs
already in the `blocklist` table. The rate-limiting rule the dossier planned
here is unavailable on this account's plan (owner-verified 2026-08-18, deploy
runbook deviations above); nothing proactive runs at the edge, and the
in-Worker rungs are the standing bound.

Rungs 1 and 2 execute inside the Worker, so a request they reject is already
billed. CPU is metered separately from requests, which is why
`worker/beacon.js` checks method, path and body size before it reads a body,
hashes anything, touches D1, or runs a conversion.

**The beacon and conversion budgets are now separate** — this is the shared-budget
flag from the previous pass, closed. Rung 1 counts `events` rows
`WHERE type <> 'convert'`, and conversions are metered by `convert_quota`
instead, so:

- A caller that loads the page five times still has its whole conversion
  ceiling. A caller that converts all day is still counted once as a visitor.
  Neither budget reaches into the other.
- Conversions still write an `events` row — that is measurement, not
  rate-limiting: what got called, and which tool. The input is never written.
- The two identities differ on purpose. `events.id_hash` is
  `hash(salt + IP + UA)`, unchanged, so the column keeps its documented meaning.
  `convert_quota.ip_hash` is `hash(salt + IP)` — no UA, so rotating one buys
  nothing. Both are day-scoped and unlinkable once the salt is overwritten.
- Daily visit counts include callers who never load the page, so the `type`
  column is what separates them. The operator queries above already do.

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

Three stores, three subject-rights answers, all stated on the page: the counting
store holds a truncated daily-salted hash and nothing attributable once the salt
rotates; the **settlements ledger** holds one row per payment attempt, including
the paying wallet address and the transaction hash, and is deliberately *not*
salted away nightly, because a payment ledger you cannot reconcile is not a
ledger; the IP blocklist is attributable and is purged on request. The
`convert_quota` counter belongs to the first store, and the page says so in *How
we count* in one line: a daily ceiling on served calls, keyed on a daily-salted
hash of the IP alone (no user-agent), unlinkable across days, same retention as
the other counters — and an unpaid call never reaches it, because the 402 is
answered before anything is read or written.

**Conversion inputs are never stored.** The `events` row records that a call
happened, which tool it used, and the day-scoped hash — never the body. The page
says so in *How we count* and again in *Privacy*.

One dependency of the anonymization argument is flagged in the dossier and
unresolved here: *whether D1's own point-in-time restore retains overwritten
rows* is unread. If it does, the salt's ≤24 h window is really as long as the
restore horizon, and the fallback is to hold the salt outside the restorable
store. A derived salt (`HMAC(secret, date)`) is not the fallback — it is
recomputable forever, which is the negation of discarded-at-rotation.

## Testing

Two commands, and the split between them is about **what each one can see** —
the converter, or the deployed gate in front of it:

```bash
npm test           # the whole suite, LOCAL ONLY — touches nothing deployed
npm run test:live  # the production smoke — serves nothing, spends nothing
```

`npm test` is the real coverage: **238 tests across eleven files**, per-tool
fixture batteries plus the protocol, quota, spoof-resistance, tier-off, x402
v1 and v2, settlement and beacon contracts. It never speaks to production and it never needs
a Cloudflare login. Framework is `node:test` — no test dependency was added, and
none is wanted.

Neither costs anything. It used to be a budget question — the live run spent the
caller's free allowance — and it is not any more: with no free tier, every unpaid
probe against production stops at the 402, so the live commands serve nothing and
spend nothing however often they are run.

Writing it found two real defects, both fixed in `worker/beacon.js` and both now
carrying a named regression test: a CSV column headed `__proto__` was **silently
dropped** from an otherwise-200 response (`csvToRecords` now builds
null-prototype records), and `html-markdown` **leaked inline `<script>`,
`<style>` and JSON-LD source into the prose** when those tags sat inside the
body (see § Worker dependencies).

```text
test/harness.mjs                  boots wrangler dev, owns teardown and D1 access
test/run.mjs                      the phase runner behind `npm test`
test/convert-md-html.test.mjs     per-tool fixture batteries
test/convert-json-yaml.test.mjs   json -> yaml -> json round-trip properties
test/convert-yaml-json.test.mjs   block scalars, anchors, comments, tabs
test/convert-csv-json.test.mjs    the RFC 4180 battery
test/convert-html-markdown.test.mjs
test/protocol.test.mjs            /check, method and routing guards, 413, /b
test/alerts.test.mjs              owner payment alerts: Telegram, email, and the silences
test/quota.test.mjs               the env-gated free tier and its spoof resistance
test/tier-off.test.mjs            the PRODUCTION default — 402 first, and it writes nothing
test/x402.test.mjs                the 402 envelope, and PAYTO set with no facilitator
test/x402-settlement.test.mjs     verify/settle against a mock facilitator + a real client
test/beacon.test.mjs              rows, bot drops, salt rotation
test/live.smoke.mjs               the production smoke (`npm run test:live`)
```

**What the tier retirement added.** `tier-off.test.mjs` is new, and the coverage
it carries is the coverage that did not exist while a free tier absorbed the
first call:

- the first call is a 402, **per live tool**, with no `x-free-tier-remaining`
  header anywhere;
- the 402 writes **nothing** — `events`, `convert_quota` and `settlements` row
  counts are read before and after five probes and must be identical;
- the 413 fires before the 402, and the 404 / 405 guards fire before both — an
  unknown id must not become "pay me first";
- `/check` reports `free_tier_daily` **0**, present rather than absent (in
  phase 1 the same field reads 3, which is the other half of the claim);
- alias matching resolves `md`, `.md`, `text/markdown`, `yml`, `.yaml`,
  `text/html`, `text/csv` and `application/json`, plus a guard that aliasing
  never crosses the have/need field binding;
- a **negative** and an **unparseable** `FREE_TIER_DAILY` both read as 0 —
  a misconfigured var fails towards charging;
- the no-`PAYTO` 429 carries no `Retry-After`;
- `openapi.json`'s documented 200 content type equals the `mimeType` the live
  envelope advertises, per tool.

In `x402-settlement.test.mjs`: the 400-not-settled regression plus its positive
control (a payment that *is* served does settle, so the test cannot pass by the
settle path being broken), and settle-carries-`resource`.

### The fresh-state guarantee

Every phase of a run boots its own `wrangler dev --local` against its own
`--persist-to` directory under the OS temp dir, with `worker/schema.sql` applied
to it **before** the server starts, and deletes that directory on teardown. Two
runs cannot see each other's rows, and no run can see the demo database in
`.wrangler/`. That is what lets the counting assertions be exact — "the 4th call
is refused" and "these five 402s wrote zero rows", not "some call is eventually
refused" and "not many rows were written".

Teardown kills the process **group**. `wrangler dev` spawns two `workerd`
children, so killing the node process alone orphans them and leaks the port; the
harness spawns it `detached` and tears it down with `process.kill(-pid, …)`,
escalating to `SIGKILL`, plus a best-effort sweep on process exit.

### Why there are four phases

Two dev vars decide what the product answers, and a dev var is fixed for the life
of a `wrangler dev` process, so each configuration needs its own worker:

- **`FREE_TIER_DAILY`** — unset (production) means every call is a paid call and
  the *first* unauthenticated call is the 402; set to N means the legacy free
  tier of N calls per caller per UTC day.
- **`PAYTO`** — unset means a 429 where a 402 would otherwise go, because there
  is nowhere to pay.

So `npm test` boots four workers and runs them in turn:

| phase | vars | files |
| --- | --- | --- |
| 1 — `free tier enabled` | `FREE_TIER_DAILY=3`, `PAYTO` unset | the five convert fixture suites, `protocol`, `quota`, `beacon` |
| 2 — `production default` | `PAYTO` set, no tier | `tier-off.test.mjs`, `x402.test.mjs` |
| 3 — `settlement` | `PAYTO` + `FACILITATOR_URL` + fake CDP keys | `x402-settlement.test.mjs` (standalone) |
| 4 — `alerts` | phase 3's vars + `TELEGRAM_*` + `HOUSE_PAYERS` + `ALERT_EMAIL_TO` | `alerts.test.mjs` (standalone) |

**Phase 1 boots the tier on purpose, for two different reasons.** `quota.test.mjs`
is there because the tier *is* what it asserts — countdown, UA-rotation
resistance, per-caller-not-per-tool — and that mechanism is env-gated now rather
than gone, so it is kept tested rather than allowed to rot into dead code. It
keeps every assertion it ever had. The fixture suites are there for a duller
reason: they need conversions actually **served**, and with no facilitator and no
wallet in the loop a free tier is the only free way to be served. `beacon.mjs`
runs last because it rotates the shared salt, which re-keys every
`convert_quota` row — harmless afterwards, confusing before.

**Phase 2 is what `toolshed.lemon-agent.dev` actually runs.** It is also the
configuration Coinbase's Bazaar probes, which is why the first-call-is-402 claim
lives here rather than being inferred from phase 1's absence.

**Phase 3 is marked `standalone`** in `test/run.mjs`: it runs a mock facilitator
on a port it only learns at startup, and `FACILITATOR_URL` has to name that port,
so the worker cannot be booted before the mock exists. The suite boots its own —
on its own fresh D1, like every other phase — with the tier off. The `exhaust()`
helpers that used to open every x402 and settlement test are gone: the first call
is now the 402, so each test simply makes its call. That simplified the setup
without weakening a single assertion.

**Phase 4 is `standalone` for the same reason twice over**: it runs a mock
facilitator *and* a mock Telegram, both on ports it only learns at startup, so
neither `FACILITATOR_URL` nor `TELEGRAM_API_BASE` can be known before the suite
starts. It also reads its worker's stdout to find the `.eml` files miniflare's
`send_email` simulator writes, which needs the worker it booted itself. Most of
the file is **negative** assertions — see [Payment alerts](#payment-alerts): the
hard claim is not that a sale pings, it is that a 402, a malformed header, a
rejected payment and a free-tier serve all stay silent.

**A file joins the phase's worker only when the WHOLE var set matches.**
`useWorker({ payTo, vars })` compares against `TOOLSHED_TEST_VARS`, which
`run.mjs` exports as the phase's canonically-ordered var set. It used to compare
`PAYTO` alone, which was enough while that was the only var that changed
behaviour; once `FREE_TIER_DAILY` became the var deciding whether the first call
is a 200 or a 402, a file joining a differently-configured worker would have
failed in a way that looked like a product bug. A file whose config does not
match boots its own.

The CDP credentials it uses are **structurally real and worth nothing**: a
freshly generated Ed25519 keypair, base64-encoded the way CDP encodes a Secret
API Key, never sent anywhere but the local mock. They have to be real enough to
sign with, because the point is that the Worker's JWT path executes for real
inside workerd — a runtime that could not import or sign with an Ed25519 key
would fail the suite rather than quietly skip it.

Suites run at `--test-concurrency=1` so the tests that count D1 rows can compare
a before and an after without another file writing between them.

### The positive controls — one per protocol version

`x402-settlement.test.mjs` drives **two real clients** against the real 402:
`x402-fetch` 1.x for v1, and `@x402/fetch` + `@x402/evm` 2.23.0 for v2 — the
same pair that paid a live third-party v2 seller on 2026-08-19. Each parses our
response, signs a genuine EIP-3009 authorization with a genuine key, and the
Worker verifies it. No funds are involved — the keys are generated in the test
and the mock does not look at the chain — but the *parsing* and the *signing*
are real, and those are the halves a mock cannot fake.

They earn their place: every other test in the file builds its own payment
header, which proves the Worker handles the payload *the test writes*, not that
a real client can produce one. The missing-`extra` bug lived exactly in that
gap — the envelope was spec-shaped, every envelope assertion passed, and no
genuine payment could ever have verified. Removing `extra` from the Worker now
fails both tests (measured, not assumed).

The v2 control is also the only proof that the **header** is what a v2 client
reads: it registers no v1 scheme at all, so a client that fell back to the 402's
v1 body would throw `No client registered for x402 version: 1` rather than pay.
And it is the evidence that omitting `PAYMENT-RESPONSE` costs a real client
nothing — the run asserts the header is absent *and* that the payment completed.

The mock facilitator **shape-checks every call against its declared version**
and answers `400` on a mismatch, so a Worker that paired a v2 payload with v1
requirements fails here instead of failing in production against a facilitator
that recovers the signature from what it was handed. That check is itself
positive-controlled: one test feeds it three deliberately wrong bodies and
requires each to be caught, plus the shape the Worker really sends and requires
it to pass.

### Running one suite

Any file works on its own — each one names the configuration it needs in
`before()`, and boots its own worker when the runner has not exported a matching
one, so there is nothing to set up:

```bash
node --test test/quota.test.mjs        # boots FREE_TIER_DAILY=3 for itself
node --test test/tier-off.test.mjs     # boots PAYTO, no tier, for itself
node --test test/convert-csv-json.test.mjs
npm test csv                           # or filter the runner by substring
```

### `cf-connecting-ip`, and why the quota tests work at all

The per-caller conversion counter is keyed on `hash(daily salt + IP)`, read from
`request.headers.get('cf-connecting-ip')`. **`wrangler dev --local` passes that
header straight through from the client** — verified empirically against
wrangler 4.42.2: three POSTs to `/convert/md-html` carrying `cf-connecting-ip`
`203.0.113.1`, `.2` and `.2` produced **two** `convert_quota` rows with
`used = 1` and `used = 2`. Had the header been ignored, there would have been
one row at `used = 3`.

So every virtual caller in the suite is just a header value, and per-test
isolation costs nothing: each suite owns a band of `198.18.<octet>.<n>`
addresses (`SUITE_OCTET` in `test/harness.mjs`), most tests take a fresh address
per call so no counter is ever in play, and `quota.test.mjs` pins addresses
deliberately so it can spend one caller's allowance down to zero and assert the
refusal lands on the exact call it should.

In production the header comes from the edge and a client cannot forge it. There
is no edge in front of `wrangler dev`, which is exactly what makes it usable as
a test control.

### The live smoke

`npm run test:live` checks that what is deployed is the same product, and against
production its budget is **zero**: the one conversion it posts stops at the 402,
so no converter runs and nothing is charged. It never depends on quota state, so
it can be repeated as often as you like and still tell the truth. It asserts the
`/check` contract, fetches `catalog.json` / `llms.txt` / `llms-full.txt` and
sanity-checks their shape (including that `catalog.json` and `/check` agree about
what is hosted), then makes exactly one `POST /convert/md-html` — accepting
**402** (the production answer), **200** (a deployment running with
`FREE_TIER_DAILY` set; the converter output is then checked) or **429** as
passes, labelled differently. It tells the two 429s apart by the header: no
`Retry-After` means no receiving address is configured, a sane one means this
caller hit the daily paid ceiling. The remaining checks are refusals (405, 404),
which reach no counter.

```bash
npm run test:live
TOOLSHED_URL=http://localhost:8787 npm run test:live
```

`npm run test:live:full` is the wider `scripts/test-live.mjs`: the whole public
surface plus a cost estimate. It serves no conversions and spends nothing either,
but it makes about twenty requests, so it paces itself — see § Maintenance.

## Maintenance

The refresh pass is ~4 h/month: re-check the verdicts, bump `verified`, and open
a PR. `build.mjs` prints a `STALE` warning for any entry whose `verified` date is
more than 35 days old and marks it *review due* on the page, so staleness is
visible in the build rather than discovered by a reader.

`scripts/test-live.mjs` reads the **public gate** on the deployed service and
asserts it in detail. It sends no `X-PAYMENT` header at any point, so every
`/convert` probe stops at the paywall: **zero conversions served, zero USDC
spent, and no meter moved past a couple of dozen requests.**

```bash
npm run test:live:full                            # production
node scripts/test-live.mjs http://localhost:8787  # against wrangler dev --local
```

`--quota` and `--tools=` are gone. Neither has anything left to do: there is no
free-tier ledger to walk, and no three scarce served slots to re-point.

It covers `GET /check` with and without parameters, the alias rows (`md`, `.md`,
`text/markdown`, `yaml`, `.yml` → `application/json`), an unknown format
returning an empty answer rather than an error, `catalog.json` / `llms.txt` /
`llms-full.txt` / `openapi.json` / `robots.txt`, **one 402-envelope assertion per
live tool**, a `413` at 300 KB, and a `POST /b` visit — then prints a PASS/FAIL
table and exits non-zero on any failure. Zero dependencies; Node 18+ for global
`fetch`.

The envelope assertion is the core of the run, because it is the exact JSON a
paying agent reads before it signs anything: the fields a signature is computed
over (`network`, `scheme`, `asset`, `extra`) and the fields that identify the
tool (`resource`, `mimeType`) are pinned exactly; `outputSchema.input.discoverable`
must be `true`; every `description` at any depth must be ≤ 500 characters; and no
two tools may claim the same description, which is how "the envelopes are
per-tool" is checked rather than assumed. Price and timeout are only
sanity-checked, because they are owner-tunable and pinning them would turn a
config change into a red row that says nothing.

**What a green row here does not say.** No converter runs on a 402 path, so a
pass means *the gate is right* — it says nothing about the tool behind the gate.
Converter coverage is `npm test` (local, free). Paid-path coverage is
`scripts/pay-test.mjs` (owner-only, real USDC). None of the three substitutes for
another.

It does not assume the tier is off, either. `GET /check` publishes the runtime
value, and a deployment with `FREE_TIER_DAILY` set will serve a probe: those rows
are **relabelled** rather than quietly asserting the wrong contract, and the run
prints a loud NOTES block under the table saying a free tier is enabled and that
the run is no longer free of served conversions. The same treatment applies to a
deployment with no receiving address. It paces itself at 2.5 s per request
against a remote host, so a run of twenty cannot look like a tight loop to
anything at the edge; there is no pause against localhost.

After the table it prints a **cost estimate** from named constants with the
arithmetic shown — Workers requests and CPU, D1 rows written, the assumed 2 ms
per conversion — the cost of the run just made (**$0.00 in USDC and $0.00 in
Cloudflare metering**, with the served-conversion count printed rather than
assumed), and a table of monthly cost at 1k / 10k / 100k / 1M calls a day, where
one "call" is a served and therefore paid one. Requests are the allowance that
cracks first, at roughly 333k calls/day (10M req/mo); at 1M calls/day the metered
charge is about $16.60/month on top of the flat plan fee. Unpaid traffic — 402s,
413s, `/check`, the static files — counts only against requests and CPU, because
an unpaid 402 writes no D1 row at all. Everything there is labelled *list prices
as of 2026-08-18* and needs re-reading, not trusting, after any Cloudflare
repricing.

One piece of automation is still **not built**: a CI link-check over every
`url`.

Adding a hosted tool is four steps: add the `hosted:` block in `entries.yaml`
(with a `price` — every hosted tool is priced), add the matching entry to
`CONVERTERS` in `worker/beacon.js`, run `npm run build` (which regenerates
`worker/catalog.generated.js`), and deploy. The build fails if `hosted.path` and
the entry id disagree; the Worker answers `501` if an entry is listed `live` with
no implementation behind it.

The `CONVERTERS` entry needs `inputFormat` and `outputFormat` alongside
`description`, `mimeType` and `contentType`: those two are what the 402
envelope's `outputSchema` descriptions are built from, so a new tool describes
itself to a discovery index without a second edit. Keep `mimeType` in step with
`RESPONSE_MIME` in `build.mjs` — a test asserts the two agree per tool, because
`openapi.json` publishes one and the envelope publishes the other.

Turning the free tier back on is [its own
runbook](#re-enabling-the-free-tier) — three steps, because the Worker and the
static copy read different sources. Numbers typed a second time and worth
grepping when it changes: `FREE_TIER_ENABLED` in `test/harness.mjs` (the width
phase 1 boots), the `5000` in the per-caller pressure query above, and
`PAID_DAILY`, which is mirrored in `test/harness.mjs` because it is deliberately
not exported by the catalog. `mcp/server.mjs` and `skills/toolshed/SKILL.md` no
longer hardcode a tier at all — both read `hosted.free_tier_daily` and the
`x-free-tier-remaining` header, and print only what the service reported.
