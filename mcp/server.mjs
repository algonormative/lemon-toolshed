#!/usr/bin/env node
// Toolshed MCP server — a thin stdio wrapper over the public HTTP API.
//
// It holds no state, no key and no wallet: every tool is one fetch against
// {BASE}, and the reply is handed back as text. The HTTP surface stays the
// source of truth, so this file never needs to know the catalog.
//
//   toolshed_check   {from?, to?}        GET  {BASE}/check
//   toolshed_convert {tool_id, input}    POST {BASE}/convert/{tool_id}
//   toolshed_catalog {}                  GET  {BASE}/llms.txt
//
// BASE comes from TOOLSHED_URL, defaulting to production.
//
// Run it:
//   npx -y github:chronick/lemon-toolshed
//   node mcp/server.mjs
//
// Dependencies: @modelcontextprotocol/sdk, and Node 18+ for global fetch.
// Nothing else — deliberately. The low-level Server API is used rather than
// McpServer so the tool schemas are plain JSON Schema and zod is not imported.

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const BASE = (process.env.TOOLSHED_URL || 'https://toolshed.lemon-agent.dev').replace(/\/+$/, '');

const NAME = 'lemon-toolshed';
const VERSION = '0.1.0';

// USDC on Base is 6 decimals, so the atomic amount in an x402 envelope has to be
// divided down before it is shown to anyone as a price.
const USDC_DECIMALS = 6;

// How many calls have to be left on a deployment-enabled free tier before a
// successful conversion carries a warning. At or below this the note is worth the
// noise; above it, the caller gets clean output, because the converted file is
// the product.
//
// A flat number rather than a fraction of the tier: the tier width is a per
// deployment setting this file has no way to know, and the hosted service has no
// tier at all — so nothing here may state one. The only number that gets printed
// is the one the response itself reported.
const LOW_TIER_WARN = 1;

