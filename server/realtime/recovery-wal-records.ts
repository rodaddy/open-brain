/**
 * Structural validation for recovery WAL journal rows.
 *
 * This is the trust boundary for a file on disk: every field is checked before
 * it becomes live state, so a hand-edited or torn WAL cannot inject an item
 * with an unknown status or a broken scope.
 *
 * The checks live here, apart from the store, because they are pure predicates
 * over untrusted JSON with no store state behind them, and because the same
 * row shape is validated by more than one copy of the WAL reader. One
 * definition is the point — a second private copy is how two readers start
 * disagreeing about what a valid row is.
 */
import type { NormalizedWorkingSetScope } from "./working-set.ts";
import {
  RECOVERY_WAL_ACTIONS,
  RECOVERY_WAL_LABEL,
  RECOVERY_WAL_STATUSES,
  type RecoveryWalItem,
  type RecoveryWalRecord,
} from "./recovery-wal-types.ts";

const RECOVERY_WAL_STATUS_SET = new Set<string>(RECOVERY_WAL_STATUSES);
const RECOVERY_WAL_ACTION_SET = new Set<string>(RECOVERY_WAL_ACTIONS);

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function isRecoveryWalStatus(value: unknown): boolean {
  return typeof value === "string" && RECOVERY_WAL_STATUS_SET.has(value);
}

export function isRecoveryWalAction(value: unknown): boolean {
  return typeof value === "string" && RECOVERY_WAL_ACTION_SET.has(value);
}

/** A parseable ISO timestamp. */
function isTimestamp(value: unknown): boolean {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

/** A timestamp, or an explicit null. Several fields are nullable this way. */
function isNullableTimestamp(value: unknown): boolean {
  return value === null || isTimestamp(value);
}

/** A string with non-whitespace content. Every scope field must be one. */
function isNonBlankString(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function isNullableString(value: unknown): boolean {
  return value === null || typeof value === "string";
}

const SCOPE_REQUIRED_FIELDS = [
  "namespace",
  "agent",
  "platform",
  "server_id",
  "channel_id",
  "session_key",
] as const;

export function isNormalizedScope(
  value: unknown,
): value is NormalizedWorkingSetScope {
  if (!isRecord(value)) return false;
  if (!SCOPE_REQUIRED_FIELDS.every((field) => isNonBlankString(value[field]))) {
    return false;
  }
  return value.thread_id === null || isNonBlankString(value.thread_id);
}

/**
 * Each item field paired with the predicate that must accept it. A table keeps
 * the check flat: adding a field is one row, and no reader has to trace a
 * twenty-clause boolean to learn what a valid item is.
 */
const ITEM_FIELD_CHECKS: Array<[string, (value: unknown) => boolean]> = [
  ["id", (value) => typeof value === "string"],
  ["label", (value) => value === RECOVERY_WAL_LABEL],
  ["status", isRecoveryWalStatus],
  ["content", (value) => typeof value === "string"],
  ["trace_id", isNullableString],
  ["source_ref", isNullableString],
  ["metadata", isRecord],
  ["created_at", isTimestamp],
  ["updated_at", isTimestamp],
  ["expires_at", isTimestamp],
  ["reviewed_at", isNullableTimestamp],
  ["last_action", (value) => value === null || isRecoveryWalAction(value)],
];

export function isRecoveryWalItem(value: unknown): value is RecoveryWalItem {
  if (!isRecord(value)) return false;
  return ITEM_FIELD_CHECKS.every(([field, accepts]) => accepts(value[field]));
}

function isMarkRecord(record: Record<string, unknown>): boolean {
  return (
    typeof record.id === "string" &&
    isRecoveryWalAction(record.action) &&
    isRecoveryWalStatus(record.status) &&
    isNullableTimestamp(record.reviewed_at) &&
    isTimestamp(record.updated_at)
  );
}

export function isRecoveryWalRecord(
  record: unknown,
): record is RecoveryWalRecord {
  if (!isRecord(record)) return false;
  if (!isNormalizedScope(record.scope)) return false;
  if (record.op === "append") return isRecoveryWalItem(record.item);
  if (record.op === "mark") return isMarkRecord(record);
  if (record.op === "purge") {
    return record.id === undefined || typeof record.id === "string";
  }
  return false;
}

export function parseWalRecord(row: string): RecoveryWalRecord | null {
  try {
    const record: unknown = JSON.parse(row);
    if (isRecoveryWalRecord(record)) return record;
  } catch {
    return null;
  }
  return null;
}
