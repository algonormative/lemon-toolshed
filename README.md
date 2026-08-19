# Toolshed

**A collection of tools for agents — no install required.** Privacy-first: no
login, no credit card, no account.

**Every tool is free to try: 3 conversions a day, no login. Past that it's a
paid call — $0.001 in USDC via x402, with much higher limits.**

An agent posts a file to an HTTP endpoint and gets the converted file back.
Inside the free tier it just answers, and says how many calls are left in an
`x-free-tier-remaining` header. Past it, the answer is HTTP 402 with an x402
envelope (USDC on Base) naming a live receiving address, and a payment
presented against that envelope is verified with the Coinbase CDP facilitator
before the conversion is served — or HTTP 429 on a deployment with no receiving
address configured (`PAYTO` unset).

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
- **The free tier is enforced and payment is live; exactly one real payment has
  settled, and it was ours.** The 3/day free tier is real and runs against D1.
  Past it, a spec-valid 402 is issued (`PAYTO` is set — live since 2026-08-18),
  and a payment presented against it is verified and settled with the Coinbase
  CDP facilitator. Proven end to end on 2026-08-18 by a real payment in real
  USDC on Base (tx `0xe2c8bb8d…`, `verify_ok = 1`, `settle_ok = 1`) — made by
  `scripts/pay-test.mjs`, which is to say by us, not by a stranger. Two honest
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
scripts/test-live.mjs       the older live probe + cost estimate; spends the whole 3/day tier
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
  price:                     # what a call costs PAST the free tier
    amount_usd: 0.001        # (`free` is still accepted, and still capped daily)
    scheme: exact
  status: live               # or planned

local:                       # how to run it yourself
  tool: pandoc               # optional; defaults to the top-level `tool`
  install: "brew install pandoc"
```

No `hosted:` block means a local-only reference entry. A bare top-level
`install:` still works and is read as `local.install`, so entries written before
the split need no edit. The build fails if `hosted.path` and the id disagree.

**The free tier is not a per-entry field.** It is one build constant,
`FREE_TIER_DAILY` in `build.mjs` (owner-tunable, currently **3**). The build
stamps it onto every hosted entry as `hosted.free_tier_daily` — so it reaches
`catalog.json`, `llms.txt`, `llms-full.txt` and `GET /check` — *and* exports it
into `worker/catalog.generated.js`, which is where the Worker reads it to
enforce the limit. One number: what the site advertises and what the Worker
enforces cannot drift apart.

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
 4. D1: events / daily_aggregates / blocklist / salt / counters / convert_quota.
 5. API Worker, routes /b + /check + /convert/* on the zone, D1 binding; the
    page addresses the beacon by RELATIVE URL.
 6. Edge abuse control — OWNER-VERIFIED 2026-08-18: the dashboard gates
    rate-limiting rules behind a higher plan for this account, so the edge
    rate rule is DROPPED from this runbook. The deployed in-Worker tiers
    (3/day free per IP-hash, 100/day beacon identifier, 200k/day global
    fail-closed) are the abuse bound, the $25 Usage-Based Billing
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

### Migration — the free-tier table (existing databases)

`worker/schema.sql` is all `CREATE TABLE IF NOT EXISTS`, so re-running the whole
file is safe. But the production database already exists, and the free tier
needs one new table, so **run this before deploying a Worker that enforces it**
— the Worker fails closed, and a missing table means 503s, not free conversions:

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
explanation quoting the price, the asset and the `payTo` address, says what an
x402 client would do with it, and states that payments are verified with the CDP
facilitator and settled — including what a `402` carrying an `invalidReason`
means, which is that a payment was rejected and resending it will fail the same
way. On a `429` it says the day's free calls are spent, quotes the free tier, the
paid tier and the reset time in hours, and says plainly that a different
user-agent will not help because the counter is keyed on the IP. A successful
call comes back clean unless the free tier is nearly out — `LOW_TIER_WARN`,
which is `min(3, FREE_TIER_DAILY - 1)`, so the last two calls of a 3/day tier —
in which case it carries a one-line warning. A verified paid call, and a call
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

**All five hosted tools are priced, and all five are free to try.** The first
`FREE_TIER_DAILY` — currently **3** — conversions per caller per UTC day cost
nothing and need no login; past that a call costs **$0.001 in USDC on Base**,
per call, negotiated with x402.

### The free tier, and its caller key

The point of a free tier is to let an agent try the thing without an account.
The point of *this* free tier's key is that trying it a second time should cost
something real:

| | |
| --- | --- |
| **counted per** | `hash(daily salt + IP)` — the IP address **alone** |
| **not counted per** | user-agent, header set, TLS fingerprint, anything else spoofable for free |
| **window** | one UTC day; the counter resets at midnight UTC |
| **stored as** | one D1 row, `convert_quota(day, ip_hash, used)` |
| **reported as** | `x-free-tier-remaining: <n>` on every free-tier answer |

Deliberately **no user-agent in the key**. Including it is the obvious mistake:
a UA string is a header a caller writes, so a UA-keyed free tier is an infinite
free tier for anyone who can type. Keying on the IP alone means a second
identity costs a second address — not free, and that is the whole point. It is
not unspoofable (proxy pools exist, and shared NAT undercounts real people in
the other direction); it is the cheapest control that makes the abuse cost more
than the abuse is worth at $0.001 a call.

The claim is spendable per call, not read-then-written: `claimConvertQuota()`
upserts with a guard — `ON CONFLICT … DO UPDATE SET used = used + 1 WHERE used <
ceiling RETURNING used` — so the check and the spend are one statement and
cannot race apart across isolates. No row back means the ceiling was already
reached.

### Environment variables

| var | read? | effect |
| --- | --- | --- |
| `PAYTO` | yes | the receiving address (USDC on Base) named in the 402 envelope. **Unset = there is nowhere to pay**, so over-tier calls answer 429 instead of 402. |
| `FACILITATOR_URL` | yes | the x402 facilitator base URL. Defaults to `https://api.cdp.coinbase.com/platform/v2/x402`; overridden only by the test suite, which points it at a local mock. |
| `CDP_API_KEY_ID` | yes | CDP API key id. A **Worker secret**, not a var. |
| `CDP_API_KEY_SECRET` | yes | CDP API key secret (base64 Ed25519). A **Worker secret**. Without both keys nothing can be verified, and over-tier paid calls are served with `x-payment-error: facilitator-unconfigured`. |

