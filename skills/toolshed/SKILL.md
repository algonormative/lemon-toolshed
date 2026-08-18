---
name: toolshed
description: Convert files/data between formats using Lemon Toolshed's hosted conversion endpoints; check pair availability first.
---

# Toolshed

Server-hosted conversion endpoints. No account, no key. Some are free; priced
ones take payment per call with x402.

Base URL: `https://toolshed.lemon-agent.dev`

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

- `hosted` — `{path, price, status}`, or `null` when we do not host it.
  `price` is `"free"` or `{amount_usd, scheme}`. Only call `status: "live"`.
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
  names the problem.

Live endpoints:

| id | converts | price |
| --- | --- | --- |
| `md-html` | Markdown to HTML | free |
| `json-yaml` | JSON to YAML | free |
| `yaml-json` | YAML to JSON | free |
| `csv-json` | CSV to JSON (array of objects from the header row) | free |
| `html-markdown` | HTML to Markdown | $0.001/call |

Treat this table as a cache; `/check` is authoritative.

## 3. Paying (x402)

A `402` answer means the tool is priced. The body is an x402 v1 envelope:

```json
{"x402Version": 1, "error": "X-PAYMENT header is required",
 "accepts": [{"scheme": "exact", "network": "base", "maxAmountRequired": "1000",
              "payTo": "0x...", "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"}]}
```

- `asset` is USDC on Base. `maxAmountRequired` is atomic units — 6 decimals, so
  `"1000"` is $0.001.
- Retry with an `X-PAYMENT` header built by your x402 client.
- Never ask the user to paste a private key or a seed phrase. If you have no
  x402 client wired up, say so and offer the local tool from `/check` instead.
- A `x-pricing: pending` response header means the endpoint is priced on paper
  but is being served free right now. Do not pay it.

## 4. The whole catalog

For picking a tool when `/check` finds nothing, fetch the catalog:

```bash
curl https://toolshed.lemon-agent.dev/llms-full.txt
```

Full entries — verdict, caveats, when a model is actually warranted, and the
local install line. `llms.txt` is the one-line-per-pair version; `catalog.json`
is the same data structured.

## Limits

- 100 calls per day per caller. Over that, `429`.
- `503` means the service is down; do not retry in a loop.
