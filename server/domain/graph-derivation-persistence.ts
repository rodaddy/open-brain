import { canWriteNamespace } from "../../src/namespace-policy.ts";
import type { AuthInfo, LinkRelation } from "../../src/types.ts";
import type {
  DerivationMetadata,
  DerivedEntity,
  GraphDerivationPool,
} from "./graph-derivation-model.ts";
import {
  CrossNamespaceEndpointError,
  anchorStorageName,
} from "./graph-derivation-model.ts";

export const ANCHOR_RELATION: LinkRelation = "mentions";

/**
 * Defense in depth: the SQL already binds namespace as a parameter, but we
 * re-verify every persisted row's returned namespace matches the derivation
 * namespace so a schema drift (e.g. a default or trigger rewriting namespace)
 * can never let a cross-namespace endpoint slip through undetected.
 */
export function assertSameNamespace(
  returned: unknown,
  expected: string,
  what: string,
): void {
  if (returned !== expected) {
    throw new CrossNamespaceEndpointError(
      `${what} persisted into namespace '${String(returned)}' but derivation namespace is '${expected}'`,
    );
  }
}

/**
 * Server-side namespace-write gate. The derivation namespace is the ONLY
 * namespace any node or edge may touch; a caller who cannot write it cannot
 * derive into it.
 */
export function assertNamespaceWritable(auth: AuthInfo, namespace: string): void {
  const nsCheck = canWriteNamespace(auth, namespace);
  if (!nsCheck.allowed) {
    throw new CrossNamespaceEndpointError(
      `derivation namespace '${namespace}' not writable: ${nsCheck.reason}`,
    );
  }
}

/** The anchor node state a prior derivation left behind, if any. */
export interface PriorAnchorState {
  derivationHash?: string;
  contentHash?: string;
  storedName?: string;
  displayName?: string;
}

/**
 * Read the anchor node's prior derivation + content hashes (namespace-bound).
 * If the derivation is unchanged the caller skips the node/edge writes, but it
 * still refreshes the anchor's stamped content_hash when it drifted: a source
 * can change its bytes (new content_hash) while its extracted terms stay
 * identical (same derivation_hash). Without refreshing the stamp, the
 * maintenance selection sweep — which compares the source content_hash to the
 * anchor's stamped content_hash — would re-select that source forever.
 */
export async function readPriorAnchorState(
  pool: GraphDerivationPool,
  namespace: string,
  anchorType: string,
  anchorCanonical: string,
): Promise<PriorAnchorState> {
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
  const row = prior.rows[0];
  return {
    derivationHash: row?.derivation_hash ?? undefined,
    contentHash: row?.content_hash ?? undefined,
    storedName: row?.name ?? undefined,
    displayName: row?.display_name ?? undefined,
  };
}

export interface AnchorIdentity {
  namespace: string;
  anchorType: string;
  anchorCanonical: string;
  anchorStoredName: string;
  anchorLabel: string;
}

/**
 * Refresh the anchor row's stored name, display label, and content hash when
 * the derived node set is unchanged but the source bytes or the human label
 * drifted, so a pure title rename does not leave stale graph display data
 * behind.
 */
export async function refreshUnchangedAnchor(
  pool: GraphDerivationPool,
  identity: AnchorIdentity,
  anchorContentHash: string | undefined,
): Promise<void> {
  const metadataPatch: Record<string, string> = {
    display_name: identity.anchorLabel,
  };
  if (anchorContentHash !== undefined) {
    metadataPatch.content_hash = anchorContentHash;
  }
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
      identity.namespace,
      identity.anchorType,
      identity.anchorCanonical,
      identity.anchorStoredName,
      JSON.stringify(metadataPatch),
    ],
  );
}

/** Decide whether an unchanged derivation still needs an anchor row refresh. */
export function unchangedAnchorNeedsRefresh(
  identity: AnchorIdentity,
  prior: PriorAnchorState,
  anchorContentHash: string | undefined,
): boolean {
  const contentHashChanged =
    anchorContentHash !== undefined && anchorContentHash !== prior.contentHash;
  const nameChanged =
    identity.anchorStoredName !== prior.storedName ||
    identity.anchorLabel !== prior.displayName;
  return contentHashChanged || nameChanged;
}

export interface UpsertedNode {
  id: string;
  isNew: boolean;
}

/**
 * Upsert the anchor entity, stamping the derivation hash into its metadata so
 * the next run can detect unchanged content. All parameters; namespace is a
 * bound value, never interpolated.
 *
 * The anchor's identity is its stable canonical id (anchorType:anchorId), NOT
 * its display name — a thought/decision can be renamed while pointing at the
 * same anchor row. ob_entities carries two partial-unique indexes that both
 * apply: idx_ob_entities_canonical (namespace, entity_type, canonical_id) WHERE
 * canonical_id IS NOT NULL AND archived_at IS NULL, and
 * idx_ob_entities_lookup_unique (namespace, entity_type, lower(name)) WHERE
 * archived_at IS NULL. If we arbitrated on lower(name) (as the derived-term
 * upsert does), a rename would find no lower(name) match, attempt an INSERT,
 * and violate the canonical index that ON CONFLICT never mentioned — throwing
 * the whole derivation. Arbitrating on the canonical index resolves the anchor
 * by its stable identity, so a rename is a safe in-place UPDATE. (Migration 017
 * makes the canonical index partial on archived_at IS NULL, matching this
 * arbiter exactly.)
 *
 * The stored `name` is anchorStorageName(canonical, label): a readable, bounded
 * human-label prefix plus the stable canonical id. This closes the #346 P2
 * lower(name) collision: two DISTINCT anchors that share a display title still
 * get distinct stored names. `display_name` preserves the complete human anchor
 * label verbatim, since the label is no longer the row's `name`. The metadata
 * `||` merge preserves any content_hash a prior run stamped, so a caller that
 * omits it never clears a previously-recorded one; a rename overwrites only
 * display_name in place.
 */
