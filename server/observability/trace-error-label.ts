/**
 * Content-free error label for tracing warn lines.
 *
 * Copied in spirit from `auditErrorLabel` (`src/audit-log.ts:526-534`) and for
 * the same reason: an SDK/transport error message can contain the endpoint, a
 * request body, or an auth header, and these warns go to the local log. Only
 * the code/name is ever emitted.
 *
 * Its own module because both `langfuse-tracing.ts` and `trace-sink-health.ts`
 * label failures, and a second copy is how the two would drift apart.
 */
export function tracingErrorLabel(err: unknown): string {
  if (err && typeof err === "object") {
    const code = (err as { code?: unknown }).code;
    if (typeof code === "string" && code.length > 0) return code;
    const name = (err as { name?: unknown }).name;
    if (typeof name === "string" && name.length > 0) return name;
  }
  return "unknown_error";
}
