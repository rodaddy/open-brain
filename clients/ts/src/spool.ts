/**
 * Durable JSONL write-ahead spool with redact-before-persist replay — the
 * TypeScript peer of `python/openbrain-memory/src/openbrain_memory/spool.py`.
 *
 * Delivery semantics (at-least-once): a replay dispatch that succeeds is only
 * removed from the spool by the atomic rewrite that follows the whole replay
 * pass. A crash after dispatch success but before that rewrite persists leaves
 * the unit in place, so its records are re-delivered on the next drain with
 * the same `idempotency_key`.
 *
 * Quarantine: a unit that fails `quarantineThreshold` consecutive replay
 * attempts moves atomically to the `<spool>.quarantine.jsonl` sidecar as a
 * content-free envelope line followed by the unit's original (already
 * redacted) record lines, and is never retried automatically. Consecutive
 * failure counts and the last replay-success time persist across process
 * restarts in the `<spool>.retry-state.json` sidecar; losing that sidecar
 * loses counters, never spool records.
 *
 * Cross-process exclusion uses an adjacent atomic-create lock file. Locks cover
 * only local snapshots and commits; replay dispatch deliberately happens after
 * releasing the lock, so slow networks never serialize writers.
 */

import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname } from "node:path";

import { stableJson } from "../../../server/contracts/contract.ts";
import type { Json } from "./client.ts";
import { idempotencyKey, redactValue, ValidationError } from "./policy.ts";
import { errorClassName, parseUnits } from "./spool-record.ts";
import type { SpoolRecord } from "./spool-record.ts";
import { summarizeUnits, unitKeyOf, unitSignature } from "./spool-summary.ts";
import {
  atomicWrite,
  normalizeSpoolLockTimings,
  normalizeSpoolSizes,
  rejectSymlink,
  syncDirectory,
  withLock,
} from "./spool-durability.ts";
import type { SpoolLockContext } from "./spool-durability.ts";
import {
  appendQuarantinedUnits,
  loadRetryState,
  mergeRetryUnits,
  quarantinedCount,
  removeQuarantinedEntries,
  splitKeepEnds,
  writeRetryState,
} from "./spool-sidecar.ts";
import type {
  RetryState,
  SpoolUnit as SidecarUnit,
  UnitRetryState,
} from "./spool-sidecar.ts";

/** This module.s replay unit: the sidecar shape carrying full records. */
type SpoolUnit = SidecarUnit<SpoolRecord>;
export { QUARANTINE_ENVELOPE_SCHEMA, RETRY_STATE_SCHEMA } from "./spool-sidecar.ts";

// Line parsing lives in ./spool-record.ts. Only errorClassName was ever part
// of this module's public surface, so only it is re-exported: the split moves
// code without widening what callers can reach.
export { errorClassName } from "./spool-record.ts";
export type { SpoolRecord } from "./spool-record.ts";

export const DEFAULT_QUARANTINE_THRESHOLD = 5;
const DEFAULT_LOCK_TIMEOUT_MS = 5_000;
const DEFAULT_LOCK_STALE_MS = 30_000;

/** Raised when an append would exceed spool capacity. */
export class SpoolFullError extends ValidationError {}

/**
 * Dispatcher signal: retain this unit without counting a replay failure.
 * Retained units accrue no retry count and never quarantine (#314).
 */
export class SpoolUnitRetained extends Error {}

export interface SpoolAppendRecord {
  operation: string;
  payload: Json;
  key?: string | null;
}

export interface SpoolStatus {
  path: string;
  exists: boolean;
  pending_count: number;
  max_lines: number;
  max_bytes: number;
  oldest_created_at: number | null;
  newest_created_at: number | null;
  operation_counts: Record<string, number>;
  corrupted_line_count: number;
  quarantined_count: number;
  retry_counts: Record<string, number>;
  last_success_at: number | null;
}

export type SpoolUnitStatusValue = "replayed" | "failed" | "quarantined" | "retained";

export interface SpoolUnitOutcome {
  status: SpoolUnitStatusValue;
  record_keys: readonly string[];
  operations: readonly string[];
  consecutive_failures: number;
  error_category: string | null;
  first_failure_at: number | null;
  last_failure_at: number | null;
}

