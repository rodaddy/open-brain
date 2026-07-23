import { z } from "zod";
import { createHash } from "node:crypto";
import type pg from "pg";
import { logger } from "./logger.ts";
import { canWriteNamespace } from "./namespace-policy.ts";
import { physicalNamespace } from "./shared-namespace.ts";
import { SOURCE_REGISTRY_TABLE } from "./source-registry.ts";
import type { AuthInfo } from "./types.ts";

/**
 * Resumable file-source synchronization (Issue #338, FILE-SYNC).
 *
 * Reconciles the set of files a collector OBSERVED under a registered git
 * repository / directory (migration 027, ob_sources) against the durable,
 * content-free file manifest (migration 030, ob_source_files), producing an
 * ordered add/edit/rename/delete plan and applying it under a persisted
 * checkpoint (ob_source_sync_runs) so an interrupted run resumes exactly where
 * it stopped and re-applies its tail idempotently (at-least-once) without ever
 * duplicating manifest state.
 *
 * Scope (deliberately narrow — see #338 non-goals):
 *  - This owns MANIFEST reconciliation + checkpointing only. It does not walk a
 *    filesystem, ingest bodies, run the scheduler (#342), the drop collector
 *    (#339), conversation ingestion (#340), or FTS (#341). The caller hands it a
 *    content-free observation (path + content_hash per file); how those bytes
 *    were read and hashed is the collector's job (hashSourceContent lives in
 *    source-registry.ts and produces exactly the digest this module expects).
 *
 * Invariants:
 *  - Durable identity survives renames. Each manifest row's file_id is minted
 *    once and preserved when a file moves paths: a vanished path whose
 *    content_hash reappears at a new path is a RENAME (in-place path update on
 *    the same file_id), not a delete+add. So references keyed on file_id stay
 *    valid across a rename.
 *  - Exact namespace + scope inheritance. Every manifest / run row copies the
 *    owning source's namespace and scope verbatim; every read and mutation is
 *    namespace-qualified and gated by canWriteNamespace. Two namespaces that
 *    registered the same external location keep separate manifests.
 *  - Idempotent at-least-once resume. The plan is deterministic and keyed to the
 *    observation; every op is applied guarded so re-applying the boundary op
 *    after a crash is a no-op. A resumed run and an uninterrupted run over the
 *    same observation converge to the SAME manifest with no duplicates.
 *  - Content-free throughout. Paths and content_hash are opaque locators/digests,
 *    never bodies; receipts and logs carry ids, counts, hashes, and states only.
 */

const SOURCE_FILES_TABLE = "ob_source_files" as const;
const SYNC_RUNS_TABLE = "ob_source_sync_runs" as const;

const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

// Upper bounds so one observation cannot plan an unbounded run. A source with
// more observed files than this is rejected up front (content-free), rather than
// silently truncated.
const MAX_OBSERVED_FILES = 50_000;
const MAX_PATH_LENGTH = 4096;

/**
 * One content-free observation of a file the collector read: an opaque path and
 * the lowercase sha256 hex digest of its content. Never a body.
 */
export const observedFileSchema = z
  .object({
    path: z.string().trim().min(1).max(MAX_PATH_LENGTH),
    content_hash: z.string().regex(SHA256_HEX_RE),
  })
  .strict();

export type ObservedFile = z.infer<typeof observedFileSchema>;

/** The full content-free observation for one source sync. */
export const sourceObservationSchema = z
  .object({
    files: z.array(observedFileSchema).max(MAX_OBSERVED_FILES),
  })
  .strict();

export type SourceObservation = z.infer<typeof sourceObservationSchema>;

export type SyncOpKind = "add" | "edit" | "rename" | "delete";

/**
 * One content-free reconciliation op. file_id is the DURABLE identity: existing
 * for edit/rename/delete, freshly minted at PLAN time for add (so it is stable
 * across a resume — the plan is persisted before any op is applied). path/hash
 * describe the target state; prev_path is retained on a rename purely as
 * content-free provenance.
 */
export interface SyncOp {
  kind: SyncOpKind;
  file_id: string;
  path: string;
  content_hash: string;
  prev_path?: string;
}

