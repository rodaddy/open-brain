/**
 * The caller-facing contract of the drop-folder collector: the source kind, the
 * input schema, the receipt/result shapes, the injected pool/embedding surface,
 * and the operator-tunable scan bounds.
 *
 * Split out of the single `drop-folder-collector.ts` (issue 864, L5) so each
 * sibling holds one responsibility. Nothing here reads the environment: the
 * bounds arrive as `DropCollectorBounds`, filled by the composition root (or by
 * the `src/` adapter for legacy callers), which is what lets the collector live
 * under `server/`.
 */
import { z } from "zod";
import type pg from "pg";
import type { generateEmbedding } from "../../src/embedding.ts";

// The only source kind this collector serves. A caller cannot ask it to collect
// a git/directory/conversation source; those are other families.
export const DROP_SOURCE_KIND = "drop" as const;

/**
 * The operator-tunable scan bounds, resolved once by the caller that owns
 * configuration and handed inward as data.
 *
 * These used to be `process.env` reads inside this module. Under `server/` the
 * environment is parsed only at the composition root, so the values arrive as
 * fields of one options object. `scanEntries` is optional: absent means derive
 * it from `files` with the factor and ceiling below, which is what the
 * unconfigured deployment did.
 */
export interface DropCollectorBounds {
  // Max files read per collection. A folder with more eligible files than this
  // is a truncated collection: the first N (in stable sorted order) are ingested
  // and the receipt reports the truncation truthfully.
  files: number;
  // Max bytes for a single file. A larger file is skipped truthfully
  // (too_large), never partially read.
  fileBytes: number;
  // Max total bytes read across the whole collection. Once reading the next file
  // would exceed this, the collection stops and reports the total bound
  // truthfully.
  totalBytes: number;
  // Max directory depth walked under the root. Bounds the traversal so a deep or
  // adversarial tree cannot recurse without end.
  depth: number;
  // Explicit override for the total number of directory entries discovery may
  // inspect. Absent means derive it from `files`.
  scanEntries?: number;
}

// The values an unconfigured deployment ran with.
export const DEFAULT_DROP_COLLECTOR_BOUNDS: DropCollectorBounds = {
  files: 256,
  fileBytes: 1_048_576, // 1 MiB
  totalBytes: 16_777_216, // 16 MiB
  depth: 8,
};

// Hard ceiling on the TOTAL number of directory entries discovery may inspect
// (stat + realpath) across the whole tree, regardless of how many are supported.
// This is the bound that makes discovery work O(1)-relative-to-tree-size rather
// than O(tree): once this many entries have been inspected, the walk stops even
// if fewer than `files + 1` supported files were found. Without it, a hostile
// tree of millions of UNSUPPORTED entries would force endless stat/realpath work
// while the supported-file sentinel never trips. A finite absolute ceiling holds
// it no matter how large `files` is set.
const SCAN_BOUND_FACTOR = 64;
const SCAN_BOUND_CEILING = 100_000;

/**
 * Derive the entry-inspection bound from the file bound with a safe factor and a
 * finite ceiling, honouring an explicit override.
 *
 * The factor gives headroom so a folder legitimately holding a few unsupported
 * files alongside `limit` supported ones still drains fully; the ceiling holds
 * total work down under any override. Result is >= limit + 1 so the candidate
 * sentinel can always be reached in a well-formed tree.
 */
export function maxEntriesInspected(limit: number, override?: number): number {
  if (override !== undefined && Number.isInteger(override) && override > 0) {
    return Math.max(override, limit + 1);
  }
  const derived = Math.min(limit * SCAN_BOUND_FACTOR, SCAN_BOUND_CEILING);
  return Math.max(derived, limit + 1);
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

export type CollectDropFolderInput = z.infer<typeof collectDropFolderInputSchema>;

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
export type DropFileSkipReason = "too_large" | "total_bound" | "unreadable" | "empty";

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
