/**
 * The operator's grading surface, minus the HTTP. Issue #394.
 *
 * This barrel is the module's public surface, unchanged from what the
 * pre-split candidate-review module exported (issue 864). The four
 * modules behind it are the file's own seams:
 *
 *   types.ts          the vocabulary, the row shapes, and the input validators
 *   queue.ts          the two queue reads and the context/reinforcement joins
 *   batch-grade.ts    the single writer of a grade, its wrapper, and undo
 *   history-stats.ts  the grading history and the progress readout
 *
 * scripts/grading-server-run.ts is the thin shell over this, mirroring how
 * scripts/dream-light-run.ts shells over the Light sweep module.
 */

export {
  assertNotMachineIdentity,
  CONTEXT_AFTER,
  CONTEXT_BEFORE,
  clampLimit,
  clampOffset,
  DEFAULT_QUEUE_LIMIT,
  MAX_QUEUE_LIMIT,
  parseAgentBehavior,
  parseGradedBy,
  parseReasonCode,
  parseReviewAction,
  type QueueResult,
  type Queryable,
  REVIEW_ACTIONS,
  type ReviewAction,
  ReviewInputError,
  type ReviewItem,
  type ReviewTurn,
  type TransactionalDb,
} from "./types.ts";

export { fetchInconclusive, fetchQueue } from "./queue.ts";

export {
  type BatchGradeInput,
  type BatchGradeResult,
  type BatchSubmitResult,
  gradeCandidate,
  type GradeResult,
  MAX_BATCH_SIZE,
  submitGradeBatch,
  type UndoBatchResult,
  undoBatch,
  ungradeCandidate,
} from "./batch-grade.ts";

export {
  fetchGradeHistory,
  fetchStats,
  type GradeHistoryItem,
  type GradeHistoryResult,
  type ReviewStats,
} from "./history-stats.ts";
