/**
 * The single writer of an operator grade, its single-item wrapper, and undo.
 * Issue #394, carried across in the L6 decomposition (issue 864).
 *
 * The operator judgement lives in candidate_grade (migration 040), not in
 * candidate_memory; grades arrive in batches, not keystrokes.
 *
 * See docs/decisions/batch-grade-one-writer-of-a-grade.md
 * See docs/decisions/batch-grade-batch-is-the-unit.md
 */

import { logger } from "../../logging/legacy-logger.ts";
import { describeError } from "../../observability/log-surface.ts";
import type { AgentBehavior } from "../grading-reasons.ts";
import {
  parseAgentBehavior,
  parseGradedBy,
  parseReasonCode,
  parseReviewAction,
  type Queryable,
  requireRow,
  type ReviewAction,
  ReviewInputError,
  type TransactionalDb,
  withIndex,
} from "./types.ts";

export interface GradeResult {
  id: string;
  review_action: ReviewAction;
  reviewed_at: string;
  graded_by: string;
  /** REM's guess at grade time, so the caller can show live agreement. */
  machine_grade: string | null;
  /** null when there was no machine guess to agree or disagree with. */
  agreed: boolean | null;
  /** The candidate_grade row this judgement was recorded as (migration 040). */
  grade_id: string;
  /**
   * The batch this single grade was submitted under. A single grade is a batch
   * of one, so it is undoable through the same /api/undo-batch path.
   */
  batch_id: string;
  /** The candidate_grade row this one superseded, when it was a regrade. */
  superseded_grade_id: string | null;
  /** The canned reason recorded, or null (migration 042). */
  reason_code: string | null;
  /** The optional agent-behavior rating, or null when not rated. */
  agent_behavior: AgentBehavior | null;
}

/** One grade as the operator staged it in the page's local batch. */
export interface BatchGradeInput {
  candidateId: string;
  action: string;
  note?: string | null;
  /**
   * Which canned reason was picked, if any (migration 042).
   *
   * Independent of `note`. Clicking a reason seeds the note text, which the
   * operator then edits freely; the code identifies the reason after the text
   * has stopped matching it, which is the only reason to store both.
   */
  reasonCode?: string | null;
  /** The optional second axis: was the AGENT's conduct worth repeating? */
  agentBehavior?: string | null;
}

/** What happened to one item of a submitted batch. */
export interface BatchGradeResult {
  candidate_id: string;
  /** The candidate_grade row id this act of judgement was recorded as. */
  grade_id: string;
  action: ReviewAction;
  /** The candidate_grade row this one superseded, when it was a regrade. */
  superseded_grade_id: string | null;
  machine_grade: string | null;
  agreed: boolean | null;
  /**
   * Whether a note was recorded, NOT the note itself. The page already has the
   * text; echoing it back would put operator prose about real dialogue into
   * every response body and therefore into anything that logs one.
   */
  has_note: boolean;
  /**
   * The canned reason recorded, or null. Echoed back UNLIKE the note, because a
   * code is a closed-vocabulary label rather than operator prose about real
   * dialogue -- it is safe in a response body and in a log line, which is what
   * makes "counts by reason_code" observable without ever logging content.
   */
  reason_code: string | null;
  /** The behavior rating recorded, or null when the operator did not rate it. */
  agent_behavior: AgentBehavior | null;
  /**
   * When the grade row was written, as the transaction stamped it. Read back
   * from the INSERT rather than restated from the caller's clock, so the single
   * -grade wrapper can report a reviewed_at that is the row's actual value.
   */
  created_at: string;
}

export interface BatchSubmitResult {
  batch_id: string;
  graded_by: string;
  results: BatchGradeResult[];
}

/**
 * How many grades one submitted batch may carry.
 *
 * The page holds staged grades in localStorage, so a batch can grow without end
 * across sessions until the operator hits Send. One transaction holding row
 * locks on 1,104 candidates is not the failure mode to discover mid-slog, and an
 * operator who has staged 200 items without sending has lost the
 * review-before-commit property the batch exists for. Well above a working
 * session's realistic staging depth, well below "the whole table".
 */
export const MAX_BATCH_SIZE = 200;

