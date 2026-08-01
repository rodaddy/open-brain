/**
 * Turn a raw HTTP outcome into a verdict. Pure functions only.
 *
 * WHY THIS IS ITS OWN MODULE AND WHY IT IS PURE
 *
 * Every decision here is a rule that will change: which statuses count as
 * healthy, how many failures make a target down, whether a slow-but-200 is
 * degraded. Rules that change need tests, and tests need functions that take
 * values and return values.
 *
 * Nothing in this file performs IO, reads a clock, or logs. Feed it a result,
 * assert on the verdict. The checker does the IO; the service does the
 * orchestration; this decides. Collapsing the three is why "is it up?" ends up
 * untestable without a live server.
 */

import type {
  CheckResult,
  CheckStatus,
  CheckTarget,
  TargetState,
} from "../../models/check.ts";

/**
 * Classify one attempt.
 *
 * A lookup-driven decision rather than an if/else ladder
 * (`STANDARDS-typescript.md ## Control flow`). Three guard clauses, each a
 * genuinely unrelated question, then the healthy case.
 *
 * @param target - The target's configuration, for its expected statuses.
 * @param statusCode - The HTTP status, or null when the request never landed.
 * @param error - The transport error, or null on a completed request.
 * @returns The verdict for THIS attempt, ignoring history.
 */
export function classify(
  target: CheckTarget,
  statusCode: number | null,
  error: string | null,
): CheckStatus {
  if (error !== null) return "down";
  if (statusCode === null) return "unknown";
  if (!target.expectStatus.includes(statusCode)) return "degraded";
  return "up";
}

/**
 * Fold one result into a target's running state.
 *
 * Pure: takes the previous state and a result, returns the next state. No
 * mutation, so a caller cannot accidentally share one state object between two
 * targets -- an aliasing bug that is invisible until two targets start
 * reporting each other's failures.
 *
 * @param previous - State before this result.
 * @param target - Configuration, for the failure threshold.
 * @param result - What just happened.
 * @returns The new state.
 */
export function applyResult(
  previous: TargetState,
  target: CheckTarget,
  result: CheckResult,
): TargetState {
  const healthy = result.status === "up";
  const consecutiveFailures = healthy ? 0 : previous.consecutiveFailures + 1;

  // A single failure is not an outage -- networks blip. The target is only
  // called down once the threshold is crossed; until then it holds its prior
  // status, which is what stops one dropped packet paging somebody.
  const status: CheckStatus =
    healthy || consecutiveFailures >= target.failureThreshold
      ? result.status
      : previous.status;

  return {
    targetName: previous.targetName,
    status,
    consecutiveFailures,
    lastCheckedAt: result.recordedAt,
    lastOkAt: healthy ? result.recordedAt : previous.lastOkAt,
  };
}

/** The state a target starts with, before it has ever been checked. */
export function initialState(targetName: string): TargetState {
  return {
    targetName,
    status: "unknown",
    consecutiveFailures: 0,
    lastCheckedAt: null,
    lastOkAt: null,
  };
}

/**
 * A human-readable line for one status.
 *
 * `switch` with a `never` default -- the compile-time exhaustiveness guarantee
 * the standard calls the main advantage over Python. Adding a member to
 * `CheckStatus` makes THIS FUNCTION fail to compile, naming the case nobody
 * handled. An if/else chain fails silently at runtime instead.
 */
export function describe(status: CheckStatus): string {
  switch (status) {
    case "up":
      return "responding as expected";
    case "down":
      return "not responding";
    case "degraded":
      return "responding with an unexpected status";
    case "unknown":
      return "not yet checked";
    default: {
      const unreachable: never = status;
      throw new Error(`unhandled status: ${String(unreachable)}`);
    }
  }
}
