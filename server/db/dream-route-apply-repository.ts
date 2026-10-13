/**
 * The public DREAM apply step: commits one routed decision to public memory
 * (issue 1525).
 *
 * This is the public-schema port of the mirror's `insertMirrorThought` and
 * `insertMirrorPromote` (`scripts/dream-route-apply.ts`). It builds no INSERT
 * of its own: the thought goes through `insertThought`, the promote event
 * through `insertSessionEvent`, and the history row through `insertTierMove`,
 * so each table keeps exactly one writer.
 *
 * It runs on the caller's client and never begins or commits: the scheduled
 * job owns the transaction, so a failed run rolls every write back together.
 */
import type { PoolClient } from "pg";
import {
  DREAM_ROUTE_SOURCE,
  DREAM_ROUTE_TIER,
  PROMOTE_EVENT_TYPE,
  RULE_CANDIDATE_TYPE,
  ruleScopeKey,
} from "../domain/dream-route/apply-constants.ts";
import type { WouldApply } from "../domain/dream-route/run-core.ts";
import type { CandidateSnapshot } from "../domain/dream-route/types.ts";
import { createReviewedCandidatePromotionRepository } from "./reviewed-candidate-promotion-repository.ts";
import { createSessionRepository, type EventLaneRow } from "./session-repository.ts";
import { DREAM_ROUTE_APPLY_CAUSE, insertTierMove } from "./tier-moves.ts";

/** The session key of the lane every DREAM rule event is filed on. */
const DREAM_ROUTE_SESSION_KEY = "dream-route";

/** What applying one routed decision did. */
export type ApplyOutcome = {
  readonly outcome: "thought" | "rule_event" | "skipped_existing" | "not_applied";
  readonly entryId: string | null;
};

/** One routed decision to commit, on the caller's transaction. */
export interface ApplyRoutedDecisionInput {
  readonly client: PoolClient;
  readonly runId: string;
  readonly candidate: CandidateSnapshot;
  readonly action: WouldApply["action"];
}

const SKIPPED: ApplyOutcome = { outcome: "skipped_existing", entryId: null };

/**
 * Commits one routed decision: a thought, a rule promote event, or nothing.
 *
 * @param input - The caller's client, the run id, the candidate, and the action.
 * @returns The destination written, `skipped_existing` for a duplicate, or
 *   `not_applied` for an action that writes nothing.
 */
export async function applyRoutedDecision(
  input: ApplyRoutedDecisionInput,
): Promise<ApplyOutcome> {
  if (input.action === "thought") return applyThought(input);
  if (input.action === "rule_event") return applyRuleEvent(input);
  return { outcome: "not_applied", entryId: null };
}

async function applyThought(input: ApplyRoutedDecisionInput): Promise<ApplyOutcome> {
  const { client, runId, candidate } = input;
  const embedding = await readCandidateEmbedding(client, candidate);
  const inserted = await createReviewedCandidatePromotionRepository(
    client,
  ).insertThought({
    content: candidate.content,
    tags: ["dream-route"],
    createdBy: DREAM_ROUTE_SOURCE,
    namespace: candidate.namespace,
    embedding,
    contentHash: candidate.content_hash,
    sourceRefs: JSON.stringify(candidate.source_turn_ids),
    promotedFrom: JSON.stringify({
      source: DREAM_ROUTE_SOURCE,
      candidate_id: candidate.id,
      routing_run_id: runId,
    }),
    source: DREAM_ROUTE_SOURCE,
    tier: DREAM_ROUTE_TIER,
  });
  if (inserted === null) return SKIPPED;
  const entryId = String(inserted.id);
  await recordMove({ client, runId, entryId, sourceTable: "thoughts" });
  return { outcome: "thought", entryId };
}

async function applyRuleEvent(input: ApplyRoutedDecisionInput): Promise<ApplyOutcome> {
  const { client, runId, candidate } = input;
  const sessions = createSessionRepository(client);
  const lane = await resolveLane(sessions, candidate.namespace);
  const embedding = await readCandidateEmbedding(client, candidate);
  const event = await sessions.insertSessionEvent({
    values: [
      lane.id,
      PROMOTE_EVENT_TYPE,
      candidate.content,
      DREAM_ROUTE_SOURCE,
      null,
      null,
      null,
      null,
      DREAM_ROUTE_TIER,
      JSON.stringify({
        memory_lifecycle_action: "promote",
        candidate_type: RULE_CANDIDATE_TYPE,
        candidate_scope: { key: ruleScopeKey(candidate.content_hash) },
        candidate_id: candidate.id,
        routing_run_id: runId,
      }),
      embedding,
      candidate.content_hash,
      null,
      null,
      DREAM_ROUTE_SOURCE,
    ],
  });
  if (event === undefined) return SKIPPED;
  const entryId = String(event.id);
  await recordMove({ client, runId, entryId, sourceTable: "ob_session_events" });
  return { outcome: "rule_event", entryId };
}

/**
 * Reads the candidate's own embedding, which the routed entry reuses: the
 * candidate text and the entry text are the same string, embedded by the same
 * model (as reviewed-candidate promotion does). Null only when the row or its
 * embedding vanished after the slice read it.
 */
async function readCandidateEmbedding(
  client: PoolClient,
  candidate: CandidateSnapshot,
): Promise<string | null> {
  const { rows } = await client.query<{ embedding: string | null }>(
    "SELECT embedding::text AS embedding FROM candidate_memory WHERE id = $1 AND namespace = $2",
    [candidate.id, candidate.namespace],
  );
  return rows[0]?.embedding ?? null;
}

/** Finds the namespace's DREAM lane, creating it on first use. */
async function resolveLane(
  sessions: ReturnType<typeof createSessionRepository>,
  namespace: string,
): Promise<EventLaneRow> {
  const key = { namespace, sessionKey: DREAM_ROUTE_SESSION_KEY };
  const existing = await sessions.selectEventLane(key);
  if (existing !== undefined) return existing;
  const created = await sessions.insertEventLane({
    values: [
      DREAM_ROUTE_SESSION_KEY,
      namespace,
      DREAM_ROUTE_SOURCE,
      DREAM_ROUTE_SOURCE,
      null,
      null,
      null,
      "DREAM route commits",
      "{}",
      DREAM_ROUTE_SOURCE,
    ],
  });
  if (created !== undefined) return created;
  // A concurrent insert won the ON CONFLICT; its row is now visible.
  const raced = await sessions.selectEventLane(key);
  if (raced === undefined) throw new Error(`dream-route lane missing for ${namespace}`);
  return raced;
}

async function recordMove(input: {
  client: PoolClient;
  runId: string;
  entryId: string;
  sourceTable: "thoughts" | "ob_session_events";
}): Promise<void> {
  await insertTierMove({
    db: input.client,
    entryId: input.entryId,
    sourceTable: input.sourceTable,
    fromTier: null,
    toTier: DREAM_ROUTE_TIER,
    cause: DREAM_ROUTE_APPLY_CAUSE,
    routingRunId: input.runId,
  });
}
