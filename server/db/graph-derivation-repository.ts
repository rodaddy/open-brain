// Owns the six SQL statements the graph-derivation primitive runs against
// ob_entities and ob_links, plus the two the graph-derivation maintenance
// handler used to run itself against the source registry; exists so neither the
// domain nor the maintenance tier holds SQL text (issue 1209).
import type { QuerySurface } from "./transaction.ts";
import { SOURCE_REGISTRY_TABLE } from "../domain/source-registry.ts";
import type { SourceKind } from "../domain/source-registry.ts";
import type {
  AnchorUpsertRow,
  AnchorLinkUpsert,
  DerivedEntityUpsert,
  GraphDerivationRepository,
  ObsoleteAnchorLinkScope,
  PriorAnchorRow,
  PrunedLinkRow,
  AnchorEntityUpsert,
  AnchorRefresh,
} from "../domain/graph-derivation-model.ts";

/** Statement 1: read the anchor row a prior derivation left behind. */
async function readPriorAnchor(
  pool: QuerySurface,
  namespace: string,
  anchorType: string,
  anchorCanonical: string,
): Promise<PriorAnchorRow | undefined> {
  const prior = await pool.query(
    `SELECT name,
            metadata ->> 'display_name'    AS display_name,
            metadata ->> 'derivation_hash' AS derivation_hash,
            metadata ->> 'content_hash'    AS content_hash
       FROM ob_entities
      WHERE namespace = $1
        AND entity_type = $2
        AND canonical_id = $3
        AND archived_at IS NULL`,
    [namespace, anchorType, anchorCanonical],
  );
  return (prior.rows[0] as PriorAnchorRow | undefined) ?? undefined;
}

/** Statement 2: refresh an unchanged anchor's stored name and metadata patch. */
async function refreshAnchor(
  pool: QuerySurface,
  refresh: AnchorRefresh,
): Promise<void> {
  await pool.query(
    `UPDATE ob_entities
        SET name = $4,
            metadata = metadata || $5::jsonb,
            updated_at = NOW()
      WHERE namespace = $1
        AND entity_type = $2
        AND canonical_id = $3
        AND archived_at IS NULL`,
    [
      refresh.namespace,
      refresh.anchorType,
      refresh.anchorCanonical,
      refresh.storedName,
      refresh.metadataPatch,
    ],
  );
}

/** Statement 3: upsert the anchor entity, arbitrating on the canonical index. */
async function upsertAnchorEntity(
  pool: QuerySurface,
  upsert: AnchorEntityUpsert,
): Promise<AnchorUpsertRow> {
  const anchorRow = await pool.query(
    `INSERT INTO ob_entities
       (entity_type, name, canonical_id, namespace, metadata, created_by)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6)
     ON CONFLICT (namespace, entity_type, canonical_id)
     WHERE canonical_id IS NOT NULL AND archived_at IS NULL
     DO UPDATE SET
       name = EXCLUDED.name,
       metadata = ob_entities.metadata || EXCLUDED.metadata,
       archived_at = NULL,
       updated_at = NOW()
     RETURNING id, (xmax = 0) AS is_new, namespace`,
    [
      upsert.anchorType,
      upsert.storedName,
      upsert.anchorCanonical,
      upsert.namespace,
      upsert.metadata,
      upsert.createdBy,
    ],
  );
  return anchorRow.rows[0] as AnchorUpsertRow;
}

/** Statement 4: upsert one derived term node, arbitrating on lower(name). */
async function upsertDerivedEntity(
  pool: QuerySurface,
  upsert: DerivedEntityUpsert,
): Promise<AnchorUpsertRow> {
  const nodeRow = await pool.query(
    `INSERT INTO ob_entities
       (entity_type, name, canonical_id, namespace, metadata, created_by)
     VALUES ($1, $2, $3, $4, '{}'::jsonb, $5)
     ON CONFLICT (namespace, entity_type, lower(name))
     WHERE archived_at IS NULL
     DO UPDATE SET
       canonical_id = COALESCE(EXCLUDED.canonical_id, ob_entities.canonical_id),
       archived_at = NULL,
       updated_at = NOW()
     RETURNING id, (xmax = 0) AS is_new, namespace`,
    [
      upsert.entityType,
      upsert.name,
      upsert.canonicalId,
      upsert.namespace,
      upsert.createdBy,
    ],
  );
  return nodeRow.rows[0] as AnchorUpsertRow;
}

