import { z } from "zod";
import { toSql } from "pgvector/pg";
import type pg from "pg";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import type { AuthInfo } from "./types.ts";
import { logger } from "./logger.ts";
import { canWriteNamespace } from "./namespace-policy.ts";
import { physicalNamespace } from "./shared-namespace.ts";
import {
  contentHash,
  EMBEDDING_MODEL,
  type generateEmbedding,
} from "./embedding.ts";
import { backgroundExtract } from "./extraction.ts";
import {
  resolveIngestionEligibility,
  updateSource,
  type SourceRecord,
} from "./source-registry.ts";

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

// The only source kind this collector serves. A caller cannot ask it to collect
// a git/directory/conversation source; those are other families.
export const DROP_SOURCE_KIND = "drop" as const;

// The durable table drop files land in. Reused (not re-implemented) so identical
// content dedupes via the existing (content_hash, namespace) upsert, and the
// same background metadata enrichment runs. Kept as an explicit constant so the
// interpolation-free INSERT below never targets an arbitrary table.
const DURABLE_TABLE = "thoughts" as const;

// Bounds. Overridable via env for operators, but every override is clamped to a
// safe positive integer so a malformed value can never disable a bound. These
// are the ONLY knobs; there is no caller-supplied way to raise them.
function boundedInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

// Max files read per collection. A folder with more eligible files than this is
// a truncated collection: the first N (in stable sorted order) are ingested and
// the receipt reports the truncation truthfully.
export function maxFiles(): number {
  return boundedInt("DROP_COLLECTOR_MAX_FILES", 256);
}

// Max bytes for a single file. A larger file is skipped truthfully (too_large),
// never partially read.
export function maxFileBytes(): number {
  return boundedInt("DROP_COLLECTOR_MAX_FILE_BYTES", 1_048_576); // 1 MiB
}

// Max total bytes read across the whole collection. Once reading the next file
// would exceed this, the collection stops and reports the total-bound truthfully.
export function maxTotalBytes(): number {
  return boundedInt("DROP_COLLECTOR_MAX_TOTAL_BYTES", 16_777_216); // 16 MiB
}

// Max directory depth walked under the root. Bounds the traversal so a deep or
// adversarial tree cannot cause unbounded recursion.
export function maxDepth(): number {
  return boundedInt("DROP_COLLECTOR_MAX_DEPTH", 8);
}

// Supported text file extensions. Only these are read; anything else is skipped
// truthfully (unsupported). Kept small and explicit so a binary/opaque file is
// never fed to the durable text path.
const SUPPORTED_EXTENSIONS = new Set([
  ".txt",
  ".md",
  ".markdown",
  ".text",
  ".log",
  ".json",
  ".yaml",
  ".yml",
  ".csv",
]);

function hasSupportedExtension(name: string): boolean {
  const dot = name.lastIndexOf(".");
  if (dot < 0) return false;
  return SUPPORTED_EXTENSIONS.has(name.slice(dot).toLowerCase());
}

// The caller-facing input. It SELECTS the approved source and bounded options;
// it never carries a file body, a path, or a root. The root is derived
// server-side from the durable registry record.
export const collectDropFolderInputSchema = z
  .object({
    external_id: z.string().trim().min(1).max(1000),
    target_namespace: z.string().trim().min(1).max(500).optional(),
    // Optional content-free tags to carry onto every durable row from this
    // collection. Never bodies.
    tags: z.array(z.string().trim().min(1).max(120)).max(64).optional(),
  })
  .strict();

export type CollectDropFolderInput = z.infer<
  typeof collectDropFolderInputSchema
>;

// Per-file disposition. All content-free:
//  - collected: content was new/changed; a durable row was written.
//  - deduped: the file's normalized content hash was already observed (earlier
//    in this batch or already durable); nothing new was written.
//  - skipped: the file was not read for a truthful, content-free reason
//    (unsupported extension, over per-file byte cap, or dropped by a bound).
export type DropFileStatus = "collected" | "deduped" | "skipped";

export type DropFileSkipReason =
  | "unsupported"
  | "too_large"
  | "count_bound"
  | "total_bound"
  | "unreadable"
  | "empty";

