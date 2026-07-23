import { z } from "zod";
import { toSql } from "pgvector/pg";
import type pg from "pg";
import type { AuthInfo } from "./types.ts";
import { logger } from "./logger.ts";
import { physicalNamespace } from "./shared-namespace.ts";
import {
  contentHash,
  EMBEDDING_MODEL,
  type generateEmbedding,
} from "./embedding.ts";
import { backgroundExtract } from "./extraction.ts";
import {
  hashSourceContent,
  resolveIngestionEligibility,
  updateSource,
  type SourceRecord,
} from "./source-registry.ts";

/**
 * Bounded explicit drop-folder collector (Issue #339, DROP-1).
 *
 * A drop folder is a `drop`-kind source in the same registry every other
 * collector family uses (git/directory/conversation). This module collects
 * caller-supplied drop items ONLY when the exact registry entry for the item's
 * namespace + `drop` kind + external identity is approved AND active. It never
 * enumerates a filesystem, never resolves paths, and never trusts a
 * caller-asserted approval: eligibility is derived purely from the durable
 * server-side registry via resolveIngestionEligibility (the same gate #337
 * built). An unregistered or unapproved drop is rejected truthfully with a
 * content-free code — the item's body is never collected.
 *
 * Responsibility split (intentionally narrow — this is NOT #338 reconciliation,
 * #340 conversation ingestion, or #341 FTS, and it defines no scheduler):
 *  - resolveEligibleSource(): reuse the registry ingestion gate. Only an
 *    approved + active drop source passes; everything else is a truthful
 *    rejection with a typed code and no body.
 *  - collectDropItem(): for ONE already-eligible source, hash the caller's
 *    content, dedupe by that hash against the source's last-observed
 *    content_hash (repeated identical content is a no-op — no durable write, no
 *    hash re-stamp), and on new/changed content run bounded metadata extraction,
 *    write the item durably through the SAME content-hash upsert the log tools
 *    use (so identical content dedupes at the durable row too), and stamp the
 *    source's content_hash / last_synced_at through the registry update path.
 *  - collectDropFolder(): the bounded fan-in over a caller-supplied batch of
 *    drop items for ONE source. It gates once, then folds each item, returning a
 *    content-free per-item + aggregate receipt.
 *
 * Content safety: every receipt, log line, and error is content-free. It carries
 * identity (source kind, namespace), an opaque digest, structural counts, and a
 * stable status code — never a drop body, a path, an external_id echoed from a
 * failure, or a driver message.
 */

// The only source kind this collector serves. A caller cannot ask it to collect
// a git/directory/conversation source; those are other families.
export const DROP_SOURCE_KIND = "drop" as const;

// The durable table drop items land in. Reused (not re-implemented) so identical
// content dedupes via the existing (content_hash, namespace) upsert, and the
// same background metadata enrichment runs. Kept as an explicit constant so the
// interpolation-free INSERT below never targets an arbitrary table.
const DURABLE_TABLE = "thoughts" as const;

// A single caller-supplied drop item: the immutable external identity of the
// drop source it belongs to, and the raw content observed for it. The content is
// hashed and (on new content) written durably; it is NEVER logged or echoed.
export const dropItemSchema = z
  .object({
    external_id: z.string().trim().min(1).max(1000),
    content: z.string().min(1),
    // Optional content-free tags to carry onto the durable row. Never bodies.
    tags: z.array(z.string().trim().min(1).max(120)).max(64).optional(),
  })
  .strict();

export type DropItem = z.infer<typeof dropItemSchema>;

export const collectDropFolderInputSchema = z
  .object({
    external_id: z.string().trim().min(1).max(1000),
    target_namespace: z.string().trim().min(1).max(500).optional(),
    items: z.array(dropItemSchema).min(1).max(256),
  })
  .strict();

export type CollectDropFolderInput = z.infer<
  typeof collectDropFolderInputSchema
>;

// Per-item disposition. All content-free:
//  - collected: content was new/changed; a durable row was written and the
//    source hash advanced.
//  - deduped: the observed content hash equals the source's last-observed hash;
//    nothing was written and the source hash was not re-stamped (idempotent).
//  - rejected: the item's external_id did not match the gated source identity
//    (a batch may only carry items for the single gated source), so it was not
//    collected. No body leaves the server.
export type DropItemStatus = "collected" | "deduped" | "rejected";

export interface DropItemReceipt {
  status: DropItemStatus;
  // Opaque digest of the observed content. Content-free; lets an operator
  // correlate dedupe decisions without ever seeing the body.
  content_hash: string;
  byte_length: number;
  // Present only when status === "collected": the durable row id and whether it
  // merged into an existing identical-content row (durable-level dedupe).
  durable_id?: string;
  durable_merged?: boolean;
  // Present only when status === "rejected": a stable, content-free reason code.
  code?: "identity_mismatch";
}

