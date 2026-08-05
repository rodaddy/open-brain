/**
 * DISTILL windowing -- turning a flat table of turns into extraction units with
 * context. Issue #382.
 *
 * THE PROBLEM THIS SOLVES. Measured on the live dogfood corpus 2026-07-28:
 * operator turns have a median length of 100 characters, and the shortest real
 * ones are "go for it", "try it", "switched both". Read alone, a 9-character
 * turn carries no extractable claim. Read after the two turns that preceded it,
 * the SAME 9 characters are an authorization of a specific proposal -- which is
 * the densest decision content in the corpus and the whole reason full-send
 * capture exists (docs/full-send-derivation-spec.md, 032_raw_turns.sql:96-99).
 *
 * THE MECHANISM IS BORROWED FROM GRAPHITI, verbatim from its prompt contract
 * (graphiti_core/prompts/extract_nodes_and_edges.py:8): "Only extract entities
 * from CURRENT MESSAGES - PREVIOUS MESSAGES are context only." Graphiti's
 * default window is the previous 3 units. We adopt both the split and the
 * default. Attribution: docs/prior-art/ATTRIBUTION.md.
 *
 * Why the split matters rather than just concatenating: without it, every
 * candidate extracted from a window would claim all N turns as its source, and
 * the same claim would be re-extracted once per window it appears in. Marking
 * exactly one turn as CURRENT makes `source_turn_ids` honest -- it names the
 * turn that made the claim, not the turns that happened to be nearby.
 *
 * ORDERING KEY: (session_ref, occurred_at, id). NOT turn_index -- migration
 * 036_raw_turns_session_seq.sql:5-16 measured that turn_index is per-hook-batch
 * (every session carries only 0..7) and never per-session. NOT
 * parent_turn_uuid -- 036:41-44 measured 24% of parent links dangle.
 *
 * session_seq (036) is the server-owned ordering column and IS the intended
 * key, but it is populated only by that migration's one-shot backfill: nothing
 * on the insert path assigns it, so turns that arrive after the migration ran
 * carry NULL. Measured 2026-07-28: 59 of 3,795 turns have session_seq IS NULL.
 * (session_ref, occurred_at, id) is the expression the backfill computes
 * session_seq FROM (036:57-63), and it is still a perfect total order on the
 * live corpus -- 3,795 turns, 3,795 distinct (session_ref, occurred_at) pairs,
 * zero ties, re-measured 2026-07-28. So ordering on the source expression is
 * both identical to session_seq where it exists and correct where it does not,
 * which is what keeps those 59 turns from being silently skipped. session_seq
 * is still SELECTed and reported, so a backfill gap stays visible.
 */

import type pg from "pg";

import { NON_SPEECH_ROLES } from "./dream-light.ts";

/** One raw turn as the distiller reads it. Content is already redacted at write. */
export interface DistillTurn {
  id: string;
  namespace: string;
  session_ref: string | null;
  session_seq: number | null;
  role: string;
  content: string;
  repo: string | null;
  occurred_at: Date | null;
  is_human_prompt: boolean;
}

/**
 * One extraction unit: exactly one CURRENT turn plus the units that preceded
 * it, read-only.
 *
 * `context` is ordered oldest-first so a model prompt reads chronologically.
 * Only `current` may produce candidates; `context` exists to make `current`
 * interpretable and must never contribute a source turn id.
 */
export interface DistillUnit {
  current: DistillTurn;
  context: readonly DistillTurn[];
}

/**
 * Previous units passed as read-only context. 3 is graphiti's default
 * (`last_n=3` in its episode retrieval) and we have no measurement that would
 * justify a different number yet -- so it is adopted, not invented.
 */
export const DEFAULT_CONTEXT_WINDOW = 3;
/** Default whole-session bound shared by direct and scheduled distill sweeps. */
export const DEFAULT_MAX_DISTILL_SESSIONS = 4;