export interface SpoolReplayReport {
  results: readonly Json[];
  outcomes: readonly SpoolUnitOutcome[];
}

export type SpoolDispatcher = (record: SpoolRecord) => Json | Promise<Json>;

function nowSeconds(): number {
  return Date.now() / 1000;
}

function utf8Length(text: string): number {
  return Buffer.byteLength(text, "utf-8");
}

/** Mutable accumulator threaded through one `replayWithReport` pass. */
interface ReplayPassState {
  replayedUnitKeys: Set<string>;
  failedUpdates: Map<string, UnitRetryState>;
  quarantineUpdates: Map<string, UnitRetryState>;
  anyReplayed: boolean;
}

/** What one unit's dispatch attempt produced, before it is scored. */
interface UnitDispatchAttempt {
  results: Json[];
  recordKeys: string[];
  operations: string[];
  failed: boolean;
  retained: boolean;
  error: unknown;
}

/**
 * Split the live spool into what stays on disk and what moves to quarantine.
 *
 * A unit that replayed this pass is dropped entirely; a unit whose failure
 * count crossed the quarantine threshold moves to the sidecar; everything
 * else keeps its original lines.
 */
function partitionLiveUnits(
  liveUnits: readonly SpoolUnit[],
  pass: ReplayPassState,
): {
  remainingLines: string[];
  remainingKeys: Set<string>;
  quarantinedNow: Array<[string, SpoolUnit, UnitRetryState]>;
} {
  const remainingLines: string[] = [];
  const remainingKeys = new Set<string>();
  const quarantinedNow: Array<[string, SpoolUnit, UnitRetryState]> = [];
  for (const unit of liveUnits) {
    const signature = unit.records !== null ? unitSignature(unit) : null;
    const unitKey = signature !== null ? unitKeyOf(signature) : null;
    if (unitKey !== null && pass.replayedUnitKeys.has(unitKey)) {
      continue;
    }
    const quarantineUpdate =
      unitKey !== null ? pass.quarantineUpdates.get(unitKey) : undefined;
    if (unitKey !== null && quarantineUpdate !== undefined) {
      quarantinedNow.push([unitKey, unit, quarantineUpdate]);
      continue;
    }
    remainingLines.push(...unit.lines);
    if (unitKey !== null) {
      remainingKeys.add(unitKey);
    }
  }
  return { remainingLines, remainingKeys, quarantinedNow };
}

/** Serialize one record to its spool line, redacting the payload first. */
function recordLine(input: {
  operation: string;
  payload: Json;
  key: string;
  createdAt: number;
  groupId: string | null;
  groupIndex: number | null;
  groupSize: number | null;
}): string {
  const record: Json = {
    idempotency_key: input.key,
    operation: input.operation,
    // Redact-before-persist: nothing unredacted may reach the spool file.
    payload: redactValue({ ...input.payload }),
    created_at: input.createdAt,
  };
  if (input.groupId !== null) {
    record["group_id"] = input.groupId;
    record["group_index"] = input.groupIndex;
    record["group_size"] = input.groupSize;
  }
  return stableJson(record) + "\n";
}

/**
 * Dispatch a unit's records in order, stopping at the first error.
 *
 * `SpoolUnitRetained` parks the unit without counting a failure; any other
 * error marks the unit failed and carries the error out for classification.
 */
async function dispatchUnit(
  records: readonly SpoolRecord[],
  dispatcher: SpoolDispatcher,
): Promise<UnitDispatchAttempt> {
  const attempt: UnitDispatchAttempt = {
    results: [],
    recordKeys: records.map((record) => record.idempotency_key),
    operations: records.map((record) => record.operation),
    failed: false,
    retained: false,
    error: null,
  };
  for (const record of records) {
    try {
      attempt.results.push(await dispatcher(record));
    } catch (dispatchError) {
      if (dispatchError instanceof SpoolUnitRetained) {
        attempt.retained = true;
      } else {
        attempt.failed = true;
        attempt.error = dispatchError;
      }
      break;
    }
  }
  return attempt;
}

