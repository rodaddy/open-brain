import type { ReviewItem } from "../server/domain/candidate-review/types.ts";
import type { RemCandidate } from "../server/maintenance/dream-rem.ts";

type FrozenQueueFields =
  | "id"
  | "namespace"
  | "candidate_type"
  | "content"
  | "source_turn_ids"
  | "context"
  | "reinforcement";

export type FrozenQueueItem = Pick<ReviewItem, FrozenQueueFields> & {
  unit_kind: "exchange";
};

/**
 * Project an immutable REM snapshot into the existing grading card's visible shape.
 *
 * Frozen snapshots contain no source turns or timestamps. Empty evidence arrays and
 * null dates state that absence without consulting mutable production tables. The
 * narrow return type deliberately cannot carry machine grades or extraction metadata.
 *
 * @param candidate Frozen candidate captured by the REM cohort.
 * @returns A blinded grading card DTO containing only frozen or safe-empty values.
 */
export function toFrozenQueueItem(candidate: Readonly<RemCandidate>): FrozenQueueItem {
  return {
    id: candidate.id,
    namespace: candidate.namespace,
    candidate_type: candidate.candidate_type,
    content: candidate.content,
    unit_kind: "exchange",
    source_turn_ids: [],
    context: [],
    reinforcement: {
      session_count: candidate.session_count,
      occurrence_count: candidate.occurrence_count,
      first_seen: null,
      last_seen: null,
    },
  };
}
