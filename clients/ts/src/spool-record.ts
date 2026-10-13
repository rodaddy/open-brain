/**
 * Spool line parsing — the JSONL decode half of `./spool.ts`.
 *
 * Split out of `spool.ts` so the spool module stays inside the repo's
 * per-file size rule. Behavior is unchanged: every function here moved
 * verbatim in intent from `spool.ts`, and `spool.ts` remains the only
 * entrypoint callers and tests import.
 *
 * Every parser is total and content-free on failure: a malformed line yields
 * `null` rather than throwing, so one corrupt record never fails a drain.
 */

import type { Json } from "./client.ts";
import type { SpoolUnit } from "./spool-sidecar.ts";

/** One decoded spool line. */
export interface SpoolRecord {
  idempotency_key: string;
  operation: string;
  payload: Json;
  created_at: number;
  group_id?: string;
  group_index?: number;
  group_size?: number;
}

/** Group metadata carried by a record line, or `"invalid"` when malformed. */
export type GroupMetadata =
  { group_id: string; group_index: number; group_size: number } | null | "invalid";

function parseObjectLine(line: string): Json | null {
  let payload: unknown;
  try {
    payload = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return null;
  }
  return payload as Json;
}

/** The `group_id` on a line, without validating the rest of the record. */
export function rawGroupId(line: string): string | null {
  const value = parseObjectLine(line);
  if (value === null) {
    return null;
  }
  const candidate = value["group_id"];
  return typeof candidate === "string" && candidate ? candidate : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function recordPayloadOf(value: Json): Json | null {
  const payload = value["payload"] ?? {};
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return null;
  }
  return payload as Json;
}

function createdAtOf(value: Json): number | null {
  const raw = value["created_at"] ?? 0;
  if (typeof raw === "number") {
    return Number.isNaN(raw) ? null : raw;
  }
  if (typeof raw === "string") {
    const parsed = Number(raw);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

/** Decode one spool line into a record, or `null` when it is unusable. */
export function parseRecord(line: string): SpoolRecord | null {
  const value = parseObjectLine(line);
  if (value === null) {
    return null;
  }
  const idempotency = nonEmptyString(value["idempotency_key"]);
  const operation = nonEmptyString(value["operation"]);
  const recordPayload = recordPayloadOf(value);
  const createdAt = createdAtOf(value);
  const groupMetadata = parseGroupMetadata(value);
  if (
    idempotency === null ||
    operation === null ||
    recordPayload === null ||
    createdAt === null ||
    groupMetadata === "invalid"
  ) {
    return null;
  }
  const record: SpoolRecord = {
    idempotency_key: idempotency,
    operation,
    payload: recordPayload,
    created_at: createdAt,
  };
  if (groupMetadata !== null) {
    record.group_id = groupMetadata.group_id;
    record.group_index = groupMetadata.group_index;
    record.group_size = groupMetadata.group_size;
  }
  return record;
}

/**
 * Read a record's group fields.
 *
 * All three absent (or all three null) means an ungrouped record. Any other
 * partial or out-of-range combination is `"invalid"`, which drops the line.
 */
export function parseGroupMetadata(value: Json): GroupMetadata {
  const groupId = value["group_id"];
  const groupIndex = value["group_index"];
  const groupSize = value["group_size"];
  if (isUngrouped([groupId, groupIndex, groupSize])) {
    return null;
  }
  if (typeof groupId !== "string" || !groupId) {
    return "invalid";
  }
  if (!isIndex(groupIndex) || !isIndex(groupSize)) {
    return "invalid";
  }
  if (groupSize < 2 || groupIndex < 0 || groupIndex >= groupSize) {
    return "invalid";
  }
  return { group_id: groupId, group_index: groupIndex, group_size: groupSize };
}

/** True when all three group fields are uniformly absent or uniformly null. */
function isUngrouped(fields: readonly unknown[]): boolean {
  return (
    fields.every((field) => field === undefined) ||
    fields.every((field) => field === null)
  );
}

function isIndex(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value);
}

/** Class name of a thrown value — never its message, which may carry content. */
export function errorClassName(error: unknown): string {
  if (error instanceof Error) {
    return error.constructor.name || error.name || "Error";
  }
  return typeof error;
}

/**
 * Collect consecutive lines sharing one `group_id` into a single group.
 *
 * Ungrouped lines each become their own group, so a group is always the
 * smallest set of lines that must replay together.
 */
function groupLinesByGroupId(lines: readonly string[]): string[][] {
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
  return grouped;
}

/**
 * Turn one group of lines into a unit.
 *
 * A group with any corrupt line, no records at all, or inconsistent group
 * metadata becomes a records-less unit: its lines are preserved verbatim and
 * never dispatched.
 */
function unitFromGroup(group: string[]): SpoolUnit<SpoolRecord> {
  const { parsed, corrupted } = parseGroupLines(group);
  if (corrupted > 0 || parsed.length === 0) {
    return { lines: group, records: null, corrupted_line_count: corrupted };
  }
  if (!isConsistentGroup(parsed)) {
    return { lines: group, records: null, corrupted_line_count: group.length };
  }
  return { lines: group, records: parsed, corrupted_line_count: 0 };
}

function parseGroupLines(group: readonly string[]): {
  parsed: SpoolRecord[];
  corrupted: number;
} {
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
  return { parsed, corrupted };
}

/** True when every record agrees on the group id, size, and its own index. */
function isConsistentGroup(parsed: readonly SpoolRecord[]): boolean {
  const first = parsed[0] as SpoolRecord;
  if (first.group_id === undefined) {
    return true;
  }
  return (
    parsed.length === first.group_size &&
    parsed.every(
      (record) =>
        record.group_id === first.group_id && record.group_size === first.group_size,
    ) &&
    parsed.every((record, index) => record.group_index === index)
  );
}

/** Group lines into replay units (single records or contiguous batches). */
export function parseUnits(lines: readonly string[]): SpoolUnit<SpoolRecord>[] {
  return groupLinesByGroupId(lines).map(unitFromGroup);
}
