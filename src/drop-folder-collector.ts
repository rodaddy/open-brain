import { z } from "zod";
import { toSql } from "pgvector/pg";
import type pg from "pg";
import { open, opendir, realpath, stat } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
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

// Hard ceiling on the TOTAL number of directory entries discovery may inspect
// (stat + realpath) across the whole tree, regardless of how many are supported.
// This is the bound that makes discovery work O(1)-relative-to-tree-size rather
// than O(tree): once this many entries have been inspected, the walk stops even
// if fewer than `limit + 1` supported files were found. Without it, a hostile
// tree of millions of UNSUPPORTED entries would force unbounded stat/realpath
// work while the supported-file sentinel never trips. A finite absolute ceiling
// caps it no matter how large `maxFiles` is set.
const SCAN_BOUND_FACTOR = 64;
const SCAN_BOUND_CEILING = 100_000;

// Derive the entry-inspection bound from the file limit with a safe factor and a
// finite ceiling. The factor gives headroom so a folder legitimately holding a
// few unsupported files alongside `limit` supported ones still drains fully; the
// ceiling caps total work under any override. Result is >= limit + 1 so the
// candidate sentinel can always be reached in a well-formed tree.
export function maxEntriesInspected(limit: number): number {
  const override = process.env.DROP_COLLECTOR_MAX_SCAN_ENTRIES;
  if (override) {
    const parsed = Number.parseInt(override, 10);
    if (Number.isInteger(parsed) && parsed > 0) {
      return Math.max(parsed, limit + 1);
    }
  }
  const derived = Math.min(limit * SCAN_BOUND_FACTOR, SCAN_BOUND_CEILING);
  return Math.max(derived, limit + 1);
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

// Per-file skip reasons that are actually emitted. Note: there is no
// `count_bound` reason -- the truncated tail (files beyond maxFiles) is reported
// ONLY as the aggregate `truncated` flag, never as one receipt per omitted file,
// so an oversized tree cannot force per-file work/receipts (P2 bounded
// discovery). Unsupported-extension files are excluded during discovery and
// likewise produce no receipt.
export type DropFileSkipReason =
  "too_large" | "total_bound" | "unreadable" | "empty";

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
  // True when more eligible files existed than the count bound (maxFiles)
  // allowed. This is the ONLY signal for the omitted tail: those files are
  // neither enumerated nor given per-file receipts (bounded discovery), so an
  // operator sees the folder was not fully drained without any path or per-file
  // work proportional to the excess.
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

export interface DiscoveredFile {
  // Confined real path (server-internal only; never leaves the server). Proven
  // at discovery to live under the real root. Used only to re-open the file with
  // no-follow semantics; the read NEVER trusts this path's bytes without also
  // re-verifying the opened descriptor's identity (see readConfinedFile).
  realPath: string;
  // The confined discovery IDENTITY of the regular file: the device+inode of the
  // real path at the moment discovery validated it lives under the root. The
  // read re-opens no-follow and fstat-verifies the descriptor still resolves to
  // THIS identity, so a final-component OR ancestor/path swap between discovery
  // and read (TOCTOU) cannot redirect the read to an outside/oversized file.
  dev: number;
  ino: number;
  // Path relative to the real root, used only to derive the opaque file token.
  relPath: string;
}

// Result of a bounded, streaming discovery pass.
export interface DiscoveryResult {
  // At most maxFiles entries, sorted by relPath.
  files: DiscoveredFile[];
  // True when discovery STOPPED before exhausting the tree — for ANY reason:
  // the supported-file sentinel (limit + 1 supported files seen), the entry-scan
  // bound (maxEntriesInspected entries inspected), or depth pruning that left a
  // subtree unwalked. It means "the folder was not fully drained", never a path
  // or per-file tail work proportional to the excess.
  truncated: boolean;
  // Content-free structural counts proving the traversal stayed bounded. Used by
  // regression tests to assert work does not scale with tree size.
  entriesInspected: number;
}

// Discover supported files under the real root with HARD-BOUNDED, streaming work.
//
// Two independent bounds cap total traversal work, whichever trips first:
//  - The candidate sentinel: once `limit + 1` supported files have been seen the
//    walk stops. This bounds work relative to how many files we could keep.
//  - The entry-scan bound (`maxEntriesInspected(limit)`): once that many
//    directory entries have been INSPECTED (each stat'd + realpath'd), the walk
//    stops even if fewer than `limit + 1` supported files were found. This is the
//    fix for the remaining P2: without it, a tree of millions of UNSUPPORTED
//    entries forces unbounded stat/realpath work while the supported sentinel
//    never trips (many unsupported entries could otherwise hide unbounded
//    scanning). Every inspected entry — supported or not, file or directory —
//    counts against this bound, so scan work can never scale with tree size.
//
// Directories are streamed with `opendir` (a `Dir` async iterator), NOT
// `readdir`: entries are pulled one at a time so a single directory holding
// millions of names never materializes a name array or an O(n log n) per-dir
// sort. The retained set is kept in a small sorted buffer capped at `limit + 1`
// (an entry sorting at/after a full buffer's end is dropped without storing), so
// peak retained memory is O(limit) independent of tree size. The retained set is
// re-sorted before return; determinism under a truncated hostile tree is
// secondary to the hard work bound (which entries win the buffer race can depend
// on filesystem iteration order), but a non-truncated tree is fully sorted.
//
// `truncated` is true whenever the walk stops before exhausting the tree for ANY
// reason: the candidate sentinel, the entry-scan bound, or depth pruning that
// left a subtree unwalked. It always means "the folder was not fully drained".
//
// Every retained file has been proven (via realpath) to live under the real
// root, with its confined device+inode captured for the read-time identity
// check. Directory symlinks escaping the root, and files whose real path escapes
// the root, are silently excluded (not read); they never produce a receipt
// because they are not files "placed under" the approved root.
export async function discoverFiles(
  realRoot: string,
  limit: number,
): Promise<DiscoveryResult> {
  const rootPrefix = realRoot.endsWith(sep) ? realRoot : realRoot + sep;
  const depthCap = maxDepth();
  const scanBound = maxEntriesInspected(limit);
  // Sorted buffer capped at limit + 1 (limit kept + one sentinel proving
  // truncation). Kept sorted by relPath for a deterministic non-truncated result.
  const cap = limit + 1;
  const buf: DiscoveredFile[] = [];
  // Total directory entries inspected (stat + realpath) across the whole walk.
  let entriesInspected = 0;
  // Set true when the walk stops before exhausting the tree (sentinel, scan
  // bound, or depth pruning). Any of these means the folder was not fully drained.
  let stopped = false;

  function consider(file: DiscoveredFile): void {
    // Binary-search insertion point by relPath.
    let lo = 0;
    let hi = buf.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (buf[mid]!.relPath < file.relPath) lo = mid + 1;
      else hi = mid;
    }
    // If the buffer is already full and this entry sorts at/after the end, it can
    // never be within the kept prefix: drop it without storing (bounded memory).
    if (buf.length >= cap && lo >= cap) return;
    buf.splice(lo, 0, file);
    if (buf.length > cap) buf.pop();
  }

  async function walk(dir: string, depth: number): Promise<void> {
    if (stopped) return;
    if (depth > depthCap) {
      // A subtree was pruned by the depth bound: the tree is not fully drained.
      stopped = true;
      return;
    }
    let handle: Awaited<ReturnType<typeof opendir>>;
    try {
      // Stream entries one at a time (no name-array materialization, no per-dir
      // sort). We take names only and re-resolve each via realpath below, so
      // symlink-to-dir vs file is decided after confinement, not from the dirent
      // type.
      handle = await opendir(dir);
    } catch {
      return; // Unreadable directory: skip, never surface the path.
    }
    try {
      for await (const dirent of handle) {
        if (stopped) return;
        // Every inspected entry counts against the hard scan bound BEFORE any
        // stat/realpath work, so unsupported entries cannot hide unbounded scan.
        entriesInspected += 1;
        if (entriesInspected >= scanBound) {
          // Inspected the last permitted entry; process it, then stop the walk.
          stopped = true;
        }
        const name = dirent.name;
        const childAbs = join(dir, name);
        let realChild: string;
        try {
          realChild = await realpath(childAbs, { encoding: "utf8" });
        } catch {
          if (stopped) return;
          continue; // Broken symlink or vanished entry: skip.
        }
        // Confinement: the resolved real path MUST stay under the real root. This
        // single check rejects both `..` traversal and symlink escape, for files
        // and directories alike.
        if (realChild !== realRoot && !realChild.startsWith(rootPrefix)) {
          if (stopped) return;
          continue;
        }
        let st: Awaited<ReturnType<typeof stat>>;
        try {
          st = await stat(realChild);
        } catch {
          if (stopped) return;
          continue;
        }
        if (st.isDirectory()) {
          if (stopped) return; // Do not descend once the scan bound is reached.
          await walk(childAbs, depth + 1);
        } else if (st.isFile() && hasSupportedExtension(name)) {
          // relPath is derived from the confined real path so the opaque token is
          // stable regardless of how the entry was reached.
          const relPath = realChild.slice(rootPrefix.length) || name;
          consider({
            realPath: realChild,
            dev: st.dev,
            ino: st.ino,
            relPath,
          });
          // Candidate sentinel: once limit + 1 supported files are buffered, no
          // further supported file can change the kept prefix's membership beyond
          // proving truncation. Stop walking entirely.
          if (buf.length > limit) {
            stopped = true;
            return;
          }
        }
        if (stopped) return;
      }
    } finally {
      // The Dir async iterator auto-closes on full consumption (and close() then
      // returns undefined). When we break out of the loop early it is still open,
      // so close explicitly to avoid a descriptor leak. Guard both cases: a
      // double-close or an already-consumed handle must not throw.
      try {
        await handle.close();
      } catch {
        // Already closed / closing: ignore.
      }
    }
  }

  await walk(realRoot, 0);
  // Retain at most `limit`; a full buffer (limit + 1) means truncation. Any early
  // stop (sentinel, scan bound, depth prune) also means the tree was not drained.
  const files = buf.length > limit ? buf.slice(0, limit) : buf;
  const truncated = stopped || buf.length > limit;
  return { files, truncated, entriesInspected };
}

