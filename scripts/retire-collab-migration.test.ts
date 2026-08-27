import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import pg from "pg";
import { runMigrations } from "../src/db/migrate.ts";
import {
  COLLAB_RETIRE_APPROVAL_ENV,
  COLLAB_RETIRE_APPROVAL_VALUE,
  assertExecuteApproval,
  auditOutOfScope,
  dbHostRequiresReleaseApproval,
  migrateEntities,
  migrateLanes,
  migrateThoughts,
  parseArgs,
  runMigration,
  type Args,
  type StepName,
} from "./retire-collab-migration.ts";

const { Client, Pool } = pg;

const approvedReleaseEnv = {
  [COLLAB_RETIRE_APPROVAL_ENV]: COLLAB_RETIRE_APPROVAL_VALUE,
};

/** Builds a full Args from the fields a given test actually varies. */
function migrationArgs(overrides: Partial<Args> = {}): Args {
  return {
    execute: false,
    acknowledgeOutOfScope: false,
    steps: new Set<StepName>(["thoughts", "entities", "lanes"]),
    ...overrides,
  };
}

// -----------------------------------------------------------------------------
// Pure arg-parsing tests (always run).
// -----------------------------------------------------------------------------
describe("retire-collab-migration args", () => {
  it("defaults to dry-run and all steps", () => {
    const args = parseArgs([]);
    expect(args.execute).toBe(false);
    expect(args.acknowledgeOutOfScope).toBe(false);
    expect([...args.steps].sort()).toEqual(["entities", "lanes", "thoughts"]);
  });

  it("honors --execute, --acknowledge-out-of-scope, and step subsets", () => {
    const args = parseArgs([
      "--execute",
      "--acknowledge-out-of-scope",
      "--thoughts",
    ]);
    expect(args.execute).toBe(true);
    expect(args.acknowledgeOutOfScope).toBe(true);
    expect([...args.steps]).toEqual(["thoughts"]);
  });

  it("rejects unknown flags", () => {
    const originalExit = process.exit;
    let exitCode: number | undefined;
    process.exit = ((code?: number) => {
      exitCode = code;
      throw new Error("exit");
    }) as typeof process.exit;
    try {
      expect(() => parseArgs(["--nope"])).toThrow();
      expect(exitCode).toBe(2);
    } finally {
      process.exit = originalExit;
    }
  });
});

// -----------------------------------------------------------------------------
// Transaction behavior (mock pool; always runs). A failure in any step must
// roll back the whole execute run.
// -----------------------------------------------------------------------------
describe("retire-collab-migration transaction", () => {
  it("refuses --execute without explicit release approval before DB access", async () => {
    expect(() => assertExecuteApproval({})).toThrow(COLLAB_RETIRE_APPROVAL_ENV);

    const pool = {
      query: async () => {
        throw new Error("db should not be touched without execute approval");
      },
      connect: async () => {
        throw new Error("connect should not be touched without execute approval");
      },
    };

    await expect(
      runMigration(
        pool,
        migrationArgs({ execute: true, steps: new Set<StepName>(["lanes"]) }),
        {},
      ),
    ).rejects.toThrow(COLLAB_RETIRE_APPROVAL_ENV);
  });

  it("refuses live dry-runs without explicit release approval before DB access", async () => {
    expect(
      dbHostRequiresReleaseApproval({ DB_HOST: "192.0.2.21" }),
    ).toBe(true);
    expect(dbHostRequiresReleaseApproval({ DB_HOST: "127.0.0.1" })).toBe(
      false,
    );

    const pool = {
      query: async () => {
        throw new Error("db should not be touched without release approval");
      },
    };

    await expect(
      runMigration(
        pool,
        migrationArgs({ steps: new Set<StepName>(["lanes"]) }),
        { DB_HOST: "production-host" },
      ),
    ).rejects.toThrow(COLLAB_RETIRE_APPROVAL_ENV);
  });

  it("rolls back the transaction when a step fails mid-run", async () => {
    const clientQueries: string[] = [];
    let released = false;
    const failingClient = {
      query: async (sql: string, _params?: unknown[]) => {
        clientQueries.push(sql.trim().split(/\s+/).slice(0, 3).join(" "));
        if (
          sql.includes("ob_session_lanes") &&
          sql.trim().startsWith("UPDATE")
        ) {
          throw new Error("boom: simulated lane failure");
        }
        return { rows: [{ count: 0 }], rowCount: 0 };
      },
      release: () => {
        released = true;
      },
    };
    const pool = {
      // audit + report scaffolding run on the pool
      query: async (_sql: string, _params?: unknown[]) => ({
        rows: [{ count: 0 }],
        rowCount: 0,
      }),
      connect: async () => failingClient,
    };

    await expect(
      runMigration(
        pool,
        migrationArgs({ execute: true, steps: new Set<StepName>(["lanes"]) }),
        approvedReleaseEnv,
      ),
    ).rejects.toThrow("simulated lane failure");

    expect(clientQueries[0]).toBe("BEGIN");
    expect(clientQueries.at(-1)).toBe("ROLLBACK");
    expect(clientQueries).not.toContain("COMMIT");
    expect(released).toBe(true);
  });
});