export async function upsertAnchorEntity(
  pool: GraphDerivationPool,
  auth: AuthInfo,
  identity: AnchorIdentity,
  hashes: { derivationHash: string; anchorContentHash?: string },
): Promise<UpsertedNode> {
  const anchorMeta = JSON.stringify(
    hashes.anchorContentHash === undefined
      ? { derivation_hash: hashes.derivationHash, display_name: identity.anchorLabel }
      : {
          derivation_hash: hashes.derivationHash,
          content_hash: hashes.anchorContentHash,
          display_name: identity.anchorLabel,
        },
  );
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
      identity.anchorType,
      identity.anchorStoredName,
      identity.anchorCanonical,
      identity.namespace,
      anchorMeta,
      auth.clientId,
    ],
  );
  const anchorNode = anchorRow.rows[0];
  assertSameNamespace(anchorNode.namespace, identity.namespace, "anchor");
  return { id: anchorNode.id, isNew: Boolean(anchorNode.is_new) };
}

/** Upsert one derived term node, re-verifying its persisted namespace. */
export async function upsertDerivedEntity(
  pool: GraphDerivationPool,
  auth: AuthInfo,
  namespace: string,
  entity: DerivedEntity,
): Promise<UpsertedNode> {
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
    [entity.entity_type, entity.name, entity.canonical_id, namespace, auth.clientId],
  );
  const node = nodeRow.rows[0];
  assertSameNamespace(node.namespace, namespace, "derived entity");
  return { id: node.id, isNew: Boolean(node.is_new) };
}

/** Upsert the anchor->term edge, re-verifying its persisted namespace. */
export async function upsertAnchorLink(
  pool: GraphDerivationPool,
  auth: AuthInfo,
  namespace: string,
  edge: { anchorEntityId: string; nodeId: string },
): Promise<UpsertedNode> {
  const { anchorEntityId, nodeId } = edge;
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
    [anchorEntityId, nodeId, ANCHOR_RELATION, namespace, auth.clientId],
  );
  const link = linkRow.rows[0];
  assertSameNamespace(link.namespace, namespace, "derived link");
  return { id: link.id, isNew: Boolean(link.is_new) };
}

/**
 * Prune obsolete anchor->term edges. A `changed` derivation whose term set
 * shrank (e.g. topics [migrations,indexing] -> [migrations]) leaves the dropped
 * term's `mentions` edge live, so the search-brain graph join keeps returning
 * it. Archive (soft-delete) every live edge FROM this exact anchor node under
 * this exact namespace whose target is no longer in the current derived set. We
 * deactivate only the obsolete anchor->term LINK — the shared term entity node
 * is left untouched (another anchor may still reference it, and it upserts back
 * into the live set on its own).
 *
 * Scoped by the exact namespace + anchor-identity predicates (from_type =
 * 'entity' AND from_id = the anchor entity id) and the ANCHOR_RELATION, so no
 * other anchor's edges and no cross-namespace edge can ever be touched. Fully
 * parameterized; NOT (... = ANY($n)) keeps the surviving-target list a bound
 * array, never interpolated. `archived_at IS NULL` in the predicate makes a
 * rerun with no newly-stale edges a no-op.
 */
export async function pruneObsoleteAnchorLinks(
  pool: GraphDerivationPool,
  namespace: string,
  anchorEntityId: string,
  liveTargetIds: Iterable<string>,
): Promise<number> {
  const pruneRes = await pool.query(
    `UPDATE ob_links
        SET archived_at = NOW(), updated_at = NOW()
      WHERE namespace = $1
        AND from_type = 'entity'
        AND from_id = $2
        AND relation = $3
        AND archived_at IS NULL
        AND NOT (to_id = ANY($4::uuid[]))
      RETURNING namespace`,
    [namespace, anchorEntityId, ANCHOR_RELATION, [...liveTargetIds]],
  );
  for (const row of pruneRes.rows) {
    // Defense in depth: a soft-deleted edge must belong to the derivation
    // namespace, mirroring the same-namespace guard on every persisted write.
    assertSameNamespace(row.namespace, namespace, "pruned link");
  }
  return pruneRes.rows.length;
}

/** The anchor identity a derivation writes under, derived from its input. */
export function buildAnchorIdentity(
  namespace: string,
  anchorType: string,
  anchorId: string,
  anchorName: string,
): AnchorIdentity {
  const anchorLabel = anchorName.trim().replace(/\s+/g, " ");
  if (anchorLabel.length === 0) {
    throw new Error("anchorName is required to name the anchor entity node");
  }
  const anchorCanonical = `${anchorType}:${anchorId}`;
  return {
    namespace,
    anchorType,
    anchorCanonical,
    anchorStoredName: anchorStorageName(anchorCanonical, anchorLabel),
    anchorLabel,
  };
}

export type { DerivationMetadata };
