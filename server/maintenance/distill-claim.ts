/**
 * DISTILL batch claim. Split out of distill-handler.ts.
 *
 * One responsibility: turn the sweep's optional selection parameters into a
 * claim against the window module, wrapped in a trace span when tracing is on.
 * The optional fields are spread conditionally rather than passed as undefined
 * because the window module distinguishes an absent field from an explicit value.
 */

import type { BackgroundTraceRecorder } from "../application/background-tracing.ts";
import { claimDistillBatch, DEFAULT_CONTEXT_WINDOW } from "../domain/distill-window.ts";
import type { DistillSweepDeps } from "./distill-handler.ts";

/** The claim result, as the window module returns it. */
export type DistillClaim = Awaited<ReturnType<typeof claimDistillBatch>>;

/** Build the selection parameters the window module expects. */
function claimParams(deps: DistillSweepDeps): Parameters<typeof claimDistillBatch>[1] {
  return {
    ...(deps.namespace !== undefined ? { namespace: deps.namespace } : {}),
    ...(deps.laneId !== undefined ? { laneId: deps.laneId } : {}),
    ...(deps.maxSessions !== undefined ? { maxSessions: deps.maxSessions } : {}),
    ...(deps.maxTurns !== undefined ? { maxTurns: deps.maxTurns } : {}),
    contextWindow: deps.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
  };
}

/** Claim one batch of undistilled turns, traced when a recorder is present. */
export async function claimBatch(
  deps: DistillSweepDeps,
  trace?: BackgroundTraceRecorder,
): Promise<DistillClaim> {
  const claim = (): Promise<DistillClaim> =>
    claimDistillBatch(deps.pool, claimParams(deps));
  if (!trace) return claim();
  return trace.span("distill.claim", claim, {
    input: {
      namespace: deps.namespace ?? null,
      lane_id: deps.laneId ?? null,
    },
    output: (result) => ({
      row_ids: result.consumedTurnIds,
      units: result.units.length,
      missing_session_seq: result.missingSessionSeq,
    }),
  });
}
