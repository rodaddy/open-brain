import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Client, Pool } from "pg";
import {
  migrateEntities,
  migrateLanes,
  migrateThoughts,
  parseArgs,
  runMigration,
} from "./retire-collab-migration.ts";

// -----------------------------------------------------------------------------
// Pure arg-parsing tests (always run).
// -----------------------------------------------------------------------------
describe("retire-collab-migration args", () => {
  it("defaults to dry-run and all steps", () => {
    const args = parseArgs([]);
    expect(args.execute).toBe(false);
    expect([...args.steps].sort()).toEqual(["entities", "lanes", "thoughts"]);
  });

  it("honors --execute and a scoped subset of steps", () => {
    const args = parseArgs(["--execute", "--thoughts"]);
    expect(args.execute).toBe(true);
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
// Scratch-DB integration tests. Gated on OPENBRAIN_SCRATCH_ADMIN_URL, a
// superuser/owner connection string that can CREATE/DROP DATABASE (e.g.
// postgres://localhost/postgres). Never point this at a live OB database.
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

async function seedSchema(pool: Pool): Promise<void> {
  // Minimal schema mirroring the columns the migration touches, including the
  // per-namespace unique index that guarantees idempotency for thoughts.
  await pool.query(`
    CREATE TABLE thoughts (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      content TEXT NOT NULL,
      tags TEXT[] DEFAULT '{}',
      source TEXT DEFAULT 'manual',
      created_by TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      content_hash TEXT,
      namespace TEXT NOT NULL DEFAULT 'collab'
    );
    CREATE UNIQUE INDEX idx_thoughts_content_hash
      ON thoughts (content_hash, namespace) WHERE content_hash IS NOT NULL;

    CREATE TABLE ob_entities (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      entity_type TEXT NOT NULL,
      name TEXT NOT NULL,
      namespace TEXT NOT NULL DEFAULT 'collab',
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_by TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      archived_at TIMESTAMPTZ
    );
    CREATE UNIQUE INDEX idx_ob_entities_lookup_unique
      ON ob_entities (namespace, entity_type, lower(name))
      WHERE archived_at IS NULL;

    CREATE TABLE ob_session_lanes (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      session_key TEXT NOT NULL,
      namespace TEXT NOT NULL DEFAULT 'collab',
      status TEXT NOT NULL DEFAULT 'active',
      created_by TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      archived_at TIMESTAMPTZ,
      UNIQUE(namespace, session_key)
    );
  `);
}

async function seedFixtures(pool: Pool): Promise<void> {
  // thoughts: 2 already-mirrored (hash present in shared-kb), 3 un-mirrored.
  await pool.query(
    `INSERT INTO thoughts (content, created_by, content_hash, namespace, created_at)
     VALUES
       ('mirrored one', 'rico', 'h-mirror-1', 'collab', '2026-01-01T00:00:00Z'),
       ('mirrored two', 'rico', 'h-mirror-2', 'collab', '2026-01-02T00:00:00Z'),
       ('unmirrored a', 'codex', 'h-uniq-a', 'collab', '2026-02-01T00:00:00Z'),
       ('unmirrored b', 'codex', 'h-uniq-b', 'collab', '2026-02-02T00:00:00Z'),
       ('unmirrored c', 'discord', 'h-uniq-c', 'collab', '2026-02-03T00:00:00Z')`,
  );
  await pool.query(
    `INSERT INTO thoughts (content, created_by, content_hash, namespace)
     VALUES
       ('mirrored one', 'rico', 'h-mirror-1', 'shared-kb'),
       ('mirrored two', 'rico', 'h-mirror-2', 'shared-kb')`,
  );

  // entities: 1 collab repo_fact re-taggable, 1 collab repo_fact that conflicts
  // with an existing active shared-kb repo_fact of the same name.
  await pool.query(
    `INSERT INTO ob_entities (entity_type, name, namespace, created_by)
     VALUES
       ('repo_fact', 'king-core:unique', 'collab', 'rico'),
       ('repo_fact', 'king-core:dupe', 'collab', 'rico'),
       ('repo_fact', 'king-core:dupe', 'shared-kb', 'rico')`,
  );

  // lanes: 2 active collab lanes to archive, 1 already-archived (skip).
  await pool.query(
    `INSERT INTO ob_session_lanes (session_key, namespace, status, created_by, archived_at)
     VALUES
       ('lane-a', 'collab', 'active', 'rico', NULL),
       ('lane-b', 'collab', 'active', 'rico', NULL),
       ('lane-old', 'collab', 'archived', 'rico', NOW())`,
  );
}

dbDescribe("retire-collab-migration (scratch Postgres)", () => {
  let pool: Pool;

  beforeAll(async () => {
    const admin = new Client({ connectionString: ADMIN_URL });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${SCRATCH_DB}`);
    await admin.end();
    pool = new Pool({ connectionString: scratchUrl(ADMIN_URL!, SCRATCH_DB), max: 2 });
    await seedSchema(pool);
    await seedFixtures(pool);
  });

  afterAll(async () => {
    if (pool) await pool.end();
    const admin = new Client({ connectionString: ADMIN_URL });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`);
    await admin.end();
  });

  it("dry-run reports reconciliation without mutating", async () => {
    const report = await runMigration(pool, {
      execute: false,
      steps: new Set(["thoughts", "entities", "lanes"]),
    });
    expect(report.dry_run).toBe(true);
    expect(report.thoughts?.unmirrored_before).toBe(3);
    expect(report.thoughts?.would_copy).toBe(3);
    expect(report.thoughts?.copied).toBe(0);
    // unchanged after dry-run
    expect(report.thoughts?.unmirrored_after).toBe(3);

    expect(report.entities?.collab_repo_facts).toBe(2);
    expect(report.entities?.would_retag).toBe(1);
    expect(report.entities?.would_archive_conflicts).toBe(1);
    expect(report.entities?.retagged).toBe(0);

    expect(report.lanes?.collab_active_lanes).toBe(2);
    expect(report.lanes?.would_archive).toBe(2);
    expect(report.lanes?.archived).toBe(0);

    // Nothing actually mutated.
    const sharedCount = await pool.query(
      `SELECT COUNT(*)::int AS c FROM thoughts WHERE namespace = 'shared-kb'`,
    );
    expect(sharedCount.rows[0].c).toBe(2);
  });

  it("execute copies un-mirrored thoughts, re-tags/archives entities, archives lanes", async () => {
    const t = await migrateThoughts(pool, true);
    expect(t.copied).toBe(3);
    expect(t.unmirrored_after).toBe(0);

    const e = await migrateEntities(pool, true);
    expect(e.retagged).toBe(1);
    expect(e.archived_conflicts).toBe(1);

    const l = await migrateLanes(pool, true);
    expect(l.archived).toBe(2);

    // shared-kb now has original 2 + 3 copied.
    const shared = await pool.query(
      `SELECT COUNT(*)::int AS c FROM thoughts WHERE namespace = 'shared-kb'`,
    );
    expect(shared.rows[0].c).toBe(5);

    // Provenance preserved on a copied thought.
    const prov = await pool.query(
      `SELECT created_by, created_at FROM thoughts
        WHERE namespace = 'shared-kb' AND content_hash = 'h-uniq-a'`,
    );
    expect(prov.rows[0].created_by).toBe("codex");
    expect(new Date(prov.rows[0].created_at).toISOString()).toBe(
      "2026-02-01T00:00:00.000Z",
    );

    // Collab rows are left in place (frozen snapshot) for thoughts.
    const collab = await pool.query(
      `SELECT COUNT(*)::int AS c FROM thoughts WHERE namespace = 'collab'`,
    );
    expect(collab.rows[0].c).toBe(5);

    // Re-tagged entity moved to shared-kb; conflicting one archived in collab.
    const retagged = await pool.query(
      `SELECT namespace, archived_at FROM ob_entities WHERE name = 'king-core:unique'`,
    );
    expect(retagged.rows[0].namespace).toBe("shared-kb");
    const conflict = await pool.query(
      `SELECT namespace, archived_at FROM ob_entities
        WHERE name = 'king-core:dupe' AND namespace = 'collab'`,
    );
    expect(conflict.rows[0].archived_at).not.toBeNull();

    // Both active lanes archived; previously-archived one untouched.
    const activeLanes = await pool.query(
      `SELECT COUNT(*)::int AS c FROM ob_session_lanes
        WHERE namespace = 'collab' AND archived_at IS NULL`,
    );
    expect(activeLanes.rows[0].c).toBe(0);
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

    // No duplicate shared-kb copies.
    const shared = await pool.query(
      `SELECT COUNT(*)::int AS c FROM thoughts WHERE namespace = 'shared-kb'`,
    );
    expect(shared.rows[0].c).toBe(5);
  });
});