// Gate outcome for a whole batch. When ineligible, `eligible` is false and a
// typed code explains why (mirrors resolveIngestionEligibility): no item is ever
// inspected, hashed, or collected.
export interface CollectDropFolderResult {
  ok: boolean;
  eligible: boolean;
  // Typed content-free code when eligible === false: not_found (unregistered),
  // approval_denied (registered but not approved / not active), or
  // namespace_denied (caller cannot read/write the requested namespace).
  code?: "not_found" | "approval_denied" | "namespace_denied";
  namespace?: string;
  // Per-item receipts, positionally aligned with the input items. Absent when
  // the gate failed (no item was inspected).
  items?: DropItemReceipt[];
  // Aggregate content-free counters.
  collected?: number;
  deduped?: number;
  rejected?: number;
}

// Minimal pool surface this collector needs, so it is injectable in tests.
export type DropCollectorPool = Pick<pg.Pool, "query">;

export interface DropCollectorDeps {
  pool: DropCollectorPool;
  // Same embedding function the durable log tools use. May return null (no
  // embedding); the durable row is still written and dedupes by content_hash.
  embedFn: typeof generateEmbedding;
}

/**
 * Resolve the single eligible drop source for this batch. Reuses the registry
 * ingestion gate: the source must be a `drop` kind, approved, and active, in a
 * namespace the caller may read/write. Returns the record when eligible, or a
 * typed content-free rejection. No body is ever inspected here.
 */
export async function resolveEligibleDropSource(
  pool: DropCollectorPool,
  auth: AuthInfo,
  external_id: string,
  target_namespace?: string,
): Promise<
  | { eligible: true; record: SourceRecord }
  | {
      eligible: false;
      code: "not_found" | "approval_denied" | "namespace_denied";
    }
> {
  const gate = await resolveIngestionEligibility(pool as pg.Pool, auth, {
    source_kind: DROP_SOURCE_KIND,
    external_id,
    target_namespace,
  });
  if (gate.ok && gate.data) {
    return { eligible: true, record: gate.data };
  }
  // Map the registry's typed codes to the collector's content-free subset. Any
  // other/absent code collapses to not_found so an unexpected shape never leaks
  // as a distinct oracle.
  const code =
    gate.code === "approval_denied"
      ? "approval_denied"
      : gate.code === "namespace_denied"
        ? "namespace_denied"
        : "not_found";
  return { eligible: false, code };
}

/**
 * Write ONE drop item's content durably, reusing the exact content-hash upsert
 * the log tools use so identical content dedupes at the durable row. Returns the
 * row id and whether it merged into an existing identical-content row. Content
 * is embedded (best-effort) and enriched in the background exactly as a logged
 * thought would be; the raw content is never logged.
 */
async function writeDurableItem(
  deps: DropCollectorDeps,
  auth: AuthInfo,
  namespace: string,
  item: DropItem,
): Promise<{ id: string; merged: boolean }> {
  const hash = contentHash(item.content);
  const tags = item.tags ?? [];
  const textToEmbed = tags.length
    ? `${item.content}\n${tags.join(" ")}`
    : item.content;
  const embedding = await deps.embedFn(textToEmbed);

  const { rows } = await deps.pool.query(
    `INSERT INTO ${DURABLE_TABLE} (content, tags, source, created_by, namespace, embedding, content_hash, embedded_at, embedding_model, source_refs)
     VALUES ($1, $2, 'drop', $3, $4, $5, $6, $7, $8, '[]'::jsonb)
     ON CONFLICT (content_hash, namespace) WHERE content_hash IS NOT NULL
     DO UPDATE SET
       tags = (
         SELECT COALESCE(array_agg(DISTINCT tag), '{}')
         FROM unnest(${DURABLE_TABLE}.tags || EXCLUDED.tags) AS tag
         WHERE tag IS NOT NULL
       ),
       updated_at = NOW()
     RETURNING id, (xmax = 0) AS is_new`,
    [
      item.content,
      tags,
      auth.clientId,
      namespace,
      embedding ? toSql(embedding) : null,
      hash,
      embedding ? new Date().toISOString() : null,
      embedding ? EMBEDDING_MODEL : null,
    ],
  );

  const id = rows[0].id as string;
  const isNew = rows[0].is_new as boolean;
  if (isNew) {
    // Same fire-and-forget background enrichment path the log tools drive.
    backgroundExtract(
      deps.pool as pg.Pool,
      DURABLE_TABLE,
      id,
      namespace,
      item.content,
      tags,
    );
  }
  return { id, merged: !isNew };
}

