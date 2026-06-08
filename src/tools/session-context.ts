import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { canRead } from "../permissions.ts";
import type { AuthInfo } from "../types.ts";
import type { ToolDeps } from "./index.ts";
import { logger } from "../logger.ts";

const EVENT_TYPES = [
  "fact",
  "decision",
  "blocker",
  "action",
  "artifact",
  "receipt",
  "question",
  "correction",
  "handoff",
] as const;

const IMPORTANCE_LEVELS = ["hot", "warm", "cold"] as const;

const LANE_COLUMNS = `id, session_key, namespace, status, agent, project, topic,
  current_context_md, metadata, created_at, updated_at`;

export function registerSessionContext(
  server: McpServer,
  deps: ToolDeps,
): void {
  server.registerTool(
    "session_context",
    {
      description:
        "Load lane state and recent events for a session. " +
        "Provides the full context needed to resume work on a lane.",
      inputSchema: {
        session_key: z
          .string()
          .max(500)
          .optional()
          .describe("Session key to look up the lane"),
        namespace: z
          .string()
          .max(500)
          .optional()
          .describe("Namespace for isolation (defaults to agent's clientId)"),
        channel_id: z
          .string()
          .max(500)
          .optional()
          .describe("Look up lane by channel_id instead of session_key"),
        thread_id: z
          .string()
          .max(500)
          .optional()
          .describe("Further narrow channel_id lookup by thread_id"),
        include_events: z
          .boolean()
          .optional()
          .describe("Whether to include events (default: true)"),
        event_limit: z
          .number()
          .int()
          .min(1)
          .max(200)
          .optional()
          .describe("Max events to return (default: 50)"),
        event_types: z
          .array(z.enum(EVENT_TYPES))
          .optional()
          .describe("Filter events by type(s)"),
        importance: z
          .enum(IMPORTANCE_LEVELS)
          .optional()
          .describe("Filter events by importance level"),
      },
      annotations: {
        title: "Session Context",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async (args, extra) => {
      const auth = extra.authInfo as AuthInfo | undefined;

      // Auth gate
      if (!auth || !canRead(auth.role, "sessions")) {
        logger.warn("session_context_denied", {
          role: auth?.role ?? "none",
          clientId: auth?.clientId ?? "none",
        });
        return {
          content: [
            {
              type: "text" as const,
              text: "Permission denied: cannot read session context",
            },
          ],
          isError: true,
        };
      }

      const ns = args.namespace ?? auth.clientId;
      const includeEvents = args.include_events !== false;
      const eventLimit = args.event_limit ?? 50;

      logger.debug("session_context_start", {
        session_key: args.session_key ?? null,
        namespace: ns,
        channel_id: args.channel_id ?? null,
        thread_id: args.thread_id ?? null,
        include_events: includeEvents,
        event_limit: eventLimit,
        clientId: auth.clientId,
      });

      try {
        // Build lane lookup query
        const laneConditions: string[] = [`namespace = $1`];
        const laneParams: unknown[] = [ns];
        let paramIdx = 2;

        if (args.session_key) {
          laneConditions.push(`session_key = $${paramIdx++}`);
          laneParams.push(args.session_key);
        } else if (args.channel_id) {
          laneConditions.push(`channel_id = $${paramIdx++}`);
          laneParams.push(args.channel_id);
          if (args.thread_id) {
            laneConditions.push(`thread_id = $${paramIdx++}`);
            laneParams.push(args.thread_id);
          }
        }

        const laneSql = `SELECT ${LANE_COLUMNS}
FROM ob_session_lanes
WHERE ${laneConditions.join(" AND ")}
ORDER BY updated_at DESC
LIMIT 1`;

        const { rows: laneRows } = await deps.pool.query(laneSql, laneParams);

        if (laneRows.length === 0) {
          logger.info("session_context_lane_not_found", {
            session_key: args.session_key ?? null,
            namespace: ns,
            channel_id: args.channel_id ?? null,
          });
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  lane: null,
                  events: [],
                  event_count: 0,
                }),
              },
            ],
          };
        }

        const lane = laneRows[0];
        let events: unknown[] = [];

        if (includeEvents) {
          const eventConditions: string[] = [`lane_id = $1`];
          const eventParams: unknown[] = [lane.id];
          let evParamIdx = 2;

          if (args.event_types && args.event_types.length > 0) {
            eventConditions.push(`event_type = ANY($${evParamIdx++})`);
            eventParams.push(args.event_types);
          }

          if (args.importance) {
            eventConditions.push(`importance = $${evParamIdx++}`);
            eventParams.push(args.importance);
          }

          eventParams.push(eventLimit);

          const eventSql = `SELECT id, event_type, content, source, artifact_path,
  importance, metadata, created_at, created_by
FROM ob_session_events
WHERE ${eventConditions.join(" AND ")}
ORDER BY created_at DESC
LIMIT $${evParamIdx}`;

          const { rows: eventRows } = await deps.pool.query(
            eventSql,
            eventParams,
          );
          events = eventRows;
        }

        const result = {
          lane,
          events,
          event_count: events.length,
        };

        logger.info("session_context_ok", {
          lane_id: lane.id,
          session_key: lane.session_key,
          namespace: ns,
          event_count: events.length,
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
        logger.error("session_context_db_error", {
          session_key: args.session_key ?? null,
          namespace: ns,
          error: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack : undefined,
        });
        return {
          content: [
            {
              type: "text" as const,
              text: `Database error during session context load: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );
}