// A per-file bounded read result. The bytes were read from a no-follow-opened
// descriptor whose fstat identity matched the confined discovery identity, so
// they cannot be an outside/oversized target substituted after discovery.
export interface ConfinedRead {
  ok: true;
  content: string;
  // The byte length actually read from the descriptor (<= maxFileBytes). This is
  // the durable truth, not a pre-read metadata size that a grow-after-stat could
  // desync from.
  byteLength: number;
}

export type ConfinedReadFailure =
  { ok: false; reason: "too_large" } | { ok: false; reason: "unreadable" };

// Open the discovered file with NO-FOLLOW semantics, verify the opened
// descriptor against the confined discovery identity, and read a BOUNDED number
// of bytes from THAT descriptor only.
//
// TOCTOU defense (P1):
//  - open(O_RDONLY | O_NOFOLLOW) fails (ELOOP) if the FINAL component was swapped
//    to a symlink after discovery, so we never follow a post-validation symlink.
//  - fstat on the returned descriptor is compared to the discovery {dev, ino}.
//    If an ANCESTOR directory or the path was swapped so the name now resolves
//    to a different real file, the descriptor's inode differs and we reject. The
//    descriptor is pinned to one inode for the whole read; the path is never
//    re-resolved.
//  - isFile() on the fstat rejects a descriptor that is no longer a regular file
//    (e.g. now a fifo/device via an ancestor swap).
//  - Bytes are read from the descriptor in a bounded loop; a file that GREW after
//    metadata capture cannot exceed maxFileBytes because we stop reading once the
//    cap is reached and treat any overflow as too_large. Only descriptor-read
//    bytes are ingested.
export async function readConfinedFile(
  file: DiscoveredFile,
  perFileCap: number,
  remainingTotal: number,
): Promise<ConfinedRead | ConfinedReadFailure> {
  const effectiveCap = Math.min(perFileCap, remainingTotal);
  let fh: Awaited<ReturnType<typeof open>>;
  try {
    // O_NOFOLLOW: never follow a symlink at the final component. If `realPath`
    // was swapped to a symlink after discovery, this throws ELOOP and we reject.
    fh = await open(
      file.realPath,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
    );
  } catch {
    return { ok: false, reason: "unreadable" };
  }
  try {
    const fst = await fh.stat();
    // Identity binding: the opened descriptor MUST be the exact regular file
    // discovery validated under the confined root. A dev/ino mismatch means an
    // ancestor/path replacement redirected the name; reject without reading.
    if (!fst.isFile() || fst.dev !== file.dev || fst.ino !== file.ino) {
      return { ok: false, reason: "unreadable" };
    }
    // Fast reject when the current descriptor size already exceeds the per-file
    // cap. This is an optimization only; the bounded read below is the real
    // guarantee even if the file grows further after this fstat.
    if (fst.size > perFileCap) {
      return { ok: false, reason: "too_large" };
    }
    // Bounded read from the descriptor. We read at most effectiveCap bytes, then
    // probe one extra byte: if anything remains, the file grew past the cap and
    // is rejected as too_large rather than partially ingested.
    const buf = Buffer.allocUnsafe(effectiveCap);
    let filled = 0;
    while (filled < effectiveCap) {
      const { bytesRead } = await fh.read(
        buf,
        filled,
        effectiveCap - filled,
        filled,
      );
      if (bytesRead === 0) break; // EOF
      filled += bytesRead;
    }
    if (filled >= effectiveCap) {
      // Probe one byte past the cap. A non-zero read means more content exists
      // than the cap allows.
      const probe = Buffer.allocUnsafe(1);
      const { bytesRead } = await fh.read(probe, 0, 1, effectiveCap);
      if (bytesRead > 0) {
        return { ok: false, reason: "too_large" };
      }
    }
    const content = buf.toString("utf8", 0, filled);
    return { ok: true, content, byteLength: filled };
  } catch {
    return { ok: false, reason: "unreadable" };
  } finally {
    await fh.close().catch(() => {});
  }
}