/** Longest note accepted. Rejected rather than shortened -- see parseBatchGrade. */
const MAX_NOTE_LENGTH = 2000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface ParsedGrade {
  candidateId: string;
  action: ReviewAction;
  note: string | null;
  reasonCode: string | null;
  agentBehavior: AgentBehavior | null;
}

/** The candidate id, in either casing, validated as a uuid. */
function parseGradeId(raw: Record<string, unknown>, index: number): string {
  const id = raw.candidateId ?? raw.candidate_id;
  if (typeof id !== "string" || !UUID_RE.test(id.trim())) {
    throw new ReviewInputError(`grades[${index}].candidateId must be a uuid`);
  }
  return id.trim();
}

/**
 * Refuse an item carrying REM's columns.
 *
 * Rejected rather than ignored: a caller that believes it recorded a machine
 * opinion here has to be told it did not. Same rule the single-grade route
 * applies, restated per item because a batch is where one bad element hides.
 */
function rejectMachineColumns(raw: Record<string, unknown>, index: number): void {
  if ("machine_grade" in raw || "machine_grade_model" in raw) {
    throw new ReviewInputError(
      `grades[${index}] carries machine_grade, which this API never writes -- it is REM's column (037:43-57)`,
      403,
    );
  }
}

/** The note, trimmed, with an over-long one rejected rather than shortened. */
function parseGradeNote(raw: Record<string, unknown>, index: number): string | null {
  const note = typeof raw.note === "string" ? raw.note.trim() : "";
  if (note.length > MAX_NOTE_LENGTH) {
    throw new ReviewInputError(
      `grades[${index}].note must be ${MAX_NOTE_LENGTH} characters or fewer`,
    );
  }
  return note === "" ? null : note;
}

/**
 * Validate one staged grade into its normalized form.
 *
 * Runs BEFORE the transaction opens, for every item, so a batch whose fifth
 * item carries a bad action never issues a single write. Validating inside the
 * transaction would work -- the rollback would clean up -- but it would burn a
 * connection and take row locks to discover a client bug.
 *
 * Both casings are accepted throughout, matching how candidateId already is:
 * the page speaks camelCase and a curl or a script speaks the column name.
 * Prefixing the index onto every failure is what makes a rejected batch
 * actionable -- "unknown reason_code" alone does not say which of 40 items.
 */
export function parseBatchGrade(value: unknown, index: number): ParsedGrade {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ReviewInputError(`grades[${index}] must be an object`);
  }
  const raw = value as Record<string, unknown>;
  const candidateId = parseGradeId(raw, index);
  rejectMachineColumns(raw, index);
  return {
    candidateId,
    action: withIndex(index, () => parseReviewAction(raw.action)),
    note: parseGradeNote(raw, index),
    reasonCode: withIndex(index, () =>
      parseReasonCode(raw.reasonCode ?? raw.reason_code),
    ),
    agentBehavior: withIndex(index, () =>
      parseAgentBehavior(raw.agentBehavior ?? raw.agent_behavior),
    ),
  };
}

/**
 * Validate the whole submitted array before a connection is taken.
 *
 * A batch that grades the same candidate twice would have the second INSERT
 * collide with the first through the partial unique index -- inside the
 * transaction, so it would fail the whole submission with a constraint error
 * the operator cannot act on. Caught here, it names the duplicate.
 */
function parseGradeBatch(grades: unknown): ParsedGrade[] {
  if (!Array.isArray(grades)) {
    throw new ReviewInputError("grades must be an array");
  }
  if (grades.length === 0) {
    throw new ReviewInputError("grades must not be empty");
  }
  if (grades.length > MAX_BATCH_SIZE) {
    throw new ReviewInputError(
      `a batch may hold at most ${MAX_BATCH_SIZE} grades; received ${grades.length}`,
    );
  }
  const parsed = grades.map(parseBatchGrade);
  const seen = new Set<string>();
  for (const g of parsed) {
    if (seen.has(g.candidateId)) {
      throw new ReviewInputError(
        `candidate ${g.candidateId} appears twice in one batch; grade it once`,
      );
    }
    seen.add(g.candidateId);
  }
  return parsed;
}