// -----------------------------------------------------------------------------
// Scratch-DB integration tests built from the REAL repo migrations
// (src/db/migrations/*.sql via runMigrations), so schema drift between the
// script and production cannot hide behind an invented fixture schema.
// Gated on OPENBRAIN_SCRATCH_ADMIN_URL — a superuser/owner connection string
// that can CREATE/DROP DATABASE (e.g. postgres://localhost/postgres). Never
// point this at a live OB database.
// -----------------------------------------------------------------------------
const ADMIN_URL =
  process.env.OPENBRAIN_SCRATCH_ADMIN_URL ??
  process.env.OPENBRAIN_SCRATCH_DATABASE_URL;
const dbDescribe = ADMIN_URL ? describe : describe.skip;

/**
 * The scratch suite only runs when ADMIN_URL is set, but `dbDescribe` carries
 * that gate at runtime and not in the type. Reading it through here keeps the
 * hooks free of assertions and names the variable if the gate ever regresses.
 */
function requireAdminUrl(): string {
  if (!ADMIN_URL) {
    throw new Error("OPENBRAIN_SCRATCH_ADMIN_URL must be set for this suite");
  }
  return ADMIN_URL;
}

const SCRATCH_DB = `ob_retire_collab_scratch_${Date.now()}`;

function scratchUrl(adminUrl: string, dbName: string): string {
  const url = new URL(adminUrl);
  url.pathname = `/${dbName}`;
  return url.toString();
}

