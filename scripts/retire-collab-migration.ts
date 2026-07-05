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
 * - PRE-FLIGHT AUDIT. Before mutating, the script counts live collab content
 *   in EVERY affected table (all five content tables, non-repo_fact entities,
 *   null-content_hash thoughts, lanes). If it finds live content outside the
 *   migrated scope it FAILS loudly unless `--acknowledge-out-of-scope` is
 *   passed. It never reports success while leaving live-unique rows invisible.
 * - TRANSACTIONAL. The whole `--execute` run happens in a single transaction;
 *   a failure in any step rolls back every step.
 * - NO destructive deletes. Collab rows are left in place (frozen) as the
 *   pre-cutover snapshot. Physical deletion is a separate, later decision.
 * - Parameterized SQL only. Table/column identifiers come from fixed
 *   allowlists in this file, never from arguments.
 * - Idempotent. Re-running is a no-op:
 *     - thoughts: copied into shared-kb keyed on (content_hash, namespace);
 *       the per-namespace partial unique index makes a second copy a
 *       conflict-skip.
 *     - repo_fact entities: re-tag is guarded by active-uniqueness checks on
 *       both (namespace, entity_type, lower(name)) and
 *       (namespace, entity_type, canonical_id); re-tagged rows leave collab
 *       and are not re-processed.
 *     - lanes: archiving sets status='archived' once; archived lanes are
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
 *   2. Run this script dry-run and review the plan + audit + counts.
 *   3. Run with --execute against the CURRENT deployed code.
 *   4. Verify un-mirrored count is 0 and the audit is clean.
 *   5. Deploy the code that removes the legacy fallback.
 */
import { createPool } from "../src/db/pool.ts";

// Canonical values. Kept as literal allowlist constants, not taken from args
// or env, so this script cannot be pointed at arbitrary namespaces/tables.
const LEGACY_NAMESPACE = "collab";
const SHARED_NAMESPACE = "shared-kb";
const REPO_FACT_ENTITY_TYPE = "repo_fact";

/** Content tables affected by the legacy fallback removal (allowlist). */
const CONTENT_TABLES = [
  "thoughts",
  "decisions",
  "relationships",
  "projects",
  "sessions",
] as const;

/**
 * Full copyable column list for `thoughts`, enumerated from the real
 * migrations (001, 002, 003, 006_cognitive_tiering, 011, 016). Excluded on
 * purpose:
 * - `id` (new identity in shared-kb)
 * - `namespace` (explicitly overridden to shared-kb; never rely on the
 *   table default, which is 'collab')
 * - `search_vector` (GENERATED ALWAYS ... STORED)
 * - `parent_id`, `consolidated_into`, `consolidated_from` (self-referencing
 *   thought-id pointers into the frozen collab namespace; copying them would
 *   couple shared-kb rows to collab rows, and `parent_id` is ON DELETE
 *   CASCADE, so a later collab cleanup could cascade-delete shared-kb copies)
 */
const THOUGHT_COPY_COLUMNS = [
  "content",
  "tags",
  "source",
  "created_by",
  "created_at",
  "updated_at",
  "embedding",
  "content_hash",
  "embedded_at",
  "embedding_model",
  "access_count",
  "archived_at",
  "last_accessed_at",
  "usefulness_score",
  "extracted_metadata",
  "tier",
  "chunk_index",
  "promoted_from",
] as const;

type StepName = "thoughts" | "entities" | "lanes";

interface Args {
  execute: boolean;
  acknowledgeOutOfScope: boolean;
  steps: Set<StepName>;
}

interface AuditReport {
  /** Live collab thoughts with no content_hash (cannot hash-reconcile). */
  thoughts_null_hash: number;
  /** Live, un-mirrored collab rows per non-thought content table. */
  unmirrored_by_table: Record<string, number>;
  /** Active collab ob_entities rows that are not repo_facts. */
  entities_non_repo_fact: number;
  /** Sum of everything the migration steps do NOT cover. */
  total_out_of_scope: number;
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
  collab_unarchived_lanes: number;
  archived: number;
  would_archive: number;
}