/** A live manifest row as this module reads it. Content-free. */
interface ManifestFile {
  file_id: string;
  path: string;
  content_hash: string;
}

export type SyncRunStatus = "running" | "completed";

/**
 * Content-free result of a sync. Structural counts + the run identity and the
 * content-free hashes only; never a path body or file content.
 */
export interface SyncReceipt {
  run_id: string;
  source_id: string;
  namespace: string;
  observation_hash: string;
  status: SyncRunStatus;
  /** Ops in the plan and how many were applied THIS invocation. */
  planned_ops: number;
  applied_ops: number;
  /**
   * Whether this invocation resumed an already-persisted run (a run row for this
   * exact observation existed). A resumed run re-reads the persisted ordered plan
   * and finishes its tail idempotently; it does not re-diff the manifest, so on a
   * resume `counts.unchanged` is 0 (the fresh-plan no-op count is not recomputed).
   */
  resumed: boolean;
  counts: {
    added: number;
    edited: number;
    renamed: number;
    deleted: number;
    /**
     * Same-path/same-hash files that produced no op when the observation was
     * FIRST planned (fresh plan only). 0 on a resumed invocation — see `resumed`.
     */
    unchanged: number;
  };
}

export type SyncResultCode =
  | "namespace_denied"
  | "source_not_found"
  | "source_not_eligible"
  | "invalid_observation"
  // A dependency (Postgres, the pool) failed mid-transaction. The transaction is
  // rolled back and this stable, content-free code is returned instead of the raw
  // driver error, so no caller ever sees a body, SQL text, or connection detail.
  | "sync_failed";

export interface SyncResult {
  ok: boolean;
  code?: SyncResultCode;
  reason?: string;
  data?: SyncReceipt;
}

/** Minimal client surface: the sync runs every statement through this client. */
type SyncClient = Pick<pg.PoolClient, "query">;

/**
 * Canonical, order-insensitive digest of an observation. Two collectors that
 * observed the same file set in any order produce the same hash, so re-planning
 * the same corpus resolves to the same run row (idempotent planning). Deriving
 * it from (path, content_hash) pairs — never bodies — keeps it content-free.
 *
 * Encoding is text-clean and collision-safe: each pair is serialized as a JSON
 * 2-tuple `[path, content_hash]`, so any character that could appear inside a
 * path is escaped by JSON rather than fused with a neighbouring field. There is
 * NO raw control-byte separator (an earlier NUL delimiter here made this source
 * a Git binary blob and defeated line diff/blame/review), and no ambiguous
 * plain-string join where e.g. `["ab", h]` and `["a", "b" + h]` could collide.
 */
export function observationHash(observation: SourceObservation): string {
  const canonical = observation.files
    .map((f) => JSON.stringify([f.path, f.content_hash]))
    .sort();
  const payload = JSON.stringify({ v: 1, files: canonical });
  return createHash("sha256").update(payload).digest("hex");
}

/**
 * Deterministically reconcile the persisted live manifest against the observed
 * file set into an ordered op plan. Pure and content-free — no I/O, no bodies.
 *
 * Matching order (each file matched at most once):
 *  1. Same path in both — 'edit' if the content_hash changed, otherwise a no-op
 *     (counted as unchanged, no op emitted).
 *  2. A live file whose path VANISHED whose content_hash reappears at a NEW
 *     observed path — 'rename': the durable file_id moves to the new path. Hash
 *     collisions are matched greedily and one-to-one so identity is never split
 *     or duplicated.
 *  3. A remaining observed path with no identity yet — 'add': mint a fresh
 *     file_id at plan time so it survives a resume.
 *  4. A remaining live file whose path is gone with no hash match — 'delete'.
 *
 * `mintId` supplies a fresh durable id for an add; injected so tests are
 * deterministic and the same plan is reproducible when re-persisted on resume.
 * The emitted order (edits, renames, deletes, adds) is stable; applying it in
 * order never transiently violates the one-live-file-per-path uniqueness because
 * a rename's destination path was freed by step 1/2/4 processing, and deletes
 * that free a path precede the adds/renames that might reuse it.
 */
