/**
 * Real-PostgreSQL proof of the three OPTIONAL shapes withTransaction grew for
 * the tools-tier ports (issue 1209).
 *
 * A sibling of `./transaction.pg.test.ts` rather than more `it` blocks inside
 * it: that file's `describe` was already at 113 lines, and four more cases push
 * the single suite function past oxlint's max-lines-per-function, which this
 * repo deliberately does NOT exempt for tests (`.oxlintrc.json`, operator
 * decision 2026-08-26). The split is along a real seam anyway -- the base file
 * proves plain BEGIN/COMMIT and the rollback-failure hook the four maintenance
 * sites depend on; this one proves only what the two tools modules
 * (`server/tools/find-duplicates.ts`, `server/tools/update-entry.ts`) need
 * before they can port.
 *
 * Real Postgres, no environment guard and no `describe.skip` (operator ruling
 * 2026-08-27, issue #878): every behavior here is the server's, not the
 * client's. `readOnly` is refused by the backend, `statement_timeout` is
 * cancelled by the backend, and whether set_config was transaction-local is a
 * question only a second real transaction on the same pooled client can answer.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { requireTestDatabaseUrl } from "../../scripts/test-support/require-test-database.ts";
import { withTransaction } from "./transaction.ts";

const DATABASE_URL = requireTestDatabaseUrl();
const schema = `transaction_options_${process.pid}`;

describe("server/db withTransaction options against real Postgres (live Postgres)", () => {
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

  it("opens READ ONLY when asked, so a write inside run is refused", async () => {
    let thrown: unknown;
    try {
      await withTransaction({
        pool,
        readOnly: true,
        run: async (tx) => {
          await tx.query(`INSERT INTO ${schema}.marks (id) VALUES ($1)`, ["read-only"]);
          return "unreachable";
        },
      });
    } catch (error) {
      thrown = error;
    }

    // 25006 is read_only_sql_transaction. Asserted by SQLSTATE rather than by
    // message text, so a Postgres wording change cannot turn this green.
    expect((thrown as { code?: string }).code).toBe("25006");
    const after = await pool.query(`SELECT id FROM ${schema}.marks WHERE id = $1`, [
      "read-only",
    ]);
    expect(after.rowCount).toBe(0);
  });

  it("applies statementTimeoutMs transaction-locally", async () => {
    let thrown: unknown;
    try {
      await withTransaction({
        pool,
        statementTimeoutMs: 50,
        run: async (tx) => {
          await tx.query("SELECT pg_sleep(1)");
          return "unreachable";
        },
      });
    } catch (error) {
      thrown = error;
    }

    // 57014 is query_canceled, which is what statement_timeout raises.
    expect((thrown as { code?: string }).code).toBe("57014");

    // set_config was passed `true` for is_local, so ROLLBACK cleared it. A
    // following plain transaction on the same pool sleeps well past 50ms and
    // reads the setting back, which is what proves nothing survived onto a
    // pooled client.
    const settingAfter = await withTransaction({
      pool,
      run: async (tx) => {
        await tx.query("SELECT pg_sleep(0.2)");
        const shown = await tx.query<{ statement_timeout: string }>(
          "SHOW statement_timeout",
        );
        return shown.rows[0]?.statement_timeout;
      },
    });
    expect(settingAfter).toBe("0");
  });

  it("returns the value control.abort was given and rolls the work back", async () => {
    const returned = await withTransaction<{ ok: boolean }>({
      pool,
      run: async (tx, control) => {
        await tx.query(`INSERT INTO ${schema}.marks (id) VALUES ($1)`, ["aborted"]);
        control.abort({ ok: false });
        return { ok: true };
      },
    });

    expect(returned).toEqual({ ok: false });
    const after = await pool.query(`SELECT id FROM ${schema}.marks WHERE id = $1`, [
      "aborted",
    ]);
    expect(after.rowCount).toBe(0);
  });

  it("commits unchanged for a run that ignores its second parameter", async () => {
    const returned = await withTransaction({
      pool,
      run: async (tx) => {
        await tx.query(`INSERT INTO ${schema}.marks (id) VALUES ($1)`, ["one-param"]);
        return "still-returned";
      },
    });

    expect(returned).toBe("still-returned");
    const after = await pool.query(`SELECT id FROM ${schema}.marks WHERE id = $1`, [
      "one-param",
    ]);
    expect(after.rowCount).toBe(1);
  });
});
