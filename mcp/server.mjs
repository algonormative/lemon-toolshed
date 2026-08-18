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

const TOOLS = [
  {
    name: 'toolshed_check',
    description:
      'List the conversions Toolshed can run. `from` is matched against what you have, ' +
      '`to` against what you need — case-insensitive substrings, each bound to its own ' +
      'side. Omit both to get every hosted tool. Call this before toolshed_convert rather ' +
      'than guessing a tool_id.',
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
      'text comes back. Input is capped at 256 KB.',
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
  if (!res.ok) return fail(`POST /convert/${id} answered ${res.status}: ${body.trim()}`);

  // A priced tool that is not yet charging says so in a header. Pass that on
  // rather than letting the caller believe it paid for something.
  const pending = res.headers.get('x-pricing') === 'pending';
  return text(pending ? `${body}\n\n[toolshed: x-pricing: pending — this tool is priced on paper but was served free.]` : body);
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

  const lines = [`POST /convert/${id} answered HTTP 402 — this tool is priced.`];
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
    'Status: pricing is not enforced yet. Priced tools normally answer free with an',
    '`x-pricing: pending` header; a 402 here means a receiving address is configured, but',
    'settlement is still unverified. If you have no x402 client, run toolshed_check and',
    'use the local tool it names instead.'
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
