/**
 * Durability and cross-process exclusion primitives for the JSONL spool.
 *
 * Extracted verbatim from `./spool.ts` so that module keeps to the repo's
 * per-file size standard. Every function here is a free function over explicit
 * arguments: the spool passes the paths and the durability seam it already
 * holds, so no behavior, ordering, or error text changes. Imported only from
 * `./spool.ts`; no caller or test reaches these directly.
 */

import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname, basename, join } from "node:path";

const LOCK_WAIT_MS = 10;

/** Injectable directory-fsync boundary, so tests can observe durability. */
export type DirectorySync = (directory: string) => void;

/** Paths and timings one spool instance needs for its lock protocol. */
export interface SpoolLockContext {
  lockPath: string;
  lockTimeoutMs: number;
  lockStaleMs: number;
}

export function syncDirectory(directory: string): void {
  const dirFd = openSync(directory, "r");
  try {
    fsyncSync(dirFd);
  } finally {
    closeSync(dirFd);
  }
}

export function rejectSymlink(path: string): void {
  let isLink = false;
  try {
    isLink = lstatSync(path).isSymbolicLink();
  } catch {
    return;
  }
  if (isLink) {
    throw new Error(`Refusing to use symlink spool path: ${path}`);
  }
}

export function atomicWrite(
  path: string,
  lines: readonly string[],
  directorySync: DirectorySync,
): void {
  const payload = Buffer.from(lines.join(""), "utf-8");
  rejectSymlink(path);
  const prior = existsSync(path) ? readFileSync(path) : null;
  let replaced = false;
  try {
    replaceBytes(path, payload);
    replaced = true;
    directorySync(dirname(path));
  } catch (error) {
    if (replaced) {
      try {
        restorePrior(path, prior, directorySync);
      } catch (restoreError) {
        throw new Error("spool durability failure could not restore prior state", {
          cause: restoreError,
        });
      }
    }
    throw error;
  }
}

/** Replace bytes atomically after the caller captured the prior state. */
function replaceBytes(path: string, payload: Buffer): void {
  const directory = dirname(path);
  const tmpPath = join(directory, `.${basename(path)}.${crypto.randomUUID()}.tmp`);
  let fd: number | null = null;
  try {
    fd = openSync(tmpPath, "wx", 0o600);
    chmodSync(tmpPath, 0o600);
    let written = 0;
    while (written < payload.byteLength) {
      const chunk = writeSync(fd, payload, written, payload.byteLength - written);
      if (chunk <= 0) {
        throw new Error("spool write made no forward progress");
      }
      written += chunk;
    }
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(tmpPath, path);
  } catch (error) {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // already closing on error
      }
    }
    try {
      unlinkSync(tmpPath);
    } catch {
      // tmp already renamed or never created
    }
    throw error;
  }
}

/** Restore original bytes (or original absence) and prove the restore. */
function restorePrior(
  path: string,
  prior: Buffer | null,
  directorySync: DirectorySync,
): void {
  if (prior === null) {
    unlinkSync(path);
  } else {
    replaceBytes(path, prior);
  }
  directorySync(dirname(path));
}

/** Execute a short local filesystem transaction under an ownership lock. */
export function withLock<T>(context: SpoolLockContext, action: () => T): T {
  const token = acquireLock(context);
  try {
    return action();
  } finally {
    releaseLock(context.lockPath, token);
  }
}

function acquireLock(context: SpoolLockContext): string {
  const deadline = Date.now() + context.lockTimeoutMs;
  mkdirSync(dirname(context.lockPath), { recursive: true });
  while (true) {
    const token = crypto.randomUUID();
    const { acquired, collision } = publishLockCandidate(context.lockPath, token);
    if (acquired) return token;
    if (!isAlreadyExists(collision)) throw collision;
    if (recoverDeadOrStaleLock(context)) continue;
    if (Date.now() >= deadline) {
      throw new Error("timed out acquiring spool lock");
    }
    waitForLock(LOCK_WAIT_MS);
  }
}

function recoverDeadOrStaleLock(context: SpoolLockContext): boolean {
  rejectSymlink(context.lockPath);
  let lockStat: ReturnType<typeof statSync>;
  try {
    lockStat = statSync(context.lockPath);
  } catch {
    return true;
  }
  let owner: { pid?: unknown } = {};
  try {
    owner = JSON.parse(readFileSync(context.lockPath, "utf-8")) as {
      pid?: unknown;
    };
  } catch {
    // A creator may still be writing metadata; only steal an old empty lock.
  }
  const stale = Date.now() - lockStat.mtimeMs >= context.lockStaleMs;
  const hasOwnerPid =
    typeof owner.pid === "number" && Number.isSafeInteger(owner.pid) && owner.pid > 0;
  const dead = hasOwnerPid && ownerIsDead(owner.pid as number);
  // Never steal a lock from a live owner merely because one local filesystem
  // transaction exceeded the stale threshold. Staleness is a recovery signal
  // only when the owner metadata is missing or malformed.
  if (!dead && !(stale && !hasOwnerPid)) return false;
  const stalePath = `${context.lockPath}.${crypto.randomUUID()}.stale`;
  try {
    renameSync(context.lockPath, stalePath);
    unlinkSync(stalePath);
    return true;
  } catch {
    return false;
  }
}

