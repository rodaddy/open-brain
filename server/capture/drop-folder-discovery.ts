/**
 * Bounded, streaming discovery of the supported files under an approved drop
 * root, plus the supported-extension allowlist that decides what "supported"
 * means.
 *
 * Split out of `drop-folder-collector.ts` (issue 864, L5). The two work bounds
 * arrive as parameters rather than being read from the environment here.
 */
import { opendir, realpath, stat } from "node:fs/promises";
import { join, sep } from "node:path";
import { logger } from "../../src/logger.ts";
import { DROP_SOURCE_KIND, maxEntriesInspected } from "./drop-folder-contract.ts";

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
export interface DiscoveryBounds {
  // Max directory depth walked under the root.
  depth: number;
  // Explicit override for the total entries discovery may inspect.
  // Absent means derive it from `limit`.
  scanEntries?: number;
}

/**
 * The mutable state of one discovery pass.
 *
 * Held as fields on a walker rather than as closure variables so the traversal
 * can be split into small steps (`walkDirectory`, `inspectEntry`, `retainFile`)
 * that each read as one decision. The traversal logic, its ordering, and every
 * bound are unchanged from the single-closure version.
 */
class DiscoveryWalk {
  private readonly rootPrefix: string;
  private readonly scanBound: number;
  private readonly depthCap: number;
  // Sorted buffer holding at most limit + 1 (limit kept + one sentinel proving
  // truncation). Kept sorted by relPath for a deterministic non-truncated result.
  private readonly retained: DiscoveredFile[] = [];
  private readonly retainedMax: number;
  // Total directory entries inspected (stat + realpath) across the whole walk.
  private entriesInspected = 0;
  // Set true when the walk stops before exhausting the tree (sentinel, scan
  // bound, or depth pruning). Any of these means the folder was not fully drained.
  private stopped = false;

  // Why entries did not make it into the result. The walk runs over untrusted
  // input and skips are ordinary -- a broken symlink, a directory the service
  // user cannot read -- so a line per entry would be noise, and the previous
  // behavior of a bare `catch { continue }` was no signal at all. An operator
  // whose files "just did not show up" had nothing to look at. Counted here and
  // emitted once per discovery, so the tally is proportional to scans, not to
  // tree size.
  private readonly skips = {
    unreadable_dir: 0,
    unresolvable_entry: 0,
    unstattable_entry: 0,
    escaped_root: 0,
    close_failed: 0,
  };
  // One representative errno per skip class, for the operator who has to guess
  // between EACCES and ENOENT. Never a path: the walk deliberately does not
  // surface filesystem paths from an untrusted tree.
  private readonly skipCodes: Record<string, string> = {};

  constructor(
    private readonly realRoot: string,
    private readonly limit: number,
    bounds: DiscoveryBounds,
  ) {
    this.rootPrefix = realRoot.endsWith(sep) ? realRoot : realRoot + sep;
    this.depthCap = bounds.depth;
    this.scanBound = maxEntriesInspected(limit, bounds.scanEntries);
    this.retainedMax = limit + 1;
  }

  private noteSkip(kind: keyof DiscoveryWalk["skips"], error: unknown): void {
    this.skips[kind] += 1;
    const code = (error as { code?: unknown } | null)?.code;
    if (typeof code === "string" && !this.skipCodes[kind]) {
      this.skipCodes[kind] = code;
    }
  }

