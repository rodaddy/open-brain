import type {
  ContextPackPayload,
  ReflexPointersPayload,
  SearchHit,
} from "./transport-types.ts";
import { LiveTransportError } from "./transport-types.ts";

// The redaction / parsing boundary of the live transport.
//
// Split out of transport.ts (issue 752) so the client module stays under the
// file-length bound. Nothing about the boundary itself changed: these are the
// same functions, and transport.ts re-exports every one of them, so no import
// specifier anywhere in the repo moves. Everything here is content-free by
// construction -- labels name a tool and a failure class, never a body.

/**
 * Parse ranked search hits from a JSON array body. Never logs the body.
 *
 * This is the transport boundary for every hit the gate scores or probes. It
 * FAILS CLOSED content-free rather than silently dropping any entry, because a
 * discarded raw result never reaches the gate-level validator (gate.ts
 * `toFixtureRetrieval`) and so could compress rankings or hide a foreign /
 * malformed result before PASS logic runs:
 *
 *  - a successful search body MUST be a JSON array. A non-array (object, scalar)
 *    or invalid JSON is a malformed result set (`search_brain:malformed-results`)
 *    -- NOT an empty result, which the old `return []` conflated with real
 *    "no hits" and let a malformed body pass as a clean empty read.
 *  - every array entry MUST be an object carrying a non-empty string `id`
 *    (`search_brain:malformed-hit`). A non-object row, a missing id, or an empty
 *    id is unaccountable at this boundary and must not be silently skipped.
 *
 * `namespace` stays OPTIONAL on purpose: a hit that is a valid object with a
 * string id but no namespace passes THIS boundary and reaches gate.ts, which
 * fails it specifically as `foreign-namespace`. Requiring namespace here would
 * mask that distinct (and security-relevant) gate-level classification.
 *
 * Content-free: labels name only the tool + failure class, never a raw body,
 * row, or id value.
 */
export function parseHits(text: string): SearchHit[] {
  const parsed = safeJsonArray(text);
  if (!parsed) {
    // Non-array success body or invalid JSON: a malformed result set, not empty.
    throw new LiveTransportError("search_brain:malformed-results", false);
  }
  const hits: SearchHit[] = [];
  for (const row of parsed) {
    if (!row || typeof row !== "object") {
      // A non-object array entry is unaccountable; never silently skip it.
      throw new LiveTransportError("search_brain:malformed-hit", false);
    }
    const id = (row as Record<string, unknown>).id;
    if (typeof id !== "string" || id.length === 0) {
      // Missing / non-string / empty id: cannot account for this hit.
      throw new LiveTransportError("search_brain:malformed-hit", false);
    }
    const sourceType = (row as Record<string, unknown>).source_type;
    const namespace = (row as Record<string, unknown>).namespace;
    hits.push({
      id,
      source_type: typeof sourceType === "string" ? sourceType : "",
      // Optional by design: a missing namespace reaches gate.ts, which fails it
      // as foreign-namespace. Do NOT reject it here.
      namespace: typeof namespace === "string" ? namespace : undefined,
    });
  }
  return hits;
}

function asRecordArray(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (row): row is Record<string, unknown> =>
      !!row && typeof row === "object" && !Array.isArray(row),
  );
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** The three warning channels, normalized to arrays with a missing one empty. */
function parseWarnings(value: unknown): ContextPackPayload["warnings"] {
  const warnings = asRecord(value);
  return {
    scope_denials: asRecordArray(warnings.scope_denials),
    degraded_sources: asRecordArray(warnings.degraded_sources),
    truncation: asRecordArray(warnings.truncation),
  };
}