/** Statement 5: upsert the anchor->term edge. */
async function upsertAnchorLink(
  pool: QuerySurface,
  upsert: AnchorLinkUpsert,
): Promise<AnchorUpsertRow> {
  const linkRow = await pool.query(
    `INSERT INTO ob_links
       (from_type, from_id, to_type, to_id, relation, weight, namespace, metadata, created_by)
     VALUES ('entity', $1, 'entity', $2, $3, 1.0, $4, '{}'::jsonb, $5)
     ON CONFLICT (namespace, from_type, from_id, to_type, to_id, relation)
     WHERE archived_at IS NULL
     DO UPDATE SET
       archived_at = NULL,
       updated_at = NOW()
     RETURNING id, (xmax = 0) AS is_new, namespace`,
    [
      upsert.anchorEntityId,
      upsert.nodeId,
      upsert.relation,
      upsert.namespace,
      upsert.createdBy,
    ],
  );
  return linkRow.rows[0] as AnchorUpsertRow;
}

/** Statement 6: soft-delete every anchor->term edge no longer in the derived set. */
async function archiveObsoleteAnchorLinks(
  pool: QuerySurface,
  scope: ObsoleteAnchorLinkScope,
): Promise<PrunedLinkRow[]> {
  const res = await pool.query(
    `UPDATE ob_links
        SET archived_at = NOW(), updated_at = NOW()
      WHERE namespace = $1
        AND from_type = 'entity'
        AND from_id = $2
        AND relation = $3
        AND archived_at IS NULL
        AND NOT (to_id = ANY($4::uuid[]))
      RETURNING namespace`,
    [scope.namespace, scope.anchorEntityId, scope.relation, scope.liveTargetIds],
  );
  return res.rows as PrunedLinkRow[];
}

/** The values the enqueue-side source scan binds. */
export interface EnqueueSourceScan {
  /** The anchor entity_type every derived source graph hangs from. */
  anchorEntityType: string;
  /**
   * The caller's writable namespace set, or undefined for a token-sourced
   * global identity. Undefined selects across namespaces; anything else
   * constrains both the source scan and the anchor join.
   */
  writableNamespaces: string[] | undefined;
  /** The already-bounded row count this sweep may read. */
  rowLimit: number;
}

/** One row of the enqueue-side source scan, exactly as the caller reads it. */
export interface EnqueueSourceRow {
  id: string;
  namespace: string;
  source_kind: SourceKind;
  external_id: string;
  content_hash: string;
  revision: number;
  derived_content_hash: string | null;
}

/** The snapshot the approved-source lock proves, and the values it binds. */
export interface ApprovedSourceLock {
  id: string;
  namespace: string;
  sourceKind: SourceKind;
  externalId: string;
  contentHash: string;
  revision: number;
}

/** The one column the approved-source lock returns. */
export interface LockedSourceRow {
  title: string | null;
}

/**
 * Statement 7: the enqueue-side read of the source registry.
 *
 * The anchor's canonical id is stable: '<entity_type>:<source id>' — matching
 * the handler's anchorCanonical. The LEFT JOIN pulls the last derived
 * content_hash from the anchor entity's metadata (same namespace only), and
 * the WHERE keeps only sources whose observed hash is absent from the anchor
 * (new) or differs from it (changed). Parameterized throughout; the only
 * interpolated identifiers are the table-name constants (allowlisted).
 */