const TOOLS = [
  {
    name: 'toolshed_check',
    description:
      'List the conversions Toolshed can run. `from` is matched against what you have, ' +
      '`to` against what you need — case-insensitive substrings, each bound to its own ' +
      'side, and extensions and MIME types hit too ("md", ".md", "text/markdown", "yml", ' +
      '"text/html"). Omit both to get every hosted tool. Call this before toolshed_convert ' +
      'rather than guessing a tool_id. Each match carries its own `hosted.price` — every ' +
      'hosted tool is $0.001 a call — and `hosted.free_tier_daily`, which is 0 unless that ' +
      'deployment has enabled a free tier.',
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'the format you have, e.g. "markdown"' },
        to: { type: 'string', description: 'the format you need, e.g. "html"' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'toolshed_convert',
    description:
      'Run a hosted conversion. `tool_id` is an id from toolshed_check (for example ' +
      '"md-html"); `input` is the file content, sent as the request body. The converted ' +
      'text comes back. Input is capped at 256 KB. The first call answers HTTP 402 with an ' +
      'x402 envelope — payment is the front door, $0.001 in USDC on Base per call. A 402 is ' +
      'not an error: it is the price. You are only charged for conversions that are actually ' +
      'served — a 400 on malformed input costs nothing. A 429 means either that deployment ' +
      'has no receiving address to take payment, or this caller hit the daily conversion ' +
      'ceiling. Both 402 and 429 come back explained, not raw.',
    inputSchema: {
      type: 'object',
      properties: {
        tool_id: { type: 'string', description: 'hosted tool id, e.g. "md-html"' },
        input: { type: 'string', description: 'the content to convert' },
      },
      required: ['tool_id', 'input'],
      additionalProperties: false,
    },
  },
  {
    name: 'toolshed_catalog',
    description:
      'Fetch the whole Toolshed catalog as text (llms.txt) — one line per pair, hosted ' +
      'and local-only alike. Use it when toolshed_check finds nothing and you need the ' +
      'name of a tool to run locally instead.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
];

const text = (s) => ({ content: [{ type: 'text', text: s }] });
const fail = (s) => ({ content: [{ type: 'text', text: s }], isError: true });

// A fetch failure is a normal outcome for a network tool, not a crash: it comes
// back as an error result the caller can read and act on.
async function request(url, init) {
  try {
    return await fetch(url, init);
  } catch (err) {
    throw new Error(`could not reach ${BASE}: ${String((err && err.message) || err)}`);
  }
}

async function check(args) {
  const params = new URLSearchParams();
  if (args.from) params.set('from', String(args.from));
  if (args.to) params.set('to', String(args.to));
  const qs = params.toString();
  const res = await request(`${BASE}/check${qs ? `?${qs}` : ''}`);
  const body = await res.text();
  if (!res.ok) return fail(`GET /check answered ${res.status}: ${body.trim()}`);
  return text(body.trim());
}

async function catalog() {
  const res = await request(`${BASE}/llms.txt`);
  const body = await res.text();
  if (!res.ok) return fail(`GET /llms.txt answered ${res.status}: ${body.trim()}`);
  return text(body.trim());
}

async function convert(args) {
  const id = String(args.tool_id || '').trim();
  if (!id) return fail('tool_id is required — run toolshed_check to see the ids.');
  if (typeof args.input !== 'string' || !args.input.length) {
    return fail('input is required, as a string.');
  }

  const res = await request(`${BASE}/convert/${encodeURIComponent(id)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    body: args.input,
  });
  const body = await res.text();

  // A 402 is NOT an error result. On this service the 402 is the front door —
  // every unpaid call meets it first — and an agent whose very first contact
  // with the shed reads `isError: true` learns "broken tool", not "priced
  // tool". The text is a price quote; it comes back as an ordinary result.
  if (res.status === 402) return text(explainPayment(id, body, res));
  if (res.status === 429) return fail(explainQuota(id, body, res));
  if (!res.ok) return fail(`POST /convert/${id} answered ${res.status}: ${body.trim()}`);

  // The converted file is the product, so it comes back clean. Two things are
  // worth interrupting it for: a deployment-enabled free tier running out, and a
  // call that was served without its payment being verified.
  //
  // The header is absent on the hosted service, which has no free tier — and
  // absent is not zero, so presence is checked before the number is read.
  const remaining = res.headers.get('x-free-tier-remaining');
  if (remaining !== null) {
    const left = Number(remaining);
    if (Number.isFinite(left) && left <= LOW_TIER_WARN) {
      return text(
        `${body}\n\n[toolshed: free tier — ${left} conversions left today for this caller. ` +
          'At zero, calls answer 402 and payment is live: $0.001 in USDC on Base via x402.]'
      );
    }
  }
  if (res.headers.get('x-pricing') === 'pending') {
    // Served, but nothing was checked — the facilitator could not be reached (or
    // is not configured on the service). Worth interrupting the product for,
    // because the caller may believe it just paid and it did not.
    const why = res.headers.get('x-payment-error') || 'unknown';
    return text(
      `${body}\n\n[toolshed: x-pricing: pending — this call was served WITHOUT its payment being ` +
        `verified (x-payment-error: ${why}). The payment service could not be reached, so no ` +
        'money moved and you have not been charged. Nothing is owed; retry later if you want ' +
        'the call to actually settle.]'
    );
  }
  if (res.headers.get('x-payment-verified') === 'true') {
    return text(`${body}\n\n[toolshed: payment verified and settling — you were charged for this call.]`);
  }
  return text(body);
}

// A 429 is not a spent allowance. It is one of two things: a deployment with no
// receiving address configured, so there is nowhere to pay at all, or the
// per-caller daily ceiling that bounds a runaway loop. They want opposite advice,
// so quote what the service actually said, then say which one it is.
function explainQuota(id, body, res) {
  let seen;
  try {
    seen = JSON.parse(body);
  } catch {
    seen = null;
  }

  const retryAfter = Number(res.headers.get('retry-after'));
  const reason = (seen && seen.error) || '';
  // The two cases are told apart by the body text: the misconfiguration names the
  // missing address, the ceiling names the ceiling. A Retry-After is only sent for
  // the ceiling, but it is a hint, not the discriminator.
  const misconfigured = /receiving address/i.test(reason);
  const tier = seen ? Number(seen.free_tier_daily) : NaN;

  const lines = [
    `POST /convert/${id} answered HTTP 429 — ${
      misconfigured
        ? 'this deployment has no receiving address configured.'
        : 'this caller reached the daily conversion ceiling.'
    }`,
  ];
  if (seen) {
    lines.push('', `  reason      ${reason || 'daily limit reached'}`);
    // Only reported when a deployment actually set one. The hosted service
    // publishes 0, and printing that as a "tier" would describe a pricing model
    // this service does not have.
    if (Number.isFinite(tier) && tier > 0) {
      lines.push(`  free tier   ${tier} conversions per caller per UTC day`);
    }
    if (seen.paid_tier) lines.push(`  paid tier   ${seen.paid_tier}`);
    lines.push(
      `  retry       ${seen.retry || 'tomorrow UTC'}${Number.isFinite(retryAfter) ? ` (${formatDuration(retryAfter)})` : ''}`
    );
  } else {
    lines.push('', 'The 429 body could not be parsed:', body.trim());
  }

  lines.push('');
  if (misconfigured) {
    lines.push(
      'There is nowhere to send payment on this deployment, so this is a misconfiguration',
      'and not a quota: retrying changes nothing, now or tomorrow, and no Retry-After is',
      'sent because waiting cannot help. Run toolshed_check and use the local tool it names',
      'for this pair.'
    );
  } else {
    const when = Number.isFinite(retryAfter) ? formatDuration(retryAfter) : 'at midnight UTC';
    lines.push(
      'This is a runaway bound on one caller, not an allowance you spent converting for',
      'nothing. It is keyed on the IP address, so retrying with a different user-agent',
      `changes nothing, and neither does retrying in a loop. Wait for the reset ${when}, or`,
      'run toolshed_check and use the local tool it names for this pair.'
    );
  }
  return lines.join('\n');
}

function formatDuration(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  return h ? `in about ${h}h ${m}m` : `in about ${m}m`;
}

// A 402 is the front door, not an error to swallow: an unpaid call is answered
// with the terms to pay against. Quote the terms the envelope actually names,
// then say plainly what the caller has to do — and, if the service rejected a
// payment it was given, exactly why.
function explainPayment(id, body, res) {
  let envelope;
  try {
    envelope = JSON.parse(body);
  } catch {
    envelope = null;
  }
  const offer = (envelope && Array.isArray(envelope.accepts) && envelope.accepts[0]) || null;

  const lines = [
    `POST /convert/${id} answered HTTP 402 — the ordinary answer to a call that carried no`,
    'payment. Every conversion is priced; this is the price, quoted in a form a client can pay.',
  ];
  if (offer) {
    lines.push(
      '',
      'The x402 envelope asks for:',
      `  price   ${formatAmount(offer.maxAmountRequired)} (${offer.maxAmountRequired} atomic units)`,
      `  asset   USDC on ${offer.network || 'base'} — ${offer.asset || 'unknown asset'}`,
      `  payTo   ${offer.payTo || 'unknown address'}`,
      `  scheme  ${offer.scheme || 'exact'}`,
      `  for     ${offer.resource || `${BASE}/convert/${id}`}`
    );
  } else {
    lines.push('', 'The 402 body could not be parsed as an x402 envelope:', body.trim());
  }
  // A 402 that names an invalidReason is a REJECTED payment, not a first ask:
  // the caller sent something and the facilitator refused it. Retrying the same
  // payload will fail the same way, so say what to fix instead.
  if (envelope && envelope.invalidReason) {
    lines.push(
      '',
      `The payment you presented was REJECTED: ${envelope.invalidReason}`,
      ...(envelope.invalidMessage ? [`  ${envelope.invalidMessage}`] : []),
      '',
      'Retrying the same payment payload will be rejected again. Common causes:',
      '  insufficient_funds                     the paying wallet has too little USDC on Base',
      '  invalid_exact_evm_payload_signature    the signature does not match the terms above',
      '  malformed_payment_header               X-PAYMENT was not base64-encoded JSON',
      'Sign a fresh payment against the terms above and retry once.'
    );
  }

  lines.push(
    '',
    'To pay, retry the request through an x402-capable HTTP client (x402-fetch, the',
    'x402 SDK, or Coinbase AgentKit) holding a wallet key with USDC on Base. The client',
    'reads this envelope, signs the payment and retries with an X-PAYMENT header. There',
    'is no login and no account — the payment is the auth. Never ask a person to paste a',
    'private key or seed phrase.',
    '',
    'Status: payments ARE verified and settled — a payment presented against this envelope',
    'is checked with the Coinbase CDP facilitator before the conversion is served, and a',
    'verified call comes back with x-payment-verified: true. If the facilitator cannot be',
    'reached the call is served anyway, unverified and uncharged, and says so with',
    'x-payment-error. You are only charged for conversions that are actually served: a 400',
    'on malformed input settles nothing, even when the payment verified. If you have no x402',
    'client, run toolshed_check and use the local tool it names instead.'
  );
  if (res.headers.get('x-pricing')) lines.push('', `Response header x-pricing: ${res.headers.get('x-pricing')}`);
  return lines.join('\n');
}

function formatAmount(atomic) {
  const n = Number(atomic);
  if (!Number.isFinite(n)) return 'an unreadable amount';
  return `$${(n / 10 ** USDC_DECIMALS).toFixed(USDC_DECIMALS).replace(/0+$/, '').replace(/\.$/, '')} USDC`;
}

const HANDLERS = {
  toolshed_check: check,
  toolshed_convert: convert,
  toolshed_catalog: catalog,
};

const server = new Server({ name: NAME, version: VERSION }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const handler = HANDLERS[req.params.name];
  if (!handler) return fail(`unknown tool "${req.params.name}"`);
  try {
    return await handler(req.params.arguments || {});
  } catch (err) {
    return fail(String((err && err.message) || err));
  }
});

await server.connect(new StdioServerTransport());
