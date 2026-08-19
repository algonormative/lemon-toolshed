---
name: toolshed
description: Convert files/data between formats using Lemon Toolshed's hosted conversion endpoints — $0.001 a call in USDC via x402, no install, no login, no account; check pair availability first.
---

# Toolshed

Conversion tools you call over HTTP with nothing installed. No login, no
account, no card: you pay per call in USDC ($0.001), and the payment is the
auth.

**Payment is the front door.** The first call carries no `X-PAYMENT` header, so
it answers `402` straight away, with an x402 envelope naming the terms to pay
against — see [Paying (x402)](#3-paying-x402). A `402` here is not an error and
not an exhausted allowance; it is the price. You are only charged for
conversions that are actually served.

Base URL: `https://toolshed.lemon-agent.dev`

Install this skill: `npx skills add chronick/lemon-toolshed`. There is also an
MCP server in the same repo (`claude mcp add toolshed -- npx -y
github:chronick/lemon-toolshed`) exposing `toolshed_check`, `toolshed_convert`
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

Live endpoints — all five priced the same:

| id | converts | price |
| --- | --- | --- |
| `md-html` | Markdown to HTML | $0.001/call |
| `json-yaml` | JSON to YAML | $0.001/call |
| `yaml-json` | YAML to JSON | $0.001/call |
| `csv-json` | CSV to JSON (array of objects from the header row) | $0.001/call |
| `html-markdown` | HTML to Markdown | $0.001/call |

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
 "accepts": [{"scheme": "exact", "network": "base", "maxAmountRequired": "1000",
              "resource": "https://toolshed.lemon-agent.dev/convert/md-html",
              "description": "Markdown to HTML conversion",
              "mimeType": "text/html",
              "payTo": "0x...", "maxTimeoutSeconds": 60,
              "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
              "extra": {"name": "USD Coin", "version": "2"},
              "outputSchema": {
                "input": {"type": "http", "method": "POST", "discoverable": true,
                          "bodyType": "text", "description": "..."},
                "output": {"type": "string", "description": "..."}}}]}
```

The v2 header, decoded, is the same offer in v2 spelling:

```json
{"x402Version": 2, "error": "Payment required",
 "resource": {"url": "https://toolshed.lemon-agent.dev/convert/md-html",
              "method": "POST", "description": "Markdown to HTML conversion",
              "mimeType": "text/html", "serviceName": "Toolshed"},
 "accepts": [{"scheme": "exact", "network": "eip155:8453", "amount": "1000",
              "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
              "payTo": "0x...", "maxTimeoutSeconds": 60,
              "extra": {"name": "USD Coin", "version": "2"}}],
 "extensions": {"bazaar": {"info": {"input": {"type": "http", "method": "POST",
                                              "bodyType": "text", "body": "..."}},
                           "schema": {"...": "..."}}}}
```

Then:

- `asset` is USDC on Base. `maxAmountRequired` (v1) and `amount` (v2) are the
  same number in atomic units — 6 decimals, so `"1000"` is $0.001.
- `network` is `base` in v1 and the CAIP-2 `eip155:8453` in v2. Same chain.
- What you are buying is `outputSchema` in v1 and `extensions.bazaar.info` in
  v2: `input` describes the request the endpoint takes — and in v2 its `body`
  is a real example you can send as-is — and `output` what comes back.
- **No `PAYMENT-RESPONSE` header comes back on a paid call**, and that is not a
  failure. Settlement runs after the response, so there is no receipt to hand
  over at that moment; `x-payment-verified: true` is the claim to read instead.
- Paying needs two things: an x402-capable HTTP client (`x402-fetch` or
  `@x402/fetch`, the x402 SDK, or Coinbase AgentKit) and a wallet key holding
  USDC on Base. The client reads the envelope, signs, and retries with an
  `X-PAYMENT` header (v1) or a `PAYMENT-SIGNATURE` header (v2). No login, no
  card, no account — the payment is the auth.
- Never ask the user to paste a private key or a seed phrase. If you have no
  x402 client wired up, say so and offer the local tool from `/check` instead.
- **Payments are verified and settled.** A payment presented against the
  envelope is checked with the Coinbase CDP facilitator *before* the conversion
  is served. Read the response headers and report accordingly:

  | header | what happened | report it as |
  | --- | --- | --- |
  | `x-payment-verified: true` | verified, and settling on Base | **paid** |
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

- **Every call is priced at $0.001 in USDC on Base.** There is no allowance to
  spend first: an unpaid call answers `402` with the envelope to pay against,
  and that is the front door. A `429` means one of two other things — that
  deployment has no receiving address, or this caller hit the per-caller daily
  conversion ceiling. The caller key is the IP address.
- The edge blocks bursts at 5 requests / 10 seconds per IP — pace calls rather
  than firing them in a tight loop.
- `413` over 256 KB, `400` on malformed input, `503` when the service is down —
  do not retry a `503` in a loop.
