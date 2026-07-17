import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type pg from "pg";
import { toSql } from "pgvector/pg";
import { canWrite } from "../permissions.ts";
import { canWriteNamespace } from "../namespace-policy.ts";
import { contentHash, EMBEDDING_MODEL } from "../embedding.ts";
import {
  classifyShareCandidate,
  containsSecret,
  SHARE_REJECTION_MAX_RESUBMIT_ATTEMPTS,
  type ShareRejectionDetail,
  shareRejectionDetail,
} from "../sharing.ts";
import type { AuthInfo } from "../types.ts";
import { logger } from "../logger.ts";
import type { ToolDeps } from "./index.ts";
import { EVENT_TYPES, IMPORTANCE_LEVELS } from "./table-constants.ts";

type AppendErrorClass =
  | "retryable_outage"
  | "auth_denied"
  | "scope_validation"
  | "unsupported_operation"
  | "conflict_retry"
  | "citation_not_stored";

function appendSessionEventError(
  errorClass: AppendErrorClass,
  message: string,
  retryable: boolean,
  details: Record<string, unknown> = {},
) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({
          error: errorClass,
          message,
          retryable,
          ...details,
        }),
      },
    ],
    isError: true,
  };
}

type Queryable = Pick<pg.Pool | pg.PoolClient, "query">;
type PreparedLaneEmbedding = {
  embeddingVal: ReturnType<typeof toSql> | null;
  contentHashValue: string | null;
  embeddedAt: string | null;
  model: string | null;
};
type PreparedEventEmbedding = {
  embeddingVal: ReturnType<typeof toSql> | null;
  contentHashValue: string;
  embeddedAt: string | null;
  model: string | null;
};
const MEMORY_LIFECYCLE_ACTIONS = new Set([
  "candidate",
  "promote",
  "relegate",
  "discard",
  "nominate_shared",
]);
const CANDIDATE_TYPES = new Set([
  "user_preference",
  "process_rule",
  "channel_server_rule",
  "code_repo_fact",
  "positive_example",
  "negative_example",
  "durable_decision",
  "shared_kb_nomination",
]);

async function withAppendDb<T>(
  deps: ToolDeps,
  transactional: boolean,
  fn: (db: Queryable) => Promise<T>,
): Promise<T> {
  if (!transactional) {
    return fn(deps.pool);
  }
  if (typeof deps.pool.connect !== "function") {
    if (!deps.allowNonTransactionalAppendFallback) {
      throw new Error(
        "append_session_event create_if_missing or exact-scope attachment requires a transactional pg Pool",
      );
    }
    return fn(deps.pool);
  }

  const client = await deps.pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackErr) {
      logger.warn("append_session_event_rollback_failed", {
        error:
          rollbackErr instanceof Error
            ? rollbackErr.message
            : String(rollbackErr),
      });
    }
    throw err;
  } finally {
    client.release();
  }
}

