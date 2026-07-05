#!/usr/bin/env bun
/**
 * Retire the legacy `collab` namespace (issue #167).
 *
 * shared-kb is canonical; collab is frozen and ~99.4% already mirrored. This
 * script reconciles the remaining live-unique collab content into shared-kb so
 * the legacy read-fallback code path can be safely retired.
 *
 * SAFETY MODEL
 * - DRY-RUN BY DEFAULT. Nothing is mutated unless `--execute` is passed.
 * - NO destructive deletes. Collab rows are left in place (frozen) as the
 *   pre-cutover snapshot. Physical deletion is a separate, later decision.
 * - Parameterized SQL only. Table/column identifiers come from a fixed
 *   allowlist in this file, never from arguments.
 * - Idempotent. Re-running is a no-op:
 *     - thoughts: copied into shared-kb keyed on (content_hash, namespace);
 *       the per-namespace unique index makes a second copy a conflict-skip.
 *     - repo_fact entities: re-tag is guarded by an "already in shared-kb?"
 *       check on (namespace, entity_type, lower(name)); re-tagged rows are no
 *       longer in collab so they are not re-processed.
 *     - lanes: archive sets archived_at once; already-archived lanes are
 *       skipped.
 *
 * STEPS (each independently toggleable):
 *   --thoughts   copy un-mirrored collab thoughts into shared-kb (default on)
 *   --entities   re-tag collab repo_fact entities to shared-kb (default on)
 *   --lanes      archive collab session lanes (default on)
 * Pass any subset explicitly to run only those steps; with none passed all run.
 *
 * MERGE / DEPLOY ORDER (see PR body):
 *   1. Back up the database (pg_dump / snapshot).
 *   2. Run this script dry-run and review the plan + reconciliation counts.
 *   3. Run with --execute against the CURRENT deployed code.
 *   4. Verify un-mirrored count is 0.
 *   5. Deploy the code that removes the legacy fallback.
 */
import { createPool } from "../src/db/pool.ts";

// Canonical target. Kept as a literal allowlist value, not taken from args or
// env, so this script cannot be pointed at an arbitrary namespace/table.
const LEGACY_NAMESPACE = "collab";
const SHARED_NAMESPACE = "shared-kb";
const REPO_FACT_ENTITY_TYPE = "repo_fact";

type StepName = "thoughts" | "entities" | "lanes";

interface Args {
  execute: boolean;
  steps: Set<StepName>;
}

interface ThoughtsReport {
  collab_total: number;
  shared_total_before: number;
  unmirrored_before: number;
  copied: number;
  would_copy: number;
  unmirrored_after: number;
}

interface EntitiesReport {
  collab_repo_facts: number;
  retagged: number;
  would_retag: number;
  archived_conflicts: number;
  would_archive_conflicts: number;
}

interface LanesReport {
  collab_active_lanes: number;
  archived: number;
  would_archive: number;
}

interface Report {
  dry_run: boolean;
  legacy_namespace: string;
  shared_namespace: string;
  steps: StepName[];
  thoughts?: ThoughtsReport;
  entities?: EntitiesReport;
  lanes?: LanesReport;
  started_at: string;
  finished_at: string;
}

type Pool = ReturnType<typeof createPool>;

function usage(exitCode = 2): never {
  console.error(
    [
      "Usage: bun run scripts/retire-collab-migration.ts [--execute]",
      "       [--thoughts] [--entities] [--lanes]",
      "",
      "Dry-run is the DEFAULT. Pass --execute to mutate.",
      "With no step flags all steps run; pass a subset to scope the run.",
      "Requires DATABASE_URL. Never touches a live DB unless you point",
      "DATABASE_URL at one.",
    ].join("\n"),
  );
  process.exit(exitCode);
}

export function parseArgs(argv: string[]): Args {
  let execute = false;
  const requested = new Set<StepName>();
  for (const arg of argv) {
    if (arg === "--execute") execute = true;
    else if (arg === "--thoughts") requested.add("thoughts");
    else if (arg === "--entities") requested.add("entities");
    else if (arg === "--lanes") requested.add("lanes");
    else if (arg === "--help" || arg === "-h") usage(0);
    else {
      console.error(`Unknown argument: ${arg}`);
      usage();
    }
  }
  const steps: Set<StepName> =
    requested.size > 0
      ? requested
      : new Set<StepName>(["thoughts", "entities", "lanes"]);
  return { execute, steps };
}

