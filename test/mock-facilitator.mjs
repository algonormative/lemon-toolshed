// A programmable stand-in for https://api.cdp.coinbase.com/platform/v2/x402.
//
// EXTRACTED from x402-settlement.test.mjs on 2026-08-31, unchanged in behaviour,
// so that x402-solana.test.mjs can drive the same upstream. Two suites asserting
// against two hand-written mocks would be two different definitions of what the
// facilitator does, and the strictness below is the whole reason these tests
// mean anything — duplicating it is how it rots in one copy.
//
// Three endpoints, and they are metered very differently by the Worker:
//
//   POST /verify     is this signed payment good?
//   POST /settle     put the transfer on chain
//   GET  /supported  which kinds does this account support, and — for Solana —
//                    which account pays the transaction fee. Added with the
//                    second rail: the Worker reads `extra.feePayer` out of it
//                    for every Solana accepts entry it publishes, and the two
//                    protocol versions carry DIFFERENT feePayers here on
//                    purpose, because they do upstream (CDP draws them from a
//                    pool) and a per-version cache that mixed them up would
//                    otherwise pass.
//
// THE MOCK IS STRICT ABOUT VERSION SHAPE. v1 and v2 send the same three-field
// body to the same endpoint and differ entirely in the shapes inside it, so a
// Worker that shipped a v1 envelope alongside a v2 payload — or the reverse —
// would look completely healthy against a mock that only echoes canned answers,
// and would verify as invalid against the real facilitator, which recovers the
// signature from what it is handed. So every hit is shape-checked against its
// own declared version and a mismatch answers 400, which surfaces as an
// unverified serve and fails whatever test made the call. Drift is meant to be
// loud. (GET /supported carries no payment and is not shape-checked.)

import http from 'node:http';

// A payer address and a settlement hash the mock hands back, so the ledger
// assertions can prove the values came from the FACILITATOR rather than from
// the payload the caller sent.
export const VERIFIED_PAYER = '0x00000000000000000000000000000000000Fa11e5';
export const TX_HASH = '0xfeedfacefeedfacefeedfacefeedfacefeedfacefeedfacefeedfacefeedface';

// The two Solana feePayers /supported hands out, and they are DELIBERATELY
// DIFFERENT from each other: these are the two addresses one owner-run pair of
// consecutive reads actually returned for the same version+network row on
// 2026-08-31 (scripts/solana-payto-setup.mjs). A Worker that fetched once and
// reused the answer for both protocol versions would publish a v2 entry naming
// the v1 fee payer, which is a payment nobody pays the fee for — and it would be
// invisible against a fixture that used one address twice.
export const FEE_PAYER_V1 = 'Hc3sdEAsCGQcpgfivywog9uwtk8gUBUZgsxdME1EJy88';
export const FEE_PAYER_V2 = 'BFK9TLC3edb13K6v4YyH3DwPb5DSUpkWvb7XnqCL9b4F';

// A settled Solana transaction is a base58 SIGNATURE, not a 0x hash. Used by the
// Solana suite so an assertion about the explorer link or the ledger cannot pass
// against a Base-shaped value.
export const SOLANA_SIGNATURE = '5UfDuX1v2mUUEPvGXQU8QU8m5N2xxVBiwmSSTSKEDBmT7ZgPLjKmxjRTkBhmDGtoUwrCzKrmwVSzMSFvMiSbaHmz';

const SOLANA_NETWORK_V1 = 'solana';
const SOLANA_NETWORK_V2 = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';

/** The default GET /supported document — Base and Solana, both versions. */
export const supportedFixture = () => ({
  kinds: [
    { x402Version: 1, scheme: 'exact', network: 'base' },
    { x402Version: 2, scheme: 'exact', network: 'eip155:8453' },
    { x402Version: 1, scheme: 'exact', network: SOLANA_NETWORK_V1, extra: { feePayer: FEE_PAYER_V1 } },
    { x402Version: 2, scheme: 'exact', network: SOLANA_NETWORK_V2, extra: { feePayer: FEE_PAYER_V2 } },
    // A row the Worker must NOT take: right network, wrong scheme. CDP really
    // does advertise `upto` alongside `exact` on Solana v2.
    { x402Version: 2, scheme: 'upto', network: SOLANA_NETWORK_V2, extra: { feePayer: 'NOTtheFeePayerForExact11111111111111111111' } },
  ],
});