Set the two secrets with `wrangler secret put`, never in `wrangler.toml`:

```bash
npx wrangler secret put CDP_API_KEY_ID
npx wrangler secret put CDP_API_KEY_SECRET
```

### Behaviour, exactly as implemented

| calls today | `PAYTO` | `X-PAYMENT` | facilitator says | response |
| --- | --- | --- | --- | --- |
| ≤ 3 | unset | no | *not asked* | **200**, the conversion, `x-free-tier-remaining: <n>` |
| ≤ 3 | unset | yes | *not asked* | **200**, plus `x-payment-verified: false` — the free tier is not a payment path |
| ≤ 3 | set | no | *not asked* | **200**, the conversion, `x-free-tier-remaining: <n>` — a receiving address does not cancel the free tier |
| ≤ 3 | set | yes | *not asked* | **200**, `x-free-tier-remaining: <n>` + `x-payment-verified: false`. **Never billed inside the free tier** |
| > 3 | unset | either | *not asked* | **429**, `{"error": "free tier is 3 conversions per day per caller", …}` + `Retry-After` |
| > 3 | set | no | *not asked* | **402**, a spec-valid x402 v1 envelope for that tool |
| > 3 | set | malformed | *not asked* | **402** + `invalidReason: malformed_payment_header` — nothing decodable to send |
| > 3 | set | yes | `isValid` | **200**, `x-payment-verified: true`, and settlement runs after the response |
| > 3 | set | yes | not valid | **402** + the envelope + `invalidReason` — no conversion served |
| > 3 | set | yes | *unreachable* | **200**, `x-payment-verified: false` + `x-payment-error` + `x-pricing: pending` — served free, recorded |
| > 5,000 | set | yes | — | **429** + `Retry-After` — the runaway bound, not a price gate |

Three rows deserve saying out loud:

- **The free tier is never a payment path.** The free allowance is claimed
  *first*, before anything looks at `X-PAYMENT`, so a caller with allowance left
  is never verified and never billed — and the facilitator is not called at
  all. That ordering is the rule, expressed as control flow rather than as a
  promise, and `test/x402-settlement.test.mjs` asserts it as **zero** calls to
  the facilitator rather than as a header.