export class JsonlSpool {
  readonly path: string;
  readonly quarantinePath: string;
  readonly retryStatePath: string;
  readonly lockPath: string;
  readonly maxLines: number;
  readonly maxBytes: number;
  readonly quarantineThreshold: number;
  private readonly directorySync: (directory: string) => void;
  private readonly lockTimeoutMs: number;
  private readonly lockStaleMs: number;

  constructor(
    path: string,
    options: {
      maxLines?: number;
      maxBytes?: number;
      quarantineThreshold?: number;
      /** Test seam for the directory durability boundary. */
      directorySync?: (directory: string) => void;
      lockTimeoutMs?: number;
      lockStaleMs?: number;
    } = {},
  ) {
    const sizes = normalizeSpoolSizes(
      options,
      DEFAULT_QUARANTINE_THRESHOLD,
      (message) => new ValidationError(message),
    );
    this.maxLines = sizes.maxLines;
    this.maxBytes = sizes.maxBytes;
    this.quarantineThreshold = sizes.quarantineThreshold;
    const timings = normalizeSpoolLockTimings(
      options,
      { timeoutMs: DEFAULT_LOCK_TIMEOUT_MS, staleMs: DEFAULT_LOCK_STALE_MS },
      (message) => new ValidationError(message),
    );
    this.lockTimeoutMs = timings.lockTimeoutMs;
    this.lockStaleMs = timings.lockStaleMs;
    this.path = path;
    this.quarantinePath = path + ".quarantine.jsonl";
    this.retryStatePath = path + ".retry-state.json";
    this.lockPath = path + ".lock";
    this.directorySync = options.directorySync ?? syncDirectory;
  }

  append(operation: string, payload: Json, key?: string | null): string {
    const keys = this.appendBatch([{ operation, payload, key: key ?? null }]);
    return keys[0] as string;
  }

  /** Append an ordered record group atomically or leave the spool unchanged. */
  appendBatch(records: readonly SpoolAppendRecord[]): string[] {
    if (records.length === 0) {
      return [];
    }
    const createdAt = nowSeconds();
    const safeKeys = records.map((record) => record.key ?? idempotencyKey());
    const groupId = records.length > 1 ? idempotencyKey() : null;
    const batchLines = records.map((record, index) =>
      recordLine({
        operation: record.operation,
        payload: record.payload,
        key: safeKeys[index] as string,
        createdAt,
        groupId,
        groupIndex: groupId !== null ? index : null,
        groupSize: groupId !== null ? records.length : null,
      }),
    );
    const batchBytes = batchLines.reduce((total, line) => total + utf8Length(line), 0);
    if (batchLines.length > this.maxLines || batchBytes > this.maxBytes) {
      throw new ValidationError(
        "spool batch exceeds configured maxLines/maxBytes limits",
      );
    }

    this.withLock(() => {
      mkdirSync(dirname(this.path), { recursive: true });
      this.rejectSymlink(this.path);
      const existing = existsSync(this.path)
        ? splitKeepEnds(readFileSync(this.path, "utf-8"))
        : [];
      const existingBytes = existing.reduce(
        (total, line) => total + utf8Length(line),
        0,
      );
      if (
        existing.length + batchLines.length > this.maxLines ||
        existingBytes + batchBytes > this.maxBytes
      ) {
        throw new SpoolFullError(
          "spool is full; append would exceed configured maxLines/maxBytes limits",
        );
      }
      this.writeLines([...existing, ...batchLines]);
    });
    return safeKeys;
  }

  records(): SpoolRecord[] {
    if (!existsSync(this.path)) {
      return [];
    }
    this.rejectSymlink(this.path);
    const lines = splitKeepEnds(readFileSync(this.path, "utf-8"));
    const result: SpoolRecord[] = [];
    for (const unit of this.parseUnits(lines)) {
      if (unit.records !== null) {
        result.push(...unit.records);
      }
    }
    return result;
  }

