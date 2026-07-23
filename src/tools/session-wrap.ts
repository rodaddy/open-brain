import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type pg from "pg";
import { toSql } from "pgvector/pg";
import { canWrite } from "../permissions.ts";
import { canWriteNamespace } from "../namespace-policy.ts";
import { contentHash, EMBEDDING_MODEL } from "../embedding.ts";
import {
  sessionEmbedText,
  sessionSourceHashInput,
} from "../embedding-canonical.ts";
import type { AuthInfo } from "../types.ts";
import { logger } from "../logger.ts";
import { sourceRefsSchema } from "../source-refs.ts";
import type { ToolDeps } from "./index.ts";

type Queryable = Pick<pg.Pool | pg.PoolClient, "query">;
type WrapScope = {
  agent?: string;
  platform?: string;
  server_id?: string;
  channel_id?: string;
  thread_id?: string;
};

async function withWrapDb<T>(
  deps: ToolDeps,
  fn: (db: Queryable) => Promise<T>,
): Promise<T> {
  if (typeof deps.pool.connect !== "function") return fn(deps.pool);
  const client = await deps.pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      logger.warn("session_wrap_rollback_failed", {
        error:
          rollbackError instanceof Error
            ? rollbackError.message
            : String(rollbackError),
      });
    }
    throw error;
  } finally {
    client.release();
  }
}

function hasCompleteExactScope(
  args: WrapScope,
): args is Required<Omit<WrapScope, "thread_id">> & { thread_id?: string } {
  return (
    args.agent !== undefined &&
    args.platform !== undefined &&
    args.server_id !== undefined &&
    args.channel_id !== undefined
  );
}

function scopeConflicts(
  lane: Record<string, unknown>,
  args: WrapScope,
): string[] {
  const metadata =
    lane.metadata && typeof lane.metadata === "object"
      ? (lane.metadata as Record<string, unknown>)
      : {};
  const completeStoredScope =
    lane.agent != null &&
    lane.source != null &&
    metadata.server_id != null &&
    lane.channel_id != null;
  const requestedThreadId =
    args.channel_id !== undefined ? (args.thread_id ?? null) : args.thread_id;
  const checks: Array<[string, unknown, unknown]> = [
    ["agent", lane.agent, args.agent],
    ["platform", lane.source, args.platform],
    ["server_id", metadata.server_id, args.server_id],
    ["channel_id", lane.channel_id, args.channel_id],
    ["thread_id", lane.thread_id, requestedThreadId],
  ];
  const conflicts: string[] = [];
  for (const [name, stored, requested] of checks) {
    if (requested === undefined) continue;
    if (stored == null) {
      if (name === "thread_id" && completeStoredScope && requested !== null) {
        conflicts.push(name);
      }
      continue;
    }
    if (stored !== requested) conflicts.push(name);
  }
  return conflicts;
}

async function loadAndEstablishWrapLane(
  db: Queryable,
  namespace: string,
  sessionKey: string,
  args: WrapScope,
): Promise<
  | { lane: Record<string, unknown>; conflicts: [] }
  | { lane: null; conflicts: [] }
  | { lane: Record<string, unknown>; conflicts: string[] }
