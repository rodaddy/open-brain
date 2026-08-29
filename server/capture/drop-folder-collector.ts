import { realpath, stat } from "node:fs/promises";
import type pg from "pg";
import type { AuthInfo } from "../../src/types.ts";
import { logger } from "../../src/logger.ts";
import { describeError } from "../../src/observability/index.ts";
import { contentHash } from "../../src/embedding.ts";
import { updateSource, type SourceRecord } from "../domain/source-registry.ts";
import {
  DEFAULT_DROP_COLLECTOR_BOUNDS,
  DROP_SOURCE_KIND,
  type CollectDropFolderInput,
  type CollectDropFolderResult,
  type DropCollectorBounds,
  type DropCollectorDeps,
} from "./drop-folder-contract.ts";
import {
  configuredRoot,
  resolveEligibleDropSource,
} from "./drop-folder-eligibility.ts";
import { discoverFiles } from "./drop-folder-discovery.ts";
import {
  emptyIngestTotals,
  ingestOneFile,
  type IngestContext,
} from "./drop-folder-ingest.ts";

/**
 * Bounded server-side drop-folder collector (Issue #339, SOURCE-3).
 *
 * A drop folder is a `drop`-kind source in the same registry every other
 * collector family uses (git/directory/conversation). The public operation
 * SELECTS an already-registered, approved, active drop source by its external
 * identity and asks the server to INGEST the files placed under it. Callers
 * NEVER submit file bodies: the server derives the folder root purely from the
 * durable source registry, enumerates the files under it, and reads bounded
 * supported files itself. This is the shape #339 requires -- "discover files
 * under a registered approved folder and ingest files placed there" -- and it
 * closes the earlier design's hole where anyone who could name an approved
 * source could attribute arbitrary content to it.
 *
 * Trust boundary (critical mode -- reject caller-asserted file provenance):
 *  - Eligibility is derived only from resolveIngestionEligibility (the #337
 *    gate): the exact registry entry for this namespace + `drop` kind +
 *    external identity must be approved AND active. An unregistered/unapproved
 *    source is a truthful content-free rejection; no folder is ever touched.
 *  - Write authority is enforced with canWriteNamespace against the EXACT
 *    target namespace before any file read or durable write. Eligibility only
 *    proves the caller may READ the source; a read-authorized but
 *    write-unauthorized caller (readonly/agent into shared-kb, or any role into
 *    a frozen namespace such as `collab`) is denied with ZERO reads and ZERO
 *    durable writes.
 *  - The folder root is taken ONLY from the durable source record
 *    (config.root), never from the caller. Every selected file is constrained
 *    to that root by resolving symlinks (realpath) and requiring the real path
 *    to stay under the real root; traversal (`..`) and symlink-escape are
 *    rejected before the file is read.
 *
 * Identity + dedupe (align with the durable normalized contentHash boundary):
 *  - File identity is the SAME normalized content hash the durable log tools
 *    use (contentHash: lowercase + trim + whitespace-collapse). The receipt
 *    hash, the in-batch dedupe key, and the durable (content_hash, namespace)
 *    upsert therefore all agree. Two files whose bodies differ only by case or
 *    whitespace collapse to one durable row and one "collected" receipt; the
 *    rest are truthfully "deduped".
 *  - In-batch dedupe tracks the FULL observed hash set, so [A,B,A] collects A
 *    once, B once, and dedupes the second A. A rerun of the same folder is a
 *    full no-op: every file dedupes at the durable row and no redundant
 *    embedding or write happens.
 *
 * Bounds: file count, per-file bytes, and total bytes are capped. A file over
 * the per-file cap, or a folder over the count/total caps, is a truthful
 * content-free failure rather than an unbounded read.
 *
 * Content safety: every receipt, log line, and error is content-free. It
 * carries identity (source kind, namespace), an opaque digest, a stable opaque
 * file token (a digest of the relative path -- never the path itself),
 * structural counts, and stable status codes -- never a file body, an absolute
 * or relative path, an external_id echoed from a failure, or a driver message.
 *
 * Scope (intentionally narrow): this is NOT #338 reconciliation, #340
 * conversation ingestion, or a scheduler. It reads the registry, discovers
 * files once, ingests them, and stamps the source's observed content hash. It
 * never changes source-registry authority.
 */

/**
 * Everything the collector needs beyond its injected pool and embedding
 * function: the operator-tunable scan bounds. They used to be `process.env`
 * reads inside this module; under `server/` the environment is parsed only at
 * the composition root, so they arrive here as fields of one options object.
 */
export interface CollectDropFolderOptions {
  bounds?: DropCollectorBounds;
}
/** The registry row a manifest stamp targets, and the namespace it is scoped to. */
interface StampTarget {
  source: SourceRecord;
  targetNamespace?: string;
}

/**
 * Stamp the source content hash to a deterministic digest of the collected
 * file hashes, so an unchanged rerun produces the same digest and never
 * re-stamps. A drift (concurrent update, retired, revoked) is reported
 * content-free; the durable files already landed and dedupe on their own hash.
 */