async function seedFixtures(pool: InstanceType<typeof Pool>): Promise<void> {
  // thoughts: 2 mirrored (hash present in shared-kb), 3 un-mirrored with
  // operational/audit columns set so preservation can be asserted, and 1
  // null-hash live thought that the audit must flag as out-of-scope.
  await pool.query(
    `INSERT INTO thoughts
       (content, created_by, content_hash, namespace, created_at, tier,
        usefulness_score, access_count, promoted_from, extracted_metadata,
        embedding_model)
     VALUES
       ('mirrored one', 'rico', 'h-mirror-1', 'collab', '2026-01-01T00:00:00Z',
        'warm', NULL, 0, NULL, NULL, NULL),
       ('mirrored two', 'rico', 'h-mirror-2', 'collab', '2026-01-02T00:00:00Z',
        'warm', NULL, 0, NULL, NULL, NULL),
       ('unmirrored a', 'codex', 'h-uniq-a', 'collab', '2026-02-01T00:00:00Z',
        'hot', 0.9, 7, '{"table":"thoughts","id":"src-1"}'::jsonb,
        '{"topic":"infra"}'::jsonb, 'embeddinggemma-300m-8bit'),
       ('unmirrored b', 'codex', 'h-uniq-b', 'collab', '2026-02-02T00:00:00Z',
        'warm', NULL, 0, NULL, NULL, NULL),
       ('unmirrored c', 'discord', 'h-uniq-c', 'collab', '2026-02-03T00:00:00Z',
        'cold', NULL, 0, NULL, NULL, NULL),
       ('no hash live', 'rico', NULL, 'collab', '2026-02-04T00:00:00Z',
        'warm', NULL, 0, NULL, NULL, NULL)`,
  );
  await pool.query(
    `INSERT INTO thoughts (content, created_by, content_hash, namespace, archived_at)
     VALUES
       ('mirrored one', 'rico', 'h-mirror-1', 'shared-kb', NULL),
       ('mirrored two', 'rico', 'h-mirror-2', 'shared-kb', NULL),
       ('archived mirror only', 'rico', 'h-uniq-b', 'shared-kb', NOW())`,
  );

  // decisions: one live un-mirrored collab row -> audit out-of-scope.
  await pool.query(
    `INSERT INTO decisions (title, rationale, created_by, content_hash, namespace)
     VALUES ('legacy decision', 'because', 'rico', 'h-dec-1', 'collab')`,
  );

  // entities: re-taggable repo_fact, name-conflict repo_fact, canonical_id
  // conflict repo_fact, and a non-repo_fact entity (audit out-of-scope).
  await pool.query(
    `INSERT INTO ob_entities (entity_type, name, canonical_id, namespace, created_by)
     VALUES
       ('repo_fact', 'king-core:unique', 'rf:king-core:unique', 'collab', 'rico'),
       ('repo_fact', 'king-core:dupe', 'rf:king-core:dupe', 'collab', 'rico'),
       ('repo_fact', 'king-core:dupe', 'rf:king-core:dupe-shared', 'shared-kb', 'rico'),
       ('repo_fact', 'king-core:canon-collab-name', 'rf:king-core:canon', 'collab', 'rico'),
       ('repo_fact', 'king-core:canon-shared-name', 'rf:king-core:canon', 'shared-kb', 'rico'),
       ('project', 'legacy-project-node', NULL, 'collab', 'rico')`,
  );

  // lanes: 1 active + 1 wrapped to archive, 1 already archived (skip).
  await pool.query(
    `INSERT INTO ob_session_lanes (session_key, namespace, status, created_by, ended_at)
     VALUES
       ('lane-a', 'collab', 'active', 'rico', NULL),
       ('lane-b', 'collab', 'wrapped', 'rico', NULL),
       ('lane-old', 'collab', 'archived', 'rico', NOW())`,
  );
}

// Bun's default 5s per-hook allowance is not enough for `beforeAll`, and the
// shortfall only shows in a full-suite run where the server is also serving
// every other suite: it creates a database and then applies all 49 files in
// src/db/migrations one transaction at a time (src/db/migrate.ts:45). That is
// real work, so the setup hook is sized against it rather than left on the
// default, which surfaced as an unnamed hook failure at 5004ms (#912).
//
// `afterAll` IS sized against real work, contrary to what this comment claimed
// before the step timings came back from CI (#912): dropping this database
// unlinks a 48-migration directory and forces a checkpoint, and on the shared
// runner cluster that is disk-bound rather than instant. Measured in one run:
// 744ms against the ephemeral PostgreSQL 18, 23691ms against the contended
// PostgreSQL 17 the `check` job shares. So the allowance absorbs I/O
// contention, not a blocked drop. If this hook ever approaches it again, ask
// what else is hammering that disk before suspecting a stuck session —
// `dropScratchDatabase` already proves the session count is zero.
const SCRATCH_SETUP_TIMEOUT_MS = 120_000;
// Teardown gets the same allowance as setup: the measured tail is a 23.7s
// DROP DATABASE on the shared runner disk (#912/#915), so do not lower this.
const SCRATCH_TEARDOWN_TIMEOUT_MS = 120_000;

/**
 * Every step section is populated when all three steps run, so a missing one is
 * a real defect rather than a shape to tiptoe around with optional chaining.
 */
