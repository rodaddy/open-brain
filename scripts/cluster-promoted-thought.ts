import type { createPool } from "../src/db/pool.ts";

/**
 * Thought-cluster supplementation knobs (Issue #173, piece (c) of #161).
 *
 * After a real promote of a new shared-kb THOUGHT, the promoter looks for the
 * nearest EXISTING shared-kb thought by cosine distance, excluding the new row,
 * inside the cluster band [EXACT_DUP_THRESHOLD, CLUSTER_THRESHOLD):
 *   - dist <  EXACT_DUP_THRESHOLD → an exact/near duplicate; dedup already
 *     handles this band, so it is NOT clustered.
 *   - EXACT_DUP_THRESHOLD <= dist < CLUSTER_THRESHOLD → related-but-distinct;
 *     link the new thought to that anchor with relation 'supplements'.
 *   - dist >= CLUSTER_THRESHOLD → no in-band neighbour; the new thought is a
 *     fresh cluster seed and gets no extra link (orphan is intentional).
 *
 * Both thresholds are env-overridable like the other promoter knobs. The lower
 * bound mirrors the dedup near-embedding threshold (`<=> < 0.08`).
 */
export const EXACT_DUP_THRESHOLD = Number(
  process.env.OPENBRAIN_SHARED_PROMOTER_EXACT_DUP_THRESHOLD ?? 0.08,
);
export const CLUSTER_THRESHOLD = Number(
  process.env.OPENBRAIN_SHARED_PROMOTER_CLUSTER_THRESHOLD ?? 0.25,
);

/**
 * After a REAL promote of a new shared-kb thought, find the nearest EXISTING
 * shared-kb thought by cosine distance — excluding the new row — inside the
 * cluster band [EXACT_DUP_THRESHOLD, CLUSTER_THRESHOLD). If one is found, create
 * an idempotent `supplements` edge (new thought → anchor) in the shared-kb
 * namespace, tagged with auto-cluster provenance. Returns true iff a link was
 * created/refreshed.
 *
 * Caller contract: only invoked in APPLY mode (never dry-run), only for rows
 * that actually inserted (not dedup skips). The new thought's vector is sourced
 * directly from its own stored `embedding` column, so a row promoted without an
 * embedding (or with no in-band neighbour) is a no-op (orphan seed).
 */
export async function clusterPromotedThought(
  pool: ReturnType<typeof createPool>,
  newThoughtId: string,
  physicalNamespace: string,
  promotedBy: string,
): Promise<boolean> {
  // Nearest existing shared-kb thought to the new row, excluding the new row and
  // any archived rows, ordered by cosine distance (the `<=>` operator). The new
  // row's embedding is read from its own column (a single round-trip), so this
  // works identically for event-sourced and promoteEntry-sourced thoughts and
  // returns nothing if the new row has no embedding.
  const { rows } = await pool.query(
    `WITH anchor AS (
       SELECT embedding FROM thoughts
        WHERE id = $2 AND namespace = $1 AND embedding IS NOT NULL
     )
     SELECT t.id, t.embedding <=> (SELECT embedding FROM anchor) AS distance
       FROM thoughts t
      WHERE t.namespace = $1
        AND t.id <> $2
        AND t.archived_at IS NULL
        AND t.embedding IS NOT NULL
        AND EXISTS (SELECT 1 FROM anchor)
      ORDER BY t.embedding <=> (SELECT embedding FROM anchor) ASC
      LIMIT 1`,
    [physicalNamespace, newThoughtId],
  );
  const anchor = rows[0];
  if (!anchor) return false;
  const distance = Number(anchor.distance);
  // Exact/near dups (handled by dedup) and far-away rows (new cluster seed) are
  // both skipped. Only the related-but-distinct band supplements a cluster.
  if (distance < EXACT_DUP_THRESHOLD || distance >= CLUSTER_THRESHOLD) {
    return false;
  }

  const metadata = {
    auto_clustered: true,
    clustered_by: "lane-shared-promoter",
    promoted_by: promotedBy,
    distance,
    cluster_band: [EXACT_DUP_THRESHOLD, CLUSTER_THRESHOLD],
  };
  // Idempotent on (namespace, from_type, from_id, to_type, to_id, relation) —
  // reuses the same ON CONFLICT shape as the link_entities tool.
  await pool.query(
    `INSERT INTO ob_links
       (from_type, from_id, to_type, to_id, relation, weight, namespace,
        metadata, created_by)
     VALUES ('thought', $1, 'thought', $2, 'supplements', 1.0, $3, $4::jsonb, $5)
     ON CONFLICT (namespace, from_type, from_id, to_type, to_id, relation)
     WHERE archived_at IS NULL
     DO UPDATE SET
       weight = EXCLUDED.weight,
       metadata = ob_links.metadata || EXCLUDED.metadata,
       archived_at = NULL,
       updated_at = NOW()`,
    [newThoughtId, anchor.id, physicalNamespace, JSON.stringify(metadata), promotedBy],
  );
  return true;
}