export function planReconciliation(
  manifest: ManifestFile[],
  observation: SourceObservation,
  mintId: () => string,
): { ops: SyncOp[]; unchanged: number } {
  const liveByPath = new Map<string, ManifestFile>();
  for (const file of manifest) liveByPath.set(file.path, file);

  // content_hash -> queue of live files at that hash whose path has vanished,
  // available to absorb a rename. Populated lazily below.
  const vanishedByHash = new Map<string, ManifestFile[]>();

  const edits: SyncOp[] = [];
  const renames: SyncOp[] = [];
  const deletes: SyncOp[] = [];
  const adds: SyncOp[] = [];
  let unchanged = 0;

  // Pass 1: same-path matches (edit / no-op). Consumed live files are removed
  // from liveByPath; the survivors are the ones whose path vanished.
  const observedNeedingIdentity: ObservedFile[] = [];
  for (const observed of observation.files) {
    const live = liveByPath.get(observed.path);
    if (live) {
      liveByPath.delete(observed.path);
      if (live.content_hash === observed.content_hash) {
        unchanged += 1;
      } else {
        edits.push({
          kind: "edit",
          file_id: live.file_id,
          path: observed.path,
          content_hash: observed.content_hash,
        });
      }
    } else {
      observedNeedingIdentity.push(observed);
    }
  }

  // The live files left in liveByPath are the vanished ones — index by hash so a
  // reappearing hash can claim one as a rename source.
  for (const live of liveByPath.values()) {
    const queue = vanishedByHash.get(live.content_hash);
    if (queue) queue.push(live);
    else vanishedByHash.set(live.content_hash, [live]);
  }

  // Pass 2: observed paths with no same-path match — rename (hash matches a
  // vanished file) or add (fresh identity).
  for (const observed of observedNeedingIdentity) {
    const queue = vanishedByHash.get(observed.content_hash);
    const renameSource = queue && queue.length > 0 ? queue.shift() : undefined;
    if (renameSource) {
      renames.push({
        kind: "rename",
        file_id: renameSource.file_id,
        path: observed.path,
        content_hash: observed.content_hash,
        prev_path: renameSource.path,
      });
    } else {
      adds.push({
        kind: "add",
        file_id: mintId(),
        path: observed.path,
        content_hash: observed.content_hash,
      });
    }
  }

  // Pass 3: any vanished live file not claimed by a rename is a delete.
  for (const queue of vanishedByHash.values()) {
    for (const live of queue) {
      deletes.push({
        kind: "delete",
        file_id: live.file_id,
        path: live.path,
        content_hash: live.content_hash,
      });
    }
  }

  // Deterministic emission order: edits and deletes (which free paths) before
  // renames and adds (which may reuse a freed path). Within each bucket, sort by
  // the durable file_id so the plan is byte-identical when re-derived on resume.
  const byFileId = (a: SyncOp, b: SyncOp): number =>
    a.file_id < b.file_id ? -1 : a.file_id > b.file_id ? 1 : 0;
  edits.sort(byFileId);
  deletes.sort(byFileId);
  renames.sort(byFileId);
  adds.sort(byFileId);

  return { ops: [...edits, ...deletes, ...renames, ...adds], unchanged };
}

const opSchema = z
  .object({
    kind: z.enum(["add", "edit", "rename", "delete"]),
    file_id: z.string().uuid(),
    path: z.string().min(1).max(MAX_PATH_LENGTH),
    content_hash: z.string().regex(SHA256_HEX_RE),
    prev_path: z.string().min(1).max(MAX_PATH_LENGTH).optional(),
  })
  .strict();

const planSchema = z.array(opSchema);

interface RunRow {
  id: string;
  namespace: string;
  scope: Record<string, string>;
  observation_hash: string;
  plan: SyncOp[];
  checkpoint_index: number;
  status: SyncRunStatus;
}