/**
 * Parse the complete context-pack payload from a JSON object body. Never logs
 * the body, which can carry memory bodies inside its section items.
 *
 * Fails closed content-free rather than defaulting a malformed body to an empty
 * pack: a non-object body, or invalid JSON, is a malformed pack
 * (`agent_context_pack:malformed-payload`), NOT an empty pack -- conflating the
 * two would let a broken pack pass as a clean empty. `sections`, `citations`,
 * `budget`, and `warnings.*` are normalized to their expected container shapes
 * (object / array), defaulting a MISSING container to its empty form so the gate
 * can classify a genuinely-empty pack without inspecting any body. The section
 * bodies themselves stay opaque records; the gate reads only their structural
 * fields.
 */
export function parseContextPackPayload(text: string): ContextPackPayload {
  const parsed = safeJson(text);
  if (!parsed) {
    throw new LiveTransportError("agent_context_pack:malformed-payload", false);
  }
  return {
    status: typeof parsed.status === "string" ? parsed.status : "",
    sections: asRecord(parsed.sections),
    citations: asRecordArray(parsed.citations),
    budget: asRecord(parsed.budget),
    warnings: parseWarnings(parsed.warnings),
  };
}

/**
 * Parse the reflex-pointers payload from a JSON object body. Never logs the
 * body. Fails closed content-free rather than defaulting a malformed body to an
 * empty reflex: a non-object body or invalid JSON is a malformed reflex
 * (`agent_reflex_pointers:malformed-payload`), NOT an empty one -- conflating
 * the two would let a broken reflex pass as a clean empty. `pointers`,
 * `citations`, `budget`, and `warnings.*` are normalized to their expected
 * container shapes, defaulting a MISSING container to its empty form so the gate
 * can classify a genuinely-empty reflex without inspecting any body. The pointer
 * item bodies stay opaque records; the gate reads only their structural fields
 * (id, citation_id, source_ref identity coordinates).
 */
export function parseReflexPointersPayload(text: string): ReflexPointersPayload {
  const parsed = safeJson(text);
  if (!parsed) {
    throw new LiveTransportError("agent_reflex_pointers:malformed-payload", false);
  }
  return {
    status: typeof parsed.status === "string" ? parsed.status : "",
    placement: typeof parsed.placement === "string" ? parsed.placement : "",
    pointers: asRecord(parsed.pointers),
    citations: asRecordArray(parsed.citations),
    budget: asRecord(parsed.budget),
    warnings: parseWarnings(parsed.warnings),
  };
}

/**
 * The exact plain-text no-op marker archive_entry returns for the zero-row case
 * (src/tools/archive-entry.ts): "Already archived or not found", and nothing
 * else. This is the ONLY non-structured success shape teardown treats as "the
 * row is gone".
 *
 * Matching is EXACT (trimmed, case-insensitive) -- not substring -- on purpose:
 * a destructive teardown must fail closed, so a partial phrase ("not found"),
 * "no rows", or the marker embedded in incidental/mixed text must NOT classify,
 * because any of those could false-pass on unrelated server output. Anything
 * that is not exactly this marker fails closed at the caller. The raw text is
 * never logged or returned -- only the boolean.
 */
const ARCHIVE_ABSENT_MARKER = "already archived or not found";

export function isAlreadyAbsentMarker(text: string): boolean {
  return text.trim().toLowerCase() === ARCHIVE_ABSENT_MARKER;
}

