import type pg from "pg";
import { createHash } from "node:crypto";
import { logger } from "./logger.ts";
import { canWriteNamespace } from "./namespace-policy.ts";
import type { AuthInfo, LinkRelation } from "./types.ts";

/**
 * Standalone, server-side graph-derivation maintenance primitive (#346).
 *
 * Turns already-extracted, structured metadata for one durable-memory anchor
 * into deterministic entity nodes and edges in the existing ob_entities /
 * ob_links graph. It is intentionally *not* wired to the maintenance queue
 * (#343), *not* exposed as an MCP tool, and does *not* re-run SOURCE-1
 * extraction (#337). Callers hand it metadata that some other stage already
 * produced; this primitive owns only the deterministic derivation + persistence.
 *
 * Invariants (see docs/sme and the graph-search join in tools/search-brain.ts):
 *  - Everything lives in a single namespace. The graph-traversal join requires
 *    l.namespace = seed.namespace and target.namespace = l.namespace, so a
 *    cross-namespace endpoint is both unreachable AND an isolation breach.
 *    We reject any such derivation up front.
 *  - ob_entities enforces TWO partial-unique indexes (migration 017), both
 *    WHERE archived_at IS NULL: idx_ob_entities_lookup_unique on
 *    (namespace, entity_type, lower(name)) and idx_ob_entities_canonical on
 *    (namespace, entity_type, canonical_id) WHERE canonical_id IS NOT NULL.
 *    Derived terms whose canonical id is name-derived upsert on lower(name)
 *    (the upsert-entity.ts shape). The anchor, whose canonical id is stable
 *    (anchorType:anchorId) but whose display name may change, upserts on the
 *    canonical index so a rename is a safe in-place UPDATE and never violates
 *    the other index (see step 2). Links are unique on
 *    (namespace, from_type, from_id, to_type, to_id, relation) WHERE
 *    archived_at IS NULL (the link-entities.ts shape).
 *  - Idempotent: identical metadata re-run is detected via a content hash stored
 *    on the anchor node and short-circuits to an `unchanged` receipt.
 *  - Receipts are content-free: counts, status, and hashes only. No topic,
 *    person, or anchor text ever leaves the server through this primitive.
 */

/** Minimal pool surface this primitive needs; keeps tests injectable. */
export interface GraphDerivationPool {
  query: pg.Pool["query"];
}

/**
 * Structured, already-extracted metadata for a single anchor. This mirrors the
 * shape produced by the extraction stage (see extraction.ts ExtractedMetadata)
 * but is passed in — we do not extract here.
 */
export interface DerivationMetadata {
  topics?: string[];
  people?: string[];
}

export interface DeriveGraphInput {
  /** The durable-memory row this graph is derived from (thought/decision/...). */
  anchorType: string;
  /** The anchor row UUID. */
  anchorId: string;
  /** Human-readable anchor label, used only to name the anchor entity node. */
  anchorName: string;
  /** Target namespace for every derived node and edge. */
  namespace: string;
  /** Already-extracted structured metadata. */
  metadata: DerivationMetadata;
  /**
   * Optional upstream source content hash (a lowercase sha256 hex digest) to
   * stamp on the anchor node's metadata as `content_hash`. This is distinct
   * from the derivation_hash (which is computed over the derived node set): it
   * records WHICH source snapshot this anchor was last derived from, so the
   * maintenance selection sweep can compare a source's observed content_hash to
   * the last-derived one and skip unchanged sources. Absent when the caller has
   * no source-content notion (e.g. a durable-memory anchor).
   */
  anchorContentHash?: string;
}

export type DerivationStatus = "new" | "changed" | "unchanged";

/**
 * Content-free receipt. Contains no topic/person/anchor text — only structural
 * counts, the derivation content hash, and status.
 */
export interface DerivationReceipt {
  status: DerivationStatus;
  namespace: string;
  anchor_type: string;
  anchor_id: string;
  /** sha256 over the normalized derivation payload. */
  derivation_hash: string;
  /** Prior hash on the anchor node, if any (present on `changed`). */
  previous_hash?: string;
  entities_upserted: number;
  entities_new: number;
  links_upserted: number;
  links_new: number;
  /**
   * Count of previously-live anchor->term `mentions` edges soft-deleted this run
   * because their target dropped out of the derived term set. Always 0 on `new`
   * and `unchanged`; only a `changed` derivation whose term set shrank prunes.
   */
  links_archived: number;
}

