---
name: toolshed
description: Convert files/data between formats using Lemon Toolshed's hosted conversion endpoints — $0.002-$0.006 a call in USDC via x402, no install, no login, no account; check pair availability first.
---

# Toolshed

Conversion tools you call over HTTP with nothing installed. No login, no
account, no card: you pay per call in USDC ($0.002-$0.006 depending on the tool),
and the payment is the auth.

**Prices are per tool.** They were uniform until 2026-08-30 and are not any
more, so never assume one figure: `/check` reports `hosted.price.amount_usd` per
tool and the `402` envelope names the exact amount for the call you are making.
The table below is a cache; those two are authoritative.

**Payment is the front door.** The first call carries no `X-PAYMENT` header, so
it answers `402` straight away, with an x402 envelope naming the terms to pay
against — see [Paying (x402)](#3-paying-x402). A `402` here is not an error and
not an exhausted allowance; it is the price. You are only charged for
conversions that are actually served.

Base URL: `https://toolshed.lemon-agent.dev`

Install this skill: `npx skills add algonormative/lemon-toolshed`. There is also an
MCP server in the same repo (`claude mcp add toolshed -- npx -y
github:algonormative/lemon-toolshed`) exposing `toolshed_check`, `toolshed_convert`
and `toolshed_catalog` — use whichever surface your harness already has.

## 1. Check availability first

Never guess an endpoint. Ask what exists:

```bash
curl "https://toolshed.lemon-agent.dev/check?from=markdown&to=html"
```

- `from` matches what you **have**, `to` matches what you **need**. They are
  bound to their own side — `from=markdown` never matches the need side.
- Both are case-insensitive substrings, and both also take extensions and MIME
  types as exact aliases. `from=md`, `from=.md`, `from=text/markdown`, `to=yml`,
  `to=.yaml`, `to=text/html` all hit. Either may be omitted.
- No parameters returns every hosted tool.

The reply gives you `matches[]`, each with:

- `hosted` — `{path, price, status, free_tier_daily}`, or `null` when we do not
  host it. `price` is `{amount_usd, scheme}`, and `free_tier_daily` is how many
  calls a day cost nothing — `0` on the hosted service, above zero only on a
  deployment that set the `FREE_TIER_DAILY` env var. Only call `status: "live"`.
- `local` — `{tool, install}`, the tool to run yourself instead.
- `x`, `y` — the pair in full, so you can tell near-matches apart.
- `x_aliases`, `y_aliases` — the extensions and MIME types each side answers to.

If `hosted` is `null`, stop calling the API and tell the user the `local`
install line instead.

## 2. Convert

POST the raw file as the body. The converted file comes back as the body.

```bash
curl -X POST "https://toolshed.lemon-agent.dev/convert/md-html" \
  --data-binary @README.md
```

- Use `--data-binary`, not `-d`: `-d` strips newlines.
- Input is capped at **256 KB**. Larger input answers `413` — split it, or use
  the local tool. The size is checked before the price, so an oversize body is
  refused without an envelope ever being built.
- Content-Type on the request is ignored. The response carries the right one.
- Malformed input answers `400` with `{"error": "..."}`. Read the message; it
  names the problem.
- **You are only charged for conversions that are actually served.** A `400` on
  malformed input is not charged, and a `413` is refused before the envelope is
  even built.
- `x-free-tier-remaining: <n>` appears only on a deployment that has enabled a
  free tier through the `FREE_TIER_DAILY` env var. The hosted service does not
  send it.

Live endpoints. The $0.002 band is a parse-and-re-emit between two structured text formats;
$0.004 buys real parsing (Markdown, TOML, frontmatter); the $0.006 band has
to build a DOM or a full document tree first.

| id | converts | price |
| --- | --- | --- |
| `md-html` | Markdown to HTML | $0.004/call |
| `json-yaml` | JSON to YAML | $0.002/call |
| `yaml-json` | YAML to JSON (first document of a stream) | $0.002/call |
| `csv-json` | CSV to JSON (array of objects from the header row) | $0.002/call |
| `json-csv` | JSON array of records to CSV (header = union of all keys) | $0.002/call |
| `csv-yaml` | CSV to YAML (list of maps) | $0.002/call |
| `yaml-csv` | YAML list of maps to CSV | $0.002/call |
| `json-ndjson` | JSON array to newline-delimited JSON | $0.002/call |
| `ndjson-json` | NDJSON to a JSON array | $0.002/call |
| `frontmatter-json` | Markdown `---` fence to `{data, content}` | $0.004/call |
| `markdown-json` | Markdown to `{toc, tokens}` (lexer AST) | $0.004/call |
| `srt-vtt` | SubRip subtitles to WebVTT | $0.002/call |
| `vtt-srt` | WebVTT to SubRip subtitles | $0.002/call |
| `toml-json` | TOML to JSON | $0.004/call |
| `json-toml` | JSON object to TOML | $0.004/call |
| `html-markdown` | HTML to Markdown | $0.006/call |
| `html-text` | HTML to readable plain text (chrome dropped) | $0.006/call |
| `html-json` | HTML `<table>`s to `{tables: [{caption, columns, rows}]}` | $0.006/call |
| `xml-json` | XML to JSON (`@_` attributes, `#text`) | $0.006/call |

Treat this table as a cache; `/check` is authoritative.

## 3. Paying (x402)

A `402` is the ordinary answer to a call that carried no payment. It is the
price, quoted in a form a client can pay — not an allowance you have used up.

**Both x402 versions come out of that one 402, so use whichever your client
speaks.** The v1 envelope is the response body. The v2 envelope is base64 JSON
in the `PAYMENT-REQUIRED` response header — where a v2 client looks first, and
where it should keep looking, because the body is the v1 half and a v2 client
cannot use it. Pay with `X-PAYMENT` (v1) or `PAYMENT-SIGNATURE` (v2). One or the
other, not both.

The v1 body:

```json
{"x402Version": 1, "error": "X-PAYMENT header is required",
 "accepts": [{"scheme": "exact", "network": "base", "maxAmountRequired": "4000",
              "resource": "https://toolshed.lemon-agent.dev/convert/md-html",
              "description": "Markdown to HTML conversion",
              "mimeType": "text/html",
              "payTo": "0x...", "maxTimeoutSeconds": 60,
              "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
              "extra": {"name": "USD Coin", "version": "2"},
              "outputSchema": {
                "input": {"type": "http", "method": "POST", "discoverable": true,
                          "bodyType": "text", "description": "..."},
                "output": {"type": "string", "description": "..."}}},
             {"scheme": "exact", "network": "solana", "maxAmountRequired": "4000",
              "resource": "https://toolshed.lemon-agent.dev/convert/md-html",
              "description": "Markdown to HTML conversion",
              "mimeType": "text/html",
              "payTo": "<base58>", "maxTimeoutSeconds": 60,
              "asset": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
              "extra": {"feePayer": "<base58>"},
              "outputSchema": {"...": "..."}}]}
```

`accepts` is a LIST, best entry first. The Solana entry is present only on a
deployment that has that rail configured; take the first entry you hold USDC on
and ignore the rest.

The v2 header, decoded, is the same offer in v2 spelling:

```json
{"x402Version": 2, "error": "Payment required",
 "resource": {"url": "https://toolshed.lemon-agent.dev/convert/md-html",
              "method": "POST", "description": "Markdown to HTML conversion",
              "mimeType": "text/html", "serviceName": "Toolshed"},
 "accepts": [{"scheme": "exact", "network": "eip155:8453", "amount": "4000",
              "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
              "payTo": "0x...", "maxTimeoutSeconds": 60,
              "extra": {"name": "USD Coin", "version": "2"}},
             {"scheme": "exact", "network": "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
              "amount": "4000",
              "asset": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
              "payTo": "<base58>", "maxTimeoutSeconds": 60,
              "extra": {"feePayer": "<base58>"}}],
 "extensions": {"bazaar": {"info": {"input": {"type": "http", "method": "POST",
                                              "bodyType": "text", "body": "..."}},
                           "schema": {"...": "..."}}}}
```

Then:

- `asset` is USDC — the Base contract on the `base` entry, the SPL mint on the
  `solana` one. `maxAmountRequired` (v1) and `amount` (v2) are the same number in
  atomic units — 6 decimals on both chains, so `"2000"` is $0.002 and `"6000"` is
  $0.006, and the two entries quote the SAME figure. Read it from the envelope;
  do not assume one price across the API.
- `network` names the chain, in that version's spelling: `base` / `eip155:8453`,
  and `solana` / `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp`. Entry *i* of the v2
  header is entry *i* of the v1 body — the two envelopes are one offer.
- `extra` is per-chain and is NOT interchangeable. On Base it is the EIP-712
  domain you sign over; on Solana it is `{feePayer}`, the account that pays the
  transaction fee. Pay the entry you picked, with the `extra` that came with it.
- **Pay a rail we actually offered.** A payment naming a chain that is not in
  `accepts` comes back `402` with `invalidReason: unsupported_network`, and
  nothing is charged.
- What you are buying is `outputSchema` in v1 and `extensions.bazaar.info` in
  v2: `input` describes the request the endpoint takes — and in v2 its `body`
  is a real example you can send as-is — and `output` what comes back.
- **No `PAYMENT-RESPONSE` header comes back on a paid call**, and that is not a
  failure. Settlement runs after the response, so there is no receipt to hand
  over at that moment; `x-payment-verified: true` is the claim to read instead.
- Paying needs two things: an x402-capable HTTP client (`x402-fetch` or
  `@x402/fetch`, the x402 SDK, or Coinbase AgentKit) and a wallet key holding
  USDC on one of the rails in `accepts`. The client reads the envelope, signs, and retries with an
  `X-PAYMENT` header (v1) or a `PAYMENT-SIGNATURE` header (v2). No login, no
  card, no account — the payment is the auth.
- Never ask the user to paste a private key or a seed phrase. If you have no
  x402 client wired up, say so and offer the local tool from `/check` instead.
- **Payments are verified and settled.** A payment presented against the
  envelope is checked with the Coinbase CDP facilitator *before* the conversion
  is served. Read the response headers and report accordingly:

  | header | what happened | report it as |
  | --- | --- | --- |
  | `x-payment-verified: true` | verified, and settling on the rail you paid | **paid** |
  | `x-payment-verified: false` + `x-payment-error` + `x-pricing: pending` | the facilitator could not be reached; served anyway | **served, not charged** |
  | `x-free-tier-remaining: <n>` | only on a deployment with a free tier enabled | **free** — never report it as paid |

  A `402` carrying an `invalidReason` means a payment you sent was **rejected**;
  retrying the same payload will fail identically. Sign a fresh one against the
  terms in the envelope, and retry once — not in a loop.

- **Nothing is charged unless a conversion is actually served.** Settlement is
  queued only after the conversion succeeded, so a `400` on malformed input
  moves no money even when the payment verified: verify-yes/settle-no leaves the
  signed authorization unused and no transfer happens. A `413` never gets as far
  as an envelope.
- **`429`** — two cases, and they want opposite responses:
  - *No receiving address configured on that deployment*, so there is nowhere to
    pay at all. The body names it: `{"error": "...no receiving address...",
    "free_tier_daily": 0, "paid_tier": "...", "retry": "..."}`, and there is
    **no** `Retry-After` header, because waiting cannot help — this is a
    misconfiguration, not a quota. Use the local tool from `/check`.
    (`toolshed.lemon-agent.dev` does not answer this.)
  - *The per-caller daily conversion ceiling*, a runaway bound on paid calls.
    The body is `{"error": "the daily conversion ceiling for this caller is
    reached", "retry": "tomorrow UTC"}` with a `Retry-After`. The ceiling is
    keyed on the IP address, so retrying with a different user-agent changes
    nothing, and neither does retrying in a loop. Wait, or use the local tool.

## 4. The whole catalog

For picking a tool when `/check` finds nothing, fetch the catalog:

```bash
curl https://toolshed.lemon-agent.dev/llms-full.txt
```

Full entries — verdict, caveats, when a model is actually warranted, and the
local install line. `llms.txt` is the one-line-per-pair version; `catalog.json`
is the same data structured; `/openapi.json` is the OpenAPI 3.1 description of
the endpoints. `/robots.txt` sits alongside them.

## Limits

- **Every call is priced, per tool, in USDC on Base or Solana** — $0.002 for the
  structured-text conversions, $0.004 for real parsers, $0.006 for the ones that build a DOM or a
  document tree. There is no allowance to
  spend first: an unpaid call answers `402` with the envelope to pay against,
  and that is the front door. A `429` means one of two other things — that
  deployment has no receiving address, or this caller hit the per-caller daily
  conversion ceiling. The caller key is the IP address.
- The edge blocks bursts at 5 requests / 10 seconds per IP — pace calls rather
  than firing them in a tight loop.
- `413` over 256 KB, `400` on malformed input, `503` when the service is down —
  do not retry a `503` in a loop.