/**
 * Read the source's identity/eligibility row, namespace-bound, and SERIALIZE all
 * concurrent syncs of this exact source on it. Returns the source's namespace +
 * scope (which every manifest/run row inherits) when the source is registered,
 * approved, and active. Content-free rejections only.
 *
 * Serialization contract (#338): this takes a `FOR UPDATE` row lock on the exact
 * (id, namespace) eligible source row. It runs inside syncSource's transaction,
 * BEFORE the manifest is read and the plan diffed, and the lock is held until that
 * transaction COMMITs. So two concurrent syncs of one source cannot both read the
 * same manifest, plan disjoint mutations, and commit a hybrid corpus neither
 * caller observed: the second sync blocks here until the first commits, then plans
 * against the manifest the first already produced. `FOR UPDATE` is safe because
 * the predicate pins one row by primary key + namespace (no lock escalation, no
 * cross-namespace contention), and it never regresses a checkpoint because the
 * losing writer's read happens strictly after the winner's commit.
 */
async function loadEligibleSource(
  client: SyncClient,
  namespace: string,
  sourceId: string,
): Promise<
  | { ok: true; scope: Record<string, string> }
  | { ok: false; code: SyncResultCode; reason: string }
> {
  const { rows } = await client.query(
    `SELECT scope, approval_state, lifecycle_state
       FROM ${SOURCE_REGISTRY_TABLE}
      WHERE id = $1 AND namespace = $2
        AND source_kind IN ('git', 'directory')
      FOR UPDATE`,
    [sourceId, namespace],
  );
  if (rows.length === 0) {
    return {
      ok: false,
      code: "source_not_found",
      reason:
        "source is not a registered git/directory source in this namespace",
    };
  }
  const row = rows[0];
  if (row.approval_state !== "approved" || row.lifecycle_state !== "active") {
    return {
      ok: false,
      code: "source_not_eligible",
      reason: "source is not approved and active",
    };
  }
  return { ok: true, scope: (row.scope as Record<string, string>) ?? {} };
}

/**
 * Load the live manifest for a source, namespace-bound. Only 'live' rows feed
 * reconciliation; 'deleted' rows are retained for provenance but are not part of
 * the current corpus.
 */
async function loadLiveManifest(
  client: SyncClient,
  namespace: string,
  sourceId: string,
): Promise<ManifestFile[]> {
  const { rows } = await client.query(
    `SELECT file_id, path, content_hash
       FROM ${SOURCE_FILES_TABLE}
      WHERE source_id = $1 AND namespace = $2 AND state = 'live'
      ORDER BY file_id ASC`,
    [sourceId, namespace],
  );
  return rows.map((r) => ({
    file_id: r.file_id as string,
    path: r.path as string,
    content_hash: r.content_hash as string,
  }));
}

/**
 * Resolve the sync run for (source, observation): resume the existing RUNNING row
 * if one is present (crash before completion), otherwise plan fresh and persist
 * the plan BEFORE any op is applied.
 *
 * Run identity is RUNNING-ONLY (#338). A 'completed' run is terminal, immutable
 * history — its checkpoint sits at plan-end, so reopening it would only re-apply
 * its tail and could never reconcile a manifest that has since diverged. So only
 * a status='running' row is resumable: a fresh observation that happens to match a
 * completed run's hash (e.g. a revert A -> B -> A) plans a NEW run against the
 * CURRENT manifest and leaves the old completed run intact as history. The partial
 * unique index (source_id, observation_hash) WHERE status='running' makes
 * concurrent planners converge on one running row. Returns the run and whether it
 * was resumed.
 */
