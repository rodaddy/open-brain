/**
 * The durable write for one collected file, including the true-no-op probe that
 * keeps an unchanged rerun from embedding or touching `updated_at`.
 *
 * Split out of `drop-folder-collector.ts` (issue 864, L5).
 */
import type { AuthInfo } from "../types.ts";
import { normalizedContentHash, embeddingModel } from "../embedding/provider.ts";
import { backgroundExtract } from "../domain/extraction.ts";
import type { DropCollectorDeps } from "./drop-folder-contract.ts";
import { DURABLE_TABLE } from "../db/drop-folder-repository.ts";

// The durable table drop files land in, re-exported from the repository that
// owns the statements (issue 1209) so this module's public surface is unchanged.
export { DURABLE_TABLE };

export function fileToken(relPath: string): string {
  return normalizedContentHash(relPath);
}

// Outcome of one durable write attempt. `mutated` distinguishes a true no-op
// (existing identical content, no durable change) from an actual write/tag
// merge, so an unchanged rerun can be proven to perform ZERO durable mutation.
interface DurableWriteResult {
  id: string;
  // True when the content hash already existed durably in this namespace (row
  // reused, not inserted).
  merged: boolean;
  // True when this call actually changed durable state (inserted a row or merged
  // a strictly larger tag set). False on a genuine no-op.
  mutated: boolean;
}

// Does the incoming tag set add anything not already present in the durable
// row's tags? Only when it does should we touch the row (and its updated_at).
function tagsAddSomething(existing: string[], incoming: string[]): boolean {
  if (incoming.length === 0) return false;
  const have = new Set(existing);
  for (const tag of incoming) {
    if (!have.has(tag)) return true;
  }
  return false;
}

/**
 * Write ONE file's content durably, reusing the exact content-hash identity the
 * log tools use so identical content dedupes at the durable row. `hash` is the
 * durable normalized content hash (normalizedContentHash), so the receipt, the in-batch
 * dedupe key, and this upsert all agree.
 *
 * True no-op reruns (P2): before embedding or writing anything, probe for an
 * existing (namespace, content_hash) row.
 *  - If it exists and the incoming tags add nothing, this is a genuine no-op: NO
 *    embedding is computed and NO row is written, so there is zero updated_at
 *    churn on an unchanged rerun.
 *  - If it exists but the incoming tags would grow the set, only the tags are
 *    updated (still no embedding recompute), and only when the merged set
 *    actually differs.
 *  - If it does not exist, embed once and INSERT. The INSERT keeps its
 *    ON CONFLICT (content_hash, namespace) arm so a concurrent writer that landed
 *    the same row between the probe and the INSERT is handled race-safely against
 *    the durable unique index; that arm, too, only bumps updated_at when the tag
 *    set actually changes.
 */
/** The one file's durable payload, grouped so the write keeps four parameters. */
export interface DurableFile {
  content: string;
  // The durable normalized content hash (normalizedContentHash).
  hash: string;
  tags: string[];
}

/**
 * The existing-row arm: content already durable in this namespace. Either a
 * genuine no-op, or a tags-only update that recomputes no embedding.
 */
async function mergeExistingTags(
  deps: DropCollectorDeps,
  namespace: string,
  file: DurableFile,
  row: { id: string; tags: string[] | null },
): Promise<DurableWriteResult> {
  const { hash, tags } = file;
  if (!tagsAddSomething(row.tags ?? [], tags)) {
    // Genuine no-op: identical content already durable and no new tags. No
    // embedding, no write, no updated_at churn.
    return { id: row.id, merged: true, mutated: false };
  }
  // Content unchanged but tags grew: update ONLY tags (no embedding recompute),
  // and only because the merged set strictly differs.
  const updated = await deps.repository.mergeTags(hash, namespace, tags);
  const id = updated ?? row.id;
  return { id, merged: true, mutated: true };
}

/**
 * The new-content arm: embed once, then INSERT. The ON CONFLICT arm makes the
 * write race-safe against the durable unique index and only churns updated_at
 * when a concurrent identical row exists AND the incoming tags actually add
 * something.
 */
async function insertNewContent(
  deps: DropCollectorDeps,
  auth: AuthInfo,
  namespace: string,
  file: DurableFile,
): Promise<DurableWriteResult> {
  const { content, hash, tags } = file;
  const textToEmbed = tags.length ? `${content}\n${tags.join(" ")}` : content;
  const embedding = await deps.embedFn(textToEmbed);

  const inserted = await deps.repository.insertContent({
    content,
    tags,
    createdBy: auth.clientId,
    namespace,
    embedding,
    hash,
    embeddedAt: embedding ? new Date().toISOString() : null,
    embeddingModel: embedding ? embeddingModel() : null,
  });

  // When the ON CONFLICT arm's WHERE excluded the update (concurrent identical
  // row, incoming tags already a subset), the statement returns no row. Re-read
  // the id so the caller still gets a stable durable id; that concurrent row is
  // reported as a merge, not a fresh insert.
  if (inserted === undefined) {
    const id = await deps.repository.idByContentHash(hash, namespace);
    return { id: id as string, merged: true, mutated: false };
  }

  const id = inserted.id;
  const isNew = inserted.is_new;
  if (isNew) {
    // Same fire-and-forget background enrichment path the log tools drive.
    backgroundExtract(
      deps.pool as Parameters<typeof backgroundExtract>[0],
      DURABLE_TABLE,
      {
        entryId: id,
        namespace,
        text: content,
        existingTags: tags,
      },
    );
  }
  return { id, merged: !isNew, mutated: true };
}

export async function writeDurableFile(
  deps: DropCollectorDeps,
  auth: AuthInfo,
  namespace: string,
  file: DurableFile,
): Promise<DurableWriteResult> {
  // Probe first. This is the no-op gate: an unchanged rerun must not embed or
  // write. The durable unique index on (content_hash, namespace) still backs the
  // race-safe INSERT below if the row appears after this read.
  const row = await deps.repository.findByContentHash(file.hash, namespace);
  if (row !== undefined) {
    return mergeExistingTags(deps, namespace, file, row);
  }
  return insertNewContent(deps, auth, namespace, file);
}
