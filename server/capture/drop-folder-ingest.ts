/**
 * The per-file ingest step and the running totals it folds into.
 *
 * Split out of `drop-folder-collector.ts` (issue 864, L5) so the entry function
 * reads as "gate, discover, fold, stamp" and each file's disposition — skipped,
 * deduped, or collected — is decided in one place.
 */
import type { AuthInfo } from "../../src/types.ts";
import { contentHash } from "../../src/embedding.ts";
import type { DropCollectorDeps, DropFileReceipt } from "./drop-folder-contract.ts";
import type { DiscoveredFile } from "./drop-folder-discovery.ts";
import { readConfinedFile } from "./drop-folder-read.ts";
import { fileToken, writeDurableFile } from "./drop-folder-durable.ts";

/** The byte bounds one file's read is held to. */
export interface IngestByteBounds {
  perFileCap: number;
  totalCap: number;
}

/**
 * Everything the fold carries across files: the receipts, the counters, and the
 * full observed-hash set that makes an in-batch repeat truthful.
 */
export interface IngestTotals {
  files: DropFileReceipt[];
  // The observed normalized-hash set for the WHOLE collection. Tracking the full
  // set (not just the last hash) is what makes [A,B,A] truthful: A collects, B
  // collects, the second A dedupes.
  observedHashes: Set<string>;
  // Ordered manifest of observed hashes -> a deterministic digest stamped back
  // onto the source so an unchanged rerun does not re-stamp.
  manifestParts: string[];
  collected: number;
  deduped: number;
  skipped: number;
  totalBytes: number;
}

export function emptyIngestTotals(): IngestTotals {
  return {
    files: [],
    observedHashes: new Set<string>(),
    manifestParts: [],
    collected: 0,
    deduped: 0,
    skipped: 0,
    totalBytes: 0,
  };
}

/** What the ingest and its durable write need beyond the file itself. */
export interface IngestContext {
  deps: DropCollectorDeps;
  auth: AuthInfo;
  namespace: string;
  tags: string[];
  bounds: IngestByteBounds;
}

function recordSkip(
  totals: IngestTotals,
  token: string,
  reason: DropFileReceipt["reason"],
): void {
  totals.files.push({ status: "skipped", file_token: token, reason });
  totals.skipped += 1;
}

/**
 * Read one discovered file and fold its outcome into `totals`.
 *
 * Every exit is a truthful content-free receipt: a skip with a typed reason, a
 * dedupe (in-batch or at the durable row), or a collection.
 */
export async function ingestOneFile(
  context: IngestContext,
  file: DiscoveredFile,
  totals: IngestTotals,
): Promise<void> {
  const { deps, auth, namespace, tags, bounds } = context;
  const token = fileToken(file.relPath);

  // No remaining total budget: every further file is a truthful total_bound
  // skip. Checked before opening so we never read past the total bound.
  const remainingTotal = bounds.totalCap - totals.totalBytes;
  if (remainingTotal <= 0) {
    recordSkip(totals, token, "total_bound");
    return;
  }

  // Open no-follow, verify the descriptor against the confined discovery
  // identity, and read a bounded number of bytes from THAT descriptor. This is
  // the P1 TOCTOU fix: a symlink/ancestor swap after discovery cannot redirect
  // the read to an outside/oversized target, and a file that grew after
  // metadata capture is held to the per-file/total bounds at read time.
  const read = await readConfinedFile(file, bounds.perFileCap, remainingTotal);
  if (!read.ok) {
    // total_bound is distinct from too_large only at the whole-collection
    // level; readConfinedFile reports too_large/unreadable. If the file would
    // fit the per-file bound but not the remaining total, it surfaces as
    // too_large from the clamped bound; reclassify that as total_bound so the
    // receipt is truthful about WHY it was dropped.
    const reason =
      read.reason === "too_large" && remainingTotal < bounds.perFileCap
        ? "total_bound"
        : read.reason;
    recordSkip(totals, token, reason);
    return;
  }

  const raw = read.content;
  totals.totalBytes += read.byteLength;

  // Empty/whitespace-only files carry no durable content; skip truthfully
  // rather than write an empty row.
  if (raw.trim().length === 0) {
    recordSkip(totals, token, "empty");
    return;
  }

  // Durable identity: the SAME normalized hash the durable upsert dedupes on.
  const hash = contentHash(raw);
  // byte_length is the descriptor-read byte count (the durable truth), not a
  // pre-read metadata size.
  const byteLength = read.byteLength;

  // In-batch dedupe against the full observed set (covers [A,B,A] and
  // case/whitespace collisions, since contentHash normalizes both).
  if (totals.observedHashes.has(hash)) {
    totals.files.push({
      status: "deduped",
      file_token: token,
      content_hash: hash,
      byte_length: byteLength,
    });
    totals.deduped += 1;
    return;
  }
  totals.observedHashes.add(hash);
  totals.manifestParts.push(hash);

  const durable = await writeDurableFile(deps, auth, namespace, {
    content: raw,
    hash,
    tags,
  });
  // A durable merge means an identical-content row already existed (a prior
  // run, or another file with the same normalized content). Report it as
  // deduped so counters match actual durable outcomes and no redundant write
  // is implied.
  totals.files.push({
    status: durable.merged ? "deduped" : "collected",
    file_token: token,
    content_hash: hash,
    byte_length: byteLength,
    durable_id: durable.id,
    durable_merged: durable.merged,
  });
  if (durable.merged) totals.deduped += 1;
  else totals.collected += 1;
}