async function resolveRun(
  client: SyncClient,
  namespace: string,
  scope: Record<string, string>,
  sourceId: string,
  observation: SourceObservation,
): Promise<{ run: RunRow; resumed: boolean; unchanged: number }> {
  const obsHash = observationHash(observation);

  // A RUNNING run for this exact observation already exists — resume it. Completed
  // runs are immutable history and are deliberately excluded. Namespace-bound.
  const existing = await client.query(
    `SELECT id, namespace, scope, observation_hash, plan, checkpoint_index, status
       FROM ${SYNC_RUNS_TABLE}
      WHERE source_id = $1 AND namespace = $2 AND observation_hash = $3
        AND status = 'running'`,
    [sourceId, namespace, obsHash],
  );
  if (existing.rows.length > 0) {
    return { run: mapRun(existing.rows[0]), resumed: true, unchanged: 0 };
  }

  // Plan fresh against the live manifest, then persist the plan up front so a
  // crash mid-apply resumes the identical ordered plan (adds keep their minted
  // file_id because it lives in the persisted plan, not re-minted on resume).
  const manifest = await loadLiveManifest(client, namespace, sourceId);
  const { ops, unchanged } = planReconciliation(manifest, observation, () =>
    randomUuid(),
  );

  // Insert the run. ON CONFLICT targets the PARTIAL running-only unique index, so
  // it only fires against a concurrent planner's still-RUNNING row for the same
  // (source_id, observation_hash) — a completed history row with the same hash is
  // outside the index and never blocks this insert. On conflict we re-read and
  // resume the other planner's running row rather than forking a duplicate plan.
  const inserted = await client.query(
    `INSERT INTO ${SYNC_RUNS_TABLE}
       (source_id, namespace, scope, observation_hash, plan, checkpoint_index, status)
     VALUES ($1, $2, $3::jsonb, $4, $5::jsonb, 0, 'running')
     ON CONFLICT (source_id, observation_hash) WHERE status = 'running' DO NOTHING
     RETURNING id, namespace, scope, observation_hash, plan, checkpoint_index, status`,
    [sourceId, namespace, JSON.stringify(scope), obsHash, JSON.stringify(ops)],
  );
  if (inserted.rows.length > 0) {
    return { run: mapRun(inserted.rows[0]), resumed: false, unchanged };
  }

  // Lost the insert race: read and resume the RUNNING row the other planner
  // committed (the only kind the partial index could have conflicted on).
  const raced = await client.query(
    `SELECT id, namespace, scope, observation_hash, plan, checkpoint_index, status
       FROM ${SYNC_RUNS_TABLE}
      WHERE source_id = $1 AND namespace = $2 AND observation_hash = $3
        AND status = 'running'`,
    [sourceId, namespace, obsHash],
  );
  return { run: mapRun(raced.rows[0]), resumed: true, unchanged: 0 };
}

function mapRun(row: Record<string, unknown>): RunRow {
  const plan = planSchema.parse(row.plan ?? []);
  return {
    id: row.id as string,
    namespace: row.namespace as string,
    scope: (row.scope as Record<string, string>) ?? {},
    observation_hash: row.observation_hash as string,
    plan,
    checkpoint_index: row.checkpoint_index as number,
    status: row.status as SyncRunStatus,
  };
}

/**
 * Apply one reconciliation op idempotently and namespace-bound. Every mutation
 * is keyed on the durable file_id and is a no-op when the manifest already
 * reflects the op's target state, so re-applying the boundary op after a crash
 * (at-least-once) never duplicates or double-counts. Returns whether the op
 * caused a durable change (for the receipt counts).
 */