// A stable, content-free token for a file: a digest of its root-relative path.
// Never the path itself. Uses the same normalized digest helper so it is
// deterministic across processes.
function fileToken(relPath: string): string {
  return contentHash(relPath);
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
 * durable normalized content hash (contentHash), so the receipt, the in-batch
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
async function writeDurableFile(
  deps: DropCollectorDeps,
  auth: AuthInfo,
  namespace: string,
  content: string,
  hash: string,
  tags: string[],
): Promise<DurableWriteResult> {
  // Probe first. This is the no-op gate: an unchanged rerun must not embed or
  // write. The durable unique index on (content_hash, namespace) still backs the
  // race-safe INSERT below if the row appears after this read.
  const existing = await deps.pool.query(
    `SELECT id, tags FROM ${DURABLE_TABLE} WHERE content_hash = $1 AND namespace = $2`,
    [hash, namespace],
  );
  if (existing.rows.length > 0) {
    const row = existing.rows[0] as { id: string; tags: string[] | null };
    const existingTags = row.tags ?? [];
    if (!tagsAddSomething(existingTags, tags)) {
      // Genuine no-op: identical content already durable and no new tags. No
      // embedding, no write, no updated_at churn.
      return { id: row.id, merged: true, mutated: false };
    }
    // Content unchanged but tags grew: update ONLY tags (no embedding recompute),
    // and only because the merged set strictly differs.
    const updated = await deps.pool.query(
      `UPDATE ${DURABLE_TABLE}
         SET tags = (
               SELECT COALESCE(array_agg(DISTINCT tag), '{}')
               FROM unnest(${DURABLE_TABLE}.tags || $3::text[]) AS tag
               WHERE tag IS NOT NULL
             ),
             updated_at = NOW()
       WHERE content_hash = $1 AND namespace = $2
       RETURNING id`,
      [hash, namespace, tags],
    );
    const id = (updated.rows[0]?.id as string) ?? row.id;
    return { id, merged: true, mutated: true };
  }

  // New content: embed once, then INSERT. The ON CONFLICT arm makes the write
  // race-safe against the durable unique index and only churns updated_at when a
  // concurrent identical row exists AND the incoming tags actually add something.
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
     WHERE NOT (EXCLUDED.tags <@ ${DURABLE_TABLE}.tags)
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

  // When the ON CONFLICT arm's WHERE excluded the update (concurrent identical
  // row, incoming tags already a subset), the statement returns no row. Re-read
  // the id so the caller still gets a stable durable id; that concurrent row is
  // reported as a merge, not a fresh insert.
  if (rows.length === 0) {
    const reread = await deps.pool.query(
      `SELECT id FROM ${DURABLE_TABLE} WHERE content_hash = $1 AND namespace = $2`,
      [hash, namespace],
    );
    const id = reread.rows[0]?.id as string;
    return { id, merged: true, mutated: false };
  }

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
  return { id, merged: !isNew, mutated: true };
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

  const limit = maxFiles();
  // Bounded, streaming discovery: at most `limit` files are retained plus a
  // sentinel used only to report truncation. An oversized tree produces neither
  // a full materialized/sorted candidate list nor one receipt per omitted file.
  const { files: selected, truncated } = await discoverFiles(realRoot, limit);

  const perFileCap = maxFileBytes();
  const totalCap = maxTotalBytes();
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

    // No remaining total budget: every further file is a truthful total_bound
    // skip. Checked before opening so we never read past the total cap.
    const remainingTotal = totalCap - totalBytes;
    if (remainingTotal <= 0) {
      files.push({
        status: "skipped",
        file_token: token,
        reason: "total_bound",
      });
      skipped += 1;
      continue;
    }

    // Open no-follow, verify the descriptor against the confined discovery
    // identity, and read a bounded number of bytes from THAT descriptor. This is
    // the P1 TOCTOU fix: a symlink/ancestor swap after discovery cannot redirect
    // the read to an outside/oversized target, and a file that grew after
    // metadata capture is bounded by the per-file/total caps at read time.
    const read = await readConfinedFile(file, perFileCap, remainingTotal);
    if (!read.ok) {
      // total_bound is distinct from too_large only at the whole-collection
      // level; readConfinedFile reports too_large/unreadable. If the file would
      // fit the per-file cap but not the remaining total, it surfaces as
      // too_large from the clamped cap; reclassify that as total_bound so the
      // receipt is truthful about WHY it was dropped.
      const reason =
        read.reason === "too_large" && remainingTotal < perFileCap
          ? "total_bound"
          : read.reason;
      files.push({ status: "skipped", file_token: token, reason });
      skipped += 1;
      continue;
    }

    const raw = read.content;
    totalBytes += read.byteLength;

    // Empty/whitespace-only files carry no durable content; skip truthfully
    // rather than write an empty row.
    if (raw.trim().length === 0) {
      files.push({ status: "skipped", file_token: token, reason: "empty" });
      skipped += 1;
      continue;
    }

    // Durable identity: the SAME normalized hash the durable upsert dedupes on.
    const hash = contentHash(raw);
    // byte_length is the descriptor-read byte count (the durable truth), not a
    // pre-read metadata size.
    const byteLength = read.byteLength;

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

  // The omitted tail (files beyond the count bound) is reported ONLY as the
  // aggregate `truncated` flag below -- never as one skipped(count_bound) receipt
  // per omitted file. Discovery already stopped after the sentinel, so the tail
  // was neither enumerated nor path-derived.

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
