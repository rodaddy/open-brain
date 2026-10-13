/**
 * The bounded fallback for a child span that cannot retain its full payload.
 *
 * Healthy retrieval spans remain contentful. Once the per-call byte circuit
 * opens, this projection keeps only the structural evidence the trace
 * forensics reader can compare: counts, row-id sequences, and the candidate
 * identity, namespace, score, and classification fields. It never copies
 * arbitrary strings such as query text or row content into the fallback.
 */
import type { TraceSpanBody } from "./trace-types.ts";

export type TracePayloadDegradationReason =
  "active_span_bytes_limit" | "serialization_error";

const CANDIDATE_KEYS = [
  "row_id",
  "id",
  "path",
  "source_type",
  "namespace",
  "distance",
  "similarity",
  "bm25_score",
  "rrf_score",
  "usefulness",
  "chosen",
  "filtered_by",
] as const;

const CONTAINER_KEYS = new Set([
  "vector",
  "keyword",
  "primary",
  "legacy",
  "evidence",
  "results",
]);
const NULLABLE_STRING_KEYS = new Set(["namespace", "filtered_by"]);
const NUMERIC_KEYS = new Set([
  "distance",
  "similarity",
  "bm25_score",
  "rrf_score",
  "usefulness",
]);

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function isCountKey(key: string): boolean {
  return key === "count" || key.endsWith("_count");
}

function isRowIdsKey(key: string): boolean {
  return key === "row_ids" || key.endsWith("_row_ids");
}

function scalarIdentity(value: unknown): string | number | undefined {
  return typeof value === "string" || typeof value === "number" ? value : undefined;
}

function serializedBytes(value: unknown): number {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined
      ? Number.POSITIVE_INFINITY
      : Buffer.byteLength(serialized, "utf8");
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function traceValueCounts(value: unknown): Record<string, number> {
  const counts = {
    values: 0,
    arrays: 0,
    objects: 0,
    strings: 0,
    string_bytes: 0,
  };
  const pending: unknown[] = [value];
  const seen = new WeakSet<object>();
  while (pending.length > 0) {
    const current = pending.pop();
    counts.values += 1;
    if (typeof current === "string") {
      counts.strings += 1;
      counts.string_bytes += Buffer.byteLength(current, "utf8");
      continue;
    }
    if (!current || typeof current !== "object") continue;
    if (seen.has(current)) continue;
    seen.add(current);
    if (Array.isArray(current)) counts.arrays += 1;
    else counts.objects += 1;
    pending.push(...Object.values(current));
  }
  return counts;
}

function compactBooleanField(
  key: string,
  child: unknown,
): readonly [string, unknown] | undefined {
  return typeof child === "boolean" ? [key, child] : undefined;
}

function compactNullableStringField(
  key: string,
  child: unknown,
): readonly [string, unknown] | undefined {
  return typeof child === "string" || child === null ? [key, child] : undefined;
}

function compactNumberField(
  key: string,
  child: unknown,
): readonly [string, unknown] | undefined {
  return typeof child === "number" && Number.isFinite(child) ? [key, child] : undefined;
}

function compactCandidateField(
  key: (typeof CANDIDATE_KEYS)[number],
  child: unknown,
): readonly [string, unknown] | undefined {
  if (child === undefined) return undefined;
  if (key === "chosen") return compactBooleanField(key, child);
  if (NULLABLE_STRING_KEYS.has(key)) return compactNullableStringField(key, child);
  if (NUMERIC_KEYS.has(key)) return compactNumberField(key, child);
  const identity = scalarIdentity(child);
  return identity === undefined ? undefined : [key, identity];
}

function compactCandidate(value: unknown): Record<string, unknown> | undefined {
  const object = objectValue(value);
  if (!object) return undefined;
  const fields = CANDIDATE_KEYS.map((key) =>
    compactCandidateField(key, object[key]),
  ).filter((field): field is readonly [string, unknown] => field !== undefined);
  return fields.length > 0 ? Object.fromEntries(fields) : undefined;
}

function compactRowIds(value: unknown): unknown[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const ids = value
    .map(scalarIdentity)
    .filter((id): id is string | number => id !== undefined);
  return ids.length === value.length ? ids : undefined;
}

function compactCounts(value: unknown): Record<string, number> | undefined {
  const object = objectValue(value);
  if (!object) return undefined;
  const counts: Record<string, number> = {};
  for (const [key, child] of Object.entries(object)) {
    if (typeof child === "number" && Number.isFinite(child)) counts[key] = child;
  }
  return Object.keys(counts).length > 0 ? counts : undefined;
}

function compactCandidates(value: unknown): Record<string, unknown>[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const candidates = value
    .map(compactCandidate)
    .filter(
      (candidate): candidate is Record<string, unknown> => candidate !== undefined,
    );
  return candidates.length > 0 ? candidates : undefined;
}

function compactEntry(key: string, child: unknown, seen: WeakSet<object>): unknown {
  if (isCountKey(key) && typeof child === "number" && Number.isFinite(child))
    return child;
  if (isRowIdsKey(key)) return compactRowIds(child);
  if (key === "candidates") return compactCandidates(child);
  if (key === "counts") return compactCounts(child);
  if (!CONTAINER_KEYS.has(key)) return undefined;
  return compactPayload(child, seen);
}

function compactPayload(
  value: unknown,
  seen: WeakSet<object> = new WeakSet<object>(),
): Record<string, unknown> | undefined {
  const object = objectValue(value);
  if (!object || seen.has(object)) return undefined;
  seen.add(object);
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(object)) {
    const compact = compactEntry(key, child, seen);
    if (compact !== undefined) result[key] = compact;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

const SAFE_METADATA_KEYS = new Set([
  "stage",
  "status",
  "duration_ms",
  "filter_names",
  "resolved_namespace",
  "namespace",
]);

function compactMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  const compact: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (!SAFE_METADATA_KEYS.has(key)) continue;
    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean" ||
      (Array.isArray(value) && value.every((item) => typeof item === "string"))
    )
      compact[key] = value;
  }
  return compact;
}