/**
 * Apply one staged grade inside the open transaction.
 *
 * The candidate_memory update comes FIRST and is the existence check: it is
 * namespace-scoped, so an id in another namespace matches zero rows and the
 * whole batch aborts. Doing it after the INSERT would let a cross-namespace
 * candidate_grade row be written and then rolled back -- correct, but it would
 * have taken the write.
 */
async function applyGrade(
  client: Queryable,
  ctx: { namespace: string; grader: string; batchId: string },
  g: ParsedGrade,
): Promise<BatchGradeResult> {
  const updated = await client.query<{ id: string; machine_grade: string | null }>(
    `UPDATE candidate_memory
        SET review_action = $3,
            reviewed_at = now(),
            graded_by = $4
      WHERE namespace = $1 AND id = $2
      RETURNING id, machine_grade`,
    [ctx.namespace, g.candidateId, g.action, ctx.grader],
  );
  const candidate = updated.rows[0];
  if (!candidate) {
    // Named, so the operator can remove the offending item and resend
    // rather than being told "something failed".
    throw new ReviewInputError(
      `candidate ${g.candidateId} not found in this namespace; the whole batch was rolled back`,
      404,
    );
  }

  // Supersede the live grade before inserting the new one. Both statements
  // are namespace-scoped even though candidate_id alone would match: the
  // predicate must not depend on the FK relationship staying correct.
  const superseded = await client.query<{ id: string }>(
    `UPDATE candidate_grade
        SET superseded_at = now()
      WHERE namespace = $1 AND candidate_id = $2 AND superseded_at IS NULL
      RETURNING id`,
    [ctx.namespace, g.candidateId],
  );

  const inserted = await client.query<{ id: string; created_at: Date }>(
    `INSERT INTO candidate_grade
       (namespace, candidate_id, action, note, graded_by, batch_id,
        reason_code, agent_behavior)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id, created_at`,
    [
      ctx.namespace,
      g.candidateId,
      g.action,
      g.note,
      ctx.grader,
      ctx.batchId,
      g.reasonCode,
      g.agentBehavior,
    ],
  );
  const row = requireRow(inserted.rows, "candidate_grade insert");

  return {
    candidate_id: g.candidateId,
    grade_id: row.id,
    action: g.action,
    superseded_grade_id: superseded.rows[0]?.id ?? null,
    has_note: g.note !== null,
    // The code survives regardless of what the operator did to the note
    // text. That independence is the requirement -- editing the inserted
    // sentence must not erase which reason was chosen.
    reason_code: g.reasonCode,
    agent_behavior: g.agentBehavior,
    created_at: row.created_at.toISOString(),
    machine_grade: candidate.machine_grade,
    agreed:
      candidate.machine_grade === null ? null : candidate.machine_grade === g.action,
  };
}

/** Best-effort rollback: if the connection is already broken this throws too. */
async function rollbackQuietly(client: Queryable, what: string): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch (rollbackError) {
    // Usually a dead connection, where the transaction is gone either way.
    // A failure for any other reason leaves the transaction's fate unknown,
    // and that was previously unrecorded anywhere.
    logger.debug(`${what}_rollback_failed`, describeError(rollbackError));
  }
}

/**
 * Submit a whole batch of operator judgements in ONE transaction. A regrade
 * supersedes rather than overwrites, candidate_memory is updated in the same
 * transaction because `reviewed_at IS NULL` is the queue predicate, and neither
 * machine_grade/machine_grade_model nor uncertainty_reason is ever written.
 *
 * See docs/decisions/batch-grade-batch-is-the-unit.md
 */