  status(): SpoolStatus {
    const retryState = loadRetryState(this.retryStatePath);
    const quarantined = quarantinedCount(this.quarantinePath);
    if (!existsSync(this.path)) {
      return {
        path: this.path,
        exists: false,
        pending_count: 0,
        max_lines: this.maxLines,
        max_bytes: this.maxBytes,
        oldest_created_at: null,
        newest_created_at: null,
        operation_counts: {},
        corrupted_line_count: 0,
        quarantined_count: quarantined,
        retry_counts: {},
        last_success_at: retryState.last_success_at,
      };
    }
    this.rejectSymlink(this.path);
    const lines = splitKeepEnds(readFileSync(this.path, "utf-8"));
    const {
      operationCounts,
      retryCounts,
      pendingCount,
      corruptedLineCount,
      oldest,
      newest,
    } = summarizeUnits(this.parseUnits(lines), retryState);
    return {
      path: this.path,
      exists: true,
      pending_count: pendingCount,
      max_lines: this.maxLines,
      max_bytes: this.maxBytes,
      oldest_created_at: oldest,
      newest_created_at: newest,
      operation_counts: operationCounts,
      corrupted_line_count: corruptedLineCount,
      quarantined_count: quarantined,
      retry_counts: retryCounts,
      last_success_at: retryState.last_success_at,
    };
  }

  async replay(dispatcher: SpoolDispatcher): Promise<Json[]> {
    const report = await this.replayWithReport(dispatcher);
    return [...report.results];
  }

  /**
   * Replay whole units and report content-free per-unit outcomes.
   *
   * A dispatcher may throw `SpoolUnitRetained` to park a unit without
   * counting a failure; any other error counts one consecutive failure, and a
   * unit reaching `quarantineThreshold` consecutive failures moves to the
   * quarantine sidecar in the same pass.
   */
  async replayWithReport(dispatcher: SpoolDispatcher): Promise<SpoolReplayReport> {
    const { snapshot, retryState } = this.withLock(() => {
      // Check before every replay snapshot read; existsSync follows symlinks.
      this.rejectSymlink(this.path);
      const lines = existsSync(this.path)
        ? splitKeepEnds(readFileSync(this.path, "utf-8"))
        : [];
      return {
        snapshot: this.parseUnits(lines),
        retryState: loadRetryState(this.retryStatePath),
      };
    });

    const now = nowSeconds();
    const results: Json[] = [];
    const outcomes: SpoolUnitOutcome[] = [];
    const pass: ReplayPassState = {
      replayedUnitKeys: new Set<string>(),
      failedUpdates: new Map<string, UnitRetryState>(),
      quarantineUpdates: new Map<string, UnitRetryState>(),
      anyReplayed: false,
    };

    for (const unit of snapshot) {
      const signature = unit.records === null ? null : unitSignature(unit);
      if (unit.records === null || signature === null) {
        continue;
      }
      const unitKey = unitKeyOf(signature);
      const attempt = await dispatchUnit(unit.records, dispatcher);
      const outcome = this.recordUnitAttempt({
        unitKey,
        attempt,
        prior: retryState.units.get(unitKey),
        pass,
        now,
      });
      if (outcome.status === "replayed") {
        results.push(...attempt.results);
      }
      outcomes.push(outcome);
    }

    if (
      pass.replayedUnitKeys.size > 0 ||
      pass.failedUpdates.size > 0 ||
      pass.quarantineUpdates.size > 0
    ) {
      this.withLock(() => this.commitReplayPass(pass, retryState, now));
    }
    return { results, outcomes };
  }

  /**
   * Fold one unit's dispatch attempt into the pass state and describe it.
   *
   * A retained unit accrues no failure count. A clean unit joins the replayed
   * set. A failed unit's consecutive count carries forward from `prior` and
   * routes to the quarantine map once it reaches the quarantine threshold.
   */
  private recordUnitAttempt(input: {
    unitKey: string;
    attempt: UnitDispatchAttempt;
    prior: UnitRetryState | undefined;
    pass: ReplayPassState;
    now: number;
  }): SpoolUnitOutcome {
    const { unitKey, attempt, prior, pass, now } = input;
    const shared = {
      record_keys: attempt.recordKeys,
      operations: attempt.operations,
      error_category: null,
      first_failure_at: null,
      last_failure_at: null,
    };
    if (attempt.retained) {
      return {
        ...shared,
        status: "retained",
        consecutive_failures: prior?.consecutive_failures ?? 0,
      };
    }
    if (!attempt.failed) {
      pass.replayedUnitKeys.add(unitKey);
      pass.anyReplayed = true;
      return { ...shared, status: "replayed", consecutive_failures: 0 };
    }
    return this.recordUnitFailure({ unitKey, attempt, prior, pass, now, shared });
  }

