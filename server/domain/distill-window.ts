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

import { NON_SPEECH_ROLES } from "../maintenance/dream-light.ts";

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
    const current = turns[i];
    if (current === undefined) continue;
    if (!isSpeech(current.role)) continue;

    // Walk backwards for context, stopping at the session boundary. Walking
    // backwards rather than slicing a fixed range is what enforces the
    // boundary: the first turn of a session simply finds nothing behind it.
    const context: DistillTurn[] = [];
    for (let j = i - 1; j >= 0 && context.length < window; j--) {
      const prior = turns[j];
      if (prior === undefined) break;
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
export const DISTILL_ORDER_BY = "session_ref NULLS LAST, occurred_at NULLS LAST, id";

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
/** Caller-supplied selection for one claim. */
export interface ClaimDistillOptions {
  namespace?: string;
  /** Bind one queued batch to the lane selected by the sweep producer. */
  laneId?: string | null;
  /** Max sessions per batch. Bounded: one sweep must not read the whole table. */
  maxSessions?: number;
  /** Max turns per batch, a second bound for pathologically large sessions. */
  maxTurns?: number;
  contextWindow?: number;
}

/**
 * The bind parameters and the SQL predicate fragments they are referenced by.
 *
 * Hoisted out of {@link claimDistillBatch} so the placeholder numbering and the
 * fragments that name those placeholders are produced in one place: the two
 * must agree, and a $n written by hand in a body that also pushes to `params`
 * is where that agreement gets broken.
 */
interface ClaimBindings {
  params: unknown[];
  nsPredicate: string;
  lanePredicate: string;
  outerLanePredicate: string;
  sessionLimit: string;
  turnLimit: string;
  contextLimit: string;
}

function buildClaimBindings(options: ClaimDistillOptions): ClaimBindings {
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
  // The context reach, in session_seq steps, used by the SQL below to pull the
  // turns preceding each due turn. Mirrors the contextWindow that buildUnits
  // applies in TypeScript: the query must fetch at least as much as the builder
  // will read, or units come back with less context than they should have.
  params.push(
    Math.min(Math.max(options.contextWindow ?? DEFAULT_CONTEXT_WINDOW, 0), 64),
  );
  const contextLimit = `$${params.length}`;

  return {
    params,
    nsPredicate,
    lanePredicate,
    outerLanePredicate,
    sessionLimit,
    turnLimit,
    contextLimit,
  };
}

/** One claim row as Postgres returns it, before it becomes a {@link DistillTurn}. */
type ClaimRow = Record<string, unknown> & { is_due?: unknown };

function toDistillTurn(r: ClaimRow): DistillTurn {
  return {
    id: r.id as string,
    namespace: r.namespace as string,
    session_ref: (r.session_ref as string | null) ?? null,
    session_seq: (r.session_seq as number | null) ?? null,
    role: r.role as string,
    content: r.content as string,
    repo: (r.repo as string | null) ?? null,
    occurred_at: (r.occurred_at as Date | null) ?? null,
    is_human_prompt: Boolean(r.is_human_prompt),
  };
}

/**
 * Turn claim rows into ordered turns, the set of ids that are actually DUE, and
 * the count of turns missing session_seq.
 *
 * Hoisted so the row shape is decoded in exactly one place, and so the due-set
 * scan reads by value rather than by parallel index into two arrays.
 */
function readClaimRows(rows: readonly ClaimRow[]): {
  turns: DistillTurn[];
  due: Set<string>;
  missingSessionSeq: number;
} {
  const turns: DistillTurn[] = [];
  const due = new Set<string>();
  let missingSessionSeq = 0;

  for (const row of rows) {
    const turn = toDistillTurn(row);
    turns.push(turn);
    if (row.is_due) due.add(turn.id);
    if (turn.session_seq === null) missingSessionSeq++;
  }

  return { turns, due, missingSessionSeq };
}

export async function claimDistillBatch(
  db: Pick<pg.Pool, "query">,
  options: ClaimDistillOptions = {},
): Promise<DistillBatch> {
  const {
    params,
    nsPredicate,
    lanePredicate,
    outerLanePredicate,
    sessionLimit,
    turnLimit,
    contextLimit,
  } = buildClaimBindings(options);

  // Three steps in one statement: pick the oldest sessions that still have
  // undistilled work, take the DUE turns inside them, then read the context
  // those specific due turns need.
  //
  // WHY THE BOUND SITS ON DUE TURNS AND NOT ON THE COMBINED SET. This query
  // used to select each due session WHOLE and apply `LIMIT maxTurns` to the
  // result. Reading whole sessions was and remains correct -- an
  // already-distilled turn reappearing here is the context that makes a short
  // current turn interpretable, which is the entire premise of this module. The
  // defect was applying maxTurns AFTERWARDS: ordered by session_ref then
  // occurred_at, a long-running session's already-distilled history filled
  // every one of the 1500 slots and the due turns fell off the end.
  //
  // Measured on the dogfood corpus 2026-08-25, namespace rico, with the
  // production parameters (maxSessions=4, maxTurns=1500):
  //
  //     due turns in claim     : 0
  //     context turns in claim : 1500
  //     undistilled backlog    : 190,102
  //
  // A claim of 1500 turns containing nothing to do. The handler stamps only
  // `if (consumedTurnIds.length > 0)` (src/distill-handler.ts), so an empty
  // claim stamped nothing, threw nothing, and completed as `succeeded`; and
  // because the producer's idempotency key hashes the DUE turns
  // (src/maintenance-queue.ts) under ON CONFLICT DO NOTHING, that unchanged
  // hash then silently dropped every later enqueue. 392 succeeded jobs, zero
  // turns stamped, no error anywhere, 27 days of starvation.
  //
  // Same family as the producer-side defect in src/maintenance-sweep.ts, where
  // already-distilled turns were ranked ahead of due ones and pushed the due
  // work past the rank cutoff. Both are "the bound was applied to the wrong
  // set", and fixing either alone yields nothing: the producer enqueues work
  // the consumer then declines to claim.
  //
  // So `due_turns` takes maxTurns, and `context_turns` is derived from
  // whichever due turns are in it. Context is deliberately NOT counted against
  // maxTurns -- it is governed by contextWindow per due turn, which is what
  // decides how much of it is ever read. maxTurns bounds the WORK; the reading
  // around that work is separate, and conflating the two is what broke this.
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
     ),
     due_turns AS (
       SELECT t.*
         FROM ob_raw_turns t
         JOIN due_sessions d
           ON t.session_ref IS NOT DISTINCT FROM d.session_ref
        WHERE t.distilled_at IS NULL
          AND t.retention_tier = 'live'${nsPredicate}${outerLanePredicate}
        ORDER BY ${DISTILL_ORDER_BY}
        LIMIT ${turnLimit}
     ),
     -- The context each due turn needs: the turns immediately preceding it in
     -- its own session. Expressed as a session_seq range rather than a row
     -- count so a claim can never pull an unrelated session's tail, and scoped
     -- to the sessions that actually produced due work. Turns carrying a null
     -- session_seq (an 036 backfill gap) are reported through
     -- missingSessionSeq and bring no context of their own.
     context_bounds AS (
       SELECT session_ref,
              min(session_seq) - ${contextLimit}::int AS low_seq,
              max(session_seq)                        AS high_seq
         FROM due_turns
        WHERE session_seq IS NOT NULL
        GROUP BY session_ref
     ),
     context_turns AS (
       SELECT t.*
         FROM ob_raw_turns t
         JOIN context_bounds b
           ON t.session_ref IS NOT DISTINCT FROM b.session_ref
        WHERE t.retention_tier = 'live'${nsPredicate}${outerLanePredicate}
          AND t.session_seq IS NOT NULL
          AND t.session_seq >= b.low_seq
          AND t.session_seq <= b.high_seq
     )
     SELECT t.id, t.namespace, t.session_ref, t.session_seq, t.role,
            t.content, t.repo, t.occurred_at, t.is_human_prompt,
            (t.distilled_at IS NULL) AS is_due
       FROM (
         SELECT * FROM due_turns
         UNION
         SELECT * FROM context_turns
       ) t
      ORDER BY ${DISTILL_ORDER_BY}`,
    params,
  );

  const { turns, due, missingSessionSeq } = readClaimRows(rows as ClaimRow[]);

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
