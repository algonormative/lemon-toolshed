// The one Pages Function: hand the request to the static asset layer and
// return what comes back, unchanged.
//
// WHY A FUNCTION AT ALL, on a project the runbook calls static-only. Measured
// 2026-09-03: the Pages ASSET layer runs its own Browser Integrity Check and
// 403s (`error code: 1010`) any request whose User-Agent is a Python stdlib
// default (`Python-urllib/3.14`, `python-requests/2.32`). Zone BIC off and a
// zone WAF Skip rule were both verified ineffective. Paths handled by CODE are
// unaffected — /convert/* answers 402 to the same agent — so a Python buyer
// could pay us but not read /llms.txt or /openapi.json to learn how.
//
// dist/_routes.json (emitted by build.mjs) bounds the invocation budget: only
// the machine surfaces and /.well-known/* invoke this. Nothing is rewritten
// here on purpose — bytes, status and headers are the asset's own, so the
// served surface stays identical to dist/ (test/surfaces.test.mjs asserts it).
export async function onRequest(context) {
  return context.env.ASSETS.fetch(context.request);
}
