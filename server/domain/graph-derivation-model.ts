import type pg from "pg";
import { createHash } from "node:crypto";

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

export const TOPIC_ENTITY_TYPE = "topic";
export const PERSON_ENTITY_TYPE = "person";
export const MAX_TERMS = 200;
// The existing ob_entities.name length bound this primitive honors on every
// stored name. The deterministic anchor storage name and every derived term stay
// within it; the complete human anchor label is preserved separately in metadata.
export const MAX_ENTITY_NAME = 500;

/**
 * The deterministic, collision-safe storage name for an anchor entity.
 *
 * The anchor's IDENTITY is its stable canonical id (anchorType:anchorId), and the
 * anchor upsert arbitrates on idx_ob_entities_canonical. But ob_entities ALSO
 * enforces idx_ob_entities_lookup_unique (namespace, entity_type, lower(name)),
 * which the canonical upsert never mentions. If the stored `name` were the human
 * label, two DISTINCT anchors (distinct canonical ids) that happen to share a
 * display title would resolve to no canonical conflict, attempt an INSERT, and
 * collide on lower(name) — an unarbitrated 23505 that throws the whole
 * derivation (#346 P2). Appending the stable canonical id to a bounded human
 * label makes lower(name) unique exactly where canonical_id is unique, so two
 * same-titled sources coexist without reducing graph displays to opaque ids. The
 * complete human label is also preserved in metadata.display_name (see anchor
 * upsert). The readable prefix is shortened as needed to honor MAX_ENTITY_NAME.
 */
export function anchorStorageName(canonicalId: string, displayName: string): string {
  const suffix = ` [${canonicalId}]`;
  const prefixLimit = Math.max(MAX_ENTITY_NAME - suffix.length, 0);
  return `${displayName.slice(0, prefixLimit)}${suffix}`.slice(0, MAX_ENTITY_NAME);
}

export interface DerivedEntity {
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
export function normalizeTerm(entityType: string, raw: string): DerivedEntity | null {
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
export function deriveEntities(metadata: DerivationMetadata): DerivedEntity[] {
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
    a.canonical_id < b.canonical_id ? -1 : a.canonical_id > b.canonical_id ? 1 : 0,
  );
}

/**
 * Deterministic content hash over the derivation payload. Only structural
 * derivation inputs feed the hash (namespace, anchor identity, ordered node
 * identities). Re-running with identical metadata yields the same hash, which
 * is how we detect unchanged content and skip re-persistence.
 */
export function derivationHash(
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
