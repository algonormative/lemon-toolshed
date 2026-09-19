// The schema self-check on GET /check.
//
// WHY IT EXISTS, measured: on 2026-09-07 the single-use payment claim shipped
// and `worker/schema.sql` was never applied to the production D1. Every real
// payment reached claimPaymentOnce(), the INSERT threw into handleConvert's
// catch, and the route took its fail-closed exit — 503 "conversion is
// unavailable" — for eleven days, while unpayable junk headers kept being served
// free. Nothing the deployment said out loud named the cause, because the
// migration is a separate command from the deploy and there was no way to ask.
//
// So the Worker now answers the question on the one route an operator already
// curls after a deploy. This file pins both halves of that answer: an empty
// `missing` list on a database that has everything, and the name of the table on
// one that does not.
//
// PHASE: standalone — it boots its own worker, because it DROPs a table out from
// under the running Worker and puts it back. Doing that on a shared phase worker
// would make whichever suite ran next fail for reasons that have nothing to do
// with it. No dev vars are needed: /check reports the schema whatever the
// payment configuration is.

import test, { before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { bootWorker, client } from './harness.mjs';

let worker;
let api;

/** Every table the Worker's own SQL touches — WORKER_TABLES in worker/beacon.js. */
const WORKER_TABLES = ['convert_quota', 'counters', 'events', 'payment_seen', 'salt', 'settlements'];

// The two tables worker/schema.sql defines and this Worker never touches. They
// are operator surfaces (README § Operator queries), so their absence cannot
// take the service down and must NOT be reported as missing — a self-check that
// cries wolf is one an operator stops reading.
const OPERATOR_ONLY_TABLES = ['blocklist', 'daily_aggregates'];

const schemaOf = async () => (await (await api.get('/check')).json()).schema;

before(async () => {
  worker = await bootWorker();
  api = client(worker);
});

after(async () => {
  await worker?.stop();
});

describe('a database with the whole schema reports nothing missing', () => {
  test('/check carries a schema block with an empty missing list', async () => {
    const schema = await schemaOf();
    assert.ok(schema, '/check published no schema block at all');
    assert.deepEqual(schema.missing, [], `a freshly migrated database reported ${JSON.stringify(schema.missing)}`);
    assert.equal(schema.error, undefined, 'the self-check reported an error against a healthy D1');
  });

  test('the rest of the /check contract is untouched', async () => {
    const body = await (await api.get('/check')).json();
    assert.deepEqual(body.x402_versions, [1, 2]);
    assert.ok(Array.isArray(body.matches) && body.matches.length > 0, '/check stopped listing tools');
    assert.equal(typeof body.matches[0].hosted.free_tier_daily, 'number');
  });
});

describe('a database missing a table names it', () => {
  // One table at a time, restored immediately, so a failure cannot leave the
  // worker crippled for the assertions after it.
  for (const table of WORKER_TABLES) {
    test(`a dropped ${table} is reported as missing`, async () => {
      const ddl = await ddlFor(table);
      await worker.d1(`DROP TABLE ${table};`);
      try {
        const schema = await schemaOf();
        assert.deepEqual(
          schema.missing,
          [table],
          `dropping ${table} produced ${JSON.stringify(schema.missing)}`
        );
      } finally {
        await restore(ddl);
      }
      assert.deepEqual((await schemaOf()).missing, [], `${table} was not restored`);
    });
  }

  test('the tables the Worker never touches are not reported', async () => {
    const ddl = [];
    for (const table of OPERATOR_ONLY_TABLES) ddl.push(...(await ddlFor(table)));
    for (const table of OPERATOR_ONLY_TABLES) await worker.d1(`DROP TABLE ${table};`);
    try {
      assert.deepEqual(
        (await schemaOf()).missing,
        [],
        'an operator-only table was reported as a missing Worker table'
      );
    } finally {
      await restore(ddl);
    }
  });
});

/**
 * Every DDL statement sqlite already holds for one table — the CREATE TABLE and
 * any CREATE INDEX on it.
 *
 * Read back out of sqlite_master rather than retyped here, so the restore is
 * byte-for-byte what worker/schema.sql created: a hand-copied DDL that drifted
 * would leave this suite testing a table shaped differently from production's.
 * The indexes matter because DROP TABLE takes them with it.
 */
async function ddlFor(table) {
  const rows = await worker.d1(
    // The table before its indexes: an index cannot be created on a table that
    // is not back yet, and sqlite_master's natural order is not a contract.
    `SELECT sql FROM sqlite_master WHERE tbl_name = '${table}' AND sql IS NOT NULL ` +
      `ORDER BY (type = 'table') DESC;`
  );
  assert.ok(rows.length >= 1, `no CREATE statement for ${table} — is it in worker/schema.sql?`);
  return rows.map((row) => `${row.sql};`);
}

const restore = async (statements) => {
  for (const statement of statements) await worker.d1(statement);
};
