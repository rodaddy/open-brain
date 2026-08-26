/**
 * Shared retrieval-failure response for search-shaped tools.
 *
 * Extracted from `search-brain.ts` (#780 lane 2). The identical inline block in
 * `brain-answer.ts:268-283` is the second caller and is expected to adopt this
 * helper in its own lane; that file is intentionally NOT edited here.
 *
 * The contract this preserves is `docs/GOTCHAS.md`'s named anti-pattern: a
 * retrieval failure must log the driver's diagnostic fields — the one place
 * they still exist — and return `isError: true`, never an empty result set that
 * would be indistinguishable from a genuine no-match.
 */
import { errorResult } from "./types.ts";
import type { NamespaceFilter } from "./read-scope.ts";

/** The subset of the tool dependencies this helper needs. */
interface FailureLogger {
  error: (fields: Record<string, unknown>, message: string) => void;
}

/**
 * Log a retrieval failure with its diagnostic fields and map it to an error result.
 *
 * @returns The tool error response carrying the failure message.
 */
export function respondToSearchFailure(options: {
  logger: FailureLogger;
  event: string;
  error: unknown;
  namespace: NamespaceFilter | undefined;
  mode: string;
  tier: string | undefined;
}): ReturnType<typeof errorResult> {
  const { logger, event, error, namespace, mode, tier } = options;
  const message = error instanceof Error ? error.message : String(error);
  logger.error({ namespace, mode, tier, error_message: message }, event);
  return errorResult(message);
}