- **The paid ceiling now keys on a VERIFIED payment.** *Changed 2026-08-18.*
  `PAID_DAILY` (5,000/day per caller) used to be unlocked by the mere
  **presence** of an `X-PAYMENT` header — a pre-facilitator placeholder that let
  any caller who could type a header buy a 500× higher ceiling for free. The
  higher ceiling is now claimed only after the facilitator returns `isValid`. A
  rejected payment leaves the counter exactly where the free tier left it.
- **An unreachable facilitator serves the call.** Availability-first, and it is
  a deliberate trade: at $0.001 a call the price is a signal, and turning paying
  callers away because *our* dependency is down is the worse failure. Every one
  of these is written to `settlements` with the precise reason, so the choice is
  auditable rather than invisible. If that table fills up with
  `facilitator-*` rows, the dependency is broken and revenue is quietly zero —
  see [Operator queries](#operator-queries-kc-cur).

And the invariant that has not changed: **nothing is ever fake-verified.**
`x-payment-verified: true` appears only after a facilitator round trip that
returned `isValid`. There is no code path that infers it from a header.

**The paid ceiling answers 429, not 402.** `PAID_DAILY` (5,000/day per caller,
in `worker/beacon.js`, owner-tunable) is a runaway bound rather than a quota to
advertise — so it is deliberately absent from the catalog and the page. A caller
that already paid cannot buy its way past it, and answering "pay to continue"
would be a lie; it gets the plain rate-limit answer with a `Retry-After`.

The page publishes the same thing in plain language under **Pricing, and paying
with USDC** — the free tier and its IP-keyed counter, what the 402 carries, the
two things an agent needs (an x402-capable HTTP client and a wallet key holding
USDC on Base), a copy-able `x402-fetch` example, and an honest-status box. The
MCP server's `toolshed_convert` explains both a 402 and a 429 rather than
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

Exercising the 402 needs the free tier spent first — eleven calls, or a
`DELETE FROM convert_quota` between runs:

```bash
npx wrangler d1 execute DB --local --command "DELETE FROM convert_quota;"
```

## Settlement (live)

Past the free tier, a payment is now **checked before the conversion is served
and settled on chain immediately afterwards**, through the Coinbase CDP
facilitator.

> **Status.** Live and proven with real money. On **2026-08-18** a real payment
> in real USDC on Base verified and settled through the CDP facilitator — tx
> `0xe2c8bb8d…`, `settlements` row `verify_ok = 1`, `settle_ok = 1`. It was made
> by `scripts/pay-test.mjs`, so the one settlement on record is **our own test
> call**; no third party has paid yet. Everything below is additionally covered
> against a mock facilitator and against a real `x402-fetch` client signing a
> real EIP-3009 authorization.

### The shape of it

```text
caller ──POST /convert/x, X-PAYMENT──▶ Worker
                                        │  free tier gone? and PAYTO set?
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
accepted exposure: one conversion served for $0.001 that never arrived,
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

`paymentPayload` is the caller's `X-PAYMENT` header, base64-decoded.
`paymentRequirements` is **the same object the 402 envelope advertised** — built
once in `paymentRequirements()` and used by both, because the client signs
against what the envelope said and the facilitator recovers that signature from
what we send. Any field that differs between the two turns a perfectly good
payment into `invalid_exact_evm_payload_signature`.

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

### Response headers, past the free tier

| header | meaning |
| --- | --- |
| `x-payment-verified: true` | the facilitator returned `isValid`. Never inferred from a header |
| `x-payment-verified: false` | nothing was checked — see `x-payment-error` |
| `x-payment-error: facilitator-unreachable` | timeout, network failure, or a non-200 from the facilitator |
| `x-payment-error: facilitator-unconfigured` | no CDP credentials on this Worker. Operator fault, not caller fault |
| `x-pricing: pending` | served over the tier without a verified payment |

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

**What step 4 actually costs:** one $0.001 USDC payment, *plus* today's free
tier for whatever IP you run it from — up to 3 throwaway conversions. The paid
path is unreachable until the free tier is spent (that is the design), so the
script burns it first and says so, call by call. It then signs, pays, and prints
the status, `x-payment-verified`, and where to confirm the money moved.

The key in `.buyer.env` is a **plaintext private key on disk**. That is fine for
a key holding a dollar and catastrophic for one holding anything else — fund it
with the minimum that proves the path, and treat the file as burnable.

### The honest-status box

**Flipped 2026-08-18**, after all three criteria were met by a real payment:

1. `npm run buyer:pay -- --yes` returned **200** with `x-payment-verified: true`.
2. A `settlements` row carried `verify_ok = 1`, `settle_ok = 1` and a real
   `tx_hash` (`0xe2c8bb8d…`).
3. The $0.001 landed at the `PAYTO` address.

The box now says payment is live and verified. **The rule holds in reverse, and
that is the part worth keeping**: if settlement ever breaks — a run of
`verify_ok = 0` in `settlements`, a facilitator outage that stops being
transient, a revoked CDP key — the box goes back to naming what is broken,
before anything else is fixed. "The code is written and the tests pass" is not
the same claim as "money has moved", and the box exists to not blur the two in
either direction.

The copy lives in `<div class="status-box">` in `build.mjs`, with a short
comment above it recording the flip.

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

**Free-tier pressure** — the number that says whether 3/day is the right number.
`hit_the_ceiling` counts callers that spent the whole tier, so a rising share is
the signal to raise `FREE_TIER_DAILY` — or evidence that the paid tier is doing
its job (the `3` in this query has to match it):

```bash
npx wrangler d1 execute DB --remote --command "
  SELECT day,
         COUNT(*)        AS callers,
         SUM(used)       AS conversions,
         SUM(used >= 3)  AS hit_the_ceiling,
         MAX(used)       AS busiest_caller
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
consequences — it is kept the 90 days purely so the free-tier pressure query
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
| 1c | Worker | **3 conversions / caller / UTC day** (`FREE_TIER_DAILY`), or 5,000 once a payment has been **verified** by the facilitator (changed 2026-08-18 — presenting a header is no longer enough) | over-tier callers get 402 or 429; the key is the IP hash, so UA rotation does **not** mint a fresh allowance |
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

**The beacon and conversion budgets are now separate** — this is the shared-budget
flag from the previous pass, closed. Rung 1 counts `events` rows
`WHERE type <> 'convert'`, and conversions are metered by `convert_quota`
instead, so:

- A caller that loads the page five times still has all 3 conversions. A caller
  that spends all 3 conversions is still counted as a visitor. Neither budget
  reaches into the other.
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

Two stores, two subject-rights answers, both stated on the page: the counting
store holds a truncated daily-salted hash and nothing attributable once the salt
rotates; the IP blocklist is attributable and is purged on request. The
free-tier counter belongs to the first store, and the page says so in *How we
count* in one line: keyed on a daily-salted hash of the IP alone (no
user-agent), unlinkable across days, same retention as the other counters.

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

Two commands, and the split between them is about **cost**, not about depth:

```bash
npm test           # the whole suite, LOCAL ONLY — touches nothing deployed
npm run test:live  # the production smoke — spends AT MOST ONE free conversion
```

`npm test` is the real coverage: 192 tests across nine files, per-tool fixture
batteries plus the protocol, quota, spoof-resistance, x402 and beacon contracts.
It never speaks to production and it never needs a Cloudflare login. Framework
is `node:test` — no test dependency was added, and none is wanted.

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
test/quota.test.mjs               the free tier and its spoof resistance
test/x402.test.mjs                the 402 envelope, and PAYTO set with no facilitator
test/x402-settlement.test.mjs     verify/settle against a mock facilitator + a real client
test/beacon.test.mjs              rows, bot drops, salt rotation
test/live.smoke.mjs               the production smoke (`npm run test:live`)
```

### The fresh-state guarantee

Every phase of a run boots its own `wrangler dev --local` against its own
`--persist-to` directory under the OS temp dir, with `worker/schema.sql` applied
to it **before** the server starts, and deletes that directory on teardown. Two
runs cannot see each other's rows, and no run can see the demo database in
`.wrangler/`. That is what lets the free-tier assertions be exact — "the 11th
call is refused", not "some call is eventually refused".

Teardown kills the process **group**. `wrangler dev` spawns two `workerd`
children, so killing the node process alone orphans them and leaks the port; the
harness spawns it `detached` and tears it down with `process.kill(-pid, …)`,
escalating to `SIGKILL`, plus a best-effort sweep on process exit.

### Why there are three phases

Dev vars change the product's answer past the free tier — with `PAYTO` unset it
is a 429, with `PAYTO` set it is a 402 envelope, and with a facilitator
configured it is a verified payment — and a dev var is fixed for the life of a
`wrangler dev` process. So `npm test` runs them in turn:

| phase | vars | files |
| --- | --- | --- |
| 1 | none | everything except the two x402 suites |
| 2 | `PAYTO` | `x402.test.mjs` — the envelope, and a half-configured deploy |
| 3 | `PAYTO` + `FACILITATOR_URL` + fake CDP keys | `x402-settlement.test.mjs` |

Phase 3 is marked `standalone` in `test/run.mjs`: it runs a mock facilitator on
a port it only learns at startup, and `FACILITATOR_URL` has to name that port,
so the worker cannot be booted before the mock exists. The suite boots its own —
on its own fresh D1, like every other phase.

The CDP credentials it uses are **structurally real and worth nothing**: a
freshly generated Ed25519 keypair, base64-encoded the way CDP encodes a Secret
API Key, never sent anywhere but the local mock. They have to be real enough to
sign with, because the point is that the Worker's JWT path executes for real
inside workerd — a runtime that could not import or sign with an Ed25519 key
would fail the suite rather than quietly skip it.

Suites run at `--test-concurrency=1` so the tests that count D1 rows can compare
a before and an after without another file writing between them.

### The positive control

`x402-settlement.test.mjs` ends by driving the **real `x402-fetch` client**
against the real 402 envelope: it parses our response, signs a genuine EIP-3009
authorization with a genuine key, and the Worker verifies it. No funds are
involved — the key is generated in the test and the mock does not look at the
chain — but the *signing* is real, and that is the half a mock cannot fake.

It earns its place: every other test in the file builds its own `X-PAYMENT`
header, which proves the Worker handles the payload *the test writes*, not that
a real client can produce one. The missing-`extra` bug lived exactly in that
gap — the envelope was spec-shaped, every envelope assertion passed, and no
genuine payment could ever have verified. Removing `extra` from the Worker now
fails this test (measured, not assumed).

### Running one suite

Any file works on its own — it boots its own worker when the runner has not
already exported one, so there is nothing to set up:

```bash
node --test test/quota.test.mjs
node --test test/convert-csv-json.test.mjs
npm test csv                       # or filter the runner by substring
```

### `cf-connecting-ip`, and why the quota tests work at all

The free-tier counter is keyed on `hash(daily salt + IP)`, read from
`request.headers.get('cf-connecting-ip')`. **`wrangler dev --local` passes that
header straight through from the client** — verified empirically against
wrangler 4.42.2: three POSTs to `/convert/md-html` carrying `cf-connecting-ip`
`203.0.113.1`, `.2` and `.2` produced **two** `convert_quota` rows with
`used = 1` and `used = 2`. Had the header been ignored, there would have been
one row at `used = 3`.

So every virtual caller in the suite is just a header value, and per-test
isolation costs nothing: each suite owns a band of `198.18.<octet>.<n>`
addresses (`SUITE_OCTET` in `test/harness.mjs`), fixture tests take a fresh
address per call so quota is never in play, and the quota and x402 suites pin
addresses deliberately so they can exhaust one.

In production the header comes from the edge and a client cannot forge it. There
is no edge in front of `wrangler dev`, which is exactly what makes it usable as
a test control.

### The live smoke

`npm run test:live` checks that what is deployed is the same product, on a
strict budget: **at most one free-tier conversion**, and it never depends on how
much allowance is left. It asserts the `/check` contract, fetches
`catalog.json` / `llms.txt` / `llms-full.txt` and sanity-checks their shape
(including that `catalog.json` and `/check` agree about what is hosted), then
makes exactly one conversion — accepting **200**, **402** (paid gate live, tier
spent) or **429** (tier spent with no receiving address, or the paid ceiling) as
passes, labelled differently, so a repeat run on a spent day still tells the
truth. The remaining checks are
refusals (405, 404), which reach no counter.

```bash
npm run test:live
TOOLSHED_URL=http://localhost:8787 npm run test:live
```

`npm run test:live:full` is the older `scripts/test-live.mjs`: the whole surface
plus a cost estimate, but it **spends the caller's whole 3/day allowance**, and
its remaining convert calls land on the paywall by design. One run a day per IP.
Its `--quota` probe burns the day on purpose.

## Maintenance

The refresh pass is ~4 h/month: re-check the verdicts, bump `verified`, and open
a PR. `build.mjs` prints a `STALE` warning for any entry whose `verified` date is
more than 35 days old and marks it *review due* on the page, so staleness is
visible in the build rather than discovered by a reader.

`scripts/test-live.mjs` posts a known payload to every hosted endpoint and
asserts a distinctive substring came back, so a rotted converter shows up as a
red row rather than as a broken product.

```bash
npm run test:live:full                            # production
node scripts/test-live.mjs http://localhost:8787  # against wrangler dev --local
node scripts/test-live.mjs --quota                # the free-tier probe, opt-in
```

It covers `GET /check` with and without parameters, all five happy-path
conversions, a malformed-input `400`, a `413` at 300 KB, and a `POST /b` visit —
then prints a PASS/FAIL table and exits non-zero on any failure. Zero
dependencies; Node 18+ for global `fetch`.

**A default run spends all 3 of the caller's free conversions, and is
deliberately wider than the tier.** Seven calls reach `/convert`: five happy
paths, a malformed-input case (which claims its free call before the body is
read) and the 413 (rejected on the declared size, before any D1 work — it costs
nothing). Only the first **3** can be served, so the run is written as a ledger:

- Calls 1–3 must be **200**, with the converter's own output and
  `x-free-tier-remaining` counting down **2 → 1 → 0** exactly.
- Every `/convert` call after them is over the tier, where the paywall is the
  **correct** answer. The run asserts that transition at exactly the call the
  tier runs out on — a **402** with a spec-shaped x402 envelope, or a **429**
  with the documented free-tier body where `PAYTO` is unset. Those rows pass
  because the *gate* is right, and each one says the converter behind it was
  **not exercised** this run. They are not converter passes.

So only the first three converters in the list get live coverage on a given day.
`--tools=<id,...>` re-points the three scarce slots at the converters you
actually changed; the local suite (`npm test`) is what covers all five, plus the
malformed-input case, unconditionally.

**A second run in the same UTC day from the same IP fails on its first
conversion**, saying the tier was already spent rather than blaming a converter.

`--quota` is the free-tier probe and is **not** part of the default run, because
it deliberately burns the day: 5 beacons, 3 conversions, one over, then three
more under rotated user-agents. It asserts, in order, that beacons do not touch
the conversion budget, that `x-free-tier-remaining` counts 2 → 0, that call 4 is
refused with the documented 429 body and a sane `Retry-After` (or a 402 envelope
when `PAYTO` is set), and that rotating the user-agent from the same IP changes
nothing. It needs a caller whose allowance is untouched today, and it paces
itself at 2.5 s against a remote host so rung 0 does not block it first (no
pause against localhost).

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

Adding a hosted tool is four steps: add the `hosted:` block in `entries.yaml`
(with a `price`, since every hosted tool is priced past the free tier), add the
matching entry to `CONVERTERS` in `worker/beacon.js`, run `npm run build` (which
regenerates `worker/catalog.generated.js`), and deploy. The build fails if
`hosted.path` and the entry id disagree; the Worker answers `501` if an entry is
listed `live` with no implementation behind it. The free tier needs no per-tool
work — it is one constant and it applies to `/convert/*` as a whole.

Changing the free tier is one line: `FREE_TIER_DAILY` in `build.mjs`, then
`npm run build` (which rewrites `worker/catalog.generated.js`) and deploy. Page
copy, `catalog.json`, `llms.txt`, `llms-full.txt`, `GET /check` and the Worker's
enforcement all move together. Two numbers are typed a second time and are worth
grepping when it changes: `FREE_TIER_EXPECT` in `scripts/test-live.mjs`,
`FREE_TIER_DAILY` in `mcp/server.mjs` (wording only — the service is
authoritative), the hardcoded numbers in `skills/toolshed/SKILL.md`, and the
`3` in the free-tier pressure query above.
