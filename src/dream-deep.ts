/**
 * DREAM Stage 3 -- Deep. Issue #394.
 *
 * Deep produces the REVIEW BUNDLE: a candidate, the turns it came from, the
 * turns around those, the corroboration Light measured, the reinforcement #398
 * absorbed, and REM's guess. That bundle is what the grading page renders and
 * what the operator grades.
 *
 * DEEP DOES NOT COMMIT. The design doc's confidence-band table
 * (dream-design.md:773-781) has Deep committing above 0.5 silently. That table
 * is SUPERSEDED for this build by the governing operator decision of
 * 2026-07-28, encoded in migration 037:59-63: "It does not change what is
 * promoted, and it does not let any machine judgement suppress an item.
 * reviewed_at IS NULL remains the operator's queue." So the queue predicate here
 * is `reviewed_at IS NULL` and nothing else -- not a 0.2-0.5 band, not a
 * machine_grade filter.
 *
 * That is a DELTA against the doc and it is recorded rather than silent:
 * docs/decisions/let-everything-pass-grading.md. dream-design.md:1363-1365
 * requires exactly that -- "if implementation forces a choice, record it as a
 * decision with its reasoning rather than closing the question silently" -- and
 * dream-design.md:1372 keeps the underlying A/B question open: whether the
 * review page is ceremony at all is unresolved until recall is compared.
 *
 * NOTHING HERE MUTATES A CANDIDATE. This module is READ-ONLY against
 * candidate_memory. It does not write review_action, reviewed_at, graded_by, or
 * even machine_grade -- that last one belongs to REM. dream-design.md:116 makes
 * delete/hard-discard ALWAYS ASK, and nothing in this queue is graded yet, so
 * Deep's output is a proposal and its only side effect is the operator reading
 * it. A stage with no write path cannot autonomously commit by accident.
 *
 * THE ATTENTION BUDGET IS THE HARD CONSTRAINT, not the cost of running Deep
 * (dream-design.md:823-827): "The metric to watch is not REM cost but how many
 * items land on the nightly page. Roughly: 20 is reviewable, 200 gets skipped."
 * So {@link buildReviewBundles} is capped by default and the cap is the
 * headline number the runner prints. A page that dumps 1,104 items is a page
 * nobody opens, which is the same outcome as no page at all.
 *
 * RECEIPTS, NOT NUMBERS (dream-design.md:709-712, borrowed from gbrain): each
 * bundle carries the evidence in the form the operator can check -- "said in 3
 * sessions", "restated twice", with the dates -- rather than a synthesised
 * score. Reinforcement is computed live on every build, never denormalized
 * (dream-design.md:686), which is why it can never be stale.
 */

import type pg from "pg";
import type { MaintenanceQueueLogger } from "./maintenance-queue.ts";
import { readReinforcement } from "./candidate-dedupe.ts";

/**
 * Bundles per page by default.
 *
 * 20 is the doc's own "reviewable" figure (dream-design.md:825). It is the cap
 * on what a person is asked to look at in one sitting, not a cap on what
 * exists -- the queue below it is unchanged and the next page picks up where
 * this one stopped.
 */
export const DEFAULT_BUNDLE_LIMIT = 20;

/**
 * Turns of context on each side of a source turn.
 *
 * Borrowed directly from graphiti, whose extract_nodes_and_edges prompt passes
 * the previous N units as READ-ONLY CONTEXT with last_n=3
 * (graphiti_core/prompts/extract_nodes_and_edges.py:8, "Only extract entities
 * from CURRENT MESSAGES - PREVIOUS MESSAGES are context only"). The same
 * argument applies to a human reader: a 6-character operator turn like "run it"
 * is unreadable alone and obvious with its predecessors visible. Attribution:
 * docs/prior-art/ATTRIBUTION.md.
 *
 * Symmetric here rather than backward-only, because the reviewer is judging
 * after the fact and what happened NEXT is often what shows whether the
 * decision was real.
 */
export const DEFAULT_CONTEXT_TURNS = 3;