function degradedValue(
  value: unknown,
  payloadLimitBytes: number,
): Record<string, unknown> {
  const evidence = compactPayload(value);
  // Reserve one third of the span limit for each input/output evidence block;
  // the remaining headroom covers the span name and metadata, while the
  // whole-object check below remains the authoritative final bound.
  const evidenceFits =
    evidence !== undefined &&
    serializedBytes(evidence) <= Math.floor(payloadLimitBytes / 3);
  return {
    counts: traceValueCounts(value),
    ...(evidenceFits ? { evidence } : {}),
    evidence_complete: evidenceFits,
    ...(evidenceFits ? {} : { evidence_truncated: true }),
  };
}

export function degradedTraceSpan(
  span: TraceSpanBody,
  reason: TracePayloadDegradationReason,
  payloadLimitBytes: number,
): TraceSpanBody {
  const degraded = {
    name: span.name.slice(0, 256),
    input: degradedValue(span.input, payloadLimitBytes),
    output: degradedValue(span.output, payloadLimitBytes),
    metadata: {
      ...compactMetadata(span.metadata),
      payload_degraded: true,
      payload_degradation_reason: reason,
      payload_limit_bytes: payloadLimitBytes,
    },
  };
  if (serializedBytes(degraded) <= payloadLimitBytes) return degraded;
  return {
    name: span.name.slice(0, 64),
    input: {
      counts: traceValueCounts(span.input),
      evidence_complete: false,
      evidence_truncated: true,
    },
    output: {
      counts: traceValueCounts(span.output),
      evidence_complete: false,
      evidence_truncated: true,
    },
    metadata: {
      payload_degraded: true,
      payload_degradation_reason: reason,
      payload_limit_bytes: payloadLimitBytes,
      payload_evidence_truncated: true,
    },
  };
}
