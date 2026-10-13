/**
 * The owning boundary for explicit human-reviewed candidate promotion.
 *
 * Distillation writes proposals only, and grading records a human label only.
 * This function is the separate, caller-invoked bridge that may copy a
 * promoted `fact` or `decision` candidate into the same namespace's durable
 * thoughts table. It has no confidence threshold or machine-grade trigger.
 */
import type {
  HumanPromotedCandidateRow,
  ReviewedCandidatePromotionRepository,
} from "../db/reviewed-candidate-promotion-repository.ts";

export const REVIEWED_CANDIDATE_SOURCE = "dream-reviewed-candidate" as const;

const SUPPORTED_CANDIDATE_TYPES: ReadonlySet<string> = new Set(["fact", "decision"]);

export class ReviewedCandidateNotFoundError extends Error {
  constructor() {
    super("Candidate not found or not human-promoted");
    this.name = "ReviewedCandidateNotFoundError";
  }
}

export class UnsupportedReviewedCandidateTypeError extends Error {
  readonly candidateType: string;

  constructor(candidateType: string) {
    super(`Candidate type '${candidateType}' has no durable thought promotion mapping`);
    this.name = "UnsupportedReviewedCandidateTypeError";
    this.candidateType = candidateType;
  }
}

export interface ReviewedCandidatePromotionResult {
  readonly status: "promoted" | "duplicate" | "dry_run";
  readonly candidate_id: string;
  readonly candidate_type: string;
  readonly namespace: string;
  readonly dry_run: boolean;
  readonly would_insert: boolean;
  readonly is_new: boolean;
  readonly thought_id?: string;
  readonly existing_archived?: boolean;
}

function timestamp(value: Date | string | null): string | null {
  return value instanceof Date ? value.toISOString() : value;
}

function provenance(
  candidate: HumanPromotedCandidateRow,
  promotedBy: string,
  promotedAt: string,
): Record<string, unknown> {
  return {
    source: REVIEWED_CANDIDATE_SOURCE,
    candidate_id: candidate.id,
    candidate_namespace: candidate.namespace,
    candidate_type: candidate.candidate_type,
    source_turn_ids: candidate.source_turn_ids,
    distill_job_id: candidate.distill_job_id,
    model: candidate.model,
    authority_tier: candidate.authority_tier,
    reviewed_at: timestamp(candidate.reviewed_at),
    reviewed_by: candidate.graded_by,
    review_action: candidate.review_action,
    promoted_at: promotedAt,
    promoted_by: promotedBy,
  };
}

function sourceRefs(
  candidate: HumanPromotedCandidateRow,
): Array<Record<string, unknown>> {
  return [
    {
      kind: "candidate_memory",
      candidate_id: candidate.id,
      namespace: candidate.namespace,
      source_turn_ids: candidate.source_turn_ids,
    },
  ];
}

function duplicateResult(
  candidate: HumanPromotedCandidateRow,
  namespace: string,
  dryRun: boolean,
  existing: { id: string; archived_at: Date | string | null },
): ReviewedCandidatePromotionResult {
  return {
    status: "duplicate",
    candidate_id: candidate.id,
    candidate_type: candidate.candidate_type,
    namespace,
    dry_run: dryRun,
    would_insert: false,
    is_new: false,
    thought_id: existing.id,
    existing_archived: existing.archived_at !== null,
  };
}

/**
 * Promote one candidate after the operator has already recorded `promoted`.
 *
 * The repository is transaction-capable; callers use the same repository
 * instance for the candidate read and thought insert when applying. The
 * content hash remains the candidate's hash so retries are idempotent without
 * inventing a second dedupe policy.
 */
export async function promoteReviewedCandidate(
  repository: ReviewedCandidatePromotionRepository,
  input: {
    candidateId: string;
    namespace: string;
    promotedBy: string;
    dryRun: boolean;
    now?: () => Date;
  },
): Promise<ReviewedCandidatePromotionResult> {
  const candidate = await repository.findHumanPromotedCandidate({
    candidateId: input.candidateId,
    namespace: input.namespace,
  });
  if (!candidate) throw new ReviewedCandidateNotFoundError();
  if (candidate.namespace !== input.namespace) {
    throw new Error("candidate namespace does not match promotion namespace");
  }
  if (!SUPPORTED_CANDIDATE_TYPES.has(candidate.candidate_type)) {
    throw new UnsupportedReviewedCandidateTypeError(candidate.candidate_type);
  }

  const existing = await repository.findThoughtByHash({
    contentHash: candidate.content_hash,
    namespace: input.namespace,
  });
  if (existing)
    return duplicateResult(candidate, input.namespace, input.dryRun, existing);

  if (input.dryRun) {
    return {
      status: "dry_run",
      candidate_id: candidate.id,
      candidate_type: candidate.candidate_type,
      namespace: input.namespace,
      dry_run: true,
      would_insert: true,
      is_new: false,
    };
  }

  const promotedAt = (input.now ?? (() => new Date()))().toISOString();
  const inserted = await repository.insertThought({
    content: candidate.content,
    tags: [REVIEWED_CANDIDATE_SOURCE, `candidate-type:${candidate.candidate_type}`],
    createdBy: input.promotedBy,
    namespace: input.namespace,
    embedding: candidate.embedding,
    contentHash: candidate.content_hash,
    sourceRefs: JSON.stringify(sourceRefs(candidate)),
    promotedFrom: JSON.stringify(provenance(candidate, input.promotedBy, promotedAt)),
  });
  if (inserted) {
    return {
      status: "promoted",
      candidate_id: candidate.id,
      candidate_type: candidate.candidate_type,
      namespace: input.namespace,
      dry_run: false,
      would_insert: true,
      is_new: true,
      thought_id: inserted.id,
    };
  }

  // Another apply won the unique namespace/hash race. Read it back so the
  // caller gets the same idempotent receipt as a sequential retry.
  const raced = await repository.findThoughtByHash({
    contentHash: candidate.content_hash,
    namespace: input.namespace,
  });
  if (!raced)
    throw new Error("candidate thought insert conflicted without an existing row");
  return duplicateResult(candidate, input.namespace, false, raced);
}