async function countScalar(
  pool: Pool,
  sql: string,
  params: unknown[],
): Promise<number> {
  const { rows } = await pool.query(sql, params);
  return Number(rows[0]?.count ?? 0);
}

/**
 * Step A: copy collab thoughts whose content_hash is not present in shared-kb.
 * Provenance is preserved: created_by/created_at/tags/source/content_hash are
 * carried over unchanged. updated_at is set to now() to reflect the copy.
 * Embedding is left null so the normal backfill re-embeds under the new
 * namespace (embedding is namespace-independent content, but we do not copy the
 * halfvec blob here to keep the migration schema-simple and let backfill own it).
 */
export async function migrateThoughts(
  pool: Pool,
  execute: boolean,
): Promise<ThoughtsReport> {
  const collabTotal = await countScalar(
    pool,
    `SELECT COUNT(*)::int AS count FROM thoughts WHERE namespace = $1`,
    [LEGACY_NAMESPACE],
  );
  const sharedTotalBefore = await countScalar(
    pool,
    `SELECT COUNT(*)::int AS count FROM thoughts WHERE namespace = $1`,
    [SHARED_NAMESPACE],
  );
  const unmirroredBefore = await countScalar(
    pool,
    `SELECT COUNT(*)::int AS count
       FROM thoughts c
      WHERE c.namespace = $1
        AND c.content_hash IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM thoughts s
           WHERE s.namespace = $2 AND s.content_hash = c.content_hash
        )`,
    [LEGACY_NAMESPACE, SHARED_NAMESPACE],
  );

  let copied = 0;
  if (execute && unmirroredBefore > 0) {
    // ON CONFLICT on the per-namespace (content_hash, namespace) unique index
    // makes this idempotent: a second run copies nothing.
    // namespace is set explicitly to shared-kb ($2) in the column list; we do
    // NOT rely on the table default (which is 'collab'). Provenance columns
    // (created_by/created_at/tags/source/content_hash) are carried over.
    const { rowCount } = await pool.query(
      `INSERT INTO thoughts
         (content, tags, source, created_by, created_at, updated_at,
          content_hash, namespace)
       SELECT c.content, c.tags, c.source, c.created_by, c.created_at, NOW(),
              c.content_hash, $2
         FROM thoughts c
        WHERE c.namespace = $1
          AND c.content_hash IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM thoughts s
             WHERE s.namespace = $2 AND s.content_hash = c.content_hash
          )
       ON CONFLICT (content_hash, namespace) WHERE content_hash IS NOT NULL
         DO NOTHING`,
      [LEGACY_NAMESPACE, SHARED_NAMESPACE],
    );
    copied = rowCount ?? 0;
  }

  const unmirroredAfter = await countScalar(
    pool,
    `SELECT COUNT(*)::int AS count
       FROM thoughts c
      WHERE c.namespace = $1
        AND c.content_hash IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM thoughts s
           WHERE s.namespace = $2 AND s.content_hash = c.content_hash
        )`,
    [LEGACY_NAMESPACE, SHARED_NAMESPACE],
  );

  return {
    collab_total: collabTotal,
    shared_total_before: sharedTotalBefore,
    unmirrored_before: unmirroredBefore,
    copied,
    would_copy: execute ? 0 : unmirroredBefore,
    unmirrored_after: unmirroredAfter,
  };
}

/**
 * Step B: re-tag collab repo_fact entities to shared-kb. If a shared-kb entity
 * of the same (entity_type, lower(name)) already exists and is active, the
 * collab row is archived instead of re-tagged to avoid violating the active
 * unique index.
 */