async function readEnqueueSources(
  db: QuerySurface,
  input: EnqueueSourceScan,
): Promise<EnqueueSourceRow[]> {
  const params: unknown[] = [input.anchorEntityType];
  let namespacePredicate = "";
  if (input.writableNamespaces !== undefined) {
    // Auth-derived namespace predicate. Constrain both the source scan and the
    // anchor join to the caller's writable namespace set; never widen.
    params.push(input.writableNamespaces);
    namespacePredicate = ` AND s.namespace = ANY($${params.length}::text[])`;
  }
  params.push(input.rowLimit);
  const limitParam = `$${params.length}`;

  const { rows } = await db.query(
    `SELECT s.id, s.namespace, s.source_kind, s.external_id,
            s.content_hash, s.revision,
            anchor.metadata ->> 'content_hash' AS derived_content_hash
       FROM ${SOURCE_REGISTRY_TABLE} s
       LEFT JOIN ob_entities anchor
         ON anchor.namespace = s.namespace
        AND anchor.entity_type = $1
        AND anchor.canonical_id = $1 || ':' || s.id::text
        AND anchor.archived_at IS NULL
      WHERE s.approval_state = 'approved'
        AND s.lifecycle_state = 'active'
        AND s.content_hash IS NOT NULL
        AND s.content_hash ~ '^[0-9a-f]{64}$'
        AND (
          anchor.id IS NULL
          OR anchor.metadata ->> 'content_hash' IS DISTINCT FROM s.content_hash
        )${namespacePredicate}
      ORDER BY s.updated_at ASC, s.id ASC
      LIMIT ${limitParam}`,
    params,
  );
  return rows as EnqueueSourceRow[];
}

/**
 * Statement 8: the snapshot guard + row lock.
 *
 * Re-read the live source, namespace-bound by id, and prove it is still an
 * approved+active ingestion target at the exact revision and content hash the
 * job was enqueued for. FOR UPDATE locks the matched row FOR THE LIFE OF THIS
 * TRANSACTION, which is what serializes concurrent/racing derivations and the
 * registry's own source updates: a stale job (content re-observed, approval
 * revoked, retired, deleted, or a revision bump) resolves to zero rows and
 * terminates without deriving from an obsolete snapshot; a newer source
 * revision cannot commit over us while we hold the lock, and a job that starts
 * after a newer revision committed sees zero rows here and stops.
 */
async function lockApprovedSource(
  db: QuerySurface,
  input: ApprovedSourceLock,
): Promise<LockedSourceRow[]> {
  const guarded = await db.query(
    `SELECT title
       FROM ${SOURCE_REGISTRY_TABLE}
      WHERE id = $1
        AND namespace = $2
        AND source_kind = $3
        AND external_id = $4
        AND content_hash = $5
        AND revision = $6
        AND approval_state = 'approved'
        AND lifecycle_state = 'active'
      FOR UPDATE`,
    [
      input.id,
      input.namespace,
      input.sourceKind,
      input.externalId,
      input.contentHash,
      input.revision,
    ],
  );
  return guarded.rows as LockedSourceRow[];
}

/**
 * The full statement surface this module owns: the domain primitive's port plus
 * the two source-registry statements the maintenance handler needs. The domain
 * port stays exactly as the primitive declared it; the maintenance-only members
 * are additive here so the domain tier never sees them.
 */
export interface GraphDerivationRepositorySurface extends GraphDerivationRepository {
  readEnqueueSources(input: EnqueueSourceScan): Promise<EnqueueSourceRow[]>;
  lockApprovedSource(input: ApprovedSourceLock): Promise<LockedSourceRow[]>;
}

/**
 * Build the repository the graph-derivation domain functions depend on. Each
 * method carries one statement verbatim from where the domain tier used to run
 * it, binds the same values in the same order, and returns exactly the rows the
 * caller reads.
 *
 * Transaction-agnostic, like the primitive above it: build it over a bare pool
 * and each statement auto-commits, or build it over a checked-out client that is
 * mid-transaction and every statement enlists in that caller's transaction.
 */
export function createGraphDerivationRepository(
  pool: QuerySurface,
): GraphDerivationRepositorySurface {
  return {
    readPriorAnchor: (namespace, anchorType, anchorCanonical) =>
      readPriorAnchor(pool, namespace, anchorType, anchorCanonical),
    refreshAnchor: (refresh) => refreshAnchor(pool, refresh),
    upsertAnchorEntity: (upsert) => upsertAnchorEntity(pool, upsert),
    upsertDerivedEntity: (upsert) => upsertDerivedEntity(pool, upsert),
    upsertAnchorLink: (upsert) => upsertAnchorLink(pool, upsert),
    archiveObsoleteAnchorLinks: (scope) => archiveObsoleteAnchorLinks(pool, scope),
    readEnqueueSources: (input) => readEnqueueSources(pool, input),
    lockApprovedSource: (input) => lockApprovedSource(pool, input),
  };
}
