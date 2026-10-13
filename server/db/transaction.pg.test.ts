/**
 * Real-PostgreSQL proof of the server/db transaction helper (issue 1209).
 *
 * `_plans/463-server-rewrite-charter.md:146` says SQL moves into server/db only
 * after a real-Postgres test proves transaction behavior, so this suite runs
 * against an actual database and fails hard without one -- no `describe.skip`,
 * no environment guard (operator ruling 2026-08-27, issue #878).
 *
 * The third test is the reason this file is not a unit test with a fake pool:
 * the failed-ROLLBACK path only exists because a real connection can die
 * mid-transaction, and the only honest way to produce that is to kill the
 * backend the transaction is running on.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { requireTestDatabaseUrl } from "../../scripts/test-support/require-test-database.ts";
import { withTransaction } from "./transaction.ts";

const DATABASE_URL = requireTestDatabaseUrl();
const schema = `transaction_helper_${process.pid}`;

describe("server/db withTransaction against real Postgres (live Postgres)", () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL, max: 4 });
    await pool.query(`CREATE SCHEMA ${schema}`);
    await pool.query(`CREATE TABLE ${schema}.marks (id TEXT PRIMARY KEY)`);
  });

  afterAll(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await pool.end();
  });

  it("commits the work and returns its value", async () => {
    const returned = await withTransaction({
      pool,
      run: async (tx) => {
        await tx.query(`INSERT INTO ${schema}.marks (id) VALUES ($1)`, ["committed"]);
        return "returned-value";
      },
    });

    expect(returned).toBe("returned-value");
    const after = await pool.query(`SELECT id FROM ${schema}.marks WHERE id = $1`, [
      "committed",
    ]);
    expect(after.rowCount).toBe(1);
  });

  it("rolls the work back and rethrows the original error instance", async () => {
    const boom = new Error("run failed");

    // Caught rather than asserted through `.rejects`, so the row check below is
    // ordered after the transaction has actually finished unwinding.
    let thrown: unknown;
    try {
      await withTransaction({
        pool,
        run: async (tx) => {
          await tx.query(`INSERT INTO ${schema}.marks (id) VALUES ($1)`, [
            "rolled-back",
          ]);
          throw boom;
        },
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBe(boom);

    const after = await pool.query(`SELECT id FROM ${schema}.marks WHERE id = $1`, [
      "rolled-back",
    ]);
    expect(after.rowCount).toBe(0);
  });

  it("reports a failed ROLLBACK and still propagates the original error", async () => {
    const sentinel = new Error("sentinel from run");
    const rollbackErrors: unknown[] = [];

    let thrown: unknown;
    try {
      await withTransaction({
        pool,
        run: async (tx) => {
          // A killed backend makes the client emit `error`; with no listener
          // that is an unhandled event and the process, not the assertion,
          // decides the outcome. Absorb it so the helper's own path is what
          // this test observes.
          tx.on("error", () => undefined);
          // Kill the backend this transaction is running on. The terminate
          // itself tears down the connection it was issued over, so its own
          // rejection is expected and swallowed; what matters is that the
          // client is dead by the time the helper reaches ROLLBACK.
          await tx
            .query("SELECT pg_terminate_backend(pg_backend_pid())")
            .catch(() => undefined);
          throw sentinel;
        },
        onRollbackFailure: (error) => {
          rollbackErrors.push(error);
        },
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBe(sentinel);
    expect(rollbackErrors).toHaveLength(1);
  });
});