export async function submitGradeBatch(
  db: TransactionalDb,
  input: { namespace: string; gradedBy: string; grades: unknown },
): Promise<BatchSubmitResult> {
  const grader = parseGradedBy(input.gradedBy);
  const parsed = parseGradeBatch(input.grades);

  const client = await db.connect();
  try {
    await client.query("BEGIN");

    const batch = await client.query<{ batch_id: string }>(
      "SELECT gen_random_uuid() AS batch_id",
    );
    const batchId = requireRow(batch.rows, "batch id").batch_id;

    const ctx = { namespace: input.namespace, grader, batchId };
    const results: BatchGradeResult[] = [];
    for (const g of parsed) {
      results.push(await applyGrade(client, ctx, g));
    }

    await client.query("COMMIT");
    return { batch_id: batchId, graded_by: grader, results };
  } catch (err) {
    // The original error is the one worth surfacing, so it is what gets
    // re-thrown -- but it is also worth recording here, because the caller
    // may convert it into a generic message and this is the only place the
    // driver's own fields are still attached.
    // The batch id is generated inside the transaction, so it is deliberately
    // not logged here -- it does not exist yet if the failure was early, and a
    // rolled-back id refers to nothing. The grader and the item count are what
    // identify this attempt.
    logger.error("grade_batch_failed", {
      graded_by: grader,
      grades_submitted: parsed.length,
      ...describeError(err),
    });
    await rollbackQuietly(client, "grade_batch");
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Record a human grade for ONE candidate. A thin wrapper over submitGradeBatch:
 * one writer of a grade, so a single grade gets its own batch_id and is undoable
 * through the same /api/undo-batch path as anything else.
 *
 * See docs/decisions/batch-grade-one-writer-of-a-grade.md
 *
 * @returns null when no row matched -- unknown id, or an id in another
 *   namespace. Both collapse to the same answer deliberately: distinguishing
 *   them would confirm the existence of a row the caller may not read.
 */
export async function gradeCandidate(
  db: TransactionalDb,
  input: {
    namespace: string;
    id: string;
    action: ReviewAction;
    gradedBy: string;
    note?: string | null;
    reasonCode?: string | null;
    agentBehavior?: string | null;
  },
): Promise<GradeResult | null> {
  let submitted: BatchSubmitResult;
  try {
    submitted = await submitGradeBatch(db, {
      namespace: input.namespace,
      gradedBy: input.gradedBy,
      grades: [
        {
          candidateId: input.id,
          action: input.action,
          note: input.note ?? null,
          // Forwarded rather than validated here: the batch writer is the single
          // validation site, so the single and batch paths cannot accept
          // different vocabularies.
          reasonCode: input.reasonCode ?? null,
          agentBehavior: input.agentBehavior ?? null,
        },
      ],
    });
  } catch (err) {
    // The batch writer reports an unknown or cross-namespace id as a 404
    // ReviewInputError, because a batch names the item that failed. The single
    // route's contract is null-for-not-found and the HTTP layer turns that into
    // its own 404, so translate rather than letting the shapes diverge again.
    if (err instanceof ReviewInputError && err.status === 404) return null;
    throw err;
  }

  const result = requireRow(submitted.results, "single-grade batch");
  return {
    id: result.candidate_id,
    review_action: result.action,
    // Read back from the row the transaction just wrote rather than restating
    // the input: reviewed_at is now()'s value inside that transaction.
    reviewed_at: result.created_at,
    graded_by: submitted.graded_by,
    machine_grade: result.machine_grade,
    agreed: result.agreed,
    grade_id: result.grade_id,
    batch_id: submitted.batch_id,
    superseded_grade_id: result.superseded_grade_id,
    reason_code: result.reason_code,
    agent_behavior: result.agent_behavior,
  };
}

/**
 * Undo the most recent grade on one candidate: put it back in the queue.
 *
 * THE ONLY DESTRUCTIVE-LOOKING OPERATION HERE, and it is deliberate and
 * narrow. A keyboard-driven grader WILL mis-hit a key; without undo the
 * operator's only recovery is to leave a wrong label in the table that a future
 * promoter will train on. Clearing all three review columns together keeps
 * candidate_memory_review_paired satisfied and restores the row to exactly its
 * pre-grade state -- it deletes no content, only the judgement.
 *
 * It cannot clear machine_grade, and does not try to: that is REM's column and
 * the operator never set it.
 */
export async function ungradeCandidate(
  db: Queryable,
  input: { namespace: string; id: string },
): Promise<{ id: string } | null> {
  const { rows } = await db.query<{ id: string }>(
    `UPDATE candidate_memory
        SET review_action = NULL, reviewed_at = NULL, graded_by = NULL
      WHERE namespace = $1 AND id = $2 AND reviewed_at IS NOT NULL
      RETURNING id`,
    [input.namespace, input.id],
  );
  return rows[0] ?? null;
}

export interface UndoBatchResult {
  batch_id: string;
  /** candidate_grade rows removed. */
  removed: number;
  /** Previously-superseded rows restored to live. */
  restored: number;
  /** candidate_memory rows whose review columns were cleared or reverted. */
  candidates: number;
}

/**
 * Un-supersede the most recent surviving grade per candidate.
 *
 * DISTINCT ON picks it: several regrades in a row leave several superseded
 * rows, and restoring more than one would violate idx_candidate_grade_current.
 */
async function restoreSuperseded(
  client: Queryable,
  namespace: string,
  candidateIds: string[],
): Promise<number> {
  const restored = await client.query<{ id: string }>(
    `WITH latest AS (
       SELECT DISTINCT ON (candidate_id) id
         FROM candidate_grade
        WHERE namespace = $1
          AND candidate_id = ANY($2::uuid[])
          AND superseded_at IS NOT NULL
        ORDER BY candidate_id, created_at DESC, id DESC
     )
     UPDATE candidate_grade g
        SET superseded_at = NULL
       FROM latest
      WHERE g.id = latest.id
    RETURNING g.id`,
    [namespace, candidateIds],
  );
  return restored.rows.length;
}

/**
 * Reconcile candidate_memory from whatever grade is live now.
 *
 * The LEFT JOIN is what makes this work for both cases in one statement: a
 * restored grade supplies the old answer, and no live grade sets the row back to
 * unreviewed so it returns to the queue.
 */
async function reconcileCandidates(
  client: Queryable,
  namespace: string,
  candidateIds: string[],
): Promise<number> {
  const reconciled = await client.query<{ id: string }>(
    `UPDATE candidate_memory c
        SET review_action = live.action,
            reviewed_at   = live.created_at,
            graded_by     = live.graded_by
       FROM (
         SELECT ids.id AS candidate_id, g.action, g.created_at, g.graded_by
           FROM unnest($2::uuid[]) AS ids(id)
           LEFT JOIN candidate_grade g
             ON g.candidate_id = ids.id
            AND g.namespace = $1
            AND g.superseded_at IS NULL
       ) live
      WHERE c.namespace = $1 AND c.id = live.candidate_id
    RETURNING c.id`,
    [namespace, candidateIds],
  );
  return reconciled.rows.length;
}

/**
 * Reverse a whole submitted batch. The operator's "undo".
 *
 * Undo is whole-batch, it DELETES rather than supersedes, and it restores what
 * the batch superseded; candidate_memory is then reconciled from whatever grade
 * is live afterwards.
 *
 * See docs/decisions/batch-grade-batch-is-the-unit.md
 */
export async function undoBatch(
  db: TransactionalDb,
  input: { namespace: string; batchId: string; gradedBy?: string },
): Promise<UndoBatchResult | null> {
  if (typeof input.batchId !== "string" || !UUID_RE.test(input.batchId.trim())) {
    throw new ReviewInputError("batchId must be a uuid");
  }
  const batchId = input.batchId.trim();
  // Undo is a write, so it carries the same identity guard as a grade: a
  // machine must not be able to retract the human's labels either.
  if (input.gradedBy !== undefined) parseGradedBy(input.gradedBy);

  const client = await db.connect();
  try {
    await client.query("BEGIN");

    const removed = await client.query<{
      id: string;
      candidate_id: string;
      created_at: Date;
    }>(
      `DELETE FROM candidate_grade
        WHERE namespace = $1 AND batch_id = $2
        RETURNING id, candidate_id, created_at`,
      [input.namespace, batchId],
    );

    if (removed.rows.length === 0) {
      await client.query("ROLLBACK");
      return null;
    }

    const candidateIds = [...new Set(removed.rows.map((r) => r.candidate_id))];
    const restored = await restoreSuperseded(client, input.namespace, candidateIds);
    const candidates = await reconcileCandidates(client, input.namespace, candidateIds);

    await client.query("COMMIT");
    return {
      batch_id: batchId,
      removed: removed.rows.length,
      restored,
      candidates,
    };
  } catch (err) {
    // Undo is the operation an operator reaches for when something already went
    // wrong. An undo that itself fails silently, with only a re-thrown error
    // the caller may generalize, is the worst time to have no record.
    logger.error("undo_batch_failed", {
      batch_id: batchId,
      ...describeError(err),
    });
    await rollbackQuietly(client, "undo_batch");
    throw err;
  } finally {
    client.release();
  }
}