/**
 * Collect ONE caller-supplied drop item against an already-gated eligible
 * source. The item MUST carry the gated source's external_id; a mismatch is a
 * truthful content-free rejection (a batch only collects for the one source it
 * gated). Dedupe by content hash against the source's last-observed
 * content_hash: an identical re-collect is a no-op (no durable write, no hash
 * re-stamp). New/changed content is written durably and advances the source
 * hash / last_synced_at through the registry update path.
 */
async function collectDropItem(
  deps: DropCollectorDeps,
  auth: AuthInfo,
  source: SourceRecord,
  item: DropItem,
  lastObservedHash: string | null,
): Promise<{ receipt: DropItemReceipt; newHash: string | null }> {
  const envelope = hashSourceContent(item.content);

  // Batch integrity: only items belonging to the gated source identity are
  // collected. A mismatched external_id is rejected truthfully; the body is
  // never inspected or written.
  if (item.external_id !== source.external_id) {
    return {
      receipt: {
        status: "rejected",
        content_hash: envelope.content_hash,
        byte_length: envelope.byte_length,
        code: "identity_mismatch",
      },
      newHash: lastObservedHash,
    };
  }

  // Dedupe by observed content hash. Repeated identical content is a no-op.
  if (lastObservedHash !== null && lastObservedHash === envelope.content_hash) {
    return {
      receipt: {
        status: "deduped",
        content_hash: envelope.content_hash,
        byte_length: envelope.byte_length,
      },
      newHash: lastObservedHash,
    };
  }

  const durable = await writeDurableItem(
    deps,
    auth,
    physicalNamespace(source.namespace),
    item,
  );

  return {
    receipt: {
      status: "collected",
      content_hash: envelope.content_hash,
      byte_length: envelope.byte_length,
      durable_id: durable.id,
      durable_merged: durable.merged,
    },
    newHash: envelope.content_hash,
  };
}

/**
 * Bounded collection over a caller-supplied batch of drop items for ONE drop
 * source. Gates once via the registry ingestion eligibility (only an approved,
 * active drop source in a readable namespace passes), then folds each item.
 *
 * Ordering + dedupe within a batch: items are folded in order against a running
 * observed hash that starts at the source's stored content_hash. Two identical
 * items in one batch therefore collect once and dedupe the rest, and the final
 * observed hash is stamped back onto the source exactly once (only if it
 * advanced), so a re-run of the identical batch is a full no-op.
 *
 * Everything returned is content-free: typed codes, opaque digests, structural
 * counts, and durable row ids. No drop body, path, or driver message leaves.
 */
export async function collectDropFolder(
  deps: DropCollectorDeps,
  auth: AuthInfo,
  input: CollectDropFolderInput,
): Promise<CollectDropFolderResult> {
  const gate = await resolveEligibleDropSource(
    deps.pool,
    auth,
    input.external_id,
    input.target_namespace,
  );
  if (!gate.eligible) {
    logger.info("drop_collect_ineligible", {
      source_kind: DROP_SOURCE_KIND,
      code: gate.code,
    });
    return { ok: false, eligible: false, code: gate.code };
  }

  const source = gate.record;
  const receipts: DropItemReceipt[] = [];
  let observedHash = source.content_hash;
  let collected = 0;
  let deduped = 0;
  let rejected = 0;

  for (const item of input.items) {
    const { receipt, newHash } = await collectDropItem(
      deps,
      auth,
      source,
      item,
      observedHash,
    );
    receipts.push(receipt);
    observedHash = newHash;
    if (receipt.status === "collected") collected += 1;
    else if (receipt.status === "deduped") deduped += 1;
    else rejected += 1;
  }

  // Advance the source's last-observed content_hash / last_synced_at exactly
  // once, only when the batch produced new content. An all-deduped batch never
  // re-stamps, keeping a re-run a true no-op. The stamp goes through the same
  // authorized registry update path (optimistic-concurrency + namespace check).
  if (observedHash !== null && observedHash !== source.content_hash) {
    const stamp = await updateSource(deps.pool as pg.Pool, auth, {
      id: source.id,
      target_namespace: input.target_namespace,
      expected_revision: source.revision,
      sync_state: "synced",
      content_hash: observedHash,
      last_synced_at: new Date().toISOString(),
    });
    if (!stamp.ok) {
      // The source drifted (concurrent update, retired, revoked). The durable
      // items already landed and dedupe by their own content_hash; surface the
      // stamp outcome content-free without failing the collected receipts.
      logger.warn("drop_collect_stamp_skipped", {
        source_kind: DROP_SOURCE_KIND,
        code: stamp.code ?? "conflict",
      });
    }
  }

  logger.info("drop_collect_ok", {
    source_kind: DROP_SOURCE_KIND,
    collected,
    deduped,
    rejected,
  });

  return {
    ok: true,
    eligible: true,
    namespace: source.namespace,
    items: receipts,
    collected,
    deduped,
    rejected,
  };
}
