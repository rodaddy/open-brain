import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { toSql } from "pgvector/pg";
import { canWrite } from "../permissions.ts";
import { canWriteNamespace } from "../namespace-policy.ts";
import { contentHash, EMBEDDING_MODEL } from "../embedding.ts";
import {
  classifyShareCandidate,
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
  | "conflict_retry";

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

function scopeConflicts(
  lane: Record<string, unknown>,
  args: {
    agent?: string;
    platform?: string;
    server_id?: string;
    channel_id?: string;
    thread_id?: string | null;
  },
): string[] {
  const conflicts: string[] = [];
  const metadata =
    lane.metadata && typeof lane.metadata === "object"
      ? (lane.metadata as Record<string, unknown>)
      : {};

  const checks: Array<[string, unknown, unknown]> = [
    ["agent", lane.agent, args.agent],
    ["platform", lane.source, args.platform],
    ["server_id", metadata.server_id, args.server_id],
    ["channel_id", lane.channel_id, args.channel_id],
    ["thread_id", lane.thread_id, args.thread_id],
  ];

  for (const [field, existing, requested] of checks) {
    if (requested === undefined) continue;
    // A null/absent existing value means this lane never asserted that scope
    // dimension (e.g. a lane created by session_start/lane_upsert, which do not
    // write `source` or `metadata.server_id`). Treat it as unconstrained so a
    // first scoped append attaches instead of falsely failing scope_validation.
    // Only a non-null mismatch is a real cross-scope spill.
    if (existing === null || existing === undefined) continue;
    if (existing !== requested) conflicts.push(field);
  }

  return conflicts;
}

async function ensureLaneForAppend(
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
  },
  auth: AuthInfo,
): Promise<
  | { ok: true; lane: Record<string, unknown>; created: boolean }
  | { ok: false; response: ReturnType<typeof appendSessionEventError> }
> {
  const laneColumns =
    "id, status, agent, source, channel_id, thread_id, metadata";
  const laneParams = [args.namespace, args.session_key];
  const { rows: laneRows } = await deps.pool.query(
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
    const { rows: insertedRows } = await deps.pool.query(
      `INSERT INTO ob_session_lanes
  (session_key, namespace, status, agent, source, channel_id, thread_id,
   project, topic, metadata, created_by)
VALUES ($1, $2, 'active', $3, $4, $5, $6, $7, $8, $9, $10)
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
        auth.clientId,
      ],
    );
    if (insertedRows.length > 0) {
      lane = insertedRows[0] as Record<string, unknown>;
      created = true;
    } else {
      const { rows: racedRows } = await deps.pool.query(
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
          remedy: "Call session_start first or retry append_session_event with create_if_missing=true.",
        },
      ),
    };
  }

  const conflicts = scopeConflicts(lane, args);
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
    { resubmit_attempt: resubmitAttempt },
  );
  const decision = classifyShareCandidate({
    event_type: eventType,
    importance,
    content,
    metadata,
  });
  if (decision === "reject-secret" || decision === "reject-private") {
    // Strip the nomination so the async promoter never sweeps it. Stamp a
    // marker for auditability; the event content itself is untouched.
    const { share_candidate: _drop, ...rest } = metadata;
    return {
      metadata: { ...rest, share_rejected_sync: decision },
      rejected: decision,
      rejectDetail,
    };
  }
  return { metadata, rejected: null, rejectDetail: null };
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

async function effectiveResubmitAttempt(
  deps: ToolDeps,
  laneId: string,
  metadata: Record<string, unknown>,
): Promise<number | undefined> {
  const resubmitOf = sanitizedResubmitOf(metadata);
  const requested = requestedResubmitAttempt(metadata);
  if (!resubmitOf) return requested;

  const { rows } = await deps.pool.query(
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
    return Math.max(requested, SHARE_REJECTION_MAX_RESUBMIT_ATTEMPTS);
  }
  const rawCount = rows[0]?.rejected_count;
  const priorRejected =
    typeof rawCount === "number"
      ? rawCount
      : Number.parseInt(String(rawCount ?? "0"), 10);
  const observedAttempt = Number.isFinite(priorRejected)
    ? priorRejected + 1
    : 1;
  return Math.max(requested, observedAttempt);
}

function attachResubmitTarget(
  detail: ShareRejectionDetail,
  eventId: string,
  metadata: Record<string, unknown>,
): ShareRejectionDetail & {
  resubmit_metadata: {
    sanitized_resubmit_of: string;
    sanitized_resubmit_attempt: number;
  };
} {
  return {
    ...detail,
    resubmit_metadata: {
      sanitized_resubmit_of: sanitizedResubmitOf(metadata) ?? eventId,
      sanitized_resubmit_attempt: Math.min(
        detail.resubmit_attempt + 1,
        detail.max_resubmit_attempts,
      ),
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
    delegated_agent_id: namespaceSource === "header" ? (auth.agentId ?? null) : null,
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
        "For realtime agents, create_if_missing can create the scoped lane on " +
        "first write instead of requiring manual pre-provisioning.",
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
          .describe("Agent identity for first-write lane creation and scope checks"),
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
          .describe("Human-readable lane topic to set when first-write creates the lane"),
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

      logger.debug("append_session_event_start", {
        session_key: args.session_key,
        namespace: ns,
        event_type: args.event_type,
        importance,
        clientId: auth.clientId,
        content_length: args.content.length,
      });

      try {
        const laneResult = await ensureLaneForAppend(
          deps,
          {
            session_key: args.session_key,
            namespace: ns,
            create_if_missing: args.create_if_missing,
            agent: args.agent,
            platform: args.platform,
            server_id: args.server_id,
            channel_id: args.channel_id,
            thread_id:
              args.create_if_missing === true && args.channel_id !== undefined
                ? (args.thread_id ?? null)
                : args.thread_id,
            project: args.project,
            topic: args.topic,
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

        // Hybrid sync gate: a share_candidate nomination carrying a secret or
        // person-private content is rejected inline (cheap, no embedding) and
        // its nomination stripped before persist, so the async promoter never
        // sees it. Worthiness/dedup/promote remain async.
        const nomination = adjudicateNominationSync(
          args.event_type,
          importance,
          args.content,
          args.metadata ?? {},
          await effectiveResubmitAttempt(
            deps,
            laneId,
            args.metadata ?? {},
          ),
        );
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

        // Generate embedding (non-fatal)
        let embedding: number[] | null = null;
        try {
          embedding = await deps.embedFn(args.content);
        } catch (err) {
          logger.warn("append_session_event_embed_error", {
            session_key: args.session_key,
            error: err instanceof Error ? err.message : String(err),
          });
        }

        const hash = contentHash(args.content);
        const embeddingVal = embedding ? toSql(embedding) : null;
        const embeddedAt = embedding ? new Date().toISOString() : null;
        const model = embedding ? EMBEDDING_MODEL : null;

        const { rows } = await deps.pool.query(
          `INSERT INTO ob_session_events
             (lane_id, event_type, content, source, artifact_path, importance,
              metadata, embedding, content_hash, embedded_at, embedding_model, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
           ON CONFLICT (lane_id, content_hash) WHERE content_hash IS NOT NULL DO NOTHING
           RETURNING id, created_at`,
          [
            laneId,
            args.event_type,
            args.content,
            args.source ?? null,
            args.artifact_path ?? null,
            importance,
            JSON.stringify(metadata),
            embeddingVal,
            hash,
            embeddedAt,
            model,
            auth.clientId,
          ],
        );

        if (rows.length === 0) {
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