> {
  const laneColumns =
    "id, status, project, agent, source, channel_id, thread_id, metadata, topic";
  const { rows: laneRows } = await db.query(
    `SELECT ${laneColumns}
       FROM ob_session_lanes
      WHERE namespace = $1 AND session_key = $2
      FOR UPDATE`,
    [namespace, sessionKey],
  );
  const lane = laneRows[0] as Record<string, unknown> | undefined;
  if (!lane) return { lane: null, conflicts: [] };

  const conflicts = scopeConflicts(lane, args);
  if (conflicts.length > 0) return { lane, conflicts };
  if (!hasCompleteExactScope(args)) return { lane, conflicts: [] };

  const requestedThreadId = args.thread_id ?? null;
  const { rows: scopedRows } = await db.query(
    `UPDATE ob_session_lanes
        SET agent = COALESCE(agent, $4),
            source = COALESCE(source, $5),
            metadata = CASE
              WHEN metadata->>'server_id' IS NOT NULL THEN metadata
              ELSE jsonb_set(metadata, '{server_id}', to_jsonb($6::text), true)
            END,
            channel_id = COALESCE(channel_id, $7),
            thread_id = CASE
              WHEN $8::text IS NOT NULL AND thread_id IS NULL THEN $8
              ELSE thread_id
            END
      WHERE id = $1
        AND namespace = $2
        AND session_key = $3
        AND (agent IS NULL OR agent = $4)
        AND (source IS NULL OR source = $5)
        AND (metadata->>'server_id' IS NULL OR metadata->>'server_id' = $6)
        AND (channel_id IS NULL OR channel_id = $7)
        AND (
          ($8::text IS NULL AND thread_id IS NULL)
          OR (
            $8::text IS NOT NULL
            AND (
              thread_id = $8
              OR (
                thread_id IS NULL
                AND NOT (
                  agent IS NOT NULL
                  AND source IS NOT NULL
                  AND metadata->>'server_id' IS NOT NULL
                  AND channel_id IS NOT NULL
                )
              )
            )
          )
        )
    RETURNING ${laneColumns}`,
    [
      lane.id,
      namespace,
      sessionKey,
      args.agent,
      args.platform,
      args.server_id,
      args.channel_id,
      requestedThreadId,
    ],
  );
  const scopedLane = scopedRows[0] as Record<string, unknown> | undefined;
  return scopedLane
    ? { lane: scopedLane, conflicts: [] }
    : { lane, conflicts: scopeConflicts(lane, args) };
}