interface Report {
  dry_run: boolean;
  legacy_namespace: string;
  shared_namespace: string;
  steps: StepName[];
  audit: AuditReport;
  audit_acknowledged: boolean;
  thoughts?: ThoughtsReport;
  entities?: EntitiesReport;
  lanes?: LanesReport;
  started_at: string;
  finished_at: string;
}

/**
 * Anything with pg's query() — a Pool for dry-run, a PoolClient inside the
 * execute transaction.
 */
export interface Queryable {
  query(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: any[]; rowCount?: number | null }>;
}

function usage(exitCode = 2): never {
  console.error(
    [
      "Usage: bun run scripts/retire-collab-migration.ts [--execute]",
      "       [--acknowledge-out-of-scope] [--thoughts] [--entities] [--lanes]",
      "",
      "Dry-run is the DEFAULT. Pass --execute to mutate.",
      "With no step flags all steps run; pass a subset to scope the run.",
      "If the pre-flight audit finds live collab content outside the migrated",
      "scope, --execute refuses to run unless --acknowledge-out-of-scope is",
      "also passed.",
      "Requires DATABASE_URL. Never touches a live DB unless you point",
      "DATABASE_URL at one.",
    ].join("\n"),
  );
  process.exit(exitCode);
}

export function parseArgs(argv: string[]): Args {
  let execute = false;
  let acknowledgeOutOfScope = false;
  const requested = new Set<StepName>();
  for (const arg of argv) {
    if (arg === "--execute") execute = true;
    else if (arg === "--acknowledge-out-of-scope") acknowledgeOutOfScope = true;
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
  return { execute, acknowledgeOutOfScope, steps };
}

async function countScalar(
  db: Queryable,
  sql: string,
  params: unknown[],
): Promise<number> {
  const { rows } = await db.query(sql, params);
  return Number(rows[0]?.count ?? 0);
}

/**
 * Pre-flight audit: count live collab content in every table affected by the
 * fallback removal, not just the tables the steps migrate. Anything counted
 * here as out-of-scope would become invisible after retirement while still
 * being live-unique — the operator must resolve or explicitly acknowledge it
 * before --execute proceeds.
 */
export async function auditOutOfScope(db: Queryable): Promise<AuditReport> {
  const thoughtsNullHash = await countScalar(
    db,
    `SELECT COUNT(*)::int AS count
       FROM thoughts
      WHERE namespace = $1 AND content_hash IS NULL AND archived_at IS NULL`,
    [LEGACY_NAMESPACE],
  );

  const unmirroredByTable: Record<string, number> = {};
  for (const table of CONTENT_TABLES) {
    if (table === "thoughts") continue; // covered by the thoughts step + null-hash count
    // Table name comes from the CONTENT_TABLES allowlist above.
    unmirroredByTable[table] = await countScalar(
      db,
      `SELECT COUNT(*)::int AS count
         FROM ${table} c
        WHERE c.namespace = $1
          AND c.archived_at IS NULL
          AND (
            c.content_hash IS NULL
            OR NOT EXISTS (
              SELECT 1 FROM ${table} s
               WHERE s.namespace = $2 AND s.content_hash = c.content_hash
            )
          )`,
      [LEGACY_NAMESPACE, SHARED_NAMESPACE],
    );
  }

  const entitiesNonRepoFact = await countScalar(
    db,
    `SELECT COUNT(*)::int AS count
       FROM ob_entities
      WHERE namespace = $1 AND entity_type <> $2 AND archived_at IS NULL`,
    [LEGACY_NAMESPACE, REPO_FACT_ENTITY_TYPE],
  );

  const totalOutOfScope =
    thoughtsNullHash +
    entitiesNonRepoFact +
    Object.values(unmirroredByTable).reduce((sum, n) => sum + n, 0);

  return {
    thoughts_null_hash: thoughtsNullHash,
    unmirrored_by_table: unmirroredByTable,
    entities_non_repo_fact: entitiesNonRepoFact,
    total_out_of_scope: totalOutOfScope,
  };
}

/**
 * Step A: copy collab thoughts whose content_hash is not present in shared-kb.
 * Every operational/audit column enumerated in THOUGHT_COPY_COLUMNS is carried
 * over unchanged (created_by/created_at/updated_at/tier/usefulness/embedding/
 * promoted_from/...); only the identity and namespace differ.
 */
export async function migrateThoughts(
  db: Queryable,
  execute: boolean,
): Promise<ThoughtsReport> {
  const collabTotal = await countScalar(
    db,
    `SELECT COUNT(*)::int AS count FROM thoughts WHERE namespace = $1`,
    [LEGACY_NAMESPACE],
  );
  const sharedTotalBefore = await countScalar(
    db,
    `SELECT COUNT(*)::int AS count FROM thoughts WHERE namespace = $1`,
    [SHARED_NAMESPACE],
  );
  const unmirroredSql = `
    SELECT COUNT(*)::int AS count
      FROM thoughts c
     WHERE c.namespace = $1
       AND c.content_hash IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM thoughts s
          WHERE s.namespace = $2 AND s.content_hash = c.content_hash
       )`;
  const unmirroredBefore = await countScalar(db, unmirroredSql, [
    LEGACY_NAMESPACE,
    SHARED_NAMESPACE,
  ]);

  let copied = 0;
  if (execute && unmirroredBefore > 0) {
    const columnList = THOUGHT_COPY_COLUMNS.join(", ");
    const selectList = THOUGHT_COPY_COLUMNS.map((c) => `c.${c}`).join(", ");
    // namespace is set explicitly to shared-kb ($2); never rely on the table
    // default (which is 'collab'). The ON CONFLICT target repeats the partial
    // index predicate so Postgres can infer the (content_hash, namespace)
    // unique index — this is the idempotency guard.
    const { rowCount } = await db.query(
      `INSERT INTO thoughts (${columnList}, namespace)
       SELECT ${selectList}, $2
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

  const unmirroredAfter = await countScalar(db, unmirroredSql, [
    LEGACY_NAMESPACE,
    SHARED_NAMESPACE,
  ]);

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
 * Step B: re-tag collab repo_fact entities to shared-kb. Production enforces
 * TWO active-row unique indexes on ob_entities (017_entity_graph_lifecycle):
 *   (namespace, entity_type, lower(name))  WHERE archived_at IS NULL
 *   (namespace, entity_type, canonical_id) WHERE canonical_id IS NOT NULL
 *                                            AND archived_at IS NULL
 * A collab row that would collide with an active shared-kb row on EITHER key
 * is archived in place instead of re-tagged.
 */
export async function migrateEntities(
  db: Queryable,
  execute: boolean,
): Promise<EntitiesReport> {
  const conflictPredicate = `
    EXISTS (
      SELECT 1 FROM ob_entities s
       WHERE s.namespace = $3 AND s.entity_type = $2
         AND s.archived_at IS NULL
         AND (
           lower(s.name) = lower(c.name)
           OR (
             s.canonical_id IS NOT NULL
             AND c.canonical_id IS NOT NULL
             AND s.canonical_id = c.canonical_id
           )
         )
    )`;

  const collabRepoFacts = await countScalar(
    db,
    `SELECT COUNT(*)::int AS count
       FROM ob_entities
      WHERE namespace = $1 AND entity_type = $2 AND archived_at IS NULL`,
    [LEGACY_NAMESPACE, REPO_FACT_ENTITY_TYPE],
  );

  const conflicting = await countScalar(
    db,
    `SELECT COUNT(*)::int AS count
       FROM ob_entities c
      WHERE c.namespace = $1 AND c.entity_type = $2 AND c.archived_at IS NULL
        AND ${conflictPredicate}`,
    [LEGACY_NAMESPACE, REPO_FACT_ENTITY_TYPE, SHARED_NAMESPACE],
  );
  const retaggable = collabRepoFacts - conflicting;

  let retagged = 0;
  let archivedConflicts = 0;
  if (execute) {
    const conflictRes = await db.query(
      `UPDATE ob_entities c
          SET archived_at = NOW(), updated_at = NOW()
        WHERE c.namespace = $1 AND c.entity_type = $2 AND c.archived_at IS NULL
          AND ${conflictPredicate}`,
      [LEGACY_NAMESPACE, REPO_FACT_ENTITY_TYPE, SHARED_NAMESPACE],
    );
    archivedConflicts = conflictRes.rowCount ?? 0;

    const retagRes = await db.query(
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
 * Step C: archive collab session lanes. ob_session_lanes has NO archived_at
 * column — its lifecycle is `status` ('active'|'wrapped'|'archived') plus
 * `ended_at` (012_session_lanes.sql). Archiving sets status='archived' and
 * stamps ended_at if unset. Already-archived lanes are skipped (idempotent).
 */
export async function migrateLanes(
  db: Queryable,
  execute: boolean,
): Promise<LanesReport> {
  const unarchivedLanes = await countScalar(
    db,
    `SELECT COUNT(*)::int AS count
       FROM ob_session_lanes
      WHERE namespace = $1 AND status <> 'archived'`,
    [LEGACY_NAMESPACE],
  );

  let archived = 0;
  if (execute) {
    const res = await db.query(
      `UPDATE ob_session_lanes
          SET status = 'archived',
              ended_at = COALESCE(ended_at, NOW()),
              updated_at = NOW()
        WHERE namespace = $1 AND status <> 'archived'`,
      [LEGACY_NAMESPACE],
    );
    archived = res.rowCount ?? 0;
  }

  return {
    collab_unarchived_lanes: unarchivedLanes,
    archived,
    would_archive: execute ? 0 : unarchivedLanes,
  };
}

async function runSteps(
  db: Queryable,
  args: Args,
  report: Report,
): Promise<void> {
  if (args.steps.has("thoughts")) {
    report.thoughts = await migrateThoughts(db, args.execute);
  }
  if (args.steps.has("entities")) {
    report.entities = await migrateEntities(db, args.execute);
  }
  if (args.steps.has("lanes")) {
    report.lanes = await migrateLanes(db, args.execute);
  }
}

/**
 * Runs the pre-flight audit and the requested steps. In execute mode the audit
 * gate is enforced first, then every step runs inside ONE transaction so a
 * failure in any step rolls back all of them (nothing is left half-migrated).
 *
 * `pool` must be a pg Pool (exposing connect()) for execute mode; dry-run only
 * needs query().
 */
export async function runMigration(
  pool: Queryable & {
    connect?: () => Promise<Queryable & { release: () => void }>;
  },
  args: Args,
): Promise<Report> {
  const report: Report = {
    dry_run: !args.execute,
    legacy_namespace: LEGACY_NAMESPACE,
    shared_namespace: SHARED_NAMESPACE,
    steps: [...args.steps],
    audit: await auditOutOfScope(pool),
    audit_acknowledged: args.acknowledgeOutOfScope,
    started_at: new Date().toISOString(),
    finished_at: "",
  };

  if (
    args.execute &&
    report.audit.total_out_of_scope > 0 &&
    !args.acknowledgeOutOfScope
  ) {
    throw new Error(
      [
        `Pre-flight audit found ${report.audit.total_out_of_scope} live collab`,
        `row(s) OUTSIDE the migrated scope:`,
        JSON.stringify(report.audit),
        `These would become invisible after retirement while still being`,
        `live-unique. Resolve them (promote/archive) or re-run with`,
        `--acknowledge-out-of-scope to proceed anyway.`,
      ].join(" "),
    );
  }

  if (!args.execute) {
    await runSteps(pool, args, report);
    report.finished_at = new Date().toISOString();
    return report;
  }

  if (typeof pool.connect !== "function") {
    throw new Error("execute mode requires a pg Pool with connect()");
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await runSteps(client, args, report);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
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
    if (report.audit.total_out_of_scope > 0) {
      console.error(
        `\nWARNING: audit found ${report.audit.total_out_of_scope} live collab row(s) outside the migrated scope. See "audit" above.`,
      );
    }
    if (report.dry_run) {
      console.error(
        "\nDRY-RUN complete. No rows were mutated. Re-run with --execute to apply.",
      );
    }
  } finally {
    await pool.end();
  }
}