function requireStepReports(report: Awaited<ReturnType<typeof runMigration>>) {
  const { thoughts, entities, lanes } = report;
  if (!thoughts || !entities || !lanes) {
    throw new Error("expected thoughts, entities and lanes step reports");
  }
  return { thoughts, entities, lanes };
}

/** Creates the scratch database, applies the real migrations, seeds fixtures. */
async function createScratchDatabase(): Promise<ScratchPool> {
  const adminUrl = requireAdminUrl();
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${SCRATCH_DB}`);
  await admin.end();
  const pool = new Pool({
    connectionString: scratchUrl(adminUrl, SCRATCH_DB),
    max: 2,
  });
  // THE REAL SCHEMA: run the repo's actual migrations, not a hand-built one.
  await runMigrations(pool);
  await seedFixtures(pool);
  return pool;
}

/**
 * Closes the pool and drops the scratch database.
 *
 * The `pg_terminate_backend` sweep stays because it is correct and nearly free,
 * but it is NOT what made this hook time out at 30004ms on the self-hosted
 * runner (#912). Timing every step on CI settled that: `pool.end()` returned in
 * 1ms, `pg_stat_activity` reported `attached=0`, the terminate was a 2ms no-op,
 * and `DROP DATABASE` alone burned 23691ms. With nothing attached, the drop was
 * never waiting on a session — it was waiting on the disk.
 *
 * `WITH (FORCE)` was the cost. It exists to evict other sessions, so with none
 * to evict it bought nothing here while taking the heavier drop path, and the
 * `check` job runs against the runner's long-lived shared PostgreSQL 17 whose
 * disk is busy serving the concurrent `db-integration` job. The same drop on
 * that job's own ephemeral PostgreSQL 18 took 744ms in the very same run, which
 * is the size of the I/O contention rather than a version difference. Dropping
 * a 48-migration database unlinks the whole directory and forces a checkpoint,
 * so a contended disk is felt directly.
 *
 * Plain `DROP DATABASE IF EXISTS`, after an explicit terminate, is therefore
 * both the cheaper and the more honest statement: the sweep handles sessions,
 * the drop handles storage. Scoping the sweep by `datname` is what keeps it
 * safe — it can only ever disconnect sessions attached to a database this suite
 * created, never the dogfood database or a neighbouring run.
 */
async function dropScratchDatabase(pool: ScratchPool | undefined): Promise<void> {
  if (pool) await pool.end();
  const admin = new Client({ connectionString: requireAdminUrl() });
  await admin.connect();
  try {
    await admin.query(
      `SELECT pg_terminate_backend(pid)
         FROM pg_stat_activity
        WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [SCRATCH_DB],
    );
    await admin.query(`DROP DATABASE IF EXISTS ${SCRATCH_DB}`);
  } finally {
    await admin.end();
  }
}

/** The plan a dry-run must report: counts populated, nothing yet performed. */
function expectDryRunPlan(
  report: Awaited<ReturnType<typeof runMigration>>,
): void {
  const { thoughts, entities, lanes } = requireStepReports(report);

  expect(thoughts.unmirrored_before).toBe(3);
  expect(thoughts.would_copy).toBe(3);
  expect(thoughts.copied).toBe(0);
  expect(thoughts.unmirrored_after).toBe(3);

  expect(entities.collab_repo_facts).toBe(3);
  expect(entities.would_retag).toBe(1);
  // one lower(name) conflict + one canonical_id conflict
  expect(entities.would_archive_conflicts).toBe(2);
  expect(entities.retagged).toBe(0);

  expect(lanes.collab_unarchived_lanes).toBe(2);
  expect(lanes.would_archive).toBe(2);
  expect(lanes.archived).toBe(0);
}

type ScratchPool = InstanceType<typeof Pool>;