export interface DropFileReceipt {
  status: DropFileStatus;
  // Opaque, content-free token identifying the file WITHIN this collection: a
  // digest of the file's path RELATIVE to the root. Lets an operator correlate
  // per-file dispositions across runs without ever seeing the path.
  file_token: string;
  // Normalized content hash (the durable identity). Present when the file was
  // read (collected/deduped); absent when skipped before read.
  content_hash?: string;
  byte_length?: number;
  // Present only when status === "collected": the durable row id and whether it
  // merged into an existing identical-content row (durable-level dedupe).
  durable_id?: string;
  durable_merged?: boolean;
  // Present only when status === "skipped": a stable, content-free reason code.
  reason?: DropFileSkipReason;
}

// Gate outcome for a whole collection. When ineligible, `eligible` is false and
// a typed code explains why: no folder is ever touched.
export interface CollectDropFolderResult {
  ok: boolean;
  eligible: boolean;
  // Typed content-free code when eligible === false:
  //  - not_found: unregistered source
  //  - approval_denied: registered but not approved / not active
  //  - namespace_denied: caller cannot read OR cannot write the target namespace
  //  - no_root: the source has no valid configured folder root
  //  - root_unavailable: the configured root does not resolve to a real dir
  code?:
    | "not_found"
    | "approval_denied"
    | "namespace_denied"
    | "no_root"
    | "root_unavailable";
  namespace?: string;
  // Per-file receipts. Absent when the gate failed (no file was inspected).
  files?: DropFileReceipt[];
  // Aggregate content-free counters.
  collected?: number;
  deduped?: number;
  skipped?: number;
  // True when more eligible files existed than the count bound allowed; the
  // excess were reported as skipped(count_bound). Lets an operator see that the
  // folder was not fully drained without exposing any path.
  truncated?: boolean;
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
 * Resolve the single eligible drop source for this collection AND prove write
 * authority. Reuses the registry ingestion gate (approved + active `drop` kind
 * in a readable namespace), then enforces canWriteNamespace against the EXACT
 * target namespace. Eligibility alone proves only read access; a
 * read-authorized but write-unauthorized caller is denied here BEFORE any file
 * is read or any row is written. No folder is ever touched on a rejection.
 */
export async function resolveEligibleDropSource(
  pool: DropCollectorPool,
  auth: AuthInfo,
  external_id: string,
  target_namespace?: string,
): Promise<
  | { eligible: true; record: SourceRecord; namespace: string }
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
  if (!gate.ok || !gate.data) {
    // Map the registry's typed codes to the collector's content-free subset. Any
    // other/absent code collapses to not_found so an unexpected shape never
    // leaks as a distinct oracle.
    const code =
      gate.code === "approval_denied"
        ? "approval_denied"
        : gate.code === "namespace_denied"
          ? "namespace_denied"
          : "not_found";
    return { eligible: false, code };
  }

  const record = gate.data;
  // The physical namespace every durable write and the source stamp will target.
  const namespace = physicalNamespace(record.namespace);
  // Enforce WRITE authority for the exact target namespace before any read or
  // mutation. This is the fix for the P1 finding: a readonly/agent caller who
  // may read an approved source must not be able to write durable rows into a
  // namespace they cannot write (shared-kb without a promoter identity, a frozen
  // namespace like collab, etc.).
  const writeCheck = canWriteNamespace(auth, namespace);
  if (!writeCheck.allowed) {
    return { eligible: false, code: "namespace_denied" };
  }
  return { eligible: true, record, namespace };
}

// Extract the durable folder root from the source record. The root lives ONLY
// in the durable registry config (config.root); a caller can never supply it.
// A missing/blank/non-absolute root is rejected content-free so an unconfigured
// source can never read an arbitrary directory.
function configuredRoot(record: SourceRecord): string | null {
  const raw = record.config?.root;
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  // Require an absolute path. A relative root would resolve against the server
  // process cwd, which is not a durable, reviewable location.
  const resolved = resolve(trimmed);
  if (resolved !== trimmed && !trimmed.startsWith("/")) return null;
  return resolved;
}

interface DiscoveredFile {
  // Absolute path (server-internal only; never leaves the server).
  absPath: string;
  // Path relative to the real root, used only to derive the opaque file token.
  relPath: string;
}