function releaseLock(lockPath: string, token: string): void {
  try {
    rejectSymlink(lockPath);
    const owner = JSON.parse(readFileSync(lockPath, "utf-8")) as {
      token?: unknown;
    };
    if (owner.token === token) {
      unlinkSync(lockPath);
    }
  } catch {
    // A stale-lock recovery may have replaced our lock; never unlink it.
  }
}

function isAlreadyExists(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "EEXIST"
  );
}

function ownerIsDead(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: unknown }).code === "ESRCH"
    );
  }
}

/**
 * Write one lock candidate and try to publish it by atomic hard-link.
 *
 * The candidate carries a unique token in its name, so it is invisible to
 * contenders until `linkSync` succeeds — only a fully written, fsynced owner
 * record ever appears at `lockPath`. The candidate is always unlinked, whether
 * the link won the race or lost it.
 */
function publishLockCandidate(
  lockPath: string,
  token: string,
): { acquired: boolean; collision: unknown } {
  const candidatePath = `${lockPath}.${token}.candidate`;
  let fd: number | null = null;
  let acquired = false;
  let collision: unknown = null;
  try {
    fd = openSync(candidatePath, "wx", 0o600);
    writeOwnerRecord(fd, token);
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    try {
      linkSync(candidatePath, lockPath);
      acquired = true;
    } catch (error) {
      collision = error;
    }
  } finally {
    closeQuietly(fd);
    unlinkQuietly(candidatePath);
  }
  return { acquired, collision };
}

function writeOwnerRecord(fd: number, token: string): void {
  const owner = Buffer.from(
    JSON.stringify({ token, pid: process.pid, created_at_ms: Date.now() }),
    "utf-8",
  );
  let written = 0;
  while (written < owner.byteLength) {
    const chunk = writeSync(fd, owner, written, owner.byteLength - written);
    if (chunk <= 0) {
      throw new Error("spool lock write made no forward progress");
    }
    written += chunk;
  }
}

function closeQuietly(fd: number | null): void {
  if (fd === null) {
    return;
  }
  try {
    closeSync(fd);
  } catch {
    // The candidate write already failed.
  }
}

function unlinkQuietly(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // Candidate was never created or was already cleaned up.
  }
}

function waitForLock(milliseconds: number): void {
  const sleeper = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  Atomics.wait(sleeper, 0, 0, milliseconds);
}

/** Options the spool normalizes at construction time. */
export interface SpoolSizeOptions {
  maxLines?: number;
  maxBytes?: number;
  quarantineThreshold?: number;
}

/** Options governing how long a contended lock is waited on or stolen. */
export interface SpoolLockOptions {
  lockTimeoutMs?: number;
  lockStaleMs?: number;
}

/** Normalized capacity settings, each already validated as >= 1. */
export interface NormalizedSpoolSizes {
  maxLines: number;
  maxBytes: number;
  quarantineThreshold: number;
}

/**
 * Apply capacity defaults and reject non-positive values.
 *
 * Same defaults, same order of checks, and the same `ValidationError` messages
 * the constructor raised inline before the split.
 */
export function normalizeSpoolSizes(
  options: SpoolSizeOptions,
  defaultQuarantineThreshold: number,
  raise: (message: string) => Error,
): NormalizedSpoolSizes {
  const maxLines = options.maxLines ?? 1000;
  const maxBytes = options.maxBytes ?? 1_000_000;
  const quarantineThreshold = options.quarantineThreshold ?? defaultQuarantineThreshold;
  if (maxLines < 1) {
    throw raise("maxLines must be >= 1");
  }
  if (maxBytes < 1) {
    throw raise("maxBytes must be >= 1");
  }
  if (quarantineThreshold < 1) {
    throw raise("quarantineThreshold must be >= 1");
  }
  return { maxLines, maxBytes, quarantineThreshold };
}

/** Apply lock timing defaults and reject non-positive durations. */
export function normalizeSpoolLockTimings(
  options: SpoolLockOptions,
  defaults: { timeoutMs: number; staleMs: number },
  raise: (message: string) => Error,
): { lockTimeoutMs: number; lockStaleMs: number } {
  const lockTimeoutMs = options.lockTimeoutMs ?? defaults.timeoutMs;
  const lockStaleMs = options.lockStaleMs ?? defaults.staleMs;
  if (lockTimeoutMs < 1 || lockStaleMs < 1) {
    throw raise("spool lock timeouts must be >= 1ms");
  }
  return { lockTimeoutMs, lockStaleMs };
}
