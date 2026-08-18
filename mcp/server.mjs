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

// Wording only — mirrors FREE_TIER_DAILY in build.mjs so the tool descriptions can
// state the tier before any HTTP call has happened. The service enforces its own
// number and publishes it per tool in /check as `hosted.free_tier_daily`, which is
// authoritative; this constant never gates anything.
const FREE_TIER_DAILY = 10;

// How few free calls have to be left before a successful conversion carries a
// warning. Below this the note is worth the noise; above it, the caller gets
// clean output, because the converted file is the product.
const LOW_TIER_WARN = 3;

const TOOLS = [
  {
    name: 'toolshed_check',
    description:
      'List the conversions Toolshed can run. `from` is matched against what you have, ' +
      '`to` against what you need — case-insensitive substrings, each bound to its own ' +
      'side. Omit both to get every hosted tool. Call this before toolshed_convert rather ' +
      `than guessing a tool_id. Every hosted tool is free to try — ${FREE_TIER_DAILY} conversions ` +
      'per caller per UTC day — and priced per call past that; each match carries its own ' +
      '`hosted.price` and `hosted.free_tier_daily`.',
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
      `text comes back. Input is capped at 256 KB. The first ${FREE_TIER_DAILY} conversions ` +
      'a day are free, counted per caller (per IP, so rotating the user-agent does not ' +
      'reset it); a 402 or a 429 means the day\'s free calls are spent — 402 when payment ' +
      'is live and asks you to pay, 429 while it is not. Both come back explained, not raw.',
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

  if (res.status === 402) return fail(explainPayment(id, body, res));
  if (res.status === 429) return fail(explainQuota(id, body, res));
  if (!res.ok) return fail(`POST /convert/${id} answered ${res.status}: ${body.trim()}`);

  // The converted file is the product, so it comes back clean. Two things are
  // worth interrupting it for: the free tier running out, and a call that was
  // served without its payment being verified.
  const left = Number(res.headers.get('x-free-tier-remaining'));
  if (Number.isFinite(left) && left < LOW_TIER_WARN) {
    return text(
      `${body}\n\n[toolshed: free tier — ${left} of ${FREE_TIER_DAILY} conversions left today for this caller. ` +
        'At zero, calls answer 402 (pay per call in USDC via x402) or 429 while payment is switched off.]'
    );
  }
  if (res.headers.get('x-pricing') === 'pending') {
    return text(
      `${body}\n\n[toolshed: x-pricing: pending — served without settlement being verified ` +
        `(x-payment-verified: ${res.headers.get('x-payment-verified') || 'false'}). You have not paid for this call.]`
    );
  }
  return text(body);
}

// A 429 is the free tier, spent — an answer with a shape, not a failure to relay
// verbatim. Quote what the service actually said, then say what to do about it.
function explainQuota(id, body, res) {
  let seen;
  try {
    seen = JSON.parse(body);
  } catch {
    seen = null;
  }

  const retryAfter = Number(res.headers.get('retry-after'));
  const lines = [`POST /convert/${id} answered HTTP 429 — this caller's free calls for today are spent.`];
  if (seen) {
    lines.push(
      '',
      `  reason      ${seen.error || 'daily limit reached'}`,
      `  free tier   ${seen.free_tier_daily ?? FREE_TIER_DAILY} conversions per caller per UTC day`,
      `  paid tier   ${seen.paid_tier || 'per-call USDC via x402'}`,
      `  retry       ${seen.retry || 'tomorrow UTC'}${Number.isFinite(retryAfter) ? ` (${formatDuration(retryAfter)})` : ''}`
    );
  } else {
    lines.push('', 'The 429 body could not be parsed:', body.trim());
  }
  lines.push(
    '',
    'The counter is keyed on the IP address, so retrying with a different user-agent',
    'changes nothing, and neither does retrying in a loop. Either wait for the reset at',
    'midnight UTC, or run toolshed_check and use the local tool it names for this pair.'
  );
  return lines.join('\n');
}

function formatDuration(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  return h ? `in about ${h}h ${m}m` : `in about ${m}m`;
}

// A 402 is the payment envelope, not an error to swallow. Quote the terms the
// envelope actually names, then say plainly what the caller has to do — and that
// settlement is not switched on yet.
function explainPayment(id, body, res) {
  let envelope;
  try {
    envelope = JSON.parse(body);
  } catch {
    envelope = null;
  }
  const offer = (envelope && Array.isArray(envelope.accepts) && envelope.accepts[0]) || null;

  const lines = [
    `POST /convert/${id} answered HTTP 402 — this caller's ${FREE_TIER_DAILY} free calls for today are`,
    'spent, and the tool is priced past them.',
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
  lines.push(
    '',
    'To pay, retry the request through an x402-capable HTTP client (x402-fetch, the',
    'x402 SDK, or Coinbase AgentKit) holding a wallet key with USDC on Base. The client',
    'reads this envelope, signs the payment and retries with an X-PAYMENT header. There',
    'is no login and no account — the payment is the auth. Never ask a person to paste a',
    'private key or seed phrase.',
    '',
    'Status: settlement is not verified yet. A 402 here means a receiving address IS',
    'configured, but the service checks no payment — it never treats an X-PAYMENT header',
    'as paid, and says so with x-payment-verified: false. If you have no x402 client, wait',
    'for the free tier to reset at midnight UTC, or run toolshed_check and use the local',
    'tool it names instead.'
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
