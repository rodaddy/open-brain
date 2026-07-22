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

import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
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
import { z } from "zod";

import { stableJson } from "../../../src/contract.ts";
import type { Json } from "./client.ts";
import { idempotencyKey, redactValue, ValidationError } from "./policy.ts";

export const DEFAULT_QUARANTINE_THRESHOLD = 5;
export const QUARANTINE_ENVELOPE_SCHEMA = "openbrain.spool_quarantine.v1";
export const RETRY_STATE_SCHEMA = "openbrain.spool_retry_state.v1";
const MAX_RETRY_STATE_FAILURES = 1_000_000;
const LOCK_WAIT_MS = 10;
const DEFAULT_LOCK_TIMEOUT_MS = 5_000;
const DEFAULT_LOCK_STALE_MS = 30_000;

/** Raised when an append would exceed spool capacity. */
export class SpoolFullError extends ValidationError {}

/**
 * Dispatcher signal: retain this unit without counting a replay failure.
 * Retained units accrue no retry count and never quarantine (#314).
 */
export class SpoolUnitRetained extends Error {}

export interface SpoolRecord {
  idempotency_key: string;
  operation: string;
  payload: Json;
  created_at: number;
  group_id?: string;
  group_index?: number;
  group_size?: number;
}

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

export type SpoolUnitStatusValue =
  "replayed" | "failed" | "quarantined" | "retained";

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

interface UnitRetryState {
  consecutive_failures: number;
  first_failure_at: number;
  last_failure_at: number;
  error_category: string;
}

interface RetryState {
  last_success_at: number | null;
  units: Map<string, UnitRetryState>;
}

interface SpoolUnit {
  lines: readonly string[];
  records: readonly SpoolRecord[] | null;
  corrupted_line_count: number;
}

const unitRetryStateSchema = z
  .object({
    consecutive_failures: z.number().int(),
    first_failure_at: z.number().finite(),
    last_failure_at: z.number().finite(),
    error_category: z.string(),
  })
  .loose();

const retryStateFileSchema = z
  .object({
    last_success_at: z.unknown().optional(),
    units: z.record(z.string(), z.unknown()),
  })
  .loose();

const quarantineEnvelopeSchema = z
  .object({
    schema: z.literal(QUARANTINE_ENVELOPE_SCHEMA),
    unit_key: z.string(),
  })
  .loose();

function nowSeconds(): number {
  return Date.now() / 1000;
}

function utf8Length(text: string): number {
  return Buffer.byteLength(text, "utf-8");
}

function splitKeepEnds(text: string): string[] {
  const lines = text.split(/(?<=\n)/);
  if (lines.length > 0 && lines.at(-1) === "") {
    lines.pop();
  }
  return lines;
}

function unitSignature(unit: SpoolUnit): [string | null, string[]] | null {
  if (unit.records === null || unit.records.length === 0) {
    return null;
  }
  const first = unit.records[0] as SpoolRecord;
  return [
    first.group_id ?? null,
    unit.records.map((record) => record.idempotency_key),
  ];
}

