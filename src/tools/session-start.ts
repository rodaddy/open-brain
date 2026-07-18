import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { canWrite } from "../permissions.ts";
import { canWriteNamespace } from "../namespace-policy.ts";
import type { AuthInfo } from "../types.ts";
import { logger } from "../logger.ts";
import type { ToolDeps } from "./index.ts";

const LANE_COLUMNS = `id, session_key, namespace, status, agent, source, channel_id,
  thread_id, project, topic, current_context_md, metadata, created_at, updated_at, ended_at`;

const EVENT_COLUMNS = `id, event_type, content, source, artifact_path,
  transcript_ref, transcript, occurred_at, importance, metadata, created_at, created_by`;

type ExactStartScope = {
  agent?: string;
  platform?: string;
  server_id?: string;
  channel_id?: string;
  thread_id?: string;
};

function hasCompleteExactScope(args: ExactStartScope): args is Required<
  Omit<ExactStartScope, "thread_id">
> & { thread_id?: string } {
  return (
    args.agent !== undefined &&
    args.platform !== undefined &&
    args.server_id !== undefined &&
    args.channel_id !== undefined
  );
}

async function establishExactStartScope(
  deps: ToolDeps,
  namespace: string,
  sessionKey: string,
  args: ExactStartScope,
): Promise<Record<string, unknown> | null> {
  if (!hasCompleteExactScope(args)) return null;
  const requestedThreadId = args.thread_id ?? null;
  const { rows } = await deps.pool.query(
    `UPDATE ob_session_lanes
        SET agent = COALESCE(agent, $3),
            source = COALESCE(source, $4),
            metadata = CASE
              WHEN metadata->>'server_id' IS NOT NULL THEN metadata
              ELSE jsonb_set(metadata, '{server_id}', to_jsonb($5::text), true)
            END,
            channel_id = COALESCE(channel_id, $6),
            thread_id = CASE
              WHEN $7::text IS NOT NULL AND thread_id IS NULL THEN $7
              ELSE thread_id
            END
      WHERE namespace = $1
        AND session_key = $2
        AND (agent IS NULL OR agent = $3)
        AND (source IS NULL OR source = $4)
        AND (metadata->>'server_id' IS NULL OR metadata->>'server_id' = $5)
        AND (channel_id IS NULL OR channel_id = $6)
        AND (
          ($7::text IS NULL AND thread_id IS NULL)
          OR (
            $7::text IS NOT NULL
            AND (
              thread_id = $7
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
    RETURNING ${LANE_COLUMNS}`,
    [
      namespace,
      sessionKey,
      args.agent,
      args.platform,
      args.server_id,
      args.channel_id,
      requestedThreadId,
    ],
  );
  return (rows[0] as Record<string, unknown> | undefined) ?? null;
}

export function registerSessionStart(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "session_start",
    {
      description:
        "Find or create a session lane and return current state with recent events. " +
        "Lane persists across wraps — wrap is a checkpoint, not an ending. " +
        "Returns the lane as-is; the agent decides what to do with its status.",
      inputSchema: {
        session_key: z
          .string()
          .min(1)
          .max(500)
          .describe("Stable identifier for this session lane"),
        namespace: z
          .string()
          .max(500)
          .optional()
          .describe("Namespace for isolation (defaults to agent's clientId)"),
        project: z
          .string()
          .max(500)
          .optional()
          .describe("Project name this session relates to"),
        agent: z
          .string()
          .max(500)
          .optional()
          .describe("Agent name/ID owning this lane"),
        platform: z
          .string()
          .max(500)
          .optional()
          .describe("Platform/source identity for exact-scope lanes"),
        server_id: z
          .string()
          .max(500)
          .optional()
          .describe("Server/guild/workspace identity for exact-scope lanes"),
        channel_id: z
          .string()
          .max(500)
          .optional()
          .describe("Discord/platform channel ID"),
        thread_id: z
          .string()
          .max(500)
          .optional()
          .describe("Discord/platform thread ID"),
        topic: z
          .string()
          .max(500)
          .optional()
          .describe("Human-readable topic description"),
      },
      annotations: {
        title: "Session Start",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async (args, extra) => {
      const auth = extra.authInfo as AuthInfo | undefined;

      // Auth gate — write because we may create/reactivate
      if (!auth || !canWrite(auth.role, "sessions")) {
        logger.warn("session_start_denied", {
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

      logger.debug("session_start_begin", {
        session_key: args.session_key,
        namespace: ns,
        agent: args.agent ?? null,
        project: args.project ?? null,
        clientId: auth.clientId,
      });

      try {
        // Step 1: Look up existing lane
        const { rows: laneRows } = await deps.pool.query(
          `SELECT ${LANE_COLUMNS}
FROM ob_session_lanes
WHERE namespace = $1 AND session_key = $2`,
          [ns, args.session_key],
        );

        if (laneRows.length > 0) {
          // ── Existing lane — establish/validate supplied exact scope ──
          let lane = laneRows[0];
          if (hasCompleteExactScope(args)) {
            const scopedLane = await establishExactStartScope(
              deps,
              ns,
              args.session_key,
              args,
            );
            if (!scopedLane) {
              return {
                content: [
                  {
                    type: "text" as const,
                    text: "Existing lane exact scope does not match session_start request",
                  },
                ],
                isError: true,
              };
            }
            lane = scopedLane;
          }

          // Load recent events regardless of lane status
          const { rows: events } = await deps.pool.query(
            `SELECT ${EVENT_COLUMNS}
FROM ob_session_events
WHERE lane_id = $1
ORDER BY created_at DESC
LIMIT 50`,
            [lane.id],
          );

          const result = {
            lane,
            events,
            events_returned: events.length,
            is_new: false,
          };

          logger.info("session_start_resumed", {
            lane_id: lane.id,
            session_key: lane.session_key,
            namespace: ns,
            status: lane.status,
            events_returned: events.length,
          });

          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(result),
              },
            ],
          };
        }

        // ── No lane found — create new ──
        const { rows: newRows } = await deps.pool.query(
          `INSERT INTO ob_session_lanes
  (session_key, namespace, status, agent, source, project, channel_id, thread_id,
   topic, metadata, created_by)
VALUES ($1, $2, 'active', $3, $4, $5, $6, $7, $8, $9, $10)
RETURNING ${LANE_COLUMNS}`,
          [
            args.session_key,
            ns,
            args.agent ?? null,
            args.platform ?? null,
            args.project ?? null,
            args.channel_id ?? null,
            args.thread_id ?? null,
            args.topic ?? null,
            JSON.stringify(
              args.server_id === undefined ? {} : { server_id: args.server_id },
            ),
            auth.clientId,
          ],
        );

        const newLane = newRows[0];

        const result = {
          lane: newLane,
          events: [] as unknown[],
          events_returned: 0,
          is_new: true,
        };

        logger.info("session_start_created", {
          lane_id: newLane.id,
          session_key: newLane.session_key,
          namespace: ns,
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
        logger.error("session_start_db_error", {
          session_key: args.session_key,
          namespace: ns,
          error: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack : undefined,
        });
        return {
          content: [
            {
              type: "text" as const,
              text: `Database error during session start: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );
}