/**
 * Is this facilitator call self-consistent? Returns a sentence, or null.
 *
 * The two versions are checked against each other rather than each on its own:
 * it is not enough that a v1 body has `maxAmountRequired`, it must ALSO not
 * have `amount`, because the failure this guards against is a half-migrated
 * envelope carrying both and being accepted by a lenient reader. Every field
 * named below is one the real facilitator reads.
 */
export function shapeProblem(body) {
  if (!body || typeof body !== 'object') return 'the body is not a JSON object';
  const { x402Version: version, paymentPayload: payload, paymentRequirements: req } = body;

  if (version !== 1 && version !== 2) return `x402Version ${JSON.stringify(version)} is neither 1 nor 2`;
  if (!payload || typeof payload !== 'object') return 'no paymentPayload';
  if (!req || typeof req !== 'object') return 'no paymentRequirements';
  if (payload.x402Version !== version) {
    return `paymentPayload.x402Version ${payload.x402Version} disagrees with the body's ${version}`;
  }

  const missing = (obj, fields, what) => {
    for (const f of fields) if (obj[f] === undefined) return `${what} is missing ${f}`;
    return null;
  };
  const foreign = (obj, fields, what, other) => {
    for (const f of fields) if (obj[f] !== undefined) return `${what} carries the v${other} field ${f}`;
    return null;
  };

  if (version === 1) {
    return (
      missing(req, ['scheme', 'network', 'maxAmountRequired', 'resource', 'description', 'payTo', 'asset'], 'v1 paymentRequirements') ||
      foreign(req, ['amount'], 'v1 paymentRequirements', 2) ||
      (typeof req.resource !== 'string' ? 'v1 paymentRequirements.resource must be the URL string' : null) ||
      (req.network.includes(':') ? `v1 network must be a plain name, got the CAIP-2 ${req.network}` : null) ||
      missing(payload, ['scheme', 'network', 'payload'], 'v1 paymentPayload') ||
      foreign(payload, ['accepted'], 'v1 paymentPayload', 2) ||
      // ADDED WITH THE SECOND RAIL, and it is the assertion the whole dual-rail
      // change turns on: the requirements must be for the chain the payload
      // says it paid on. A Solana payload checked against the Base entry is a
      // perfectly good payment the facilitator cannot recover.
      (payload.network !== req.network
        ? `v1 paymentPayload names network ${payload.network} but paymentRequirements names ${req.network}`
        : null)
    );
  }

  return (
    missing(req, ['scheme', 'network', 'amount', 'asset', 'payTo', 'maxTimeoutSeconds'], 'v2 paymentRequirements') ||
    foreign(req, ['maxAmountRequired', 'resource', 'description', 'mimeType', 'outputSchema'], 'v2 paymentRequirements', 1) ||
    (!/^[a-z0-9-]+:[a-zA-Z0-9-]+$/.test(req.network) ? `v2 network must be CAIP-2, got ${req.network}` : null) ||
    missing(payload, ['accepted', 'payload'], 'v2 paymentPayload') ||
    foreign(payload, ['scheme', 'network'], 'v2 paymentPayload', 1) ||
    // The signature was made over `accepted`, so a requirements object that
    // does not match it is a payment the facilitator cannot recover. Compared
    // key-order-independently, the way x402's own server does it — a client
    // that re-serialises our entry has not changed the offer. (This subsumes
    // the network check the v1 branch has to make explicitly.)
    (canonical(payload.accepted) !== canonical(req)
      ? 'v2 paymentRequirements is not the accepts entry the payload signed against'
      : null)
  );
}