/**
 * Is this turn SPEECH -- something a person or an agent actually said, and
 * therefore something that can make a claim?
 *
 * This is the same distinction Light draws, and it now uses the SAME SET
 * (NON_SPEECH_ROLES, src/dream-light.ts:143) rather than a second private list.
 * The two stages still USE the answer differently, and that difference is
 * deliberate:
 *
 *   Light      does not COUNT tool output (it recurs meaninglessly).
 *   Distill    does not EXTRACT FROM tool output, but DOES pass it as context.
 *
 * Tool output is often the evidence a claim rests on -- measured in session
 * 069dd23f seq 102-103, the assistant's factual turn "2370 pass, 0 fail" is
 * only checkable because the tool turn before it carried the test output. So
 * dropping tool turns from the window entirely would remove the grounding;
 * extracting from them would produce candidates out of `ls` output. Context,
 * not source, is the correct disposition for both.
 *
 * THE DIRECTION IS LOAD-BEARING, and this was previously wrong here. An earlier
 * version declared an allowlist (`{user, assistant}`), which inverted Light's
 * documented failure mode: an unrecognised role yielded NO CANDIDATE AT ALL --
 * the silent, permanent drop that dream-light.ts:126-142 and the 2026-07-28
 * "let everything pass" decision both forbid. Zero impact on today's corpus
 * (assistant 2172 / tool 1360 / user 263 on the clone, so no unknown role
 * exists yet) and total impact the first day a new runtime writes one. As a
 * denylist an unknown role is treated as speech and over-extracts a little,
 * which the operator queue and the tier system are there to correct.
 */
export function isSpeech(role: string): boolean {
  return !NON_SPEECH_ROLES.has(role);
}

/**
 * Group ordered turns into extraction units.
 *
 * Every SPEECH turn becomes exactly one unit. Non-speech turns never become a
 * unit's `current` but do occupy slots in the following units' context, because
 * they carry the evidence (see SPEECH_ROLES). The window never crosses a
 * `session_ref` boundary: two sessions are two conversations, and letting one
 * supply context for the other would fabricate a relationship the corpus does
 * not contain.
 *
 * @param turns Turns already ordered by (session_ref, occurred_at, id).
 * @param contextWindow How many preceding turns to carry. Clamped at 0.
 */
export function buildUnits(
  turns: readonly DistillTurn[],
  contextWindow: number = DEFAULT_CONTEXT_WINDOW,
): DistillUnit[] {
  const window = Math.max(0, Math.trunc(contextWindow));
  const units: DistillUnit[] = [];

  for (let i = 0; i < turns.length; i++) {
    const current = turns[i]!;
    if (!isSpeech(current.role)) continue;

    // Walk backwards for context, stopping at the session boundary. Walking
    // backwards rather than slicing a fixed range is what enforces the
    // boundary: the first turn of a session simply finds nothing behind it.
    const context: DistillTurn[] = [];
    for (let j = i - 1; j >= 0 && context.length < window; j--) {
      const prior = turns[j]!;
      if (prior.session_ref !== current.session_ref) break;
      context.push(prior);
    }
    context.reverse(); // oldest first, so a prompt reads in time order

    units.push({ current, context });
  }

  return units;
}

/** A bounded slice of undistilled turns, plus the context needed to read it. */
export interface DistillBatch {
  /** Units whose `current` turn is unclaimed work. */
  units: DistillUnit[];
  /**
   * EVERY turn id the batch consumed, speech or not. This is what gets stamped
   * `distilled_at`, so non-speech turns drain from the queue too -- otherwise
   * the 1,360 tool turns would be re-selected forever and the sweep would never
   * terminate.
   */
  consumedTurnIds: string[];
  /** Turns that carried no session_seq -- a 036 backfill gap, reported not hidden. */
  missingSessionSeq: number;
}

/**
 * SQL fragment for the canonical order. Extracted so the claim query and any
 * context lookup cannot drift apart.
 *
 * NULLS LAST on session_ref keeps orphan turns (the schema allows a null
 * session_ref, 032_raw_turns.sql:78) at the end rather than interleaved with a
 * real session, where they would silently become another session's context.
 */
export const DISTILL_ORDER_BY =
  "session_ref NULLS LAST, occurred_at NULLS LAST, id";

/**
 * Claim a bounded batch of undistilled turns and build their units.
 *
 * WHY IT CLAIMS BY SESSION, NOT BY ROW. A LIMIT over the whole table would cut
 * a session mid-conversation and hand the tail of it to a later batch with no
 * context -- the exact failure the windowing exists to prevent, reintroduced by
 * the pagination. Selecting whole sessions costs a larger read and buys a
 * guarantee: a unit's context is always the turns that actually preceded it.
 *
 * Sessions are ordered oldest-first by their earliest undistilled turn, so the
 * backlog drains in the order it accumulated.
 *
 * FOR UPDATE SKIP LOCKED is deliberately NOT used here. It is the right
 * primitive for row-at-a-time queues (the maintenance queue uses it at
 * src/maintenance-queue.ts:440), but here the claim unit is a whole session and
 * the context read must see turns that are ALREADY distilled -- locking them
 * would serialise two sweeps working on unrelated sessions. Concurrency is
 * instead handled where it actually matters: the `distilled_at IS NULL`
 * predicate plus `ON CONFLICT DO NOTHING` on the candidate write make a
 * double-run converge rather than duplicate.
 */