  /** Insert into the sorted buffer, dropping anything that cannot reach the kept prefix. */
  private consider(file: DiscoveredFile): void {
    const buf = this.retained;
    // Binary-search insertion point by relPath.
    let lo = 0;
    let hi = buf.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      const at = buf[mid];
      if (at !== undefined && at.relPath < file.relPath) lo = mid + 1;
      else hi = mid;
    }
    // If the buffer is already full and this entry sorts at/after the end, it can
    // never be within the kept prefix: drop it without storing (bounded memory).
    if (buf.length >= this.retainedMax && lo >= this.retainedMax) return;
    buf.splice(lo, 0, file);
    if (buf.length > this.retainedMax) buf.pop();
  }

  /**
   * Resolve one entry to its confined real path, or null when it is skipped.
   *
   * Confinement: the resolved real path MUST stay under the real root. This
   * single check rejects both `..` traversal and symlink escape, for files and
   * directories alike.
   */
  private async confine(childAbs: string): Promise<string | null> {
    let realChild: string;
    try {
      realChild = await realpath(childAbs, { encoding: "utf8" });
    } catch (error) {
      this.noteSkip("unresolvable_entry", error); // Broken symlink or vanished entry.
      return null;
    }
    if (realChild !== this.realRoot && !realChild.startsWith(this.rootPrefix)) {
      // Not an error -- an entry pointing outside the approved root is correctly
      // excluded -- but an operator wondering why their symlinked file never
      // ingested deserves to see that this is why.
      this.skips.escaped_root += 1;
      return null;
    }
    return realChild;
  }

  /**
   * Retain a supported regular file and report whether the candidate sentinel
   * tripped: once limit + 1 supported files are buffered, no further supported
   * file can change the kept prefix's membership beyond proving truncation.
   */
  private retainFile(
    name: string,
    realChild: string,
    st: { dev: number; ino: number },
  ): void {
    // relPath is derived from the confined real path so the opaque token is
    // stable regardless of how the entry was reached.
    const relPath = realChild.slice(this.rootPrefix.length) || name;
    this.consider({ realPath: realChild, dev: st.dev, ino: st.ino, relPath });
    if (this.retained.length > this.limit) this.stopped = true;
  }

  /**
   * Inspect one directory entry: count it against the scan bound, confine it,
   * then either descend or retain it.
   */
  private async inspectEntry(dir: string, name: string, depth: number): Promise<void> {
    // Every inspected entry counts against the hard scan bound BEFORE any
    // stat/realpath work, so unsupported entries cannot hide an unbounded scan.
    this.entriesInspected += 1;
    if (this.entriesInspected >= this.scanBound) {
      // Inspected the last permitted entry; process it, then stop the walk.
      this.stopped = true;
    }
    const childAbs = join(dir, name);
    const realChild = await this.confine(childAbs);
    if (realChild === null) return;
    let st: Awaited<ReturnType<typeof stat>>;
    try {
      st = await stat(realChild);
    } catch (error) {
      this.noteSkip("unstattable_entry", error);
      return;
    }
    if (st.isDirectory()) {
      // Do not descend once the scan bound is reached.
      if (!this.stopped) await this.walkDirectory(childAbs, depth + 1);
      return;
    }
    if (st.isFile() && hasSupportedExtension(name)) {
      this.retainFile(name, realChild, st);
    }
  }

  private async walkDirectory(dir: string, depth: number): Promise<void> {
    if (this.stopped) return;
    if (depth > this.depthCap) {
      // A subtree was pruned by the depth bound: the tree is not fully drained.
      this.stopped = true;
      return;
    }
    let handle: Awaited<ReturnType<typeof opendir>>;
    try {
      // Stream entries one at a time (no name-array materialization, no per-dir
      // sort). We take names only and re-resolve each via realpath below, so
      // symlink-to-dir vs file is decided after confinement, not from the dirent
      // type.
      handle = await opendir(dir);
    } catch (error) {
      // Unreadable directory: skip, never surface the path. Counted so the whole
      // subtree going unread is not indistinguishable from it being empty.
      this.noteSkip("unreadable_dir", error);
      return;
    }
    try {
      for await (const dirent of handle) {
        if (this.stopped) return;
        await this.inspectEntry(dir, dirent.name, depth);
        if (this.stopped) return;
      }
    } finally {
      // The Dir async iterator auto-closes on full consumption (and close() then
      // returns undefined). When we break out of the loop early it is still open,
      // so close explicitly to avoid a descriptor leak. Guard both cases: a
      // double-close or an already-consumed handle must not throw.
      try {
        await handle.close();
      } catch (error) {
        // Ordinarily a double-close on an already-consumed iterator, which is
        // harmless. Counted anyway: a rising count is how a descriptor leak would
        // announce itself instead of appearing as an unrelated EMFILE.
        this.noteSkip("close_failed", error);
      }
    }
  }

  private report(): void {
    const skipped = Object.values(this.skips).reduce((sum, n) => sum + n, 0);
    if (skipped > 0) {
      // Warning, not info: every one of these is a file or subtree the operator
      // put in the folder that this scan did not ingest.
      logger.warn("drop_discover_entries_skipped", {
        source_kind: DROP_SOURCE_KIND,
        entries_inspected: this.entriesInspected,
        skipped_total: skipped,
        ...this.skips,
        skip_codes: this.skipCodes,
      });
    } else {
      logger.debug("drop_discover_scanned", {
        source_kind: DROP_SOURCE_KIND,
        entries_inspected: this.entriesInspected,
        retained: this.retained.length,
      });
    }
  }

  async run(): Promise<DiscoveryResult> {
    await this.walkDirectory(this.realRoot, 0);
    this.report();
    // Retain at most `limit`; a full buffer (limit + 1) means truncation. Any
    // early stop (sentinel, scan bound, depth prune) also means the tree was not
    // drained.
    const buf = this.retained;
    const files = buf.length > this.limit ? buf.slice(0, this.limit) : buf;
    return {
      files,
      truncated: this.stopped || buf.length > this.limit,
      entriesInspected: this.entriesInspected,
    };
  }
}

export async function discoverFiles(
  realRoot: string,
  limit: number,
  bounds: DiscoveryBounds,
): Promise<DiscoveryResult> {
  return new DiscoveryWalk(realRoot, limit, bounds).run();
}