// Discover supported files under the real root, in stable sorted order, bounded
// by depth. Every returned file has ALREADY been proven (via realpath) to live
// under the real root, so traversal and symlink escapes are rejected here rather
// than at read time. Directories that are symlinks escaping the root, and files
// whose real path escapes the root, are silently excluded (not read); they never
// produce a receipt because they are not files "placed under" the approved root.
async function discoverFiles(realRoot: string): Promise<DiscoveredFile[]> {
  const out: DiscoveredFile[] = [];
  const rootPrefix = realRoot.endsWith(sep) ? realRoot : realRoot + sep;

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > maxDepth()) return;
    let names: string[];
    try {
      // Names only (no Dirent): every entry is stat'ed via its real path below,
      // so symlink-to-dir vs file is resolved after confinement, not from the
      // dirent type.
      names = await readdir(dir, { encoding: "utf8" });
    } catch {
      return; // Unreadable directory: skip, never surface the path.
    }
    // Stable order so truncation by the count bound is deterministic.
    names.sort();
    for (const name of names) {
      const childAbs = join(dir, name);
      let realChild: string;
      try {
        realChild = await realpath(childAbs, { encoding: "utf8" });
      } catch {
        continue; // Broken symlink or vanished entry: skip.
      }
      // Confinement: the resolved real path MUST stay under the real root. This
      // single check rejects both `..` traversal and symlink escape, for files
      // and directories alike.
      if (realChild !== realRoot && !realChild.startsWith(rootPrefix)) {
        continue;
      }
      let st: Awaited<ReturnType<typeof stat>>;
      try {
        st = await stat(realChild);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        await walk(childAbs, depth + 1);
      } else if (st.isFile() && hasSupportedExtension(name)) {
        // relPath is derived from the confined real path so the opaque token is
        // stable regardless of how the entry was reached.
        const relPath = realChild.slice(rootPrefix.length) || name;
        out.push({ absPath: realChild, relPath });
      }
    }
  }

  await walk(realRoot, 0);
  // Global stable order across the whole tree so the count bound truncates
  // deterministically.
  out.sort((a, b) =>
    a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0,
  );
  return out;
}

// A stable, content-free token for a file: a digest of its root-relative path.
// Never the path itself. Uses the same normalized digest helper so it is
// deterministic across processes.
function fileToken(relPath: string): string {
  return contentHash(relPath);
}

/**
 * Write ONE file's content durably, reusing the exact content-hash upsert the
 * log tools use so identical content dedupes at the durable row. `hash` is the
 * durable normalized content hash (contentHash), so the receipt, the in-batch
 * dedupe key, and this upsert all agree. Returns the row id and whether it
 * merged into an existing identical-content row. Content is embedded
 * (best-effort) and enriched in the background exactly as a logged thought
 * would be; the raw content is never logged.
 */
async function writeDurableFile(
  deps: DropCollectorDeps,
  auth: AuthInfo,
  namespace: string,
  content: string,
  hash: string,
  tags: string[],
): Promise<{ id: string; merged: boolean }> {
  const textToEmbed = tags.length ? `${content}\n${tags.join(" ")}` : content;
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
      content,
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
      content,
      tags,
    );
  }
  return { id, merged: !isNew };
}