export async function claimDistillBatch(
  db: Pick<pg.Pool, "query">,
  options: {
    namespace?: string;
    /** Bind one queued batch to the lane selected by the sweep producer. */
    laneId?: string | null;
    /** Max sessions per batch. Bounded: one sweep must not read the whole table. */
    maxSessions?: number;
    /** Max turns per batch, a second bound for pathologically large sessions. */
    maxTurns?: number;
    contextWindow?: number;
  } = {},
): Promise<DistillBatch> {
  const maxSessions = Math.min(
    Math.max(options.maxSessions ?? DEFAULT_MAX_DISTILL_SESSIONS, 1),
    64,
  );
  const maxTurns = Math.min(Math.max(options.maxTurns ?? 1500, 1), 20_000);

  const params: unknown[] = [];
  let nsPredicate = "";
  if (options.namespace !== undefined) {
    params.push(options.namespace);
    nsPredicate = ` AND namespace = $${params.length}`;
  }
  let lanePredicate = "";
  let outerLanePredicate = "";
  if (options.laneId === null) {
    lanePredicate = " AND lane_id IS NULL";
    outerLanePredicate = " AND t.lane_id IS NULL";
  }
  if (typeof options.laneId === "string") {
    params.push(options.laneId);
    lanePredicate = ` AND lane_id = $${params.length}::uuid`;
    outerLanePredicate = ` AND t.lane_id = $${params.length}::uuid`;
  }
  params.push(maxSessions);
  const sessionLimit = `$${params.length}`;
  params.push(maxTurns);
  const turnLimit = `$${params.length}`;

  // Two-step in one statement: pick the oldest sessions that still have
  // undistilled work, then read those sessions WHOLE (including already
  // distilled turns, which are needed as context) in canonical order.
  //
  // retention_tier = 'live' matches the sweep's own work-queue index
  // (idx_ob_raw_turns_undistilled, 032_raw_turns.sql:216-218) so an archived
  // turn is never re-distilled.
  const { rows } = await db.query(
    `WITH due_sessions AS (
       SELECT session_ref, min(occurred_at) AS first_due
         FROM ob_raw_turns
        WHERE distilled_at IS NULL
          AND retention_tier = 'live'${nsPredicate}${lanePredicate}
        GROUP BY session_ref
        ORDER BY first_due ASC NULLS LAST
        LIMIT ${sessionLimit}
     )
     SELECT t.id, t.namespace, t.session_ref, t.session_seq, t.role,
            t.content, t.repo, t.occurred_at, t.is_human_prompt,
            (t.distilled_at IS NULL) AS is_due
       FROM ob_raw_turns t
       JOIN due_sessions d
         ON t.session_ref IS NOT DISTINCT FROM d.session_ref
      WHERE t.retention_tier = 'live'${nsPredicate}${outerLanePredicate}
      ORDER BY ${DISTILL_ORDER_BY}
      LIMIT ${turnLimit}`,
    params,
  );

  const turns: DistillTurn[] = rows.map((r) => ({
    id: r.id as string,
    namespace: r.namespace as string,
    session_ref: (r.session_ref as string | null) ?? null,
    session_seq: (r.session_seq as number | null) ?? null,
    role: r.role as string,
    content: r.content as string,
    repo: (r.repo as string | null) ?? null,
    occurred_at: (r.occurred_at as Date | null) ?? null,
    is_human_prompt: Boolean(r.is_human_prompt),
  }));

  const due = new Set<string>();
  let missingSessionSeq = 0;
  for (let i = 0; i < rows.length; i++) {
    if (rows[i]!.is_due) due.add(turns[i]!.id);
    if (turns[i]!.session_seq === null) missingSessionSeq++;
  }

  // Build units over the FULL ordered slice so context is complete, then keep
  // only the units whose current turn is actually unclaimed work. An
  // already-distilled turn re-appearing here is context, never a re-extraction.
  const allUnits = buildUnits(turns, options.contextWindow);
  const units = allUnits.filter((u) => due.has(u.current.id));

  // Everything due is stamped, including non-speech turns that produced no
  // unit. Without this the tool turns never drain and the sweep never ends.
  const consumedTurnIds = turns.filter((t) => due.has(t.id)).map((t) => t.id);

  return { units, consumedTurnIds, missingSessionSeq };
}
