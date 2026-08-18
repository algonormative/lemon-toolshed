---
name: toolshed
description: Convert files/data between formats using Lemon Toolshed's hosted conversion endpoints — 10 free conversions a day, then $0.001 a call in USDC via x402; check pair availability first.
---

# Toolshed

Conversion tools you call over HTTP with nothing installed. No login, no
account, no key.

**Every tool is free to try: 10 conversions a day.** Past that a call is priced
at $0.001 in USDC on Base, paid per call with x402 — see
[Paying (x402)](#3-paying-x402). The count is per caller per UTC day, and a
caller is an IP address: rotating the user-agent does not get you a second 10.

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
- Both are case-insensitive substrings. Either may be omitted.
- No parameters returns every hosted tool.

The reply gives you `matches[]`, each with:

- `hosted` — `{path, price, status, free_tier_daily}`, or `null` when we do not
  host it. `price` is `{amount_usd, scheme}` (or `"free"`), and
  `free_tier_daily` is how many calls a day cost nothing. Only call
  `status: "live"`.
- `local` — `{tool, install}`, the tool to run yourself instead.
- `x`, `y` — the pair in full, so you can tell near-matches apart.

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
  the local tool.
- Content-Type on the request is ignored. The response carries the right one.
- Malformed input answers `400` with `{"error": "..."}`. Read the message; it
  names the problem. A rejected call still spends a free-tier conversion.
- Every free-tier answer carries `x-free-tier-remaining: <n>` — how many of the
  day's 10 are left. At `0`, the next call is refused.

Live endpoints — all five priced the same, all five free to try:

| id | converts | price |
| --- | --- | --- |
| `md-html` | Markdown to HTML | 10/day free, then $0.001/call |
| `json-yaml` | JSON to YAML | 10/day free, then $0.001/call |
| `yaml-json` | YAML to JSON | 10/day free, then $0.001/call |
| `csv-json` | CSV to JSON (array of objects from the header row) | 10/day free, then $0.001/call |
| `html-markdown` | HTML to Markdown | 10/day free, then $0.001/call |

Treat this table as a cache; `/check` is authoritative.

## 3. Paying (x402)

A `402` **or** a `429` means the same thing: this caller's 10 free conversions
for the UTC day are gone.

- **`429`** — payment is not switched on yet, so there is nowhere to pay. The
  body is `{"error": "free tier is 10 conversions per day per caller",
  "free_tier_daily": 10, "paid_tier": "...", "retry": "tomorrow UTC"}` and a
  `Retry-After` header gives the seconds to midnight UTC. Do not retry in a
  loop, and do not retry with a different user-agent — the counter is keyed on
  the IP. Wait, or use the local tool from `/check`.
- **`402`** — payment is live. The body is an x402 v1 envelope:

  ```json
  {"x402Version": 1, "error": "X-PAYMENT header is required",
   "accepts": [{"scheme": "exact", "network": "base", "maxAmountRequired": "1000",
                "payTo": "0x...", "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"}]}
  ```

Then:

- `asset` is USDC on Base. `maxAmountRequired` is atomic units — 6 decimals, so
  `"1000"` is $0.001.
- Paying needs two things: an x402-capable HTTP client (`x402-fetch`, the x402
  SDK, or Coinbase AgentKit) and a wallet key holding USDC on Base. The client
  reads the envelope, signs, and retries with an `X-PAYMENT` header. No login,
  no card, no account — the payment is the auth.
- Never ask the user to paste a private key or a seed phrase. If you have no
  x402 client wired up, say so and offer the local tool from `/check` instead.
- **Payments are verified and settled.** A payment presented against the
  envelope is checked with the Coinbase CDP facilitator *before* the conversion
  is served. Read the response headers and report accordingly:

  | header | what happened | report it as |
  | --- | --- | --- |
  | `x-payment-verified: true` | verified, and settling on Base | **paid** |
  | `x-payment-verified: false` + `x-payment-error` | the facilitator could not be reached; served anyway | **served, not charged** |
  | `x-free-tier-remaining: <n>` | a free call | **free** — never report it as paid |

  A `402` carrying an `invalidReason` means a payment you sent was **rejected**;
  retrying the same payload will fail identically. Sign a fresh one against the
  terms in the envelope, and retry once — not in a loop.

- **Inside the free tier, `X-PAYMENT` is ignored.** The free allowance is spent
  first and the facilitator is never called, so a free-tier call carrying a
  payment header is still free and still uncharged. Do not report it as paid.

## 4. The whole catalog

For picking a tool when `/check` finds nothing, fetch the catalog:

```bash
curl https://toolshed.lemon-agent.dev/llms-full.txt
```

Full entries — verdict, caveats, when a model is actually warranted, and the
local install line. `llms.txt` is the one-line-per-pair version; `catalog.json`
is the same data structured.

## Limits

- **10 conversions per caller per UTC day, free.** Over that, `402` (pay) or
  `429` (payment not switched on yet). The caller key is the IP address.
- The edge blocks bursts at 5 requests / 10 seconds per IP — pace calls rather
  than firing them in a tight loop.
- `413` over 256 KB, `400` on malformed input, `503` when the service is down —
  do not retry a `503` in a loop.
