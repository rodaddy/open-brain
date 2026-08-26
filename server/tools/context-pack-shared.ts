/**
 * Shared internals for the two durable context-pack loaders.
 *
 * Owner lane: this module is owned alongside
 * `context-pack-durable-memory.ts` and `context-pack-durable-lane.ts` (#780,
 * one owner for a shared helper). It exists because those two files carried
 * structural twins — a char-allocation resolver and a failure logger that
 * differed only in their event names and their extra fields — and two private
 * copies of one rule is how the two recall paths drift apart.
 *
 * Nothing here changes behavior. Each helper reproduces exactly what the two
 * call sites already did, including the order in which the driver's own fields
 * are read.
 */
import type { AgentContextPackArgs } from "./context-pack-args.ts";

/**
 * Characters reserved for the envelope (schema/scope/warnings/allocation/
 * citations) before section bodies get any of a caller's token allocation.
 */
export const CONTEXT_PACK_ENVELOPE_CHAR_RESERVE = 1_200;

/**
 * What the pack reports for a bond nobody imposed.
 *
 * These allocation fields are typed `number` and mean "the value that actually
 * applied to this read". When nothing applied, the honest typed value is the
 * effective one — every row, every character — not `null`. Nulling it would
 * force every consumer to handle an absence that never happens, and would say
 * "unknown" where the truth is "everything".
 */
export const UNBOUNDED = Number.MAX_SAFE_INTEGER;

/**
 * Resolve how many content characters a durable section may spend.
 *
 * Recall means TOTAL recall. Both recall paths once carried fixed ceilings that
 * nobody asked for, and the effect was visible in every session-start block:
 * whole records severed mid-word while the store held them complete. An
 * explicit whole-pack allocation is the caller's own request and wins; then an
 * explicit `budget.max_tokens`; and absent BOTH, everything comes back whole.
 * Do not reintroduce a default.
 *
 * `ceiling` is the caller's own maximum, applied to both explicit branches. The
 * lane path has none, so it passes {@link UNBOUNDED} and `Math.min` is inert
 * there — the same arithmetic either way.
 */
export function resolveContentChars(
  args: AgentContextPackArgs,
  contentCharLimit: number | undefined,
  ceiling: number = UNBOUNDED,
): number {
  if (contentCharLimit !== undefined) {
    return Math.max(0, Math.min(ceiling, contentCharLimit));
  }
  if (args.budget?.max_tokens !== undefined) {
    return Math.max(
      0,
      Math.min(
        ceiling,
        args.budget.max_tokens * 4 - CONTEXT_PACK_ENVELOPE_CHAR_RESERVE,
      ),
    );
  }
  return ceiling;
}

/**
 * Trim a text value to `maxChars`, reporting whether anything was dropped.
 * Shared by both recall paths so they shape content identically.
 */
export function boundedText(
  value: unknown,
  maxChars: number,
): { text: string | null; truncated: boolean } {
  if (typeof value !== "string" || value.length === 0 || maxChars <= 0) {
    return {
      text: null,
      truncated: typeof value === "string" && value.length > 0,
    };
  }
  if (value.length <= maxChars) return { text: value, truncated: false };
  return { text: value.slice(0, maxChars), truncated: true };
}

/** The subset of the logger both durable loaders need. */
export interface DurableFailureLogger {
  error: (fields: Record<string, unknown>, message: string) => void;
  debug: (fields: Record<string, unknown>, message: string) => void;
}

/**
 * The thrown value as an `Error`, or `undefined` when something else was
 * thrown. Both loaders fall back to `String(error)` in that case.
 */
export function asError(error: unknown): Error | undefined {
  return error instanceof Error ? error : undefined;
}

/** `error_name` / `error_message` exactly as both loaders derive them. */
export function errorIdentityFields(error: unknown): Record<string, unknown> {
  const err = asError(error);
  return {
    error_name: err?.name ?? typeof error,
    error_message: err?.message ?? String(error),
  };
}

/**
 * The driver's own diagnostic fields, named individually rather than spread, so
 * no driver string carrying query fragments reaches the log wholesale.
 *
 * `fields` names which ones to read. The two call sites ask for different sets
 * and each keeps the exact set it already logged — adding a field to one of
 * them here would change what that log emits.
 */
export function pgDiagnosticFields(
  error: unknown,
  fields: readonly string[],
): Record<string, unknown> {
  const source = error as Record<string, unknown> | null | undefined;
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    out[`pg_${field}`] = source?.[field] ?? null;
  }
  return out;
}

/**
 * Log a durable-recall failure on two lines, then let the caller return its own
 * content-free envelope.
 *
 * Two lines on purpose. ERROR states what broke, briefly, so it is visible at
 * the default level. DEBUG carries every input that shaped the call plus the
 * driver's own fields — sifting a large log is a later reader's problem; having
 * no log at all is a later reader's disaster. This catch was once bare in both
 * loaders: the read failed, the envelope named a generic reason, and the actual
 * cause went in the bin.
 */
export function logDurableFailure(options: {
  logger: DurableFailureLogger;
  event: string;
  error: unknown;
  errorFields: Record<string, unknown>;
  detailFields: Record<string, unknown>;
}): void {
  const { logger, event, error, errorFields, detailFields } = options;
  const err = asError(error);
  logger.error(
    { ...errorFields, error_message: err?.message ?? String(error) },
    event,
  );
  logger.debug(detailFields, `${event}_detail`);
}