  /**
   * Score a failed unit: carry its consecutive count forward, route it to the
   * quarantine or retry map, and describe the outcome.
   */
  private recordUnitFailure(input: {
    unitKey: string;
    attempt: UnitDispatchAttempt;
    prior: UnitRetryState | undefined;
    pass: ReplayPassState;
    now: number;
    shared: Pick<SpoolUnitOutcome, "record_keys" | "operations">;
  }): SpoolUnitOutcome {
    const { unitKey, attempt, prior, pass, now, shared } = input;
    const update: UnitRetryState = {
      consecutive_failures: (prior?.consecutive_failures ?? 0) + 1,
      first_failure_at: prior?.first_failure_at ?? now,
      last_failure_at: now,
      // Error CLASS name only — never message bodies on disk or in
      // observability output.
      error_category: errorClassName(attempt.error),
    };
    const crossed = update.consecutive_failures >= this.quarantineThreshold;
    (crossed ? pass.quarantineUpdates : pass.failedUpdates).set(unitKey, update);
    return {
      ...shared,
      status: crossed ? "quarantined" : "failed",
      consecutive_failures: update.consecutive_failures,
      error_category: update.error_category,
      first_failure_at: update.first_failure_at,
      last_failure_at: update.last_failure_at,
    };
  }

  /**
   * Persist one replay pass: quarantine sidecar (replace-not-skip), stale
   * sidecar reconcile for replayed units, main-spool rewrite, retry state.
   * Each write is individually atomic; a crash before the retry-state write
   * loses only counters, never spool records.
   */
  private commitReplayPass(
    pass: ReplayPassState,
    priorState: RetryState,
    now: number,
  ): void {
    // Check before the commit read too: an attacker must not redirect a replay
    // between its unlocked network dispatch and the reconciliation pass.
    this.rejectSymlink(this.path);
    const liveLines = existsSync(this.path)
      ? splitKeepEnds(readFileSync(this.path, "utf-8"))
      : [];
    const partition = partitionLiveUnits(this.parseUnits(liveLines), pass);
    if (partition.quarantinedNow.length > 0) {
      appendQuarantinedUnits({
        quarantinePath: this.quarantinePath,
        entries: partition.quarantinedNow,
        now,
        directorySync: this.directorySync,
      });
    }
    if (pass.replayedUnitKeys.size > 0) {
      removeQuarantinedEntries(
        this.quarantinePath,
        pass.replayedUnitKeys,
        this.directorySync,
      );
    }
    this.writeLines(partition.remainingLines);
    const currentState = loadRetryState(this.retryStatePath);
    writeRetryState({
      retryStatePath: this.retryStatePath,
      state: {
        last_success_at: pass.anyReplayed ? now : currentState.last_success_at,
        units: mergeRetryUnits({
          remainingKeys: partition.remainingKeys,
          failedUpdates: pass.failedUpdates,
          currentState,
          priorState,
        }),
      },
      directorySync: this.directorySync,
    });
  }

  private writeLines(lines: readonly string[]): void {
    this.atomicWrite(this.path, lines);
  }

  private atomicWrite(path: string, lines: readonly string[]): void {
    atomicWrite(path, lines, this.directorySync);
  }

  private withLock<T>(action: () => T): T {
    return withLock(this.lockContext(), action);
  }

  private lockContext(): SpoolLockContext {
    return {
      lockPath: this.lockPath,
      lockTimeoutMs: this.lockTimeoutMs,
      lockStaleMs: this.lockStaleMs,
    };
  }

  private rejectSymlink(path: string): void {
    rejectSymlink(path);
  }

  /** Group lines into replay units (single records or contiguous batches). */
  private parseUnits(lines: readonly string[]): SpoolUnit[] {
    return parseUnits(lines);
  }
}

/** Expose file mode for tests without importing node:fs everywhere. */
export function fileMode(path: string): number {
  return statSync(path).mode & 0o7777;
}