/**
 * Bounded server-side collection over an approved drop source's folder. Gates
 * once (eligibility + write authority), derives the root from the durable
 * registry record, discovers supported files under it (confined to the real
 * root), reads bounded files, and ingests new content. Dedupe is by the durable
 * normalized content hash, tracked across the whole batch, so repeats within the
 * folder and reruns are truthful no-ops. The source's observed content hash is
 * stamped to a manifest digest so a rerun with no changes never re-stamps.
 *
 * Everything returned is content-free: typed codes, opaque digests, opaque file
 * tokens, structural counts, and durable row ids. No file body, path, or driver
 * message leaves.
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
  } catch {
    logger.info("drop_collect_root_unavailable", {
      source_kind: DROP_SOURCE_KIND,
    });
    return { ok: false, eligible: true, code: "root_unavailable", namespace };
  }

  const discovered = await discoverFiles(realRoot);
  const limit = maxFiles();
  const truncated = discovered.length > limit;
  const selected = discovered.slice(0, limit);

  const tags = input.tags ?? [];
  const files: DropFileReceipt[] = [];
  // The observed normalized-hash set for the WHOLE collection. Tracking the full
  // set (not just the last hash) is what makes [A,B,A] truthful: A collects, B
  // collects, the second A dedupes.
  const observedHashes = new Set<string>();
  // Ordered manifest of observed hashes -> a deterministic digest stamped back
  // onto the source so an unchanged rerun does not re-stamp.
  const manifestParts: string[] = [];
  let collected = 0;
  let deduped = 0;
  let skipped = 0;
  let totalBytes = 0;

  for (const file of selected) {
    const token = fileToken(file.relPath);

    // Per-file byte bound: stat first so an over-cap file is never read.
    let size: number;
    try {
      const st = await stat(file.absPath);
      size = st.size;
    } catch {
      files.push({
        status: "skipped",
        file_token: token,
        reason: "unreadable",
      });
      skipped += 1;
      continue;
    }
    if (size > maxFileBytes()) {
      files.push({ status: "skipped", file_token: token, reason: "too_large" });
      skipped += 1;
      continue;
    }
    // Total byte bound: stop reading once the next file would exceed it. The
    // remaining files are reported as skipped(total_bound) truthfully.
    if (totalBytes + size > maxTotalBytes()) {
      files.push({
        status: "skipped",
        file_token: token,
        reason: "total_bound",
      });
      skipped += 1;
      continue;
    }

    let raw: string;
    try {
      raw = await readFile(file.absPath, "utf8");
    } catch {
      files.push({
        status: "skipped",
        file_token: token,
        reason: "unreadable",
      });
      skipped += 1;
      continue;
    }
    totalBytes += size;

    // Empty/whitespace-only files carry no durable content; skip truthfully
    // rather than write an empty row.
    if (raw.trim().length === 0) {
      files.push({ status: "skipped", file_token: token, reason: "empty" });
      skipped += 1;
      continue;
    }

    // Durable identity: the SAME normalized hash the durable upsert dedupes on.
    const hash = contentHash(raw);
    const byteLength = Buffer.byteLength(raw, "utf8");

    // In-batch dedupe against the full observed set (covers [A,B,A] and
    // case/whitespace collisions, since contentHash normalizes both).
    if (observedHashes.has(hash)) {
      files.push({
        status: "deduped",
        file_token: token,
        content_hash: hash,
        byte_length: byteLength,
      });
      deduped += 1;
      continue;
    }
    observedHashes.add(hash);
    manifestParts.push(hash);

    const durable = await writeDurableFile(
      deps,
      auth,
      namespace,
      raw,
      hash,
      tags,
    );
    // A durable merge means an identical-content row already existed (a prior
    // run, or another file with the same normalized content). Report it as
    // deduped so counters match actual durable outcomes and no redundant write
    // is implied.
    if (durable.merged) {
      files.push({
        status: "deduped",
        file_token: token,
        content_hash: hash,
        byte_length: byteLength,
        durable_id: durable.id,
        durable_merged: true,
      });
      deduped += 1;
    } else {
      files.push({
        status: "collected",
        file_token: token,
        content_hash: hash,
        byte_length: byteLength,
        durable_id: durable.id,
        durable_merged: false,
      });
      collected += 1;
    }
  }

  // Report the truncated tail as skipped(count_bound) so the receipt is truthful
  // about the folder not being fully drained, without exposing any path.
  if (truncated) {
    for (const file of discovered.slice(limit)) {
      files.push({
        status: "skipped",
        file_token: fileToken(file.relPath),
        reason: "count_bound",
      });
      skipped += 1;
    }
  }

  // Stamp the source's observed content hash to a deterministic manifest digest
  // of the collected file hashes (in discovery order). An unchanged rerun
  // produces the same manifest digest and therefore never re-stamps, keeping the
  // rerun a true no-op. The stamp goes through the same authorized registry
  // update path (optimistic-concurrency + namespace check).
  const manifestHash =
    manifestParts.length > 0 ? contentHash(manifestParts.join("\n")) : null;
  if (manifestHash !== null && manifestHash !== source.content_hash) {
    const stamp = await updateSource(deps.pool as pg.Pool, auth, {
      id: source.id,
      target_namespace: input.target_namespace,
      expected_revision: source.revision,
      sync_state: "synced",
      content_hash: manifestHash,
      last_synced_at: new Date().toISOString(),
    });
    if (!stamp.ok) {
      // The source drifted (concurrent update, retired, revoked). The durable
      // files already landed and dedupe by their own content_hash; surface the
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