async function applyOp(
  client: SyncClient,
  namespace: string,
  scope: Record<string, string>,
  sourceId: string,
  runId: string,
  op: SyncOp,
): Promise<boolean> {
  switch (op.kind) {
    case "add": {
      // Insert the durable identity at its planned file_id. A resume re-runs the
      // same INSERT; the file_id PK collision makes it a no-op (idempotent), and
      // it re-asserts live state if a prior partial run left it. Namespace/scope
      // are inherited from the source, not the caller.
      const res = await client.query(
        `INSERT INTO ${SOURCE_FILES_TABLE}
           (file_id, source_id, namespace, scope, path, content_hash, state, last_run_id)
         VALUES ($1, $2, $3, $4::jsonb, $5, $6, 'live', $7)
         ON CONFLICT (file_id) DO UPDATE SET
           path = EXCLUDED.path,
           content_hash = EXCLUDED.content_hash,
           state = 'live',
           last_run_id = EXCLUDED.last_run_id,
           revision = ${SOURCE_FILES_TABLE}.revision + 1,
           updated_at = NOW()
         WHERE ${SOURCE_FILES_TABLE}.namespace = $3
           AND (${SOURCE_FILES_TABLE}.state <> 'live'
                OR ${SOURCE_FILES_TABLE}.path <> EXCLUDED.path
                OR ${SOURCE_FILES_TABLE}.content_hash <> EXCLUDED.content_hash
                OR ${SOURCE_FILES_TABLE}.last_run_id IS DISTINCT FROM EXCLUDED.last_run_id)
         RETURNING (xmax = 0) AS is_new`,
        [
          op.file_id,
          sourceId,
          namespace,
          JSON.stringify(scope),
          op.path,
          op.content_hash,
          runId,
        ],
      );
      return res.rows.length > 0;
    }
    case "edit": {
      // Move the same file_id to the new content_hash in place. Guarded so a
      // replay that finds the hash already applied changes nothing.
      const res = await client.query(
        `UPDATE ${SOURCE_FILES_TABLE}
            SET content_hash = $3, state = 'live', last_run_id = $4,
                revision = revision + 1, updated_at = NOW()
          WHERE file_id = $1 AND namespace = $2
            AND (content_hash <> $3 OR state <> 'live' OR last_run_id IS DISTINCT FROM $4)
          RETURNING file_id`,
        [op.file_id, namespace, op.content_hash, runId],
      );
      return res.rows.length > 0;
    }
    case "rename": {
      // Move the durable file_id to the new path (identity preserved). Guarded on
      // the destination path so a replay is a no-op. content_hash is re-asserted
      // too (a rename may coincide with an edit at the collector).
      const res = await client.query(
        `UPDATE ${SOURCE_FILES_TABLE}
            SET path = $3, content_hash = $4, state = 'live', last_run_id = $5,
                revision = revision + 1, updated_at = NOW()
          WHERE file_id = $1 AND namespace = $2
            AND (path <> $3 OR content_hash <> $4 OR state <> 'live'
                 OR last_run_id IS DISTINCT FROM $5)
          RETURNING file_id`,
        [op.file_id, namespace, op.path, op.content_hash, runId],
      );
      return res.rows.length > 0;
    }
    case "delete": {
      // Soft-delete: retire the identity row but keep it for provenance and
      // re-add recognition. Guarded so a replay of an already-deleted row is a
      // no-op and never re-bumps the revision.
      const res = await client.query(
        `UPDATE ${SOURCE_FILES_TABLE}
            SET state = 'deleted', last_run_id = $3,
                revision = revision + 1, updated_at = NOW()
          WHERE file_id = $1 AND namespace = $2 AND state = 'live'
          RETURNING file_id`,
        [op.file_id, namespace, runId],
      );
      return res.rows.length > 0;
    }
  }
}

/**
 * The maximum number of ops one invocation applies before returning. A run whose
 * plan exceeds this returns still-'running'; the next call resumes from the
 * persisted checkpoint. Keeps a single call bounded without losing progress.
 */
const DEFAULT_APPLY_BUDGET = 5_000;

export interface SyncSourceOptions {
  target_namespace?: string;
  /** Max ops to apply this invocation (resume continues the rest). */
  apply_budget?: number;
}

/**
 * Reconcile and resume a registered git/directory source against a content-free
 * observation. Namespace/scope are inherited from the source registry row and
 * gated by canWriteNamespace. The whole reconciliation runs in ONE transaction
 * on a checked-out client: the plan is persisted, then each op is applied and
 * the checkpoint advanced, so a crash resumes from the last committed op and the
 * idempotent apply makes the boundary op safe to re-run. A resumed run and an
 * uninterrupted run over the same observation reach the SAME manifest.
 *
 * Transaction ownership: this function owns BEGIN/COMMIT/ROLLBACK on the client
 * it checks out. Everything — eligibility read, plan persist, op applies,
 * checkpoint advance, completion mark — commits together, so the manifest is
 * never left half-reconciled against a fully-advanced checkpoint.
 */