export function safeJson(text: string): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function safeJsonArray(text: string): unknown[] | undefined {
  try {
    const value = JSON.parse(text);
    return Array.isArray(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Denial keywords: a permission/namespace/auth refusal. These are the security-
 * relevant signals the isolation proof depends on, so they are classified FIRST,
 * ahead of any generic error keyword. A server body can legitimately mix a
 * denial phrase with a generic one (e.g. "invalid request: permission denied for
 * namespace"); if a generic keyword like "invalid" were matched first, a real
 * denial would be mislabeled as a non-denial error and the isolation proof (or a
 * teardown auth failure) would be silently misread. Denial precedence closes
 * that classification hole.
 */
const DENIAL_ERROR_KEYWORDS: readonly string[] = [
  "permission denied",
  "not authenticated",
  "unauthorized",
  "forbidden",
];

/**
 * Generic (non-denial) error bodies the gate is willing to name in a content-
 * free label. Matched only AFTER the denial keywords above, so a mixed body that
 * contains a denial phrase always classifies as a denial regardless of array
 * order.
 */
const GENERIC_ERROR_KEYWORDS: readonly string[] = [
  "invalid",
  "not found",
  "already archived",
  "rate limit",
  "timeout",
];

/**
 * The full allowlist of non-sensitive tokens the gate may copy out of a
 * response is exactly DENIAL_ERROR_KEYWORDS followed by GENERIC_ERROR_KEYWORDS.
 * Only these tokens are ever emitted; anything else collapses to a bare marker,
 * so a memory body or secret in the error text can never leak into a log or
 * receipt.
 *
 * Select the single keyword to name in a content-free label, prioritizing any
 * denial keyword over every generic one so a mixed body classifies as a denial.
 * Returns undefined when no known keyword is present.
 */
function matchRedactedKeyword(lower: string): string | undefined {
  return (
    DENIAL_ERROR_KEYWORDS.find((kw) => lower.includes(kw)) ??
    GENERIC_ERROR_KEYWORDS.find((kw) => lower.includes(kw))
  );
}

/** True when the redacted error signal indicates a permission/namespace denial. */
export function isDenialLabel(label: string): boolean {
  return (
    label.includes("permission-denied") ||
    label.includes("unauthorized") ||
    label.includes("forbidden") ||
    label.includes("not-authenticated")
  );
}

/**
 * Reduce a failed tool call to a content-free label. Emits the tool name plus
 * at most one matched known keyword (as a slug); the raw response text is never
 * included. Returns { errorLabel, denied }.
 */
export function redactToolFailure(
  toolName: string,
  rawText: string,
): { errorLabel: string; denied: boolean } {
  const lower = rawText.toLowerCase();
  const matched = matchRedactedKeyword(lower);
  const slug = matched ? matched.replace(/\s+/g, "-") : "error";
  const errorLabel = `${toolName}:${slug}`;
  return { errorLabel, denied: isDenialLabel(errorLabel) };
}

/**
 * Sanitize a THROWN transport-layer error (connect / callTool / close) into a
 * content-free LiveTransportError. The MCP SDK can throw errors whose `.message`
 * carries the raw remote HTTP body or response text -- which could include a
 * memory body or secret -- so we NEVER surface `error.message` verbatim. We copy
 * out only the operation name plus, if the message happens to contain one of the
 * known non-sensitive keywords, that single keyword as a slug. Anything else
 * collapses to `<op>:transport-error`. An HTTP status code (a bare number) is
 * safe to name and helps triage, so we extract at most one 3-digit status.
 *
 * `op` is the transport operation (e.g. "connect", "close", or a tool name), not
 * the raw error, so the label shape matches redactToolFailure's `<name>:<slug>`.
 */
export function sanitizeThrownTransportError(
  op: string,
  error: unknown,
): LiveTransportError {
  // Already redacted upstream: pass it through unchanged so we never re-wrap or
  // accidentally widen a content-free label.
  if (error instanceof LiveTransportError) {
    return error;
  }
  const raw = error instanceof Error ? error.message : String(error);
  const lower = raw.toLowerCase();
  const matchedKeyword = matchRedactedKeyword(lower);
  const statusMatch = /\b([1-5]\d{2})\b/.exec(raw);
  let slug: string;
  if (matchedKeyword) {
    slug = matchedKeyword.replace(/\s+/g, "-");
  } else if (statusMatch) {
    slug = `http-${statusMatch[1]}`;
  } else {
    slug = "transport-error";
  }
  const errorLabel = `${op}:${slug}`;
  return new LiveTransportError(errorLabel, isDenialLabel(errorLabel));
}