function unitKeyOf(signature: [string | null, string[]]): string {
  return JSON.stringify([signature[0], signature[1]]);
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
    this.maxLines = options.maxLines ?? 1000;
    this.maxBytes = options.maxBytes ?? 1_000_000;
    this.quarantineThreshold =
      options.quarantineThreshold ?? DEFAULT_QUARANTINE_THRESHOLD;
    if (this.maxLines < 1) {
      throw new ValidationError("maxLines must be >= 1");
    }
    if (this.maxBytes < 1) {
      throw new ValidationError("maxBytes must be >= 1");
    }
    if (this.quarantineThreshold < 1) {
      throw new ValidationError("quarantineThreshold must be >= 1");
    }
    this.lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
    this.lockStaleMs = options.lockStaleMs ?? DEFAULT_LOCK_STALE_MS;
    if (this.lockTimeoutMs < 1 || this.lockStaleMs < 1) {
      throw new ValidationError("spool lock timeouts must be >= 1ms");
    }
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
      this.recordLine(
        record.operation,
        record.payload,
        safeKeys[index] as string,
        createdAt,
        groupId,
        groupId !== null ? index : null,
        groupId !== null ? records.length : null,
      ),
    );
    const batchBytes = batchLines.reduce(
      (total, line) => total + utf8Length(line),
      0,
    );
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

  private recordLine(
    operation: string,
    payload: Json,
    key: string,
    createdAt: number,
    groupId: string | null,
    groupIndex: number | null,
    groupSize: number | null,
  ): string {
    const record: Json = {
      idempotency_key: key,
      operation,
      // Redact-before-persist: nothing unredacted may reach the spool file.
      payload: redactValue({ ...payload }),
      created_at: createdAt,
    };
    if (groupId !== null) {
      record["group_id"] = groupId;
      record["group_index"] = groupIndex;
      record["group_size"] = groupSize;
    }
    return stableJson(record) + "\n";
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
    const retryState = this.loadRetryState();
    const quarantinedCount = this.quarantinedCount();
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
        quarantined_count: quarantinedCount,
        retry_counts: {},
        last_success_at: retryState.last_success_at,
      };
    }
    this.rejectSymlink(this.path);
    const lines = splitKeepEnds(readFileSync(this.path, "utf-8"));
    const units = this.parseUnits(lines);
    const operationCounts: Record<string, number> = {};
    const retryCounts: Record<string, number> = {};
    let pendingCount = 0;
    let corruptedLineCount = 0;
    let oldest: number | null = null;
    let newest: number | null = null;
    for (const unit of units) {
      corruptedLineCount += unit.corrupted_line_count;
      if (unit.records === null) {
        continue;
      }
      const signature = unitSignature(unit);
      if (signature !== null) {
        const state = retryState.units.get(unitKeyOf(signature));
        if (state !== undefined) {
          // Keyed by the unit's first record key: content-free and matching
          // the spool_key used on quarantine receipts.
          retryCounts[(unit.records[0] as SpoolRecord).idempotency_key] =
            state.consecutive_failures;
        }
      }
      for (const record of unit.records) {
        pendingCount += 1;
        operationCounts[record.operation] =
          (operationCounts[record.operation] ?? 0) + 1;
        if (oldest === null || record.created_at < oldest) {
          oldest = record.created_at;
        }
        if (newest === null || record.created_at > newest) {
          newest = record.created_at;
        }
      }
    }
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
      quarantined_count: quarantinedCount,
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
  async replayWithReport(
    dispatcher: SpoolDispatcher,
  ): Promise<SpoolReplayReport> {
    const { snapshot, retryState } = this.withLock(() => {
      // Check before every replay snapshot read; existsSync follows symlinks.
      this.rejectSymlink(this.path);
      const lines = existsSync(this.path)
        ? splitKeepEnds(readFileSync(this.path, "utf-8"))
        : [];
      return {
        snapshot: this.parseUnits(lines),
        retryState: this.loadRetryState(),
      };
    });

    const now = nowSeconds();
    const results: Json[] = [];
    const outcomes: SpoolUnitOutcome[] = [];
    const replayedUnitKeys = new Set<string>();
    const failedUpdates = new Map<string, UnitRetryState>();
    const quarantineUpdates = new Map<string, UnitRetryState>();
    let anyReplayed = false;

    for (const unit of snapshot) {
      if (unit.records === null) {
        continue;
      }
      const signature = unitSignature(unit);
      if (signature === null) {
        continue;
      }
      const unitKey = unitKeyOf(signature);
      const prior = retryState.units.get(unitKey);
      const recordKeys = unit.records.map((record) => record.idempotency_key);
      const operations = unit.records.map((record) => record.operation);
      const unitResults: Json[] = [];
      let error: unknown = null;
      let failed = false;
      let retained = false;
      for (const record of unit.records) {
        try {
          unitResults.push(await dispatcher(record));
        } catch (dispatchError) {
          if (dispatchError instanceof SpoolUnitRetained) {
            retained = true;
          } else {
            failed = true;
            error = dispatchError;
          }
          break;
        }
      }
      if (retained) {
        outcomes.push({
          status: "retained",
          record_keys: recordKeys,
          operations,
          consecutive_failures: prior?.consecutive_failures ?? 0,
          error_category: null,
          first_failure_at: null,
          last_failure_at: null,
        });
        continue;
      }
      if (!failed) {
        replayedUnitKeys.add(unitKey);
        results.push(...unitResults);
        anyReplayed = true;
        outcomes.push({
          status: "replayed",
          record_keys: recordKeys,
          operations,
          consecutive_failures: 0,
          error_category: null,
          first_failure_at: null,
          last_failure_at: null,
        });
        continue;
      }
      const update: UnitRetryState = {
        consecutive_failures: (prior?.consecutive_failures ?? 0) + 1,
        first_failure_at: prior?.first_failure_at ?? now,
        last_failure_at: now,
        // Error CLASS name only — never message bodies on disk or in
        // observability output.
        error_category: errorClassName(error),
      };
      const crossed = update.consecutive_failures >= this.quarantineThreshold;
      (crossed ? quarantineUpdates : failedUpdates).set(unitKey, update);
      outcomes.push({
        status: crossed ? "quarantined" : "failed",
        record_keys: recordKeys,
        operations,
        consecutive_failures: update.consecutive_failures,
        error_category: update.error_category,
        first_failure_at: update.first_failure_at,
        last_failure_at: update.last_failure_at,
      });
    }

    if (
      replayedUnitKeys.size > 0 ||
      failedUpdates.size > 0 ||
      quarantineUpdates.size > 0
    ) {
      this.withLock(() =>
        this.commitReplayPass(
          replayedUnitKeys,
          failedUpdates,
          quarantineUpdates,
          retryState,
          anyReplayed,
          now,
        ),
      );
    }
    return { results, outcomes };
  }

  /**
   * Persist one replay pass: quarantine sidecar (replace-not-skip), stale
   * sidecar reconcile for replayed units, main-spool rewrite, retry state.
   * Each write is individually atomic; a crash before the retry-state write
   * loses only counters, never spool records.
   */
  private commitReplayPass(
    replayedUnitKeys: Set<string>,
    failedUpdates: Map<string, UnitRetryState>,
    quarantineUpdates: Map<string, UnitRetryState>,
    priorState: RetryState,
    anyReplayed: boolean,
    now: number,
  ): void {
    // Check before the commit read too: an attacker must not redirect a replay
    // between its unlocked network dispatch and the reconciliation pass.
    this.rejectSymlink(this.path);
    const liveLines = existsSync(this.path)
      ? splitKeepEnds(readFileSync(this.path, "utf-8"))
      : [];
    const liveUnits = this.parseUnits(liveLines);
    const remainingLines: string[] = [];
    const remainingKeys = new Set<string>();
    const quarantinedNow: Array<[string, SpoolUnit, UnitRetryState]> = [];
    for (const unit of liveUnits) {
      const signature = unit.records !== null ? unitSignature(unit) : null;
      const unitKey = signature !== null ? unitKeyOf(signature) : null;
      if (unitKey !== null && replayedUnitKeys.has(unitKey)) {
        continue;
      }
      const quarantineUpdate =
        unitKey !== null ? quarantineUpdates.get(unitKey) : undefined;
      if (unitKey !== null && quarantineUpdate !== undefined) {
        quarantinedNow.push([unitKey, unit, quarantineUpdate]);
        continue;
      }
      remainingLines.push(...unit.lines);
      if (unitKey !== null) {
        remainingKeys.add(unitKey);
      }
    }
    if (quarantinedNow.length > 0) {
      this.appendQuarantinedUnits(quarantinedNow, now);
    }
    if (replayedUnitKeys.size > 0) {
      this.removeQuarantinedEntries(replayedUnitKeys);
    }
    this.writeLines(remainingLines);
    const currentState = this.loadRetryState();
    const units = new Map<string, UnitRetryState>();
    for (const unitKey of remainingKeys) {
      const update = failedUpdates.get(unitKey);
      const prior =
        currentState.units.get(unitKey) ?? priorState.units.get(unitKey);
      if (
        update !== undefined &&
        (prior === undefined ||
          update.consecutive_failures >= prior.consecutive_failures)
      ) {
        units.set(unitKey, update);
      } else if (prior !== undefined) {
        units.set(unitKey, prior);
      }
    }
    this.writeRetryState({
      last_success_at: anyReplayed ? now : currentState.last_success_at,
      units,
    });
  }

  /**
   * Persist quarantined units, replacing any prior entry per unit key
   * (replace-not-skip): re-quarantining after a crash between the sidecar
   * append and the main-spool rewrite converges to one entry while keeping
   * the freshest lines and counts.
   */
  private appendQuarantinedUnits(
    entries: Array<[string, SpoolUnit, UnitRetryState]>,
    now: number,
  ): void {
    this.rejectSymlink(this.quarantinePath);
    const existingLines = existsSync(this.quarantinePath)
      ? splitKeepEnds(readFileSync(this.quarantinePath, "utf-8"))
      : [];
    const fresh = new Map<string, string[]>();
    for (const [unitKey, unit, state] of entries) {
      const records = unit.records as readonly SpoolRecord[];
      const envelope: Json = {
        schema: QUARANTINE_ENVELOPE_SCHEMA,
        unit_key: unitKey,
        record_keys: records.map((record) => record.idempotency_key),
        operations: records.map((record) => record.operation),
        consecutive_failures: state.consecutive_failures,
        first_failure_at: state.first_failure_at,
        last_failure_at: state.last_failure_at,
        error_category: state.error_category,
        quarantined_at: now,
        line_count: unit.lines.length,
      };
      fresh.set(unitKey, [stableJson(envelope) + "\n", ...unit.lines]);
    }
    const kept = this.quarantineLinesWithout(
      existingLines,
      new Set(fresh.keys()),
    );
    const appended: string[] = [];
    for (const entry of fresh.values()) {
      appended.push(...entry);
    }
    this.atomicWrite(this.quarantinePath, [...kept, ...appended]);
  }

  /**
   * Drop sidecar entries for units that just replayed successfully — a crash
   * between the quarantine append and the main-spool rewrite leaves a unit in
   * both files; the phantom entry is removed on later replay success.
   */
  private removeQuarantinedEntries(unitKeys: Set<string>): void {
    if (!existsSync(this.quarantinePath)) {
      return;
    }
    this.rejectSymlink(this.quarantinePath);
    const lines = splitKeepEnds(readFileSync(this.quarantinePath, "utf-8"));
    const kept = this.quarantineLinesWithout(lines, unitKeys);
    if (kept.length !== lines.length) {
      this.atomicWrite(this.quarantinePath, kept);
    }
  }

  private quarantineLinesWithout(
    lines: readonly string[],
    unitKeys: Set<string>,
  ): string[] {
    const kept: string[] = [];
    let dropping = false;
    for (const line of lines) {
      const envelope = quarantineEnvelope(line);
      if (envelope !== null) {
        dropping = unitKeys.has(envelope.unit_key);
      }
      if (!dropping) {
        kept.push(line);
      }
    }
    return kept;
  }

  private quarantinedCount(): number {
    if (!existsSync(this.quarantinePath)) {
      return 0;
    }
    this.rejectSymlink(this.quarantinePath);
    const lines = splitKeepEnds(readFileSync(this.quarantinePath, "utf-8"));
    return lines.filter((line) => quarantineEnvelope(line) !== null).length;
  }

  private loadRetryState(): RetryState {
    const empty: RetryState = { last_success_at: null, units: new Map() };
    if (!existsSync(this.retryStatePath)) {
      return empty;
    }
    this.rejectSymlink(this.retryStatePath);
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(this.retryStatePath, "utf-8"));
    } catch {
      return empty;
    }
    const parsed = retryStateFileSchema.safeParse(raw);
    if (!parsed.success) {
      return empty;
    }
    const units = new Map<string, UnitRetryState>();
    for (const [unitKey, value] of Object.entries(parsed.data.units)) {
      const unitParsed = unitRetryStateSchema.safeParse(value);
      if (!unitParsed.success) {
        continue;
      }
      const unit = unitParsed.data;
      // Zero/negative counters carry no information: treat as absent — the
      // safe direction, a unit can never quarantine early. Absurd counters
      // from the untrusted sidecar are clamped.
      if (unit.consecutive_failures < 1) {
        continue;
      }
      units.set(unitKey, {
        consecutive_failures: Math.min(
          unit.consecutive_failures,
          MAX_RETRY_STATE_FAILURES,
        ),
        first_failure_at: unit.first_failure_at,
        last_failure_at: unit.last_failure_at,
        error_category: unit.error_category,
      });
    }
    const lastSuccess = parsed.data.last_success_at;
    return {
      last_success_at:
        typeof lastSuccess === "number" && Number.isFinite(lastSuccess)
          ? lastSuccess
          : null,
      units,
    };
  }

  private writeRetryState(state: RetryState): void {
    this.rejectSymlink(this.retryStatePath);
    const payload: Json = {
      schema: RETRY_STATE_SCHEMA,
      last_success_at: state.last_success_at,
      units: Object.fromEntries(
        [...state.units.entries()].map(([unitKey, unit]) => [
          unitKey,
          { ...unit },
        ]),
      ),
    };
    this.atomicWrite(this.retryStatePath, [stableJson(payload) + "\n"]);
  }

  private writeLines(lines: readonly string[]): void {
    this.atomicWrite(this.path, lines);
  }

  private atomicWrite(path: string, lines: readonly string[]): void {
    const payload = Buffer.from(lines.join(""), "utf-8");
    this.rejectSymlink(path);
    const prior = existsSync(path) ? readFileSync(path) : null;
    let replaced = false;
    try {
      this.replaceBytes(path, payload);
      replaced = true;
      this.directorySync(dirname(path));
    } catch (error) {
      if (replaced) {
        try {
          this.restorePrior(path, prior);
        } catch (restoreError) {
          throw new Error(
            "spool durability failure could not restore prior state",
            {
              cause: restoreError,
            },
          );
        }
      }
      throw error;
    }
  }

  /** Replace bytes atomically after the caller captured the prior state. */
  private replaceBytes(path: string, payload: Buffer): void {
    const directory = dirname(path);
    const tmpPath = join(
      directory,
      `.${basename(path)}.${crypto.randomUUID()}.tmp`,
    );
    let fd: number | null = null;
    try {
      fd = openSync(tmpPath, "wx", 0o600);
      chmodSync(tmpPath, 0o600);
      let written = 0;
      while (written < payload.byteLength) {
        const chunk = writeSync(
          fd,
          payload,
          written,
          payload.byteLength - written,
        );
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
  private restorePrior(path: string, prior: Buffer | null): void {
    if (prior === null) {
      unlinkSync(path);
    } else {
      this.replaceBytes(path, prior);
    }
    this.directorySync(dirname(path));
  }

  /** Execute a short local filesystem transaction with a token-safe lock. */
  private withLock<T>(action: () => T): T {
    const token = this.acquireLock();
    try {
      return action();
    } finally {
      this.releaseLock(token);
    }
  }

  private acquireLock(): string {
    const deadline = Date.now() + this.lockTimeoutMs;
    mkdirSync(dirname(this.lockPath), { recursive: true });
    while (true) {
      const token = crypto.randomUUID();
      let fd: number | null = null;
      let created = false;
      try {
        fd = openSync(this.lockPath, "wx", 0o600);
        created = true;
        const owner = Buffer.from(
          JSON.stringify({
            token,
            pid: process.pid,
            created_at_ms: Date.now(),
          }),
          "utf-8",
        );
        let written = 0;
        while (written < owner.byteLength) {
          const chunk = writeSync(
            fd,
            owner,
            written,
            owner.byteLength - written,
          );
          if (chunk <= 0) {
            throw new Error("spool lock write made no forward progress");
          }
          written += chunk;
        }
        fsyncSync(fd);
        closeSync(fd);
        return token;
      } catch (error) {
        if (fd !== null) {
          try {
            closeSync(fd);
          } catch {
            // The lock acquisition failed before ownership was established.
          }
        }
        if (created) {
          try {
            unlinkSync(this.lockPath);
          } catch {
            // Stale-lock recovery will safely handle a failed cleanup.
          }
        }
        if (!isAlreadyExists(error)) throw error;
        if (this.recoverDeadOrStaleLock()) continue;
        if (Date.now() >= deadline) {
          throw new Error("timed out acquiring spool lock");
        }
        waitForLock(LOCK_WAIT_MS);
      }
    }
  }

  private recoverDeadOrStaleLock(): boolean {
    this.rejectSymlink(this.lockPath);
    let lockStat: ReturnType<typeof statSync>;
    try {
      lockStat = statSync(this.lockPath);
    } catch {
      return true;
    }
    let owner: { pid?: unknown } = {};
    try {
      owner = JSON.parse(readFileSync(this.lockPath, "utf-8")) as {
        pid?: unknown;
      };
    } catch {
      // A creator may still be writing metadata; only steal an old empty lock.
    }
    const stale = Date.now() - lockStat.mtimeMs >= this.lockStaleMs;
    const hasOwnerPid = typeof owner.pid === "number";
    const dead = hasOwnerPid && ownerIsDead(owner.pid as number);
    // Never steal a lock from a live owner merely because one local filesystem
    // transaction exceeded the stale threshold. Staleness is a recovery signal
    // only when the owner metadata is missing or malformed.
    if (!dead && !(stale && !hasOwnerPid)) return false;
    const stalePath = `${this.lockPath}.${crypto.randomUUID()}.stale`;
    try {
      renameSync(this.lockPath, stalePath);
      unlinkSync(stalePath);
      return true;
    } catch {
      return false;
    }
  }

  private releaseLock(token: string): void {
    try {
      this.rejectSymlink(this.lockPath);
      const owner = JSON.parse(readFileSync(this.lockPath, "utf-8")) as {
        token?: unknown;
      };
      if (owner.token === token) {
        unlinkSync(this.lockPath);
      }
    } catch {
      // A stale-lock recovery may have replaced our lock; never unlink it.
    }
  }

  private rejectSymlink(path: string): void {
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

  /** Group lines into replay units (single records or contiguous batches). */
  private parseUnits(lines: readonly string[]): SpoolUnit[] {
    const units: SpoolUnit[] = [];
    const grouped: string[][] = [];
    let activeGroupId: string | null = null;
    for (const line of lines) {
      const groupId = rawGroupId(line);
      if (groupId !== null && groupId === activeGroupId) {
        (grouped.at(-1) as string[]).push(line);
        continue;
      }
      grouped.push([line]);
      activeGroupId = groupId;
    }
    for (const group of grouped) {
      const parsed: SpoolRecord[] = [];
      let corrupted = 0;
      for (const line of group) {
        if (!line.trim()) {
          continue;
        }
        const record = parseRecord(line);
        if (record === null) {
          corrupted += 1;
        } else {
          parsed.push(record);
        }
      }
      if (corrupted > 0 || parsed.length === 0) {
        units.push({
          lines: group,
          records: null,
          corrupted_line_count: corrupted,
        });
        continue;
      }
      const first = parsed[0] as SpoolRecord;
      const validGroup =
        first.group_id === undefined ||
        (parsed.length === first.group_size &&
          parsed.every(
            (record) =>
              record.group_id === first.group_id &&
              record.group_size === first.group_size,
          ) &&
          parsed.every((record, index) => record.group_index === index));
      if (!validGroup) {
        units.push({
          lines: group,
          records: null,
          corrupted_line_count: group.length,
        });
        continue;
      }
      units.push({ lines: group, records: parsed, corrupted_line_count: 0 });
    }
    return units;
  }
}

function syncDirectory(directory: string): void {
  const dirFd = openSync(directory, "r");
  try {
    fsyncSync(dirFd);
  } finally {
    closeSync(dirFd);
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

function waitForLock(milliseconds: number): void {
  const sleeper = new Int32Array(
    new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT),
  );
  Atomics.wait(sleeper, 0, 0, milliseconds);
}

function rawGroupId(line: string): string | null {
  let payload: unknown;
  try {
    payload = JSON.parse(line);
  } catch {
    return null;
  }
  if (
    typeof payload !== "object" ||
    payload === null ||
    Array.isArray(payload)
  ) {
    return null;
  }
  const candidate = (payload as Json)["group_id"];
  return typeof candidate === "string" && candidate ? candidate : null;
}

function parseRecord(line: string): SpoolRecord | null {
  let payload: unknown;
  try {
    payload = JSON.parse(line);
  } catch {
    return null;
  }
  if (
    typeof payload !== "object" ||
    payload === null ||
    Array.isArray(payload)
  ) {
    return null;
  }
  const value = payload as Json;
  const idempotency = value["idempotency_key"];
  const operation = value["operation"];
  if (typeof idempotency !== "string" || !idempotency.trim()) {
    return null;
  }
  if (typeof operation !== "string" || !operation.trim()) {
    return null;
  }
  const recordPayload = value["payload"] ?? {};
  if (
    typeof recordPayload !== "object" ||
    recordPayload === null ||
    Array.isArray(recordPayload)
  ) {
    return null;
  }
  const createdAtRaw = value["created_at"] ?? 0;
  const createdAt =
    typeof createdAtRaw === "number"
      ? createdAtRaw
      : typeof createdAtRaw === "string"
        ? Number(createdAtRaw)
        : Number.NaN;
  if (Number.isNaN(createdAt)) {
    return null;
  }
  const groupMetadata = parseGroupMetadata(value);
  if (groupMetadata === "invalid") {
    return null;
  }
  const record: SpoolRecord = {
    idempotency_key: idempotency,
    operation,
    payload: recordPayload as Json,
    created_at: createdAt,
  };
  if (groupMetadata !== null) {
    record.group_id = groupMetadata.group_id;
    record.group_index = groupMetadata.group_index;
    record.group_size = groupMetadata.group_size;
  }
  return record;
}

function parseGroupMetadata(
  value: Json,
):
  | { group_id: string; group_index: number; group_size: number }
  | null
  | "invalid" {
  const groupId = value["group_id"];
  const groupIndex = value["group_index"];
  const groupSize = value["group_size"];
  if (
    groupId === undefined &&
    groupIndex === undefined &&
    groupSize === undefined
  ) {
    return null;
  }
  if (groupId === null && groupIndex === null && groupSize === null) {
    return null;
  }
  if (typeof groupId !== "string" || !groupId) {
    return "invalid";
  }
  if (typeof groupIndex !== "number" || !Number.isInteger(groupIndex)) {
    return "invalid";
  }
  if (typeof groupSize !== "number" || !Number.isInteger(groupSize)) {
    return "invalid";
  }
  if (groupSize < 2 || groupIndex < 0 || groupIndex >= groupSize) {
    return "invalid";
  }
  return { group_id: groupId, group_index: groupIndex, group_size: groupSize };
}

function quarantineEnvelope(line: string): { unit_key: string } | null {
  if (!line.trim()) {
    return null;
  }
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  const parsed = quarantineEnvelopeSchema.safeParse(value);
  return parsed.success ? { unit_key: parsed.data.unit_key } : null;
}

export function errorClassName(error: unknown): string {
  if (error instanceof Error) {
    return error.constructor.name || error.name || "Error";
  }
  return typeof error;
}

/** Expose file mode for tests without importing node:fs everywhere. */
export function fileMode(path: string): number {
  return statSync(path).mode & 0o7777;
}