export class CrossNamespaceEndpointError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "CrossNamespaceEndpointError";
  }
}

const TOPIC_ENTITY_TYPE = "topic";
const PERSON_ENTITY_TYPE = "person";
const ANCHOR_RELATION: LinkRelation = "mentions";
const MAX_TERMS = 200;

interface DerivedEntity {
  entity_type: string;
  /** Display name (identity is namespace + entity_type + lower(name)). */
  name: string;
  /** Stable canonical id, e.g. "topic:migrations". */
  canonical_id: string;
}

/**
 * Normalize one extracted term to a stable identity. Deterministic: trims,
 * collapses internal whitespace, lowercases the canonical id. The display name
 * preserves the first-seen casing; identity dedup is case-insensitive so
 * "Rico" and "rico" collapse to one node.
 */
function normalizeTerm(entityType: string, raw: string): DerivedEntity | null {
  const name = raw.trim().replace(/\s+/g, " ");
  if (name.length === 0) return null;
  const canonical = `${entityType}:${name.toLowerCase()}`;
  return { entity_type: entityType, name, canonical_id: canonical };
}

/**
 * Deterministically build the node set from metadata. Dedups by canonical id
 * (case-insensitive) and sorts by canonical id so identical input always
 * produces the same ordered derivation regardless of extraction ordering.
 */
function deriveEntities(metadata: DerivationMetadata): DerivedEntity[] {
  const byCanonical = new Map<string, DerivedEntity>();
  const add = (entityType: string, terms: string[] | undefined) => {
    for (const raw of (terms ?? []).slice(0, MAX_TERMS)) {
      const entity = normalizeTerm(entityType, raw);
      if (!entity) continue;
      if (!byCanonical.has(entity.canonical_id)) {
        byCanonical.set(entity.canonical_id, entity);
      }
    }
  };
  add(TOPIC_ENTITY_TYPE, metadata.topics);
  add(PERSON_ENTITY_TYPE, metadata.people);
  return [...byCanonical.values()].sort((a, b) =>
    a.canonical_id < b.canonical_id
      ? -1
      : a.canonical_id > b.canonical_id
        ? 1
        : 0,
  );
}

/**
 * Deterministic content hash over the derivation payload. Only structural
 * derivation inputs feed the hash (namespace, anchor identity, ordered node
 * identities). Re-running with identical metadata yields the same hash, which
 * is how we detect unchanged content and skip re-persistence.
 */
function derivationHash(
  namespace: string,
  anchorType: string,
  anchorId: string,
  entities: DerivedEntity[],
): string {
  const payload = JSON.stringify({
    v: 1,
    namespace,
    anchor_type: anchorType,
    anchor_id: anchorId,
    entities: entities.map((e) => [e.entity_type, e.canonical_id]),
  });
  return createHash("sha256").update(payload).digest("hex");
}

/**
 * Derive and persist the entity/link graph for one anchor's structured
 * metadata. Content-hash idempotent, namespace-bound, cross-namespace-rejecting,
 * content-free receipt. Throws CrossNamespaceEndpointError on isolation breach
 * and rethrows DB errors to the caller (no partial receipt on failure).
 *
 * Transaction-agnostic: this primitive opens NO transaction of its own. It runs
 * every statement — the prior-hash read, the anchor upsert that stamps the
 * derivation/content hash, the entity+link upserts, and the stale-edge prune —
 * through the `query` of whatever `pool` it is handed, in call order. Hand it a
 * bare pool and each statement auto-commits independently (fine for a
 * durable-memory anchor with no cross-statement atomicity need, and what the
 * unit tests inject). Hand it a checked-out client that is mid-transaction — as
 * the maintenance handler does under its source-row lock — and ALL of these
 * writes, including the hash stamp, become part of that caller's transaction and
 * roll back together on any error. The caller owns BEGIN/COMMIT/ROLLBACK; this
 * primitive never touches them, which is why passing a client (whose surface is
 * a superset of GraphDerivationPool) needs no signature change.
 */