/** A turn as it appears inside a bundle. */
export interface BundleTurn {
  id: string;
  role: string | null;
  content: string;
  occurred_at: string;
  session_ref: string | null;
  session_seq: number | null;
  repo: string | null;
  /** True when this turn is one the candidate was extracted FROM. */
  is_source: boolean;
}

/** Everything the review page needs to judge one candidate. */
export interface ReviewBundle {
  candidate: {
    id: string;
    namespace: string;
    candidate_type: string;
    content: string;
    uncertain: boolean;
    uncertainty_reason: string | null;
    model: string | null;
    authority_tier: string | null;
    created_at: string;
    first_said_at: string | null;
    last_said_at: string | null;
  };
  /** REM's guess. Advisory: it sorts, it never filters. */
  machine: {
    grade: string | null;
    model: string | null;
  };
  /** Corroboration from Light (#390). Zero when this content was never counted. */
  corroboration: {
    session_count: number;
    occurrence_count: number;
    first_seen_at: string | null;
    last_seen_at: string | null;
  };
  /** Absorbed near-duplicates (#398). Computed live, never cached. */
  reinforcement: {
    count: number;
    first_at: string | null;
    last_at: string | null;
  };
  /** Source turns plus surrounding context, in session order. */
  turns: BundleTurn[];
}

export interface DeepBundleSummary {
  /** Bundles built this pass. */
  bundles: number;
  /** Unreviewed candidates in the queue behind them. */
  queue_depth: number;
  /** Bundles whose candidate REM had already graded. */
  machine_graded: number;
  /** Bundles with cross-session corroboration from Light. */
  corroborated: number;
  /** Bundles carrying at least one absorbed restatement. */
  reinforced: number;
  /** Bundles whose source turns could not be resolved. Surfaced, not hidden. */
  missing_turns: number;
}

export interface DeepDeps {
  pool: pg.Pool;
  logger: MaintenanceQueueLogger;
  namespace?: string;
  /** Bundles to build. Defaults to {@link DEFAULT_BUNDLE_LIMIT}. */
  limit?: number;
  /** Context turns each side. Defaults to {@link DEFAULT_CONTEXT_TURNS}. */
  contextTurns?: number;
}

export interface DeepBundleResult {
  bundles: ReviewBundle[];
  summary: DeepBundleSummary;
}

interface CandidateRow {
  id: string;
  namespace: string;
  candidate_type: string;
  content: string;
  uncertain: boolean;
  uncertainty_reason: string | null;
  model: string | null;
  authority_tier: string | null;
  created_at: Date;
  first_said_at: Date | null;
  last_said_at: Date | null;
  machine_grade: string | null;
  machine_grade_model: string | null;
  source_turn_ids: string[];
  session_count: string | null;
  occurrence_count: string | null;
  occ_first_seen_at: Date | null;
  occ_last_seen_at: Date | null;
}

interface TurnRow {
  id: string;
  role: string | null;
  content: string;
  occurred_at: Date;
  session_ref: string | null;
  session_seq: number | null;
  repo: string | null;
}

function iso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

/**
 * Build one page of review bundles.
 *
 * ORDERING IS `uncertain DESC, created_at ASC`, matching
 * idx_candidate_memory_uncertain_first (037:141-143) so the page is served from
 * the index. The doubtful items surface first because that is where the
 * operator's judgement is worth the most -- and, per 037:59-63, sorting is the
 * ONLY thing `uncertain` is allowed to do. Every unreviewed candidate is still
 * reachable; a later page reaches it.
 */