export async function syncSource(
  pool: Pick<pg.Pool, "connect">,
  auth: AuthInfo,
  sourceId: string,
  rawObservation: unknown,
  options: SyncSourceOptions = {},
): Promise<SyncResult> {
  const namespace = physicalNamespace(
    options.target_namespace ?? auth.clientId,
  );
  const nsCheck = canWriteNamespace(auth, namespace);
  if (!nsCheck.allowed) {
    return { ok: false, code: "namespace_denied", reason: nsCheck.reason };
  }

  const parsed = sourceObservationSchema.safeParse(rawObservation);
  if (!parsed.success) {
    return {
      ok: false,
      code: "invalid_observation",
      reason:
        "observation must be a content-free {path, content_hash} file set",
    };
  }
  const observation = parsed.data;

  // Reject duplicate observed paths BEFORE any planning or mutation. Two ops for
  // the same live path would collide on the one-live-file-per-path unique index
  // and, because the plan is persisted under the observation hash, that same
  // observation would fail forever (a poison run). Content-free rejection: report
  // the count of collisions, never the offending path strings. Zero DB work has
  // happened yet, so this cannot leave partial state.
  const duplicatePaths = countDuplicatePaths(observation);
  if (duplicatePaths > 0) {
    return {
      ok: false,
      code: "invalid_observation",
      reason: "observation contains duplicate file paths",
    };
  }

  const budget = boundedBudget(options.apply_budget);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const source = await loadEligibleSource(client, namespace, sourceId);
    if (!source.ok) {
      await client.query("ROLLBACK");
      return { ok: false, code: source.code, reason: source.reason };
    }

    const { run, resumed, unchanged } = await resolveRun(
      client,
      namespace,
      source.scope,
      sourceId,
      observation,
    );

    // `unchanged` is a fresh-plan quantity: it is the number of same-path,
    // same-hash files that produced NO op when this observation was first planned.
    // A resumed invocation re-reads the persisted plan (which never contained the
    // no-op files) rather than re-diffing the manifest, so resolveRun reports
    // unchanged=0 on resume and the receipt carries 0 accordingly. add/edit/
    // rename/delete are tallied from ops actually applied THIS invocation.
    const counts = {
      added: 0,
      edited: 0,
      renamed: 0,
      deleted: 0,
      unchanged,
    };
    let applied = 0;
    let index = run.checkpoint_index;
    // Re-apply from ONE before the checkpoint so the last op the previous run may
    // have applied-without-committing-the-cursor is safely (idempotently) redone.
    // clamp to 0. This is what makes resume at-least-once rather than at-most-once.
    let cursor = Math.max(index - 1, 0);

    while (cursor < run.plan.length && applied < budget) {
      const op = run.plan[cursor];
      if (!op) break;
      const changed = await applyOp(
        client,
        namespace,
        run.scope,
        sourceId,
        run.id,
        op,
      );
      if (changed) tallyOp(counts, op.kind);
      cursor += 1;
      applied += 1;
      // Advance the persisted checkpoint monotonically to the furthest applied op.
      if (cursor > index) {
        index = cursor;
        await client.query(
          `UPDATE ${SYNC_RUNS_TABLE}
              SET checkpoint_index = $3, updated_at = NOW()
            WHERE id = $1 AND namespace = $2`,
          [run.id, namespace, index],
        );
      }
    }

    const complete = index >= run.plan.length;
    if (complete && run.status !== "completed") {
      await client.query(
        `UPDATE ${SYNC_RUNS_TABLE}
            SET status = 'completed', updated_at = NOW()
          WHERE id = $1 AND namespace = $2`,
        [run.id, namespace],
      );
    }

    await client.query("COMMIT");

    logger.info("source_sync_ok", {
      source_kind_scope: "git_directory",
      status: complete ? "completed" : "running",
      planned_ops: run.plan.length,
      applied_ops: applied,
      resumed,
      added: counts.added,
      edited: counts.edited,
      renamed: counts.renamed,
      deleted: counts.deleted,
    });

    return {
      ok: true,
      data: {
        run_id: run.id,
        source_id: sourceId,
        namespace,
        observation_hash: run.observation_hash,
        status: complete ? "completed" : "running",
        planned_ops: run.plan.length,
        applied_ops: applied,
        resumed,
        counts,
      },
    };
  } catch (err) {
    // Content-free failure boundary. The transaction is rolled back atomically
    // (nothing partial commits), and instead of rethrowing the raw dependency
    // error — which for a pg error would carry SQL text, parameter values, table
    // detail, and connection info — we log ONLY the allowlisted error class name
    // and SQLSTATE code, then return a stable content-free `sync_failed` result.
    await client.query("ROLLBACK").catch(() => undefined);
    const safe = contentFreeErrorLabel(err);
    logger.error("source_sync_failed", {
      source_kind_scope: "git_directory",
      error_name: safe.name,
      error_code: safe.code,
    });
    return { ok: false, code: "sync_failed", reason: "sync failed" };
  } finally {
    client.release();
  }
}