export async function deriveGraphFromMetadata(
  pool: GraphDerivationPool,
  auth: AuthInfo,
  input: DeriveGraphInput,
): Promise<DerivationReceipt> {
  const {
    anchorType,
    anchorId,
    anchorName,
    namespace,
    metadata,
    anchorContentHash,
  } = input;

  // Server-side namespace-write gate. The derivation namespace is the ONLY
  // namespace any node or edge may touch; a caller who cannot write it cannot
  // derive into it.
  const nsCheck = canWriteNamespace(auth, namespace);
  if (!nsCheck.allowed) {
    throw new CrossNamespaceEndpointError(
      `derivation namespace '${namespace}' not writable: ${nsCheck.reason}`,
    );
  }

  const anchorLabel = anchorName.trim().replace(/\s+/g, " ");
  if (anchorLabel.length === 0) {
    throw new Error("anchorName is required to name the anchor entity node");
  }

  const entities = deriveEntities(metadata);
  const hash = derivationHash(namespace, anchorType, anchorId, entities);

  const anchorCanonical = `${anchorType}:${anchorId}`;

  // 1) Read the anchor node's prior derivation + content hashes (namespace-
  //    bound). If the derivation is unchanged we skip the node/edge writes, but
  //    we still refresh the anchor's stamped content_hash when it drifted: a
  //    source can change its bytes (new content_hash) while its extracted terms
  //    stay identical (same derivation_hash). Without refreshing the stamp, the
  //    maintenance selection sweep — which compares the source content_hash to
  //    the anchor's stamped content_hash — would re-select that source forever.
  const prior = await pool.query(
    `SELECT metadata ->> 'derivation_hash' AS derivation_hash,
            metadata ->> 'content_hash'    AS content_hash
       FROM ob_entities
      WHERE namespace = $1
        AND entity_type = $2
        AND canonical_id = $3
        AND archived_at IS NULL`,
    [namespace, anchorType, anchorCanonical],
  );
  const previousHash: string | undefined =
    prior.rows[0]?.derivation_hash ?? undefined;
  const previousContentHash: string | undefined =
    prior.rows[0]?.content_hash ?? undefined;

  if (previousHash === hash) {
    // The derived node set is unchanged. Only touch the anchor when the caller
    // supplied a content_hash that differs from the stamped one (a source-bytes
    // change with identical extracted terms); otherwise this is a true no-op.
    if (
      anchorContentHash !== undefined &&
      anchorContentHash !== previousContentHash
    ) {
      await pool.query(
        `UPDATE ob_entities
            SET metadata = metadata || $4::jsonb, updated_at = NOW()
          WHERE namespace = $1
            AND entity_type = $2
            AND canonical_id = $3
            AND archived_at IS NULL`,
        [
          namespace,
          anchorType,
          anchorCanonical,
          JSON.stringify({ content_hash: anchorContentHash }),
        ],
      );
    }
    // Content-free: no namespace value, no derivation_hash value, no anchor id.
    // Only the stable anchor_type category and the status leave the server.
    logger.debug("graph_derivation_unchanged", {
      anchor_type: anchorType,
      status: "unchanged",
    });
    return {
      status: "unchanged",
      namespace,
      anchor_type: anchorType,
      anchor_id: anchorId,
      derivation_hash: hash,
      entities_upserted: 0,
      entities_new: 0,
      links_upserted: 0,
      links_new: 0,
      links_archived: 0,
    };
  }

  const status: DerivationStatus =
    previousHash === undefined ? "new" : "changed";

  // 2) Upsert the anchor entity, stamping the new derivation hash into its
  //    metadata so the next run can detect unchanged content. All parameters;
  //    namespace is a bound value, never interpolated.
  //
  //    The anchor's identity is its stable canonical id (anchorType:anchorId),
  //    NOT its display name — a thought/decision can be renamed while pointing
  //    at the same anchor row. ob_entities carries two partial-unique indexes
  //    that both apply here: idx_ob_entities_canonical
  //    (namespace, entity_type, canonical_id) WHERE canonical_id IS NOT NULL
  //    AND archived_at IS NULL, and idx_ob_entities_lookup_unique
  //    (namespace, entity_type, lower(name)) WHERE archived_at IS NULL. If we
  //    arbitrated on lower(name) (as the derived-term upsert does), a rename
  //    would find no lower(name) match, attempt an INSERT, and violate the
  //    canonical index that ON CONFLICT never mentioned — throwing the whole
  //    derivation. Arbitrating on the canonical index resolves the anchor by
  //    its stable identity and updates the display name in place, so a rename
  //    is a safe UPDATE. (Migration 017 makes the canonical index partial on
  //    archived_at IS NULL, matching this arbiter exactly.)
  // Stamp both hashes on the anchor. `derivation_hash` (over the derived node
  // set) drives the primitive's own unchanged short-circuit; `content_hash`
  // (the upstream source snapshot digest, when the caller supplies one) is what
  // the maintenance selection sweep reads back to decide new/unchanged/changed.
  // The metadata `||` merge below preserves any content_hash a prior run
  // stamped, so a caller that omits it never clears a previously-recorded one.
  const anchorMeta = JSON.stringify(
    anchorContentHash === undefined
      ? { derivation_hash: hash }
      : { derivation_hash: hash, content_hash: anchorContentHash },
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
      anchorType,
      anchorLabel,
      anchorCanonical,
      namespace,
      anchorMeta,
      auth.clientId,
    ],
  );
  const anchorNode = anchorRow.rows[0];
  assertSameNamespace(anchorNode.namespace, namespace, "anchor");

  const anchorEntityId: string = anchorNode.id;
  let entitiesUpserted = 1;
  let entitiesNew = anchorNode.is_new ? 1 : 0;
  let linksUpserted = 0;
  let linksNew = 0;
  let linksArchived = 0;

  // The entity ids this derivation keeps a live anchor->term edge to. Any live
  // `mentions` edge FROM this anchor to an id NOT in this set is a stale edge
  // left behind by a prior derivation whose term set has since shrunk; step 4
  // archives exactly those. The anchor's own id is included defensively so the
  // self-link guard below can never let the prune touch a (nonexistent) self
  // edge.
  const liveTargetIds = new Set<string>([anchorEntityId]);

  // 3) Upsert each derived node and its anchor->node edge. Every write is
  //    parameterized and namespace-bound; every returned row's namespace is
  //    re-verified against the derivation namespace as defense in depth.
  for (const entity of entities) {
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
        entity.entity_type,
        entity.name,
        entity.canonical_id,
        namespace,
        auth.clientId,
      ],
    );
    const node = nodeRow.rows[0];
    assertSameNamespace(node.namespace, namespace, "derived entity");
    entitiesUpserted += 1;
    if (node.is_new) entitiesNew += 1;

    const nodeId: string = node.id;
    // Self-link guard: an anchor that is itself a derived term would violate the
    // ob_links CHECK (from_type <> to_type OR from_id <> to_id). Skip it.
    if (anchorEntityId === nodeId) continue;

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
    linksUpserted += 1;
    if (link.is_new) linksNew += 1;
    liveTargetIds.add(nodeId);
  }

  // 4) Prune obsolete anchor->term edges. A `changed` derivation whose term set
  //    shrank (e.g. topics [migrations,indexing] -> [migrations]) leaves the
  //    dropped term's `mentions` edge live, so the search-brain graph join keeps
  //    returning it. Archive (soft-delete) every live edge FROM this exact
  //    anchor node under this exact namespace whose target is no longer in the
  //    current derived set. We deactivate only the obsolete anchor->term LINK —
  //    the shared term entity node is left untouched (another anchor may still
  //    reference it, and it upserts back into the live set on its own).
  //
  //    Scoped by the exact namespace + anchor-identity predicates
  //    (from_type = 'entity' AND from_id = the anchor entity id) and the
  //    ANCHOR_RELATION, so no other anchor's edges and no cross-namespace edge
  //    can ever be touched. Fully parameterized; NOT (... = ANY($n)) keeps the
  //    surviving-target list a bound array, never interpolated. `archived_at IS
  //    NULL` in the predicate makes a rerun with no newly-stale edges a no-op.
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
  linksArchived = pruneRes.rows.length;

  // Content-free: only the stable anchor_type category, the status, and
  // structural counts. No namespace value, no derivation_hash value, no ids.
  logger.info("graph_derivation_ok", {
    anchor_type: anchorType,
    status,
    entities_upserted: entitiesUpserted,
    entities_new: entitiesNew,
    links_upserted: linksUpserted,
    links_new: linksNew,
    links_archived: linksArchived,
  });

  return {
    status,
    namespace,
    anchor_type: anchorType,
    anchor_id: anchorId,
    derivation_hash: hash,
    previous_hash: previousHash,
    entities_upserted: entitiesUpserted,
    entities_new: entitiesNew,
    links_upserted: linksUpserted,
    links_new: linksNew,
    links_archived: linksArchived,
  };
}

/**
 * Defense in depth: the SQL already binds namespace as a parameter, but we
 * re-verify every persisted row's returned namespace matches the derivation
 * namespace so a schema drift (e.g. a default or trigger rewriting namespace)
 * can never let a cross-namespace endpoint slip through undetected.
 */
function assertSameNamespace(
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