async function stampManifest(
  deps: DropCollectorDeps,
  auth: AuthInfo,
  manifestParts: string[],
  target: StampTarget,
): Promise<void> {
  if (manifestParts.length === 0) return;
  const manifestHash = contentHash(manifestParts.join("\n"));
  const { source, targetNamespace } = target;
  if (manifestHash === source.content_hash) return;
  const stamp = await updateSource(deps.pool as pg.Pool, auth, {
    id: source.id,
    target_namespace: targetNamespace,
    expected_revision: source.revision,
    sync_state: "synced",
    content_hash: manifestHash,
    last_synced_at: new Date().toISOString(),
  });
  if (!stamp.ok) {
    logger.warn("drop_collect_stamp_skipped", {
      source_kind: DROP_SOURCE_KIND,
      code: stamp.code ?? "conflict",
    });
  }
}

export async function collectDropFolder(
  deps: DropCollectorDeps,
  auth: AuthInfo,
  input: CollectDropFolderInput,
  options: CollectDropFolderOptions = {},
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

  const { record: source, namespace } = gate;

  const configuredPath = configuredRoot(source);
  if (configuredPath === null) {
    logger.info("drop_collect_no_root", { source_kind: DROP_SOURCE_KIND });
    return { ok: false, eligible: true, code: "no_root", namespace };
  }

  // Resolve the durable root to its real path once. A configured root that is
  // not a real directory is a truthful content-free failure; we never fall back
  // to a caller-influenced path.
  let realRoot: string;
  try {
    realRoot = await realpath(configuredPath, { encoding: "utf8" });
    const rootStat = await stat(realRoot);
    if (!rootStat.isDirectory()) {
      throw new Error("root is not a directory");
    }
  } catch (error) {
    // "Root unavailable" is the answer to the most common operator question
    // about this feature, and it used to arrive with no reason attached:
    // a folder that does not exist, one the service user cannot traverse, and
    // a path that turned out to be a file all produced the same line.
    // Warning, not info -- an approved source that ingests nothing is degraded.
    logger.warn("drop_collect_root_unavailable", {
      source_kind: DROP_SOURCE_KIND,
      // The configured root is operator-supplied server-side registry state,
      // not untrusted tree content, so naming its errno is safe and necessary.
      ...describeError(error),
    });
    return { ok: false, eligible: true, code: "root_unavailable", namespace };
  }

  const bounds = options.bounds ?? DEFAULT_DROP_COLLECTOR_BOUNDS;
  const limit = bounds.files;
  // Bounded, streaming discovery: at most `limit` files are retained plus a
  // sentinel used only to report truncation. An oversized tree produces neither
  // a full materialized/sorted candidate list nor one receipt per omitted file.
  const { files: selected, truncated } = await discoverFiles(realRoot, limit, {
    depth: bounds.depth,
    scanEntries: bounds.scanEntries,
  });

  const totals = emptyIngestTotals();
  const context: IngestContext = {
    deps,
    auth,
    namespace,
    tags: input.tags ?? [],
    bounds: { perFileCap: bounds.fileBytes, totalCap: bounds.totalBytes },
  };
  for (const file of selected) {
    await ingestOneFile(context, file, totals);
  }
  const { files, collected, deduped, skipped, manifestParts } = totals;

  // The omitted tail (files beyond the count bound) is reported ONLY as the
  // aggregate `truncated` flag below -- never as one skipped(count_bound) receipt
  // per omitted file. Discovery already stopped after the sentinel, so the tail
  // was neither enumerated nor path-derived.

  // Stamp the source's observed content hash to a deterministic manifest digest
  // of the collected file hashes (in discovery order). An unchanged rerun
  // produces the same manifest digest and therefore never re-stamps, keeping the
  // rerun a true no-op. The stamp goes through the same authorized registry
  // update path (optimistic-concurrency + namespace check).
  await stampManifest(deps, auth, manifestParts, {
    source,
    targetNamespace: input.target_namespace,
  });

  logger.info("drop_collect_ok", {
    source_kind: DROP_SOURCE_KIND,
    collected,
    deduped,
    skipped,
    truncated,
  });

  return {
    ok: true,
    eligible: true,
    namespace: source.namespace,
    files,
    collected,
    deduped,
    skipped,
    truncated,
  };
}

// Re-exported so the collector's entry module stays the one import site for its
// callers even though the implementation now lives in siblings.
export {
  DEFAULT_DROP_COLLECTOR_BOUNDS,
  DROP_SOURCE_KIND,
  collectDropFolderInputSchema,
  type CollectDropFolderInput,
  type CollectDropFolderResult,
  type DropCollectorBounds,
  type DropCollectorDeps,
  type DropCollectorPool,
  type DropFileReceipt,
  type DropFileSkipReason,
  type DropFileStatus,
} from "./drop-folder-contract.ts";
export {
  configuredRoot,
  resolveEligibleDropSource,
} from "./drop-folder-eligibility.ts";
export {
  discoverFiles,
  type DiscoveredFile,
  type DiscoveryBounds,
  type DiscoveryResult,
} from "./drop-folder-discovery.ts";
export {
  readConfinedFile,
  type ConfinedRead,
  type ConfinedReadFailure,
} from "./drop-folder-read.ts";