async function firstWriteLaneEmbedding(
  deps: ToolDeps,
  args: {
    session_key: string;
    project?: string;
    topic?: string;
  },
): Promise<{
  embeddingVal: ReturnType<typeof toSql> | null;
  contentHashValue: string | null;
  embeddedAt: string | null;
  model: string | null;
}> {
  const contextText = args.topic || "";
  const contentHashValue = firstWriteLaneContentHash(args);

  let embedding: number[] | null = null;
  if (contextText) {
    const embedParts = [contextText];
    if (args.project) embedParts.push(args.project);
    try {
      embedding = await deps.embedFn(embedParts.join("\n"));
    } catch (err) {
      logger.warn("append_session_event_lane_embed_error", {
        session_key: args.session_key,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    embeddingVal: embedding ? toSql(embedding) : null,
    contentHashValue,
    embeddedAt: embedding ? new Date().toISOString() : null,
    model: embedding ? EMBEDDING_MODEL : null,
  };
}

function firstWriteLaneContentHash(args: {
  session_key: string;
  topic?: string;
}): string | null {
  const contextText = args.topic || "";
  return contextText ? contentHash(args.session_key + "|" + contextText) : null;
}

function firstWriteLaneHashOnly(args: {
  session_key: string;
  topic?: string;
}): PreparedLaneEmbedding {
  return {
    embeddingVal: null,
    contentHashValue: firstWriteLaneContentHash(args),
    embeddedAt: null,
    model: null,
  };
}

async function appendEventEmbedding(
  deps: ToolDeps,
  args: { session_key: string; content: string },
): Promise<PreparedEventEmbedding> {
  let embedding: number[] | null = null;
  try {
    embedding = await deps.embedFn(args.content);
  } catch (err) {
    logger.warn("append_session_event_embed_error", {
      session_key: args.session_key,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return {
    embeddingVal: embedding ? toSql(embedding) : null,
    contentHashValue: contentHash(args.content),
    embeddedAt: embedding ? new Date().toISOString() : null,
    model: embedding ? EMBEDDING_MODEL : null,
  };
}

async function fillAcceptedLaneEmbedding(
  deps: ToolDeps,
  laneId: string,
  args: {
    session_key: string;
    project?: string;
    topic?: string;
  },
): Promise<void> {
  const laneEmbedding = await firstWriteLaneEmbedding(deps, args);
  if (!laneEmbedding.embeddingVal) return;

  try {
    await deps.pool.query(
      `UPDATE ob_session_lanes
          SET embedding = $1,
              embedded_at = $2,
              embedding_model = $3,
              updated_at = NOW()
        WHERE id = $4`,
      [
        laneEmbedding.embeddingVal,
        laneEmbedding.embeddedAt,
        laneEmbedding.model,
        laneId,
      ],
    );
  } catch (err) {
    logger.warn("append_session_event_lane_embedding_update_error", {
      session_key: args.session_key,
      lane_id: laneId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function fillAcceptedEventEmbedding(
  deps: ToolDeps,
  eventId: string,
  args: { session_key: string; content: string },
): Promise<void> {
  const eventEmbedding = await appendEventEmbedding(deps, args);
  if (!eventEmbedding.embeddingVal) return;

  try {
    await deps.pool.query(
      `UPDATE ob_session_events
          SET embedding = $1,
              embedded_at = $2,
              embedding_model = $3
        WHERE id = $4`,
      [
        eventEmbedding.embeddingVal,
        eventEmbedding.embeddedAt,
        eventEmbedding.model,
        eventId,
      ],
    );
  } catch (err) {
    logger.warn("append_session_event_embedding_update_error", {
      session_key: args.session_key,
      event_id: eventId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

type ExactLaneScope = {
  agent?: string;
  platform?: string;
  server_id?: string;
  channel_id?: string;
  thread_id?: string | null;
};

function hasAssertedExactScope(
  lane: Record<string, unknown>,
  metadata: Record<string, unknown>,
): boolean {
  return (
    lane.agent != null &&
    lane.source != null &&
    metadata.server_id != null &&
    lane.channel_id != null
  );
}

function scopeConflicts(
  lane: Record<string, unknown>,
  args: ExactLaneScope,
): string[] {
  const conflicts: string[] = [];
  const metadata =
    lane.metadata && typeof lane.metadata === "object"
      ? (lane.metadata as Record<string, unknown>)
      : {};
  const exactScopeAsserted = hasAssertedExactScope(lane, metadata);

  const checks: Array<[string, unknown, unknown]> = [
    ["agent", lane.agent, args.agent],
    ["platform", lane.source, args.platform],
    ["server_id", metadata.server_id, args.server_id],
    ["channel_id", lane.channel_id, args.channel_id],
    ["thread_id", lane.thread_id, args.thread_id],
  ];

  for (const [field, existing, requested] of checks) {
    if (requested === undefined) continue;
    // A null/absent value on a legacy lane is attachable only until the four
    // non-thread exact-scope coordinates are all asserted. Once they are, a
    // null thread is an explicit unthreaded scope, not a wildcard that a later
    // threaded append may claim.
    if (existing === null || existing === undefined) {
      if (field === "thread_id" && exactScopeAsserted && requested !== null) {
        conflicts.push(field);
      }
      continue;
    }
    if (existing !== requested) conflicts.push(field);
  }

  return conflicts;
}

function hasUnassertedScope(
  lane: Record<string, unknown>,
  args: ExactLaneScope,
): boolean {
  const metadata =
    lane.metadata && typeof lane.metadata === "object"
      ? (lane.metadata as Record<string, unknown>)
      : {};
  const exactScopeAsserted = hasAssertedExactScope(lane, metadata);
  return (
    (args.agent !== undefined && lane.agent == null) ||
    (args.platform !== undefined && lane.source == null) ||
    (args.server_id !== undefined && metadata.server_id == null) ||
    (args.channel_id !== undefined && lane.channel_id == null) ||
    (args.thread_id !== undefined &&
      args.thread_id !== null &&
      lane.thread_id == null &&
      !exactScopeAsserted)
  );
}

async function attachUnassertedScope(
  db: Queryable,
  lane: Record<string, unknown>,
  args: {
    namespace: string;
    session_key: string;
  } & ExactLaneScope,
  laneColumns: string,
): Promise<Record<string, unknown> | null> {
  const { rows } = await db.query(
    `UPDATE ob_session_lanes
        SET agent = COALESCE(agent, $4),
            source = COALESCE(source, $5),
            metadata = CASE
              WHEN $6::text IS NULL OR metadata->>'server_id' IS NOT NULL THEN metadata
              ELSE jsonb_set(metadata, '{server_id}', to_jsonb($6::text), true)
            END,
            channel_id = COALESCE(channel_id, $7),
            thread_id = COALESCE(thread_id, $8)
      WHERE id = $1
        AND namespace = $2
        AND session_key = $3
        AND ($4::text IS NULL OR agent IS NULL OR agent = $4)
        AND ($5::text IS NULL OR source IS NULL OR source = $5)
        AND ($6::text IS NULL OR metadata->>'server_id' IS NULL OR metadata->>'server_id' = $6)
        AND ($7::text IS NULL OR channel_id IS NULL OR channel_id = $7)
        AND (
          $9::boolean = false
          OR thread_id IS NOT DISTINCT FROM $8::text
          OR NOT (
            agent IS NOT NULL
            AND source IS NOT NULL
            AND metadata->>'server_id' IS NOT NULL
            AND channel_id IS NOT NULL
          )
        )
    RETURNING ${laneColumns}`,
    [
      lane.id,
      args.namespace,
      args.session_key,
      args.agent ?? null,
      args.platform ?? null,
      args.server_id ?? null,
      args.channel_id ?? null,
      args.thread_id ?? null,
      args.thread_id !== undefined,
    ],
  );
  return (rows[0] as Record<string, unknown> | undefined) ?? null;
}

async function ensureLaneForAppend(
  db: Queryable,
  deps: ToolDeps,
  args: {
    session_key: string;
    namespace: string;
    create_if_missing?: boolean;
    agent?: string;
    platform?: string;
    server_id?: string;
    channel_id?: string;
    thread_id?: string | null;
    project?: string;
    topic?: string;
    laneEmbedding?: PreparedLaneEmbedding;
  },
  auth: AuthInfo,
): Promise<
  | { ok: true; lane: Record<string, unknown>; created: boolean }
  | { ok: false; response: ReturnType<typeof appendSessionEventError> }
> {
  const laneColumns =
    "id, status, agent, source, channel_id, thread_id, metadata";
  const laneParams = [args.namespace, args.session_key];
  const { rows: laneRows } = await db.query(
    `SELECT ${laneColumns}
FROM ob_session_lanes
WHERE namespace = $1 AND session_key = $2`,
    laneParams,
  );

  let lane = laneRows[0] as Record<string, unknown> | undefined;
  let created = false;
  let attemptedCreate = false;

  if (!lane && args.create_if_missing === true) {
    attemptedCreate = true;
    const metadata =
      args.server_id === undefined ? {} : { server_id: args.server_id };
    const laneEmbedding =
      args.laneEmbedding ?? (await firstWriteLaneEmbedding(deps, args));
    const { rows: insertedRows } = await db.query(
      `INSERT INTO ob_session_lanes
  (session_key, namespace, status, agent, source, channel_id, thread_id,
   project, topic, metadata, embedding, content_hash, embedded_at,
   embedding_model, created_by)
VALUES ($1, $2, 'active', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
ON CONFLICT (namespace, session_key) DO NOTHING
RETURNING ${laneColumns}`,
      [
        args.session_key,
        args.namespace,
        args.agent ?? null,
        args.platform ?? null,
        args.channel_id ?? null,
        args.thread_id ?? null,
        args.project ?? null,
        args.topic ?? null,
        JSON.stringify(metadata),
        laneEmbedding.embeddingVal,
        laneEmbedding.contentHashValue,
        laneEmbedding.embeddedAt,
        laneEmbedding.model,
        auth.clientId,
      ],
    );
    if (insertedRows.length > 0) {
      lane = insertedRows[0] as Record<string, unknown>;
      created = true;
    } else {
      const { rows: racedRows } = await db.query(
        `SELECT ${laneColumns}
FROM ob_session_lanes
WHERE namespace = $1 AND session_key = $2`,
        laneParams,
      );
      lane = racedRows[0] as Record<string, unknown> | undefined;
    }
  }

  if (!lane) {
    logger.info("append_session_event_lane_not_found", {
      session_key: args.session_key,
      namespace: args.namespace,
      create_if_missing: args.create_if_missing === true,
    });
    if (attemptedCreate) {
      return {
        ok: false,
        response: appendSessionEventError(
          "conflict_retry",
          "Lane creation raced but the lane was not visible after retry lookup",
          true,
          {
            session_key: args.session_key,
            namespace: args.namespace,
          },
        ),
      };
    }
    return {
      ok: false,
      response: appendSessionEventError(
        "scope_validation",
        `Lane not found for session_key "${args.session_key}" in namespace "${args.namespace}"`,
        false,
        {
          session_key: args.session_key,
          namespace: args.namespace,
          remedy:
            "Call session_start first or retry append_session_event with create_if_missing=true.",
        },
      ),
    };
  }

  let conflicts = scopeConflicts(lane, args);
  if (conflicts.length > 0) {
    return {
      ok: false,
      response: appendSessionEventError(
        "scope_validation",
        "Existing lane scope does not match requested append scope",
        false,
        {
          session_key: args.session_key,
          namespace: args.namespace,
          conflicts,
        },
      ),
    };
  }

  if (!created && hasUnassertedScope(lane, args)) {
    const attached = await attachUnassertedScope(
      db,
      lane,
      args,
      laneColumns,
    );
    if (attached) {
      lane = attached;
    } else {
      const { rows: currentRows } = await db.query(
        `SELECT ${laneColumns}
FROM ob_session_lanes
WHERE namespace = $1 AND session_key = $2`,
        laneParams,
      );
      const current = currentRows[0] as Record<string, unknown> | undefined;
      conflicts = current ? scopeConflicts(current, args) : [];
      if (!current || conflicts.length > 0) {
        return {
          ok: false,
          response: appendSessionEventError(
            "scope_validation",
            "Existing lane scope changed before requested append scope could attach",
            false,
            {
              session_key: args.session_key,
              namespace: args.namespace,
              conflicts,
            },
          ),
        };
      }
      lane = current;
    }
  }

  return { ok: true, lane, created };
}

/**
 * Hybrid-timing sync gate for the share_candidate nomination (Issue #161, Q1).
 *
 * An agent nominates an event for shared-kb promotion by setting
 * `metadata.share_candidate = true` on this write. The full worthiness +
 * dedup + promote adjudication is ASYNC (the promoter cron). But the ONE check
 * we must run synchronously is the cheap, security-critical one: a secret or
 * person-private nomination must never even enter the promotion queue.
 *
 * `classifyShareCandidate` is pure (no DB, no embedding) so it is safe on the
 * write path. We only act on its hard-reject decisions here; worthiness/noise
 * stays for the async adjudicator. On a hard reject we STRIP the nomination
 * flag (the event itself still persists — it is the agent's lane journal) and
 * report it, so the cron never sees a secret/private candidate.
 *
 * Returns the metadata to persist (nomination stripped if rejected) and the
 * sync decision to surface back to the agent, or null when no nomination was
 * present.
 */
function adjudicateNominationSync(
  eventType: string,
  importance: string,
  content: string,
  metadata: Record<string, unknown>,
  resubmitAttempt?: number,
  resubmitBlockedReason?: ShareRejectionDetail["resubmit_blocked_reason"],
): {
  metadata: Record<string, unknown>;
  rejected: "reject-secret" | "reject-private" | null;
  rejectDetail: ShareRejectionDetail | null;
} {
  // Match the async promoter's truthiness exactly: its SQL nominates on
  // `metadata->>'share_candidate' = 'true'`, which matches both a JSON boolean
  // true and the string "true". If the sync gate only accepted boolean true, a
  // mistyped string nomination would skip the inline secret/private check yet
  // still be swept async — voiding this gate's guarantee. Accept both.
  const nominated =
    metadata.share_candidate === true || metadata.share_candidate === "true";
  if (!nominated) {
    return { metadata, rejected: null, rejectDetail: null };
  }
  const rejectDetail = shareRejectionDetail(
    {
      event_type: eventType,
      importance,
      content,
      metadata,
    },
    {
      resubmit_attempt: resubmitAttempt,
      resubmit_blocked_reason: resubmitBlockedReason,
    },
  );
  const decision = classifyShareCandidate({
    event_type: eventType,
    importance,
    content,
    metadata,
  });
  if (decision === "reject-secret" || decision === "reject-private") {
    // Strip nomination/candidate metadata so the async promoter never sweeps it
    // and persisted metadata does not violate lifecycle invariants. Stamp a
    // marker for auditability; the event content itself is untouched.
    const {
      share_candidate: _dropShareCandidate,
      memory_lifecycle_action: _dropLifecycleAction,
      candidate_type: _dropCandidateType,
      candidate_reason: _dropCandidateReason,
      candidate_confidence: _dropCandidateConfidence,
      candidate_scope: _dropCandidateScope,
      candidate_staleness_policy: _dropCandidateStalenessPolicy,
      evidence_refs: _dropEvidenceRefs,
      ...rest
    } = metadata;
    return {
      metadata: { ...rest, share_rejected_sync: decision },
      rejected: decision,
      rejectDetail,
    };
  }
  return { metadata, rejected: null, rejectDetail: null };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function hasShareCandidate(metadata: Record<string, unknown>): boolean {
  return (
    metadata.share_candidate === true || metadata.share_candidate === "true"
  );
}

function validateMemoryLifecycleMetadata(
  metadata: Record<string, unknown>,
): string | null {
  const action = metadata.memory_lifecycle_action;
  if (action === undefined) return null;
  if (typeof action !== "string" || !MEMORY_LIFECYCLE_ACTIONS.has(action)) {
    return "metadata.memory_lifecycle_action is not a supported lifecycle action";
  }

  const shareCandidate = hasShareCandidate(metadata);
  if (shareCandidate && action !== "nominate_shared") {
    return "metadata.share_candidate=true is only valid with memory_lifecycle_action=nominate_shared";
  }
  if (action === "nominate_shared" && !shareCandidate) {
    return "metadata.memory_lifecycle_action=nominate_shared requires share_candidate=true";
  }
  if (
    typeof metadata.candidate_type !== "string" ||
    !CANDIDATE_TYPES.has(metadata.candidate_type)
  ) {
    return "metadata.candidate_type is required for memory lifecycle actions";
  }
  if (
    typeof metadata.candidate_reason !== "string" ||
    metadata.candidate_reason.trim().length === 0 ||
    metadata.candidate_reason.length > 2000
  ) {
    return "metadata.candidate_reason is required for memory lifecycle actions";
  }
  if (
    metadata.candidate_confidence !== undefined &&
    (typeof metadata.candidate_confidence !== "number" ||
      !Number.isFinite(metadata.candidate_confidence) ||
      metadata.candidate_confidence < 0 ||
      metadata.candidate_confidence > 1)
  ) {
    return "metadata.candidate_confidence must be a number from 0 to 1";
  }
  if (
    metadata.candidate_scope !== undefined &&
    !isRecord(metadata.candidate_scope)
  ) {
    return "metadata.candidate_scope must be an object";
  }
  if (
    metadata.candidate_staleness_policy !== undefined &&
    (typeof metadata.candidate_staleness_policy !== "string" ||
      metadata.candidate_staleness_policy.length > 1000)
  ) {
    return "metadata.candidate_staleness_policy must be a string of at most 1000 characters";
  }
  if (metadata.evidence_refs !== undefined) {
    if (!Array.isArray(metadata.evidence_refs)) {
      return "metadata.evidence_refs must be an array";
    }
    if (metadata.evidence_refs.length > 20) {
      return "metadata.evidence_refs must contain at most 20 items";
    }
    if (metadata.evidence_refs.some((item) => !isRecord(item))) {
      return "metadata.evidence_refs items must be objects";
    }
    let totalEvidenceBytes = 0;
    for (const item of metadata.evidence_refs) {
      const serialized = JSON.stringify(item);
      totalEvidenceBytes += Buffer.byteLength(serialized, "utf8");
      if (Buffer.byteLength(serialized, "utf8") > 2000) {
        return "metadata.evidence_refs items must be at most 2000 JSON bytes";
      }
      if (containsSecret(serialized)) {
        return "metadata.evidence_refs must not contain secrets";
      }
    }
    if (totalEvidenceBytes > 10000) {
      return "metadata.evidence_refs must be at most 10000 total JSON bytes";
    }
  }
  return null;
}

function sanitizedResubmitOf(metadata: Record<string, unknown>): string | null {
  const raw = metadata.sanitized_resubmit_of;
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function requestedResubmitAttempt(metadata: Record<string, unknown>): number {
  const raw = metadata.sanitized_resubmit_attempt;
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0) return 0;
  return raw;
}

async function effectiveResubmitState(
  db: Queryable,
  laneId: string,
  metadata: Record<string, unknown>,
): Promise<{
  attempt: number;
  blockedReason?: ShareRejectionDetail["resubmit_blocked_reason"];
}> {
  const resubmitOf = sanitizedResubmitOf(metadata);
  const requested = requestedResubmitAttempt(metadata);
  if (!resubmitOf) {
    const { rows } = await db.query(
      `SELECT COUNT(*)::int AS rejected_count
         FROM ob_session_events
        WHERE lane_id = $1
          AND metadata->>'sanitized_resubmit_of' IS NULL
          AND metadata->>'share_rejected_sync' IN ('reject-secret', 'reject-private')`,
      [laneId],
    );
    const rawCount = rows[0]?.rejected_count;
    const priorRejected =
      typeof rawCount === "number"
        ? rawCount
        : Number.parseInt(String(rawCount ?? "0"), 10);
    const observedAttempt = Number.isFinite(priorRejected) ? priorRejected : 0;
    return { attempt: Math.max(requested, observedAttempt) };
  }

  const { rows } = await db.query(
    `SELECT
        (
          SELECT COUNT(*)::int
            FROM ob_session_events
           WHERE lane_id = $1
             AND id::text = $2
             AND metadata->>'sanitized_resubmit_of' IS NULL
             AND metadata->>'share_rejected_sync' IN ('reject-secret', 'reject-private')
        ) AS root_rejected_count,
        (
          SELECT COUNT(*)::int
            FROM ob_session_events
           WHERE lane_id = $1
             AND metadata->>'sanitized_resubmit_of' = $2
             AND metadata->>'share_rejected_sync' IN ('reject-secret', 'reject-private')
        ) AS rejected_count`,
    [laneId, resubmitOf],
  );
  const rawRootCount = rows[0]?.root_rejected_count;
  const rootRejected =
    typeof rawRootCount === "number"
      ? rawRootCount
      : Number.parseInt(String(rawRootCount ?? "0"), 10);
  if (!Number.isFinite(rootRejected) || rootRejected < 1) {
    return {
      attempt: Math.max(requested, SHARE_REJECTION_MAX_RESUBMIT_ATTEMPTS),
      blockedReason: "invalid_resubmit_root",
    };
  }
  const rawCount = rows[0]?.rejected_count;
  const priorRejected =
    typeof rawCount === "number"
      ? rawCount
      : Number.parseInt(String(rawCount ?? "0"), 10);
  const observedAttempt = Number.isFinite(priorRejected)
    ? priorRejected + 1
    : 1;
  return { attempt: Math.max(requested, observedAttempt) };
}

function attachResubmitTarget(
  detail: ShareRejectionDetail,
  eventId: string,
  metadata: Record<string, unknown>,
): ShareRejectionDetail & {
  resubmit_metadata?: {
    sanitized_resubmit_of: string;
    sanitized_resubmit_attempt: number;
  };
} {
  if (!detail.resubmittable) {
    return { ...detail };
  }
  return {
    ...detail,
    resubmit_metadata: {
      sanitized_resubmit_of: sanitizedResubmitOf(metadata) ?? eventId,
      sanitized_resubmit_attempt: detail.resubmit_attempt + 1,
    },
  };
}

function writerProvenance(auth: AuthInfo): {
  writer_identity: string;
  token_identity: string;
  delegated_agent_id: string | null;
  namespace_source: "token" | "header";
} {
  const namespaceSource = auth.namespaceSource ?? "token";
  return {
    writer_identity: auth.clientId,
    token_identity: auth.tokenClientId ?? auth.clientId,
    delegated_agent_id:
      namespaceSource === "header" ? (auth.agentId ?? null) : null,
    namespace_source: namespaceSource,
  };
}

function appendWriterProvenance(
  metadata: Record<string, unknown>,
  auth: AuthInfo,
): Record<string, unknown> {
  const { _openbrain: callerOpenBrainMetadata, ...rest } = metadata;
  const provenance = writerProvenance(auth);
  return {
    ...rest,
    ...(callerOpenBrainMetadata === undefined
      ? {}
      : { _caller_openbrain_metadata: callerOpenBrainMetadata }),
    // The public metadata limit applies to caller input. OpenBrain adds this
    // small bounded block after validation so later readback can audit writer
    // provenance without trusting caller-supplied metadata.
    _openbrain: {
      writer: {
        client_id: provenance.writer_identity,
        token_client_id: provenance.token_identity,
        agent_id: provenance.delegated_agent_id,
        namespace_source: provenance.namespace_source,
      },
    },
  };
}

function transcriptCitationValidationError(args: {
  transcript_ref?: string;
  transcript?: string;
  occurred_at?: string;
}): string | undefined {
  const citationPayloadSupplied =
    args.transcript !== undefined || args.occurred_at !== undefined;
  if (!args.transcript_ref && citationPayloadSupplied) {
    return "transcript_ref is required when transcript or occurred_at is supplied";
  }
  if (!args.transcript_ref) return undefined;
  if (
    !/^collab\/[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/.test(
      args.transcript_ref,
    )
  ) {
    return "transcript_ref must use canonical host-neutral collab/... path segments";
  }
  return undefined;
}

export function registerAppendSessionEvent(
  server: McpServer,
  deps: ToolDeps,
): void {
  server.registerTool(
    "append_session_event",
    {
      description:
        "Append an event to a session lane's journal. Events are append-only " +
        "and capture discrete facts, decisions, blockers, actions, etc. " +
        "create_if_missing can create the scoped lane on first write. For an " +
        "existing legacy lane, supplied exact-scope coordinates atomically fill " +
        "only previously unasserted values; asserted conflicts fail closed.",
      inputSchema: {
        session_key: z
          .string()
          .min(1)
          .max(500)
          .describe(
            "Session key identifying the lane to append to (looked up by namespace + session_key)",
          ),
        namespace: z
          .string()
          .max(500)
          .optional()
          .describe("Namespace for isolation (defaults to agent's clientId)"),
        create_if_missing: z
          .boolean()
          .optional()
          .describe(
            "Create the session lane when missing, then append the event. " +
              "Use for first-write realtime agent scopes; repeated calls are idempotent.",
          ),
        agent: z
          .string()
          .max(500)
          .optional()
          .describe(
            "Agent identity for first-write lane creation and scope checks",
          ),
        platform: z
          .string()
          .max(500)
          .optional()
          .describe(
            "Platform/source identity for first-write lane creation, such as discord",
          ),
        server_id: z
          .string()
          .max(500)
          .optional()
          .describe("Server/guild identity for exact realtime lane scope"),
        channel_id: z
          .string()
          .max(500)
          .optional()
          .describe("Channel identity for exact realtime lane scope"),
        thread_id: z
          .string()
          .max(500)
          .optional()
          .describe("Thread identity for exact realtime lane scope"),
        project: z
          .string()
          .max(500)
          .optional()
          .describe("Project name to set when first-write creates the lane"),
        topic: z
          .string()
          .max(500)
          .optional()
          .describe(
            "Human-readable lane topic to set when first-write creates the lane",
          ),
        event_type: z
          .enum(EVENT_TYPES)
          .describe(
            "Type of event: fact, decision, blocker, action, artifact, receipt, question, correction, handoff",
          ),
        content: z
          .string()
          .min(1)
          .max(50_000)
          .describe("Event content — what happened"),
        source: z
          .string()
          .max(500)
          .optional()
          .describe("Source of the event (agent name, tool, user, etc.)"),
        artifact_path: z
          .string()
          .max(2000)
          .optional()
          .describe("Path to related artifact (file, URL, etc.)"),
        transcript_ref: z
          .string()
          .trim()
          .min(1)
          .max(2000)
          .optional()
          .describe(
            "Host-neutral source conversation reference (collab/...); never use /Volumes or /mnt paths",
          ),
        transcript: z
          .string()
          .max(50_000)
          .optional()
          .describe("Optional inline source exchange captured with the event"),
        occurred_at: z
          .string()
          .datetime({ offset: true })
          .optional()
          .describe(
            "When the cited exchange occurred (ISO 8601 with timezone)",
          ),
        importance: z
          .enum(IMPORTANCE_LEVELS)
          .optional()
          .describe("Event importance: hot, warm (default), cold"),
        metadata: z
          .record(z.string().max(100), z.unknown())
          .optional()
          .refine(
            (v) =>
              !v ||
              (Object.keys(v).length <= 50 &&
                JSON.stringify(v).length <= 100_000),
            { message: "metadata: max 50 keys, max 100KB total" },
          )
          .describe("Arbitrary JSON metadata; max 50 keys, max 100KB total"),
      },
      annotations: {
        title: "Append Session Event",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async (args, extra) => {
      const auth = extra.authInfo as AuthInfo | undefined;

      // Auth gate
      if (!auth || !canWrite(auth.role, "sessions")) {
        logger.warn("append_session_event_denied", {
          role: auth?.role ?? "none",
          clientId: auth?.clientId ?? "none",
          session_key: args.session_key,
        });
        return appendSessionEventError(
          "auth_denied",
          "Permission denied: cannot write to session events",
          false,
        );
      }

      const ns = args.namespace ?? auth.clientId;
      const nsCheck = canWriteNamespace(auth, ns);
      if (!nsCheck.allowed) {
        return appendSessionEventError(
          "auth_denied",
          `Permission denied: ${nsCheck.reason}`,
          false,
          { namespace: ns },
        );
      }
      const importance = args.importance ?? "warm";
      const provenance = writerProvenance(auth);
      const lifecycleError = validateMemoryLifecycleMetadata(
        args.metadata ?? {},
      );
      if (lifecycleError) {
        return appendSessionEventError(
          "scope_validation",
          lifecycleError,
          false,
          { session_key: args.session_key, namespace: ns },
        );
      }
      const citationError = transcriptCitationValidationError(args);
      if (citationError) {
        return appendSessionEventError(
          "scope_validation",
          citationError,
          false,
          {
            session_key: args.session_key,
            namespace: ns,
          },
        );
      }
      if (args.transcript !== undefined && containsSecret(args.transcript)) {
        return appendSessionEventError(
          "scope_validation",
          "transcript must not contain credential-like material",
          false,
          { session_key: args.session_key, namespace: ns },
        );
      }

      logger.debug("append_session_event_start", {
        session_key: args.session_key,
        namespace: ns,
        event_type: args.event_type,
        importance,
        clientId: auth.clientId,
        content_length: args.content.length,
      });

      try {
        const requestedThreadId =
          args.channel_id !== undefined ? (args.thread_id ?? null) : args.thread_id;
        const transactionalAppend =
          args.create_if_missing === true ||
          args.agent !== undefined ||
          args.platform !== undefined ||
          args.server_id !== undefined ||
          args.channel_id !== undefined ||
          requestedThreadId !== undefined;
        let acceptedLaneForEmbedding: string | null = null;
        let acceptedEventForEmbedding: string | null = null;

        const response = await withAppendDb(
          deps,
          transactionalAppend,
          async (db) => {
            const laneResult = await ensureLaneForAppend(
              db,
              deps,
              {
                session_key: args.session_key,
                namespace: ns,
                create_if_missing: args.create_if_missing,
                agent: args.agent,
                platform: args.platform,
                server_id: args.server_id,
                channel_id: args.channel_id,
                thread_id: requestedThreadId,
                project: args.project,
                topic: args.topic,
                laneEmbedding: transactionalAppend
                  ? firstWriteLaneHashOnly(args)
                  : undefined,
              },
              auth,
            );
            if (!laneResult.ok) {
              return laneResult.response;
            }

            if (laneResult.lane.status === "archived") {
              return appendSessionEventError(
                "unsupported_operation",
                `Lane "${args.session_key}" is archived; reactivate before appending events`,
                false,
                { session_key: args.session_key, namespace: ns },
              );
            }

            const laneId = String(laneResult.lane.id);
            if (transactionalAppend && laneResult.created) {
              acceptedLaneForEmbedding = laneId;
            }

            // Hybrid sync gate: a share_candidate nomination carrying a secret or
            // person-private content is rejected inline (cheap, no embedding) and
            // its nomination stripped before persist, so the async promoter never
            // sees it. Worthiness/dedup/promote remain async.
            let nomination = adjudicateNominationSync(
              args.event_type,
              importance,
              args.content,
              args.metadata ?? {},
            );
            if (nomination.rejected) {
              const resubmit = await effectiveResubmitState(
                db,
                laneId,
                args.metadata ?? {},
              );
              nomination = adjudicateNominationSync(
                args.event_type,
                importance,
                args.content,
                args.metadata ?? {},
                resubmit.attempt,
                resubmit.blockedReason,
              );
            }
            const metadata = appendWriterProvenance(nomination.metadata, auth);
            if (nomination.rejected) {
              logger.warn("append_session_event_share_rejected", {
                session_key: args.session_key,
                namespace: ns,
                decision: nomination.rejected,
                matched_kind: nomination.rejectDetail?.matched_kind,
                span_count: nomination.rejectDetail?.span_count,
                resubmittable: nomination.rejectDetail?.resubmittable,
                clientId: auth.clientId,
              });
            }

            const eventEmbedding: PreparedEventEmbedding = transactionalAppend
              ? {
                  embeddingVal: null,
                  contentHashValue: contentHash(args.content),
                  embeddedAt: null,
                  model: null,
                }
              : await appendEventEmbedding(deps, args);

            const { rows } = await db.query(
              `INSERT INTO ob_session_events
             (lane_id, event_type, content, source, artifact_path, transcript_ref,
              transcript, occurred_at, importance, metadata, embedding, content_hash,
              embedded_at, embedding_model, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
           ON CONFLICT (lane_id, content_hash) WHERE content_hash IS NOT NULL DO NOTHING
           RETURNING id, created_at`,
              [
                laneId,
                args.event_type,
                args.content,
                args.source ?? null,
                args.artifact_path ?? null,
                args.transcript_ref ?? null,
                args.transcript ?? null,
                args.occurred_at ?? null,
                importance,
                JSON.stringify(metadata),
                eventEmbedding.embeddingVal,
                eventEmbedding.contentHashValue,
                eventEmbedding.embeddedAt,
                eventEmbedding.model,
                auth.clientId,
              ],
            );

            if (rows.length === 0) {
              const citationSupplied =
                args.transcript_ref !== undefined ||
                args.transcript !== undefined ||
                args.occurred_at !== undefined;
              if (citationSupplied) {
                const { rows: existingRows } = await db.query<{
                  id: string;
                  citation_matches: boolean;
                }>(
                  `SELECT id,
                    transcript_ref IS NOT DISTINCT FROM $3::text
                    AND transcript IS NOT DISTINCT FROM $4::text
                    AND occurred_at IS NOT DISTINCT FROM $5::timestamptz
                      AS citation_matches
FROM ob_session_events
WHERE lane_id = $1 AND content_hash = $2`,
                  [
                    laneId,
                    eventEmbedding.contentHashValue,
                    args.transcript_ref ?? null,
                    args.transcript ?? null,
                    args.occurred_at ?? null,
                  ],
                );
                const existing = existingRows[0];
                if (!existing || !existing.citation_matches) {
                  return appendSessionEventError(
                    "citation_not_stored",
                    "Duplicate content exists but the supplied citation was not stored",
                    false,
                    {
                      duplicate: true,
                      existing_event_id: existing?.id ?? null,
                      ...provenance,
                    },
                  );
                }
              }
              return {
                content: [
                  {
                    type: "text" as const,
                    text: JSON.stringify({
                      duplicate: true,
                      message:
                        "Event with identical content already exists in this lane",
                      ...provenance,
                    }),
                  },
                ],
              };
            }

            const result = {
              event_id: rows[0].id,
              lane_id: laneId,
              lane_created: laneResult.created,
              event_type: args.event_type,
              importance,
              created_at: rows[0].created_at,
              transcript_ref: args.transcript_ref ?? null,
              ...provenance,
              // Surface the sync nomination outcome so a contract-driven agent
              // learns its share_candidate was refused (and why) without polling.
              ...(nomination.rejected
                ? {
                    share_candidate_rejected: nomination.rejected,
                    ...(nomination.rejectDetail
                      ? {
                          reject_detail: attachResubmitTarget(
                            nomination.rejectDetail,
                            rows[0].id,
                            nomination.metadata,
                          ),
                        }
                      : {}),
                  }
                : {}),
            };
            if (transactionalAppend) {
              acceptedEventForEmbedding = String(result.event_id);
            }

            logger.info("append_session_event_ok", {
              event_id: result.event_id,
              lane_id: result.lane_id,
              event_type: result.event_type,
              importance: result.importance,
            });

            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify(result),
                },
              ],
            };
          },
        );

        if (acceptedLaneForEmbedding) {
          await fillAcceptedLaneEmbedding(deps, acceptedLaneForEmbedding, args);
        }
        if (acceptedEventForEmbedding) {
          await fillAcceptedEventEmbedding(
            deps,
            acceptedEventForEmbedding,
            args,
          );
        }

        return response;
      } catch (err) {
        logger.error("append_session_event_db_error", {
          session_key: args.session_key,
          namespace: ns,
          error: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack : undefined,
        });
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                error: "retryable_outage",
                message: `Database error during event append: ${err instanceof Error ? err.message : String(err)}`,
                retryable: true,
                session_key: args.session_key,
                namespace: ns,
              }),
            },
          ],
          isError: true,
        };
      }
    },
  );
}
