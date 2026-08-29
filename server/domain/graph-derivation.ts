import { logger } from "../../src/logger.ts";
import type { AuthInfo } from "../../src/types.ts";
import { deriveEntities, derivationHash } from "./graph-derivation-model.ts";
import type {
  DeriveGraphInput,
  DerivationReceipt,
  DerivationStatus,
  GraphDerivationPool,
} from "./graph-derivation-model.ts";
import {
  assertNamespaceWritable,
  buildAnchorIdentity,
  pruneObsoleteAnchorLinks,
  readPriorAnchorState,
  refreshUnchangedAnchor,
  unchangedAnchorNeedsRefresh,
  upsertAnchorEntity,
  upsertAnchorLink,
  upsertDerivedEntity,
} from "./graph-derivation-persistence.ts";
import type { AnchorIdentity } from "./graph-derivation-persistence.ts";

export * from "./graph-derivation-model.ts";

interface GraphWriteCounts {
  entitiesUpserted: number;
  entitiesNew: number;
  linksUpserted: number;
  linksNew: number;
  linksArchived: number;
}

/**
 * Upsert every derived node and its anchor->node edge, then prune the
 * anchor->term edges whose target dropped out of this derivation's term set.
 */
async function persistDerivedGraph(
  pool: GraphDerivationPool,
  auth: AuthInfo,
  identity: AnchorIdentity,
  work: {
    anchorEntityId: string;
    entities: ReturnType<typeof deriveEntities>;
    counts: GraphWriteCounts;
  },
): Promise<void> {
  const { anchorEntityId, entities, counts } = work;
  // The entity ids this derivation keeps a live anchor->term edge to. Any live
  // `mentions` edge FROM this anchor to an id NOT in this set is a stale edge
  // left behind by a prior derivation whose term set has since shrunk; the
  // prune below archives exactly those. The anchor's own id is included
  // defensively so the self-link guard can never let the prune touch a
  // (nonexistent) self edge.
  const liveTargetIds = new Set<string>([anchorEntityId]);
  const { namespace } = identity;
  for (const entity of entities) {
    const node = await upsertDerivedEntity(pool, auth, namespace, entity);
    counts.entitiesUpserted += 1;
    if (node.isNew) counts.entitiesNew += 1;
    // Self-link guard: an anchor that is itself a derived term would violate
    // the ob_links CHECK (from_type <> to_type OR from_id <> to_id). Skip it.
    if (anchorEntityId === node.id) continue;
    const link = await upsertAnchorLink(pool, auth, namespace, {
      anchorEntityId,
      nodeId: node.id,
    });
    counts.linksUpserted += 1;
    if (link.isNew) counts.linksNew += 1;
    liveTargetIds.add(node.id);
  }
  counts.linksArchived = await pruneObsoleteAnchorLinks(
    pool,
    namespace,
    anchorEntityId,
    liveTargetIds,
  );
}

/** The content-free receipt an unchanged derivation returns. */
function unchangedReceipt(input: DeriveGraphInput, hash: string): DerivationReceipt {
  return {
    status: "unchanged",
    namespace: input.namespace,
    anchor_type: input.anchorType,
    anchor_id: input.anchorId,
    derivation_hash: hash,
    entities_upserted: 0,
    entities_new: 0,
    links_upserted: 0,
    links_new: 0,
    links_archived: 0,
  };
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
  const { anchorType, anchorId, namespace, metadata, anchorContentHash } = input;

  assertNamespaceWritable(auth, namespace);
  const identity = buildAnchorIdentity(
    namespace,
    anchorType,
    anchorId,
    input.anchorName,
  );

  const entities = deriveEntities(metadata);
  const hash = derivationHash(namespace, anchorType, anchorId, entities);

  const prior = await readPriorAnchorState(
    pool,
    namespace,
    anchorType,
    identity.anchorCanonical,
  );
  const previousHash = prior.derivationHash;

  if (previousHash === hash) {
    // The derived node set is unchanged, but source bytes and the human label
    // are independent anchor state. Refresh either when it drifted so a pure
    // title rename does not leave stale graph display data behind.
    if (unchangedAnchorNeedsRefresh(identity, prior, anchorContentHash)) {
      await refreshUnchangedAnchor(pool, identity, anchorContentHash);
    }
    // Content-free: no namespace value, no derivation_hash value, no anchor id.
    // Only the stable anchor_type category and the status leave the server.
    logger.debug("graph_derivation_unchanged", {
      anchor_type: anchorType,
      status: "unchanged",
    });
    return unchangedReceipt(input, hash);
  }

  const status: DerivationStatus = previousHash === undefined ? "new" : "changed";

  const anchorNode = await upsertAnchorEntity(pool, auth, identity, {
    derivationHash: hash,
    anchorContentHash,
  });
  const counts: GraphWriteCounts = {
    entitiesUpserted: 1,
    entitiesNew: anchorNode.isNew ? 1 : 0,
    linksUpserted: 0,
    linksNew: 0,
    linksArchived: 0,
  };

  await persistDerivedGraph(pool, auth, identity, {
    anchorEntityId: anchorNode.id,
    entities,
    counts,
  });

  // Content-free: only the stable anchor_type category, the status, and
  // structural counts. No namespace value, no derivation_hash value, no ids.
  logger.info("graph_derivation_ok", {
    anchor_type: anchorType,
    status,
    entities_upserted: counts.entitiesUpserted,
    entities_new: counts.entitiesNew,
    links_upserted: counts.linksUpserted,
    links_new: counts.linksNew,
    links_archived: counts.linksArchived,
  });

  return {
    status,
    namespace,
    anchor_type: anchorType,
    anchor_id: anchorId,
    derivation_hash: hash,
    previous_hash: previousHash,
    entities_upserted: counts.entitiesUpserted,
    entities_new: counts.entitiesNew,
    links_upserted: counts.linksUpserted,
    links_new: counts.linksNew,
    links_archived: counts.linksArchived,
  };
}