export function registerSessionWrap(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "session_wrap",
    {
      description:
        "Checkpoint a session lane by persisting a summary to durable OB storage. " +
        "Lane stays active — wrap is a checkpoint, not an ending. " +
        "The caller distills the summary from events before calling this.",
      inputSchema: {
        session_key: z
          .string()
          .min(1)
          .max(500)
          .describe("Session key identifying the lane to wrap"),
        namespace: z
          .string()
          .max(500)
          .optional()
          .describe("Namespace for isolation (defaults to agent's clientId)"),
        agent: z
          .string()
          .max(500)
          .optional()
          .describe("Agent identity for exact-scope checkpoint validation"),
        platform: z
          .string()
          .max(500)
          .optional()
          .describe(
            "Platform/source identity for exact-scope checkpoint validation",
          ),
        server_id: z
          .string()
          .max(500)
          .optional()
          .describe(
            "Server/guild/workspace identity for exact-scope validation",
          ),
        channel_id: z
          .string()
          .max(500)
          .optional()
          .describe("Channel identity for exact-scope checkpoint validation"),
        thread_id: z
          .string()
          .max(500)
          .optional()
          .describe(
            "Thread identity; omission with channel_id asserts unthreaded scope",
          ),
        summary: z
          .string()
          .min(1)
          .max(100_000)
          .describe("The distilled session summary"),
        key_decisions: z
          .array(z.string().max(2000))
          .max(20)
          .optional()
          .describe("Key decisions made during this session"),
        next_steps: z
          .array(z.string().max(2000))
          .max(20)
          .optional()
          .describe("Planned next steps"),
        project: z
          .string()
          .max(500)
          .optional()
          .describe("Project name for the session record"),
        source_refs: sourceRefsSchema
          .optional()
          .describe(
            "Structured file/document refs for closed-brain provenance",
          ),
      },
      annotations: {
        title: "Session Wrap",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
      },
    },
    async (args, extra) => {
      const auth = extra.authInfo as AuthInfo | undefined;
      if (!auth || !canWrite(auth.role, "sessions")) {
        logger.warn("session_wrap_denied", {
          role: auth?.role ?? "none",
          clientId: auth?.clientId ?? "none",
          session_key: args.session_key,
        });
        return {
          content: [
            {
              type: "text" as const,
              text: "Permission denied: cannot write to sessions",
            },
          ],
          isError: true,
        };
      }

      const ns = args.namespace ?? auth.clientId;
      const nsCheck = canWriteNamespace(auth, ns);
      if (!nsCheck.allowed) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Permission denied: ${nsCheck.reason}`,
            },
          ],
          isError: true,
        };
      }

      logger.debug("session_wrap_begin", {
        session_key: args.session_key,
        namespace: ns,
        summary_length: args.summary.length,
        clientId: auth.clientId,
      });

      let embedding: number[] | null = null;
      try {
        // Embed the canonical session text (summary + key_decisions/next_steps),
        // matching session_save / REST via sessionEmbedText(). Historically this
        // path embedded the summary alone, which diverged from the other session
        // writers and from the repair registry; converge on the shared builder.
        // session_wrap has no `blockers` field, so that segment is simply absent.
        embedding = await deps.embedFn(sessionEmbedText(args));
      } catch (error) {
        logger.warn("session_wrap_embed_error", {
          session_key: args.session_key,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      const embeddingVal = embedding ? toSql(embedding) : null;
      const embeddedAt = embedding ? new Date().toISOString() : null;
      const model = embedding ? EMBEDDING_MODEL : null;

      try {
        return await withWrapDb(deps, async (db) => {
          const laneResult = await loadAndEstablishWrapLane(
            db,
            ns,
            args.session_key,
            args,
          );
          if (!laneResult.lane) {
            logger.info("session_wrap_lane_not_found", {
              session_key: args.session_key,
              namespace: ns,
            });
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Lane not found for session_key "${args.session_key}" in namespace "${ns}"`,
                },
              ],
              isError: true,
            };
          }
          if (laneResult.conflicts.length > 0) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify({
                    error: "scope_validation",
                    message:
                      "Existing lane scope does not match session_wrap request",
                    retryable: false,
                    conflicts: laneResult.conflicts,
                  }),
                },
              ],
              isError: true,
            };
          }

          const lane = laneResult.lane;
          const { rows: countRows } = await db.query(
            "SELECT count(*)::int AS cnt FROM ob_session_events WHERE lane_id = $1",
            [lane.id],
          );
          const eventCount: number = countRows[0].cnt;
          const project = args.project ?? lane.project ?? null;
          // Shared session hash input: summary + "|" + project (the resolved
          // project, which may come from the lane). Matches the other session
          // writers and the repair registry via sessionSourceHashInput().
          const sessionHash = contentHash(
            sessionSourceHashInput({ summary: args.summary, project }),
          );
          const laneHash = contentHash(args.session_key + "|" + args.summary);

          const { rows: sessionRows } = await db.query(
            `INSERT INTO sessions
  (summary, key_decisions, next_steps, project, namespace, embedding, content_hash, embedded_at, embedding_model, created_by, source_refs)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)
ON CONFLICT (content_hash, namespace) WHERE content_hash IS NOT NULL DO NOTHING
RETURNING id, created_at, source_refs`,
            [
              args.summary,
              args.key_decisions ?? [],
              args.next_steps ?? [],
              project,
              ns,
              embeddingVal,
              sessionHash,
              embeddedAt,
              model,
              auth.clientId,
              JSON.stringify(args.source_refs ?? []),
            ],
          );

          await db.query(
            `UPDATE ob_session_lanes
                SET current_context_md = $2,
                    embedding = $3,
                    content_hash = $4,
                    embedded_at = $5,
                    embedding_model = $6
              WHERE id = $1 AND namespace = $7 AND session_key = $8`,
            [
              lane.id,
              args.summary,
              embeddingVal,
              laneHash,
              embeddedAt,
              model,
              ns,
              args.session_key,
            ],
          );

          if (sessionRows.length === 0) {
            logger.info("session_wrap_duplicate", {
              session_key: args.session_key,
              namespace: ns,
              lane_id: lane.id,
            });
            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify({
                    duplicate: true,
                    lane_id: lane.id,
                    lane_status: lane.status,
                    context_updated: true,
                    message:
                      "Session with identical content already checkpointed; duplicate source_refs are not merged",
                  }),
                },
              ],
            };
          }

          const result = {
            session_id: sessionRows[0].id,
            lane_id: lane.id,
            lane_status: lane.status,
            event_count: eventCount,
            created_at: sessionRows[0].created_at,
            source_refs: sessionRows[0].source_refs,
            context_updated: true,
          };
          logger.info("session_wrap_ok", {
            session_id: result.session_id,
            lane_id: result.lane_id,
            lane_status: result.lane_status,
            event_count: result.event_count,
          });
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(result),
              },
            ],
          };
        });
      } catch (error) {
        logger.error("session_wrap_db_error", {
          session_key: args.session_key,
          namespace: ns,
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        });
        return {
          content: [
            {
              type: "text" as const,
              text: `Database error during session wrap: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );
}