/** JSON with object keys sorted, so a comparison is about values not order. */
export const canonical = (value) =>
  JSON.stringify(value, (_key, v) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)))
      : v
  );

/** Boot one on an ephemeral port. Call `stop()` in the suite's after(). */
export async function startMockFacilitator() {
  const state = {
    hits: [],
    // Defaults: everything works. Individual tests overwrite these.
    verify: { status: 200, body: { isValid: true, payer: VERIFIED_PAYER } },
    settle: {
      status: 200,
      body: { success: true, transaction: TX_HASH, network: 'base', payer: VERIFIED_PAYER },
    },
    supported: { status: 200, body: supportedFixture() },
    delayMs: { verify: 0, settle: 0, supported: 0 },
    // Enforcement, on by default. One test turns it off to prove the check
    // itself has teeth — a strictness that nothing ever trips is indistinguishable
    // from no strictness at all.
    strict: true,
  };

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', async () => {
      const endpoint = new URL(req.url, 'http://mock').pathname.split('/').pop();
      let body = null;
      try {
        body = JSON.parse(raw);
      } catch {
        /* recorded as null — a malformed body is itself a finding */
      }

      // /supported is a GET with no payment in it, so the version-shape check
      // does not apply and must not be run: it would call every read malformed.
      if (endpoint === 'supported') {
        state.hits.push({
          endpoint,
          method: req.method,
          url: req.url,
          authorization: req.headers.authorization || null,
          contentType: req.headers['content-type'] || null,
          version: null,
          problem: null,
          body: null,
        });
        const delay = state.delayMs.supported || 0;
        if (delay) await new Promise((r) => setTimeout(r, delay));
        const canned = state.supported;
        res.writeHead(canned.status, { 'content-type': 'application/json' });
        return res.end(typeof canned.body === 'string' ? canned.body : JSON.stringify(canned.body));
      }

      // The version-shape verdict is recorded on the hit whether or not it is
      // enforced, so a test can assert on it directly as well as through the
      // 400 below.
      const problem = shapeProblem(body);
      state.hits.push({
        endpoint,
        method: req.method,
        url: req.url,
        authorization: req.headers.authorization || null,
        contentType: req.headers['content-type'] || null,
        version: body?.x402Version ?? null,
        problem,
        body,
      });

      const delay = state.delayMs[endpoint] || 0;
      if (delay) await new Promise((r) => setTimeout(r, delay));

      const canned = state[endpoint];
      if (!canned) {
        res.writeHead(404, { 'content-type': 'application/json' });
        return res.end('{"error":"no such endpoint"}');
      }

      // A malformed call answers 400 rather than the canned success, which is
      // what the real facilitator would do and what makes drift fail loudly
      // instead of passing green against a mock that never looks.
      if (problem && state.strict) {
        res.writeHead(400, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: 'x402_shape', detail: problem }));
      }
      res.writeHead(canned.status, { 'content-type': 'application/json' });
      res.end(typeof canned.body === 'string' ? canned.body : JSON.stringify(canned.body));
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  return {
    state,
    url: `http://127.0.0.1:${port}/platform/v2/x402`,
    get hits() {
      return state.hits;
    },
    hitsOn: (endpoint) => state.hits.filter((h) => h.endpoint === endpoint),
    /** Every shape complaint this mock has recorded, as one readable string. */
    problems: () =>
      state.hits
        .filter((h) => h.problem)
        .map((h) => `${h.endpoint} (v${h.version}): ${h.problem}`)
        .join('; '),
    reset: () => {
      state.hits.length = 0;
      state.verify = { status: 200, body: { isValid: true, payer: VERIFIED_PAYER } };
      state.settle = {
        status: 200,
        body: { success: true, transaction: TX_HASH, network: 'base', payer: VERIFIED_PAYER },
      };
      state.supported = { status: 200, body: supportedFixture() };
      state.delayMs = { verify: 0, settle: 0, supported: 0 };
      state.strict = true;
    },
    stop: () => new Promise((resolve) => server.close(resolve)),
  };
}