export async function buildReviewBundles(
  deps: DeepDeps,
): Promise<DeepBundleResult> {
  const limit = deps.limit ?? DEFAULT_BUNDLE_LIMIT;
  const contextTurns = deps.contextTurns ?? DEFAULT_CONTEXT_TURNS;
  const summary: DeepBundleSummary = {
    bundles: 0,
    queue_depth: 0,
    machine_graded: 0,
    corroborated: 0,
    reinforced: 0,
    missing_turns: 0,
  };

  const depth = await deps.pool.query<{ n: string }>(
    `SELECT count(*)::text AS n
       FROM candidate_memory
      WHERE reviewed_at IS NULL
        AND ($1::text IS NULL OR namespace = $1)`,
    [deps.namespace ?? null],
  );
  summary.queue_depth = Number(depth.rows[0]?.n ?? 0);

  // THE QUEUE PREDICATE. `reviewed_at IS NULL`, and nothing else. No band, no
  // machine_grade filter, no uncertainty gate -- 037:59-63. If a future change
  // adds a WHERE clause here it is a suppression path and needs an operator
  // decision, not a commit.
  const candidates = await deps.pool.query<CandidateRow>(
    `SELECT c.id, c.namespace, c.candidate_type, c.content,
            c.uncertain, c.uncertainty_reason, c.model, c.authority_tier,
            c.created_at, c.first_said_at, c.last_said_at,
            c.machine_grade, c.machine_grade_model, c.source_turn_ids,
            o.session_count, o.occurrence_count,
            o.first_seen_at AS occ_first_seen_at,
            o.last_seen_at  AS occ_last_seen_at
       FROM candidate_memory c
       LEFT JOIN content_occurrences o
              ON o.namespace = c.namespace
             AND o.content_hash = c.content_hash
      WHERE c.reviewed_at IS NULL
        AND ($1::text IS NULL OR c.namespace = $1)
      ORDER BY c.uncertain DESC, c.created_at ASC
      LIMIT $2`,
    [deps.namespace ?? null, limit],
  );

  if (candidates.rows.length === 0) {
    // An empty queue is a legitimate day-one state, not an error. The page must
    // render it, so the builder must return it.
    deps.logger.info("dream_deep_bundles_built", { ...summary });
    return { bundles: [], summary };
  }

  const reinforcement = await readReinforcement(
    deps.pool,
    candidates.rows.map((c) => c.id),
  );

  // Every source turn across the page, in one query. Then context in one more.
  // Two queries per page rather than two per bundle: the page is capped at ~20
  // but the cap is a policy dial, and a builder that issues 2N queries degrades
  // the moment someone raises it.
  const allSourceIds = [
    ...new Set(candidates.rows.flatMap((c) => c.source_turn_ids)),
  ];

  const sourceTurns = await deps.pool.query<TurnRow>(
    `SELECT id, role, content, occurred_at, session_ref, session_seq, repo
       FROM ob_raw_turns
      WHERE id = ANY($1::uuid[])`,
    [allSourceIds],
  );
  const sourceById = new Map(sourceTurns.rows.map((t) => [t.id, t]));

  // Context by (session_ref, session_seq) window. session_seq is THE ordering
  // key (036) -- turn_index is per-batch and broken, and parent_turn_uuid
  // dangles on 24% of rows, so neither can order a window. A source turn whose
  // session_seq is NULL (the 036 backfill gap, re-run in 039) simply gets no
  // context rather than getting wrong context.
  const windows = sourceTurns.rows
    .filter((t) => t.session_ref !== null && t.session_seq !== null)
    .map((t) => ({
      session_ref: t.session_ref as string,
      lo: (t.session_seq as number) - contextTurns,
      hi: (t.session_seq as number) + contextTurns,
    }));

  const contextRows: TurnRow[] = [];
  if (windows.length > 0) {
    const ctx = await deps.pool.query<TurnRow>(
      `SELECT DISTINCT t.id, t.role, t.content, t.occurred_at,
              t.session_ref, t.session_seq, t.repo
         FROM ob_raw_turns t
         JOIN unnest($1::text[], $2::int[], $3::int[]) AS w(session_ref, lo, hi)
           ON t.session_ref = w.session_ref
          AND t.session_seq BETWEEN w.lo AND w.hi`,
      [
        windows.map((w) => w.session_ref),
        windows.map((w) => w.lo),
        windows.map((w) => w.hi),
      ],
    );
    contextRows.push(...ctx.rows);
  }

  const bundles: ReviewBundle[] = [];

  for (const row of candidates.rows) {
    const sourceIds = new Set(row.source_turn_ids);
    const sources = row.source_turn_ids
      .map((id) => sourceById.get(id))
      .filter((t): t is TurnRow => t !== undefined);

    if (sources.length === 0) {
      // Provenance that does not resolve. The bundle is still built -- the
      // candidate is real and the operator can still grade its text -- but the
      // gap is counted so it cannot hide behind a healthy-looking page.
      summary.missing_turns++;
    }

    // Only context from the sessions this candidate actually touches. Without
    // this, one page-wide context query would leak another candidate's turns
    // into this bundle, which is worse than no context: it makes the reviewer
    // judge the claim against the wrong conversation.
    const sessions = new Set(
      sources.map((t) => t.session_ref).filter((s): s is string => s !== null),
    );
    const seqs = sources
      .map((t) => t.session_seq)
      .filter((s): s is number => s !== null);
    const lo = seqs.length > 0 ? Math.min(...seqs) - contextTurns : 0;
    const hi = seqs.length > 0 ? Math.max(...seqs) + contextTurns : -1;

    const turnRows = [
      ...sources,
      ...contextRows.filter(
        (t) =>
          !sourceIds.has(t.id) &&
          t.session_ref !== null &&
          sessions.has(t.session_ref) &&
          t.session_seq !== null &&
          t.session_seq >= lo &&
          t.session_seq <= hi,
      ),
    ];

    // Session order, oldest first: the reviewer reads the conversation the way
    // it happened. Falls back to occurred_at when session_seq is missing,
    // which is the expression 036:57-63 computes session_seq from anyway.
    turnRows.sort((a, b) => {
      const s = (a.session_ref ?? "").localeCompare(b.session_ref ?? "");
      if (s !== 0) return s;
      if (a.session_seq !== null && b.session_seq !== null) {
        return a.session_seq - b.session_seq;
      }
      return a.occurred_at.getTime() - b.occurred_at.getTime();
    });

    const receipt = reinforcement.get(row.id);
    const sessionCount = Number(row.session_count ?? 0);

    if (row.machine_grade !== null) summary.machine_graded++;
    if (sessionCount > 1) summary.corroborated++;
    if (receipt && receipt.count > 0) summary.reinforced++;

    bundles.push({
      candidate: {
        id: row.id,
        namespace: row.namespace,
        candidate_type: row.candidate_type,
        content: row.content,
        uncertain: row.uncertain,
        uncertainty_reason: row.uncertainty_reason,
        model: row.model,
        authority_tier: row.authority_tier,
        created_at: row.created_at.toISOString(),
        first_said_at: iso(row.first_said_at),
        last_said_at: iso(row.last_said_at),
      },
      machine: {
        grade: row.machine_grade,
        model: row.machine_grade_model,
      },
      corroboration: {
        session_count: sessionCount,
        occurrence_count: Number(row.occurrence_count ?? 0),
        first_seen_at: iso(row.occ_first_seen_at),
        last_seen_at: iso(row.occ_last_seen_at),
      },
      reinforcement: {
        count: receipt?.count ?? 0,
        first_at: receipt?.first_at ?? null,
        last_at: receipt?.last_at ?? null,
      },
      turns: turnRows.map((t) => ({
        id: t.id,
        role: t.role,
        content: t.content,
        occurred_at: t.occurred_at.toISOString(),
        session_ref: t.session_ref,
        session_seq: t.session_seq,
        repo: t.repo,
        is_source: sourceIds.has(t.id),
      })),
    });
  }

  summary.bundles = bundles.length;

  // Content-free telemetry: counts only.
  deps.logger.info("dream_deep_bundles_built", {
    bundles: summary.bundles,
    queue_depth: summary.queue_depth,
    machine_graded: summary.machine_graded,
    corroborated: summary.corroborated,
    reinforced: summary.reinforced,
    missing_turns: summary.missing_turns,
    limit,
  });

  return { bundles, summary };
}