/** Post-execute state of the thoughts table: copies made, snapshot frozen. */
async function expectThoughtsMigrated(pool: ScratchPool): Promise<void> {
  // shared-kb now has original 2 active mirrors + 1 reactivated archived mirror + 2 copied.
  const shared = await pool.query(
    `SELECT COUNT(*)::int AS c FROM thoughts WHERE namespace = 'shared-kb'`,
  );
  expect(shared.rows[0].c).toBe(5);

  const activeUniqB = await pool.query(
    `SELECT COUNT(*)::int AS c FROM thoughts
      WHERE namespace = 'shared-kb'
        AND content_hash = 'h-uniq-b'
        AND archived_at IS NULL`,
  );
  expect(activeUniqB.rows[0].c).toBe(1);

  // Operational/audit columns preserved on the copied thought.
  const prov = await pool.query(
    `SELECT created_by, created_at, tier, usefulness_score, access_count,
            promoted_from, extracted_metadata, embedding_model
       FROM thoughts
      WHERE namespace = 'shared-kb' AND content_hash = 'h-uniq-a'`,
  );
  expect(prov.rows[0].created_by).toBe("codex");
  expect(new Date(prov.rows[0].created_at).toISOString()).toBe(
    "2026-02-01T00:00:00.000Z",
  );
  expect(prov.rows[0].tier).toBe("hot");
  expect(Number(prov.rows[0].usefulness_score)).toBe(0.9);
  expect(Number(prov.rows[0].access_count)).toBe(7);
  expect(prov.rows[0].promoted_from).toEqual({
    table: "thoughts",
    id: "src-1",
  });
  expect(prov.rows[0].extracted_metadata).toEqual({ topic: "infra" });
  expect(prov.rows[0].embedding_model).toBe("embeddinggemma-300m-8bit");

  // Collab thoughts left in place (frozen snapshot).
  const collab = await pool.query(
    `SELECT COUNT(*)::int AS c FROM thoughts WHERE namespace = 'collab'`,
  );
  expect(collab.rows[0].c).toBe(6);
}

/** Post-execute state of ob_entities: one re-tagged, two conflicts archived. */
async function expectEntitiesMigrated(pool: ScratchPool): Promise<void> {
  // Re-tagged entity moved to shared-kb.
  const retagged = await pool.query(
    `SELECT namespace FROM ob_entities WHERE name = 'king-core:unique'`,
  );
  expect(retagged.rows[0].namespace).toBe("shared-kb");

  // Name-conflict entity archived in collab.
  const nameConflict = await pool.query(
    `SELECT archived_at FROM ob_entities
      WHERE name = 'king-core:dupe' AND namespace = 'collab'`,
  );
  expect(nameConflict.rows[0].archived_at).not.toBeNull();

  // canonical_id-conflict entity (different name, same canonical_id as an
  // active shared-kb row) archived in collab, NOT re-tagged.
  const canonConflict = await pool.query(
    `SELECT namespace, archived_at FROM ob_entities
      WHERE name = 'king-core:canon-collab-name'`,
  );
  expect(canonConflict.rows[0].namespace).toBe("collab");
  expect(canonConflict.rows[0].archived_at).not.toBeNull();
}

/** Post-execute state of ob_session_lanes: every collab lane archived. */
async function expectLanesMigrated(pool: ScratchPool): Promise<void> {
  // Lanes archived via status + ended_at (real schema has no archived_at).
  const unarchived = await pool.query(
    `SELECT COUNT(*)::int AS c FROM ob_session_lanes
      WHERE namespace = 'collab' AND status <> 'archived'`,
  );
  expect(unarchived.rows[0].c).toBe(0);
  const endedStamped = await pool.query(
    `SELECT COUNT(*)::int AS c FROM ob_session_lanes
      WHERE namespace = 'collab' AND ended_at IS NULL`,
  );
  expect(endedStamped.rows[0].c).toBe(0);
}

