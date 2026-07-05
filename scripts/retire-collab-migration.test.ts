import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import pg from "pg";
import { runMigrations } from "../src/db/migrate.ts";
import {
  auditOutOfScope,
  migrateEntities,
  migrateLanes,
  migrateThoughts,
  parseArgs,
  runMigration,
} from "./retire-collab-migration.ts";

const { Client, Pool } = pg;

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
      runMigration(pool as any, {
        execute: true,
        acknowledgeOutOfScope: false,
        steps: new Set(["lanes"]),
      } as any),
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
    `INSERT INTO thoughts (content, created_by, content_hash, namespace)
     VALUES
       ('mirrored one', 'rico', 'h-mirror-1', 'shared-kb'),
       ('mirrored two', 'rico', 'h-mirror-2', 'shared-kb')`,
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

dbDescribe("retire-collab-migration (scratch Postgres, real migrations)", () => {
  let pool: InstanceType<typeof Pool>;

  beforeAll(async () => {
    const admin = new Client({ connectionString: ADMIN_URL });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${SCRATCH_DB}`);
    await admin.end();
    pool = new Pool({
      connectionString: scratchUrl(ADMIN_URL!, SCRATCH_DB),
      max: 2,
    });
    // THE REAL SCHEMA: run the repo's actual migrations, not a hand-built one.
    await runMigrations(pool);
    await seedFixtures(pool);
  });

  afterAll(async () => {
    if (pool) await pool.end();
    const admin = new Client({ connectionString: ADMIN_URL });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`);
    await admin.end();
  });

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
    const report = await runMigration(pool, {
      execute: false,
      acknowledgeOutOfScope: false,
      steps: new Set(["thoughts", "entities", "lanes"]),
    } as any);
    expect(report.dry_run).toBe(true);
    expect(report.audit.total_out_of_scope).toBe(3);

    expect(report.thoughts?.unmirrored_before).toBe(3);
    expect(report.thoughts?.would_copy).toBe(3);
    expect(report.thoughts?.copied).toBe(0);
    expect(report.thoughts?.unmirrored_after).toBe(3);

    expect(report.entities?.collab_repo_facts).toBe(3);
    expect(report.entities?.would_retag).toBe(1);
    // one lower(name) conflict + one canonical_id conflict
    expect(report.entities?.would_archive_conflicts).toBe(2);
    expect(report.entities?.retagged).toBe(0);

    expect(report.lanes?.collab_unarchived_lanes).toBe(2);
    expect(report.lanes?.would_archive).toBe(2);
    expect(report.lanes?.archived).toBe(0);

    const sharedCount = await pool.query(
      `SELECT COUNT(*)::int AS c FROM thoughts WHERE namespace = 'shared-kb'`,
    );
    expect(sharedCount.rows[0].c).toBe(2);
  });

  it("refuses --execute while out-of-scope content exists and mutates nothing", async () => {
    await expect(
      runMigration(pool, {
        execute: true,
        acknowledgeOutOfScope: false,
        steps: new Set(["thoughts", "entities", "lanes"]),
      } as any),
    ).rejects.toThrow("OUTSIDE the migrated scope");

    const sharedCount = await pool.query(
      `SELECT COUNT(*)::int AS c FROM thoughts WHERE namespace = 'shared-kb'`,
    );
    expect(sharedCount.rows[0].c).toBe(2);
    const lanes = await pool.query(
      `SELECT COUNT(*)::int AS c FROM ob_session_lanes
        WHERE namespace = 'collab' AND status <> 'archived'`,
    );
    expect(lanes.rows[0].c).toBe(2);
  });

  it("executes with --acknowledge-out-of-scope: copies, re-tags, archives", async () => {
    const report = await runMigration(pool, {
      execute: true,
      acknowledgeOutOfScope: true,
      steps: new Set(["thoughts", "entities", "lanes"]),
    } as any);

    expect(report.thoughts?.copied).toBe(3);
    expect(report.thoughts?.unmirrored_after).toBe(0);
    expect(report.entities?.retagged).toBe(1);
    expect(report.entities?.archived_conflicts).toBe(2);
    expect(report.lanes?.archived).toBe(2);

    // shared-kb now has original 2 + 3 copied.
    const shared = await pool.query(
      `SELECT COUNT(*)::int AS c FROM thoughts WHERE namespace = 'shared-kb'`,
    );
    expect(shared.rows[0].c).toBe(5);

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
