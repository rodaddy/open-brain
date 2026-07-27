/**
 * Live-Postgres coverage for bulk_set_tier, the highest-blast-radius dream
 * mutator: one call rewrites the tier of up to 100 rows inside a single
 * transaction, applying the namespace predicate SEPARATELY to each row.
 *
 * The focused suite (bulk-set-tier.test.ts) proves call shape against a fake
 * pool. It cannot prove the thing that matters here, and its happy path shows
 * why: the fake returns `{ rowCount: 1 }` for every UPDATE, so the reported
 * `updated` count is a property of the fake, not of the predicate. A predicate
 * that excluded every row would produce a byte-identical passing assertion.
 *
 * These proofs need real SQL evaluation and real rows:
 *  1. A scoped agent's own-namespace entries are updated and PERSIST at the new
 *     tier -- the positive control, without which every denial below is vacuous.
 *  2. A mixed batch (own + foreign namespace) updates only the owned rows. The
 *     foreign row is compared field-by-field before and after, because the
 *     caller-visible signal for "denied" and for "already that tier" is the
 *     same number, so only the untouched row proves isolation.
 *  3. `updated` is the true count of rows Postgres changed, not the count the
 *     caller requested -- the fake could never disagree with the request.
 *  4. An archived row is excluded by `archived_at IS NULL` against a real
 *     timestamp, and its tier survives the call.
 *  5. Atomicity is real: a batch that fails partway leaves NO row changed,
 *     including rows whose UPDATE already succeeded before the failure. The
 *     fake's "rolls back on error" test asserts a ROLLBACK string was sent; it
 *     never had a transaction, so it cannot show the first row was restored.
 *  6. The transaction is not left open and the connection is returned to the
 *     pool after a failure -- a leaked client is invisible to a fake `connect`.
 *
 * Gated on OPENBRAIN_TEST_DATABASE_URL (repo dbDescribe convention); skips when
 * unset so the DB-less CI job passes while db-integration runs it for real.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { Pool } from "pg";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { runMigrations } from "../../db/migrate.ts";
import { registerBulkSetTier } from "../bulk-set-tier.ts";
import type { ToolDeps } from "../index.ts";
import type { AuthInfo } from "../../types.ts";

const DB_URL = process.env.OPENBRAIN_TEST_DATABASE_URL;
const dbDescribe = DB_URL ? describe : describe.skip;

// Every row this suite creates carries this created_by so cleanup deletes
// exactly what the suite owns, even against a database shared with other
// suites or with rows left by a previous failed run.
const CREATED_BY = "dream-bulk-set-tier-pg-test";

// The caller's own namespace and one it must never be able to reach. Both are
// suite-specific so a real namespace can never be touched.
const OWNER_NS = "dream-bulk-owner-ns";
const FOREIGN_NS = "dream-bulk-foreign-ns";

// A token-scoped agent: writable namespaces resolve to [OWNER_NS], so the
// predicate becomes `AND namespace = ANY($n)`. This is the role that must be
// contained. An admin would produce a different (exclusion-based) predicate and
// would not exercise the containment this suite exists to prove.
const ownerAuth: AuthInfo = {
  role: "agent",
  clientId: OWNER_NS,
  namespaceSource: "token",
};

dbDescribe("bulk_set_tier (live Postgres)", () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DB_URL });
    await pool.query("CREATE EXTENSION IF NOT EXISTS vector");
    await runMigrations(pool);
    await cleanup();
  });

  afterEach(cleanup);

  afterAll(async () => {
    await cleanup();
    await pool.end();
  });

  async function cleanup(): Promise<void> {
    for (const table of ["thoughts", "decisions"]) {
      await pool.query(`DELETE FROM ${table} WHERE created_by = $1`, [
        CREATED_BY,
      ]);
    }
  }

  /**
   * Insert one row and return its id. `tier` is set explicitly rather than
   * relying on the column default so each test states the precondition it
   * later asserts a change (or a non-change) against.
   */
  async function seedThought(opts: {
    namespace: string;
    tier: string;
    content: string;
    archivedAt?: Date | null;
  }): Promise<string> {
    const { rows } = await pool.query(
      `INSERT INTO thoughts (content, created_by, namespace, tier, archived_at)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [
        opts.content,
        CREATED_BY,
        opts.namespace,
        opts.tier,
        opts.archivedAt ?? null,
      ],
    );
    return rows[0].id as string;
  }

  /** The full stored row, for before/after comparison of a denied write. */
  async function readRow(id: string): Promise<Record<string, unknown>> {
    const { rows } = await pool.query(
      `SELECT id, tier, namespace, archived_at, content, updated_at
         FROM thoughts WHERE id = $1`,
      [id],
    );
    return rows[0];
  }

  async function readTier(id: string): Promise<string> {
    return (await readRow(id)).tier as string;
  }

  /** Call the tool over a real MCP transport, exactly as a client would. */
  async function callBulkSetTier(
    auth: AuthInfo,
    entries: Array<{ id: string; table: string; tier: string }>,
    depsOverride?: Partial<ToolDeps>,
  ) {
    const server = new McpServer({ name: "test", version: "1.0.0" });
    const deps: ToolDeps = {
      pool: pool as any,
      embedFn: async () => null,
      ...depsOverride,
    };
    registerBulkSetTier(server, deps);

    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const originalSend = clientTransport.send.bind(clientTransport);
    clientTransport.send = (message: any, options?: any) =>
      originalSend(message, { ...options, authInfo: auth });

    const client = new Client({ name: "test-client", version: "1.0.0" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    try {
      return await client.callTool({
        name: "bulk_set_tier",
        arguments: { entries },
      });
    } finally {
      await client.close();
      await server.close();
    }
  }

  function parseResult(result: any): { requested: number; updated: number } {
    return JSON.parse((result.content as any)[0].text);
  }

  it("persists tier changes for the caller's own namespace", async () => {
    // The positive control. Every isolation proof below is meaningless unless
    // the same call, same role, same table demonstrably works when allowed.
    const a = await seedThought({
      namespace: OWNER_NS,
      tier: "warm",
      content: "own-a",
    });
    const b = await seedThought({
      namespace: OWNER_NS,
      tier: "warm",
      content: "own-b",
    });

    const result = await callBulkSetTier(ownerAuth, [
      { id: a, table: "thoughts", tier: "hot" },
      { id: b, table: "thoughts", tier: "cold" },
    ]);

    expect(result.isError).toBeFalsy();
    expect(parseResult(result)).toEqual({ requested: 2, updated: 2 });

    // Read back from Postgres: the response could be right while the write
    // was rolled back, and only the stored row distinguishes those.
    expect(await readTier(a)).toBe("hot");
    expect(await readTier(b)).toBe("cold");
  });

  it("updates only owned rows in a mixed-namespace batch and leaves the foreign row byte-identical", async () => {
    const owned = await seedThought({
      namespace: OWNER_NS,
      tier: "warm",
      content: "mixed-owned",
    });
    const foreign = await seedThought({
      namespace: FOREIGN_NS,
      tier: "warm",
      content: "mixed-foreign",
    });

    const before = await readRow(foreign);

    const result = await callBulkSetTier(ownerAuth, [
      { id: owned, table: "thoughts", tier: "hot" },
      { id: foreign, table: "thoughts", tier: "hot" },
    ]);

    // Not an error: a filtered-out row is a no-op, not a failure. The caller
    // is told 2 requested / 1 updated and cannot tell WHY the second missed --
    // deliberate, since a distinct "denied" reply would be an existence oracle
    // for rows in namespaces the caller cannot read.
    expect(result.isError).toBeFalsy();
    expect(parseResult(result)).toEqual({ requested: 2, updated: 1 });

    expect(await readTier(owned)).toBe("hot");

    // The whole row, not just the tier: a predicate bug that wrote the right
    // column to the wrong row, or bumped updated_at via a trigger, is the kind
    // of damage a tier-only assertion would miss.
    expect(await readRow(foreign)).toEqual(before);
  });

  it("reports the true number of rows Postgres changed, not the number requested", async () => {
    // Three requested, one reachable. A fake pool cannot produce this
    // disagreement, which is precisely why the count is worth proving here.
    const owned = await seedThought({
      namespace: OWNER_NS,
      tier: "cold",
      content: "count-owned",
    });
    const foreign = await seedThought({
      namespace: FOREIGN_NS,
      tier: "cold",
      content: "count-foreign",
    });
    // A syntactically valid UUID that matches no row at all.
    const missing = "550e8400-e29b-41d4-a716-4466554400ff";

    const result = await callBulkSetTier(ownerAuth, [
      { id: owned, table: "thoughts", tier: "hot" },
      { id: foreign, table: "thoughts", tier: "hot" },
      { id: missing, table: "thoughts", tier: "hot" },
    ]);

    expect(parseResult(result)).toEqual({ requested: 3, updated: 1 });
    expect(await readTier(owned)).toBe("hot");
    expect(await readTier(foreign)).toBe("cold");
  });

  it("excludes an archived row and leaves its tier untouched", async () => {
    // `archived_at IS NULL` is a real timestamp comparison in Postgres. The
    // row is in the caller's OWN namespace, so archival is the only thing
    // that can exclude it -- isolating this predicate from the namespace one.
    const live = await seedThought({
      namespace: OWNER_NS,
      tier: "warm",
      content: "archive-live",
    });
    const archived = await seedThought({
      namespace: OWNER_NS,
      tier: "warm",
      content: "archive-dead",
      archivedAt: new Date("2020-01-01T00:00:00Z"),
    });

    const result = await callBulkSetTier(ownerAuth, [
      { id: live, table: "thoughts", tier: "hot" },
      { id: archived, table: "thoughts", tier: "hot" },
    ]);

    expect(parseResult(result)).toEqual({ requested: 2, updated: 1 });
    expect(await readTier(live)).toBe("hot");
    expect(await readTier(archived)).toBe("warm");
  });

  it("rolls back a database-level failure partway through the batch", async () => {
    // First entry updates successfully; the second raises inside the same
    // transaction. If each UPDATE ran on its own connection, the first row
    // would keep its new tier and the batch would be half-applied.
    //
    // Scope note, and the reason the next test exists: a RAISE inside Postgres
    // puts the transaction in the aborted state, where the server treats a
    // subsequent COMMIT as a ROLLBACK. So this test alone does NOT distinguish
    // a correct ROLLBACK in the catch from a mistaken COMMIT -- verified by
    // mutation: swapping the keyword leaves this test green. What it does
    // prove is that the batch shares one transaction rather than running each
    // UPDATE independently, which is a separate defect worth its own case.
    const first = await seedThought({
      namespace: OWNER_NS,
      tier: "warm",
      content: "atomic-first",
    });
    const second = await seedThought({
      namespace: OWNER_NS,
      tier: "warm",
      content: "atomic-second",
    });

    // A trigger is used rather than a bad argument because every schema-level
    // way to make one entry fail is rejected by Zod before any SQL runs.
    await pool.query(`
      CREATE OR REPLACE FUNCTION dream_bulk_fail_sentinel() RETURNS trigger AS $$
      BEGIN
        IF NEW.content = 'atomic-second' THEN
          RAISE EXCEPTION 'dream-bulk-test forced failure';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);
    await pool.query(`
      CREATE TRIGGER dream_bulk_fail_trigger
        BEFORE UPDATE ON thoughts
        FOR EACH ROW EXECUTE FUNCTION dream_bulk_fail_sentinel();
    `);

    try {
      const result = await callBulkSetTier(ownerAuth, [
        { id: first, table: "thoughts", tier: "hot" },
        { id: second, table: "thoughts", tier: "hot" },
      ]);

      expect(result.isError).toBe(true);
      expect((result.content as any)[0].text).toContain("Transaction failed");

      // Both rows at their ORIGINAL tier. The first one is the assertion that
      // matters: its UPDATE had already succeeded when the failure hit.
      expect(await readTier(first)).toBe("warm");
      expect(await readTier(second)).toBe("warm");
    } finally {
      await pool.query(
        "DROP TRIGGER IF EXISTS dream_bulk_fail_trigger ON thoughts",
      );
      await pool.query("DROP FUNCTION IF EXISTS dream_bulk_fail_sentinel()");
    }
  });

  it("rolls back when the failure is in application code and the transaction is still committable", async () => {
    // The case that actually pins ROLLBACK in the catch block.
    //
    // The loop between BEGIN and COMMIT is application code: it builds params
    // and calls appendWriteNamespacePredicate per entry. A throw from there
    // reaches the catch with a HEALTHY transaction holding every prior update,
    // so COMMIT would persist a partial batch -- exactly the silent
    // half-applied state a bulk tier rewrite must never produce.
    //
    // The database-level test above cannot cover this: Postgres has already
    // aborted the transaction there, so COMMIT and ROLLBACK behave alike.
    // Here nothing is wrong server-side, and the keyword is the only thing
    // deciding whether the first row's new tier survives.
    const first = await seedThought({
      namespace: OWNER_NS,
      tier: "warm",
      content: "app-fail-first",
    });
    const second = await seedThought({
      namespace: OWNER_NS,
      tier: "warm",
      content: "app-fail-second",
    });

    // The failure is injected by handing the handler a real pooled client
    // whose `query` refuses the second UPDATE, wrapped in a delegating object
    // rather than by reassigning `client.query` on the pooled client itself.
    //
    // That distinction is load-bearing and was found the hard way: monkey-
    // patching `query` on a client borrowed from `pg` breaks the pool's
    // internal release bookkeeping, so the connection is never reclaimed and
    // the next query on that pool blocks forever. Delegating leaves the real
    // client object untouched, so release works normally.
    //
    // A dedicated pool keeps even a mistake here from wedging the suite pool.
    const injectPool = new Pool({ connectionString: DB_URL, max: 2 });
    let result: any;
    try {
      const failingPool = {
        connect: async () => {
          const real: any = await injectPool.connect();
          let updates = 0;
          return {
            query: (sql: any, params?: any) => {
              if (typeof sql === "string" && sql.startsWith("UPDATE")) {
                updates += 1;
                if (updates === 2) {
                  // Rejected from the caller's side: the server never sees it,
                  // so the transaction stays open, valid, and committable.
                  return Promise.reject(
                    new Error("dream-bulk-test application failure"),
                  );
                }
              }
              return real.query(sql, params);
            },
            release: () => real.release(),
          };
        },
        query: (sql: any, params?: any) => injectPool.query(sql, params),
      };

      result = await callBulkSetTier(
        ownerAuth,
        [
          { id: first, table: "thoughts", tier: "hot" },
          { id: second, table: "thoughts", tier: "hot" },
        ],
        { pool: failingPool as any },
      );
    } finally {
      await injectPool.end();
    }

    expect(result.isError).toBe(true);
    expect((result.content as any)[0].text).toContain("Transaction failed");

    // The load-bearing assertion: `first` was successfully updated to "hot"
    // inside a transaction that could still have been committed. It is "warm"
    // only because the catch block rolled back.
    expect(await readTier(first)).toBe("warm");
    expect(await readTier(second)).toBe("warm");
  });

  it("returns the connection to the pool after a failed batch", async () => {
    // A handler that fails without releasing its client leaks a connection per
    // failed call and eventually deadlocks the pool. The `finally { release }`
    // is invisible to a fake `connect`, so it is proven here by draining a
    // one-connection pool: the second call can only get a client if the first
    // gave one back, and it would hang rather than fail if it did not.
    const single = new Pool({ connectionString: DB_URL, max: 1 });
    try {
      const id = await seedThought({
        namespace: OWNER_NS,
        tier: "warm",
        content: "release-probe",
      });

      await pool.query(`
        CREATE OR REPLACE FUNCTION dream_bulk_release_sentinel() RETURNS trigger AS $$
        BEGIN
          RAISE EXCEPTION 'dream-bulk-test forced failure';
        END;
        $$ LANGUAGE plpgsql;
      `);
      await pool.query(`
        CREATE TRIGGER dream_bulk_release_trigger
          BEFORE UPDATE ON thoughts
          FOR EACH ROW EXECUTE FUNCTION dream_bulk_release_sentinel();
      `);

      const failed = await callBulkSetTier(
        ownerAuth,
        [{ id, table: "thoughts", tier: "hot" }],
        { pool: single as any },
      );
      expect(failed.isError).toBe(true);

      await pool.query(
        "DROP TRIGGER IF EXISTS dream_bulk_release_trigger ON thoughts",
      );
      await pool.query("DROP FUNCTION IF EXISTS dream_bulk_release_sentinel()");

      // The pool has exactly one connection. This succeeds only if the failed
      // call released it.
      const second = await callBulkSetTier(
        ownerAuth,
        [{ id, table: "thoughts", tier: "hot" }],
        { pool: single as any },
      );
      expect(second.isError).toBeFalsy();
      expect(await readTier(id)).toBe("hot");
    } finally {
      await pool.query(
        "DROP TRIGGER IF EXISTS dream_bulk_release_trigger ON thoughts",
      );
      await pool.query("DROP FUNCTION IF EXISTS dream_bulk_release_sentinel()");
      await single.end();
    }
  });
});
