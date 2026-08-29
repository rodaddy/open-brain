/**
 * The TOCTOU-safe, bounded per-file read.
 *
 * Split out of `drop-folder-collector.ts` (issue 864, L5). The file is re-opened
 * no-follow and its descriptor identity is checked against the identity
 * discovery captured, so a post-discovery swap cannot redirect the read.
 */
import { open } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { logger } from "../../src/logger.ts";
import { describeError } from "../../src/observability/index.ts";
import { DROP_SOURCE_KIND } from "./drop-folder-contract.ts";
import type { DiscoveredFile } from "./drop-folder-discovery.ts";

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
type FileHandle = Awaited<ReturnType<typeof open>>;

/**
 * Open the discovered file with no-follow semantics.
 *
 * The caller only ever learns "unreadable", which is correct -- it must not
 * learn anything about the filesystem. But collapsing every cause into that one
 * word also hid the case this defense exists for: ELOOP here means the final
 * component was swapped to a symlink between discovery and read, an active
 * TOCTOU attempt, and it looked exactly like a missing file.
 */
async function openNoFollow(file: DiscoveredFile): Promise<FileHandle | null> {
  try {
    // O_NOFOLLOW: never follow a symlink at the final component. If `realPath`
    // was swapped to a symlink after discovery, this throws ELOOP and we reject.
    return await open(file.realPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    const fields = {
      source_kind: DROP_SOURCE_KIND,
      // The opaque discovery token, not a filesystem path.
      rel_path: file.relPath,
      errno: typeof code === "string" ? code : "unknown",
    };
    if (code === "ELOOP") {
      logger.warn("drop_read_nofollow_rejected", fields);
    } else {
      logger.debug("drop_read_open_failed", fields);
    }
    return null;
  }
}

/**
 * Identity binding: the opened descriptor MUST be the exact regular file
 * discovery validated under the confined root. A dev/ino mismatch means an
 * ancestor/path replacement redirected the name; reject without reading.
 */
function descriptorMatches(
  file: DiscoveredFile,
  fst: { isFile(): boolean; dev: number; ino: number },
): boolean {
  if (fst.isFile() && fst.dev === file.dev && fst.ino === file.ino) return true;
  // The descriptor is not the file discovery validated. Either an ancestor
  // directory was replaced between the two steps, or the entry stopped being a
  // regular file. Both are the attack this check exists for, and both returned
  // silently before.
  logger.warn("drop_read_identity_mismatch", {
    source_kind: DROP_SOURCE_KIND,
    rel_path: file.relPath,
    still_regular_file: fst.isFile(),
    // Whether identity moved, never the inode numbers themselves.
    identity_changed: fst.dev !== file.dev || fst.ino !== file.ino,
  });
  return false;
}

/**
 * Read at most `effectiveCap` bytes from the descriptor, then probe one extra
 * byte: if anything remains, the file grew past the bound and is rejected as
 * too_large rather than partially ingested.
 */
async function readBounded(
  fh: FileHandle,
  effectiveCap: number,
): Promise<ConfinedRead | ConfinedReadFailure> {
  const buf = Buffer.allocUnsafe(effectiveCap);
  let filled = 0;
  while (filled < effectiveCap) {
    const { bytesRead } = await fh.read(buf, filled, effectiveCap - filled, filled);
    if (bytesRead === 0) break; // EOF
    filled += bytesRead;
  }
  if (filled >= effectiveCap) {
    const probe = Buffer.allocUnsafe(1);
    const { bytesRead } = await fh.read(probe, 0, 1, effectiveCap);
    if (bytesRead > 0) return { ok: false, reason: "too_large" };
  }
  return { ok: true, content: buf.toString("utf8", 0, filled), byteLength: filled };
}

export async function readConfinedFile(
  file: DiscoveredFile,
  perFileCap: number,
  remainingTotal: number,
): Promise<ConfinedRead | ConfinedReadFailure> {
  const fh = await openNoFollow(file);
  if (fh === null) return { ok: false, reason: "unreadable" };
  try {
    const fst = await fh.stat();
    if (!descriptorMatches(file, fst)) {
      return { ok: false, reason: "unreadable" };
    }
    // Fast reject when the current descriptor size already exceeds the per-file
    // bound. This is an optimization only; the bounded read below is the real
    // guarantee even if the file grows further after this fstat.
    if (fst.size > perFileCap) {
      return { ok: false, reason: "too_large" };
    }
    return await readBounded(fh, Math.min(perFileCap, remainingTotal));
  } catch (error) {
    // An I/O error mid-read (EIO on a failing disk, ESTALE on an NFS mount).
    // The caller still learns only "unreadable"; the operator learns which.
    logger.warn("drop_read_failed", {
      source_kind: DROP_SOURCE_KIND,
      rel_path: file.relPath,
      ...describeError(error),
    });
    return { ok: false, reason: "unreadable" };
  } finally {
    await fh.close().catch((error: unknown) => {
      // Closing is not allowed to change the read's outcome, but a descriptor
      // that will not close is how a leak starts.
      logger.debug("drop_read_close_failed", {
        source_kind: DROP_SOURCE_KIND,
        rel_path: file.relPath,
        ...describeError(error),
      });
    });
  }
}