function tallyOp(counts: SyncReceipt["counts"], kind: SyncOpKind): void {
  if (kind === "add") counts.added += 1;
  else if (kind === "edit") counts.edited += 1;
  else if (kind === "rename") counts.renamed += 1;
  else if (kind === "delete") counts.deleted += 1;
}

// The ONLY error class names this substrate will ever emit. Membership is decided
// off the reliable error CLASS (constructor), never off an attacker-mutable
// `.name` STRING field: a leaky dependency can assign any class-name-shaped
// alphanumeric token (a secret, an id, a codename) to `error.name`, and the old
// pattern-based acceptance would have logged it verbatim. Anything whose
// constructor is not on this finite allowlist collapses to the constant 'other'.
const KNOWN_ERROR_CLASSES = new Set<string>([
  "Error",
  "TypeError",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "EvalError",
  "URIError",
  "AggregateError",
  "DatabaseError", // pg's error class
]);

const UNKNOWN_ERROR_LABEL = "other" as const;

// Extract ONLY a stable, content-free label from a thrown dependency error: the
// error class name (allowlisted) and (for pg errors) the SQLSTATE `code`.
// Deliberately reads no `message`, `detail`, `hint`, `query`, `where`, or `name`
// string field — those can echo path/content bytes, SQL text, or an attacker-
// planted sentinel, which must never leave this substrate.
//
// The class name is derived from the constructor and validated against the finite
// KNOWN_ERROR_CLASSES allowlist; an unknown class (or a non-object throw) maps to
// the constant 'other', so no caller-influenced byte reaches the log. SQLSTATE is
// a fixed 5-char alphanumeric code and is preserved when it conforms.
function contentFreeErrorLabel(err: unknown): { name: string; code: string } {
  let name: string = UNKNOWN_ERROR_LABEL;
  let code = "unknown";
  if (err && typeof err === "object") {
    // Class off the constructor, NOT the mutable `.name` string field.
    const ctorName = (err as { constructor?: { name?: unknown } }).constructor
      ?.name;
    if (typeof ctorName === "string" && KNOWN_ERROR_CLASSES.has(ctorName)) {
      name = ctorName;
    }
    // pg SQLSTATE is always exactly 5 alphanumerics (e.g. 23505). Reject anything
    // else so a driver that stuffs a string into `code` cannot leak content.
    const rec = err as { code?: unknown };
    if (typeof rec.code === "string" && /^[0-9A-Za-z]{5}$/.test(rec.code)) {
      code = rec.code;
    }
  }
  return { name, code };
}

// Count observed paths that appear more than once. Content-free: returns a count
// only, never the colliding path values. A source is expected to observe each
// path at most once; a duplicate is a malformed observation, not a plan input.
function countDuplicatePaths(observation: SourceObservation): number {
  const seen = new Set<string>();
  let duplicates = 0;
  for (const file of observation.files) {
    if (seen.has(file.path)) duplicates += 1;
    else seen.add(file.path);
  }
  return duplicates;
}

function boundedBudget(requested?: number): number {
  if (requested === undefined) return DEFAULT_APPLY_BUDGET;
  const n = Math.trunc(requested);
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(n, DEFAULT_APPLY_BUDGET);
}

// Fresh durable id for an added file. Minted once at plan time and persisted in
// the plan, so a resume reuses the same id rather than re-minting (which would
// fork identity). Uses the platform crypto UUID; planReconciliation takes an
// injectable mintId so tests stay deterministic.
function randomUuid(): string {
  return globalThis.crypto.randomUUID();
}
