import {
  appendFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { dirname } from "node:path";

/**
 * Size-capped rolling file sink.
 *
 * Every deployment inherits a bounded log footprint: once the active file
 * would exceed `maxBytes`, it is rotated to `<path>.1`, existing rotations
 * shift up (`.1` -> `.2`, ...), and anything past `maxFiles` is pruned. The
 * size check runs at write time so a long-running process never relies on an
 * external cron/newsyslog/logrotate to keep the file bounded.
 *
 * Defaults (1MB, 3 rotated files) come from OB issue #193. They are
 * configurable so an operator can tune retention without a code change.
 */

const DEFAULT_MAX_BYTES = 1_000_000; // 1 MB
const DEFAULT_MAX_FILES = 3; // rotated siblings kept beyond the active file

export interface RotatingFileOptions {
  /** Absolute or relative path of the active log file. */
  path: string;
  /** Max bytes for the active file before rotation. Must be > 0. */
  maxBytes?: number;
  /** Number of rotated files to retain (e.g. .1 .. .N). Must be >= 0. */
  maxFiles?: number;
}

export interface RotatingFileSink {
  /** Append a single line (a trailing newline is added). */
  write(line: string): void;
  readonly path: string;
  readonly maxBytes: number;
  readonly maxFiles: number;
}

function currentSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

/**
 * Rotate `path` -> `path.1`, shifting existing `path.N` up by one and pruning
 * everything past `maxFiles`. Best-effort: filesystem errors on individual
 * rotation steps must never take down the writing process.
 *
 * Returns whether the active file at `path` was actually cleared (renamed
 * away, removed, or already absent), verified against the filesystem. Callers
 * must only reset their size accounting when this returns true; on false the
 * over-cap active file is still in place and the next write must retry.
 * Failures shifting intermediate `.N` files do not affect the result — they
 * can at worst overwrite an older rotation, never unbound the active file.
 */
function rotate(path: string, maxFiles: number): boolean {
  if (maxFiles <= 0) {
    // No retention: just drop the active file so it restarts empty.
    try {
      rmSync(path, { force: true });
    } catch {
      /* best-effort; verified below */
    }
    return !existsSync(path);
  }

  // Prune the oldest rotation that would fall off the end.
  try {
    rmSync(`${path}.${maxFiles}`, { force: true });
  } catch {
    /* best-effort */
  }

  // Shift .1..(maxFiles-1) up to .2..maxFiles, oldest first.
  for (let i = maxFiles - 1; i >= 1; i -= 1) {
    const from = `${path}.${i}`;
    const to = `${path}.${i + 1}`;
    if (existsSync(from)) {
      try {
        renameSync(from, to);
      } catch {
        /* best-effort */
      }
    }
  }

  // Move the active file to .1. This is the step that matters for the cap:
  // if it fails (EACCES on the parent dir, EXDEV, ENOSPC, ...) the active
  // file is still over cap and the caller must not zero its counter.
  if (existsSync(path)) {
    try {
      renameSync(path, `${path}.1`);
    } catch {
      /* best-effort; verified below */
    }
  }
  return !existsSync(path);
}

/**
 * Create a size-capped rolling file sink. Never throws on write; logging must
 * not be able to crash the server.
 */
export function createRotatingFileSink(
  options: RotatingFileOptions,
): RotatingFileSink {
  const path = options.path;
  const maxBytes =
    options.maxBytes && options.maxBytes > 0
      ? options.maxBytes
      : DEFAULT_MAX_BYTES;
  const maxFiles =
    options.maxFiles !== undefined && options.maxFiles >= 0
      ? options.maxFiles
      : DEFAULT_MAX_FILES;

  try {
    // Logs are app-owned files now; keep them private to the service user.
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  } catch {
    /* best-effort; write() below will no-op on failure */
  }

  // Track size in-process to avoid a stat() on every line, refreshing from
  // disk lazily. Seed from the existing file so an already-large file rotates
  // on the next write rather than growing further.
  let size = currentSize(path);

  function write(line: string): void {
    const payload = line.endsWith("\n") ? line : `${line}\n`;
    const bytes = Buffer.byteLength(payload, "utf8");

    // Rotate before writing when this line would push us over the cap, so a
    // normal write never mixes into an already-full file. Only zero the
    // counter when rotation verifiably cleared the active file; otherwise
    // re-sync from disk so the next write still sees over-cap and retries
    // (a phantom-zero counter here would let the file grow unbounded while
    // appends keep succeeding, e.g. read-only parent dir).
    if (size > 0 && size + bytes > maxBytes) {
      size = rotate(path, maxFiles) ? 0 : currentSize(path);
    }

    try {
      appendFileSync(path, payload, { mode: 0o600 });
      size += bytes;
    } catch {
      // Re-sync from disk in case another process rotated underneath us; the
      // next write retries. Never throw.
      size = currentSize(path);
    }

    // Rotate immediately after any write that leaves the active file over the
    // cap (e.g. a single oversized line as the very first write), so the
    // active file never sits above maxBytes waiting for the next write. The
    // oversized content is bounded to that one rotated file and pruned like
    // any other rotation. Same rule: never zero the counter on a failed
    // rotation.
    if (size > maxBytes) {
      size = rotate(path, maxFiles) ? 0 : currentSize(path);
    }
  }

  return { write, path, maxBytes, maxFiles };
}