dbDescribe("retire-collab-migration (scratch Postgres, real migrations)", () => {
  let pool: InstanceType<typeof Pool>;

  beforeAll(async () => {
    pool = await createScratchDatabase();
  }, SCRATCH_SETUP_TIMEOUT_MS);

  afterAll(async () => {
    await dropScratchDatabase(pool);
  }, SCRATCH_TEARDOWN_TIMEOUT_MS);

  it("migration 019 drops every 'collab' namespace column default (#167)", async () => {
    // No namespace column anywhere may still default to the frozen namespace.
    const { rows } = await pool.query(
      `SELECT table_name, column_default
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND column_name = 'namespace'
          AND column_default IS NOT NULL`,
    );
    expect(rows).toEqual([]);

    // With no default and NOT NULL, an INSERT omitting namespace fails loudly
    // instead of silently landing in collab.
    await expect(
      pool.query(
        `INSERT INTO thoughts (content, created_by) VALUES ('no ns', 'test')`,
      ),
    ).rejects.toThrow();
    await expect(
      pool.query(
        `INSERT INTO ob_session_lanes (session_key, created_by)
         VALUES ('no-ns-lane', 'test')`,
      ),
    ).rejects.toThrow();
  });

  it("pre-flight audit counts out-of-scope collab content in every table", async () => {
    const audit = await auditOutOfScope(pool);
    expect(audit.thoughts_null_hash).toBe(1);
    expect(audit.unmirrored_by_table.decisions).toBe(1);
    expect(audit.unmirrored_by_table.relationships).toBe(0);
    expect(audit.unmirrored_by_table.projects).toBe(0);
    expect(audit.unmirrored_by_table.sessions).toBe(0);
    expect(audit.entities_non_repo_fact).toBe(1);
    expect(audit.total_out_of_scope).toBe(3);
  });

  it("dry-run reports plan + audit without mutating", async () => {
    const report = await runMigration(pool, migrationArgs());
    expect(report.dry_run).toBe(true);
    expect(report.audit.total_out_of_scope).toBe(3);

    expectDryRunPlan(report);

    const sharedCount = await pool.query(
      `SELECT COUNT(*)::int AS c FROM thoughts WHERE namespace = 'shared-kb'`,
    );
    expect(sharedCount.rows[0].c).toBe(3);
  });

  it("refuses --execute while out-of-scope content exists and mutates nothing", async () => {
    await expect(
      runMigration(
        pool,
        migrationArgs({ execute: true }),
        approvedReleaseEnv,
      ),
    ).rejects.toThrow("OUTSIDE the migrated scope");

    const sharedCount = await pool.query(
      `SELECT COUNT(*)::int AS c FROM thoughts WHERE namespace = 'shared-kb'`,
    );
    expect(sharedCount.rows[0].c).toBe(3);
    const lanes = await pool.query(
      `SELECT COUNT(*)::int AS c FROM ob_session_lanes
        WHERE namespace = 'collab' AND status <> 'archived'`,
    );
    expect(lanes.rows[0].c).toBe(2);
  });

  it("executes with --acknowledge-out-of-scope: copies, re-tags, archives", async () => {
    const report = await runMigration(
      pool,
      migrationArgs({ execute: true, acknowledgeOutOfScope: true }),
      approvedReleaseEnv,
    );

    const { thoughts, entities, lanes } = requireStepReports(report);
    expect(thoughts.copied).toBe(3);
    expect(thoughts.unmirrored_after).toBe(0);
    expect(entities.retagged).toBe(1);
    expect(entities.archived_conflicts).toBe(2);
    expect(lanes.archived).toBe(2);

    await expectThoughtsMigrated(pool);
    await expectEntitiesMigrated(pool);
    await expectLanesMigrated(pool);
  });

  it("is idempotent: a second execute copies/retags/archives nothing", async () => {
    const t = await migrateThoughts(pool, true);
    expect(t.copied).toBe(0);
    expect(t.unmirrored_after).toBe(0);

    const e = await migrateEntities(pool, true);
    expect(e.retagged).toBe(0);
    expect(e.archived_conflicts).toBe(0);

    const l = await migrateLanes(pool, true);
    expect(l.archived).toBe(0);

    const shared = await pool.query(
      `SELECT COUNT(*)::int AS c FROM thoughts WHERE namespace = 'shared-kb'`,
    );
    expect(shared.rows[0].c).toBe(5);
  });
});