export async function migrateEntities(
  pool: Pool,
  execute: boolean,
): Promise<EntitiesReport> {
  const collabRepoFacts = await countScalar(
    pool,
    `SELECT COUNT(*)::int AS count
       FROM ob_entities
      WHERE namespace = $1 AND entity_type = $2 AND archived_at IS NULL`,
    [LEGACY_NAMESPACE, REPO_FACT_ENTITY_TYPE],
  );

  const conflicting = await countScalar(
    pool,
    `SELECT COUNT(*)::int AS count
       FROM ob_entities c
      WHERE c.namespace = $1 AND c.entity_type = $2 AND c.archived_at IS NULL
        AND EXISTS (
          SELECT 1 FROM ob_entities s
           WHERE s.namespace = $3 AND s.entity_type = $2
             AND s.archived_at IS NULL
             AND lower(s.name) = lower(c.name)
        )`,
    [LEGACY_NAMESPACE, REPO_FACT_ENTITY_TYPE, SHARED_NAMESPACE],
  );
  const retaggable = collabRepoFacts - conflicting;

  let retagged = 0;
  let archivedConflicts = 0;
  if (execute) {
    const conflictRes = await pool.query(
      `UPDATE ob_entities c
          SET archived_at = NOW(), updated_at = NOW()
        WHERE c.namespace = $1 AND c.entity_type = $2 AND c.archived_at IS NULL
          AND EXISTS (
            SELECT 1 FROM ob_entities s
             WHERE s.namespace = $3 AND s.entity_type = $2
               AND s.archived_at IS NULL
               AND lower(s.name) = lower(c.name)
          )`,
      [LEGACY_NAMESPACE, REPO_FACT_ENTITY_TYPE, SHARED_NAMESPACE],
    );
    archivedConflicts = conflictRes.rowCount ?? 0;

    const retagRes = await pool.query(
      `UPDATE ob_entities
          SET namespace = $3, updated_at = NOW()
        WHERE namespace = $1 AND entity_type = $2 AND archived_at IS NULL`,
      [LEGACY_NAMESPACE, REPO_FACT_ENTITY_TYPE, SHARED_NAMESPACE],
    );
    retagged = retagRes.rowCount ?? 0;
  }

  return {
    collab_repo_facts: collabRepoFacts,
    retagged,
    would_retag: execute ? 0 : retaggable,
    archived_conflicts: archivedConflicts,
    would_archive_conflicts: execute ? 0 : conflicting,
  };
}

/**
 * Step C: archive collab session lanes. Lanes are ephemeral coordination
 * state; the issue's decision is archive (not re-tag). Already-archived lanes
 * are skipped, making this idempotent.
 */
export async function migrateLanes(
  pool: Pool,
  execute: boolean,
): Promise<LanesReport> {
  const activeLanes = await countScalar(
    pool,
    `SELECT COUNT(*)::int AS count
       FROM ob_session_lanes
      WHERE namespace = $1 AND archived_at IS NULL`,
    [LEGACY_NAMESPACE],
  );

  let archived = 0;
  if (execute) {
    const res = await pool.query(
      `UPDATE ob_session_lanes
          SET archived_at = NOW(), status = 'archived', updated_at = NOW()
        WHERE namespace = $1 AND archived_at IS NULL`,
      [LEGACY_NAMESPACE],
    );
    archived = res.rowCount ?? 0;
  }

  return {
    collab_active_lanes: activeLanes,
    archived,
    would_archive: execute ? 0 : activeLanes,
  };
}

export async function runMigration(pool: Pool, args: Args): Promise<Report> {
  const report: Report = {
    dry_run: !args.execute,
    legacy_namespace: LEGACY_NAMESPACE,
    shared_namespace: SHARED_NAMESPACE,
    steps: [...args.steps],
    started_at: new Date().toISOString(),
    finished_at: "",
  };

  if (args.steps.has("thoughts")) {
    report.thoughts = await migrateThoughts(pool, args.execute);
  }
  if (args.steps.has("entities")) {
    report.entities = await migrateEntities(pool, args.execute);
  }
  if (args.steps.has("lanes")) {
    report.lanes = await migrateLanes(pool, args.execute);
  }

  report.finished_at = new Date().toISOString();
  return report;
}

if (import.meta.main) {
  const args = parseArgs(Bun.argv.slice(2));
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is required.");
    process.exit(1);
  }
  const pool = createPool({
    max: 2,
    statement_timeout: 60000,
    application_name: "openbrain-retire-collab",
  });
  try {
    const report = await runMigration(pool, args);
    console.log(JSON.stringify(report, null, 2));
    if (report.dry_run) {
      console.error(
        "\nDRY-RUN complete. No rows were mutated. Re-run with --execute to apply.",
      );
    }
  } finally {
    await pool.end();
  }
}
