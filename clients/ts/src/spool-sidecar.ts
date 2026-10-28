/**
 * Retry-state and quarantine sidecar layer for the JSONL spool.
 *
 * Extracted verbatim from `./spool.ts` so that module keeps to the repo's
 * per-file size standard. The two sidecars — `<spool>.retry-state.json` and
 * `<spool>.quarantine.jsonl` — are a self-contained concern: the spool owns
 * the main file and its lock, and calls in here for everything that reads or
 * rewrites a sidecar. Free functions over explicit paths, with the same
 * ordering, clamping, and replace-not-skip convergence as before the split.
 * Imported only from `./spool.ts`; no caller or test reaches these directly.
 */

import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";

import { stableJson } from "../../../server/contracts/contract.ts";
import type { Json } from "./client.ts";
import { atomicWrite, rejectSymlink, type DirectorySync } from "./spool-durability.ts";

// Structural view of the fields this layer reads. The full `SpoolRecord` is
// declared in ./spool.ts; naming it here would make the two modules cyclic.
export interface SidecarRecord {
  idempotency_key: string;
  operation: string;
  created_at: number;
  group_id?: string;
}

export const QUARANTINE_ENVELOPE_SCHEMA = "openbrain.spool_quarantine.v1";
export const RETRY_STATE_SCHEMA = "openbrain.spool_retry_state.v1";
const MAX_RETRY_STATE_FAILURES = 1_000_000;

/** One unit's persisted consecutive-failure record. */
export interface UnitRetryState {
  consecutive_failures: number;
  first_failure_at: number;
  last_failure_at: number;
  error_category: string;
}

/** The whole retry-state sidecar, parsed. */
export interface RetryState {
  last_success_at: number | null;
  units: Map<string, UnitRetryState>;
}

/** A replay unit: contiguous lines that must replay together. */
export interface SpoolUnit<Record extends SidecarRecord = SidecarRecord> {
  lines: readonly string[];
  records: readonly Record[] | null;
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

export function splitKeepEnds(text: string): string[] {
  const lines = text.split(/(?<=\n)/);
  if (lines.length > 0 && lines.at(-1) === "") {
    lines.pop();
  }
  return lines;
}

export function quarantineEnvelope(line: string): { unit_key: string } | null {
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

/**
 * Fold this pass's failure counts into the persisted retry state.
 *
 * A concurrent writer may already have advanced a unit's count, so this pass's
 * update only wins when it is at least as high as what is on disk.
 */
export function mergeRetryUnits(input: {
  remainingKeys: Set<string>;
  failedUpdates: Map<string, UnitRetryState>;
  currentState: RetryState;
  priorState: RetryState;
}): Map<string, UnitRetryState> {
  const units = new Map<string, UnitRetryState>();
  for (const unitKey of input.remainingKeys) {
    const update = input.failedUpdates.get(unitKey);
    const prior =
      input.currentState.units.get(unitKey) ?? input.priorState.units.get(unitKey);
    if (
      update !== undefined &&
      (prior === undefined || update.consecutive_failures >= prior.consecutive_failures)
    ) {
      units.set(unitKey, update);
    } else if (prior !== undefined) {
      units.set(unitKey, prior);
    }
  }
  return units;
}

function quarantineLinesWithout(
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

/**
 * Persist quarantined units, replacing any prior entry per unit key
 * (replace-not-skip): re-quarantining after a crash between the sidecar
 * append and the main-spool rewrite converges to one entry while keeping
 * the freshest lines and counts.
 */
export function appendQuarantinedUnits(input: {
  quarantinePath: string;
  entries: Array<[string, SpoolUnit, UnitRetryState]>;
  now: number;
  directorySync: DirectorySync;
}): void {
  rejectSymlink(input.quarantinePath);
  const existingLines = existsSync(input.quarantinePath)
    ? splitKeepEnds(readFileSync(input.quarantinePath, "utf-8"))
    : [];
  const fresh = new Map<string, string[]>();
  for (const [unitKey, unit, state] of input.entries) {
    const records = unit.records as readonly SidecarRecord[];
    const envelope: Json = {
      schema: QUARANTINE_ENVELOPE_SCHEMA,
      unit_key: unitKey,
      record_keys: records.map((record) => record.idempotency_key),
      operations: records.map((record) => record.operation),
      consecutive_failures: state.consecutive_failures,
      first_failure_at: state.first_failure_at,
      last_failure_at: state.last_failure_at,
      error_category: state.error_category,
      quarantined_at: input.now,
      line_count: unit.lines.length,
    };
    fresh.set(unitKey, [stableJson(envelope) + "\n", ...unit.lines]);
  }
  const kept = quarantineLinesWithout(existingLines, new Set(fresh.keys()));
  const appended: string[] = [];
  for (const entry of fresh.values()) {
    appended.push(...entry);
  }
  atomicWrite(input.quarantinePath, [...kept, ...appended], input.directorySync);
}

/**
 * Drop sidecar entries for units that just replayed successfully — a crash
 * between the quarantine append and the main-spool rewrite leaves a unit in
 * both files; the phantom entry is removed on later replay success.
 */
export function removeQuarantinedEntries(
  quarantinePath: string,
  unitKeys: Set<string>,
  directorySync: DirectorySync,
): void {
  if (!existsSync(quarantinePath)) {
    return;
  }
  rejectSymlink(quarantinePath);
  const lines = splitKeepEnds(readFileSync(quarantinePath, "utf-8"));
  const kept = quarantineLinesWithout(lines, unitKeys);
  if (kept.length !== lines.length) {
    atomicWrite(quarantinePath, kept, directorySync);
  }
}

export function quarantinedCount(quarantinePath: string): number {
  if (!existsSync(quarantinePath)) {
    return 0;
  }
  rejectSymlink(quarantinePath);
  const lines = splitKeepEnds(readFileSync(quarantinePath, "utf-8"));
  return lines.filter((line) => quarantineEnvelope(line) !== null).length;
}

export function loadRetryState(retryStatePath: string): RetryState {
  const empty: RetryState = { last_success_at: null, units: new Map() };
  if (!existsSync(retryStatePath)) {
    return empty;
  }
  rejectSymlink(retryStatePath);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(retryStatePath, "utf-8"));
  } catch {
    return empty;
  }
  const parsed = retryStateFileSchema.safeParse(raw);
  if (!parsed.success) {
    return empty;
  }
  const units = collectRetryUnits(parsed.data.units);
  const lastSuccess = parsed.data.last_success_at;
  return {
    last_success_at:
      typeof lastSuccess === "number" && Number.isFinite(lastSuccess)
        ? lastSuccess
        : null,
    units,
  };
}

function collectRetryUnits(raw: Record<string, unknown>): Map<string, UnitRetryState> {
  const units = new Map<string, UnitRetryState>();
  for (const [unitKey, value] of Object.entries(raw)) {
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
  return units;
}

export function writeRetryState(input: {
  retryStatePath: string;
  state: RetryState;
  directorySync: DirectorySync;
}): void {
  rejectSymlink(input.retryStatePath);
  const payload: Json = {
    schema: RETRY_STATE_SCHEMA,
    last_success_at: input.state.last_success_at,
    units: Object.fromEntries(
      [...input.state.units.entries()].map(([unitKey, unit]) => [unitKey, { ...unit }]),
    ),
  };
  atomicWrite(input.retryStatePath, [stableJson(payload) + "\n"], input.directorySync);
}
