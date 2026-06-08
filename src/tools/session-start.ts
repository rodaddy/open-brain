import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { canWrite } from "../permissions.ts";
import type { AuthInfo } from "../types.ts";
import { logger } from "../logger.ts";
import type { ToolDeps } from "./index.ts";

const LANE_COLUMNS = `id, session_key, namespace, status, agent, project, topic,
  current_context_md, metadata, created_at, updated_at, ended_at`;

const EVENT_COLUMNS = `id, event_type, content, source, artifact_path,
  importance, metadata, created_at, created_by`;

export function registerSessionStart(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "session_start",
    {
      description:
        "Find or create a session lane and return full context with recent events. " +
        "Idempotent entry point for agents resuming work.",
      inputSchema: {
        session_key: z
          .string()
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
          // ── Existing lane ──
          const lane = laneRows[0];
          const previousStatus = lane.status;
          let reactivated = false;

          // Reactivate if wrapped or archived
          if (previousStatus === "wrapped" || previousStatus === "archived") {
            const { rows: updated } = await deps.pool.query(
              `UPDATE ob_session_lanes SET status = 'active', ended_at = NULL
WHERE id = $1
RETURNING ${LANE_COLUMNS}`,
              [lane.id],
            );
            Object.assign(lane, updated[0]);
            reactivated = true;
          }

          // Load recent events
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
            event_count: events.length,
            is_new: false,
            reactivated,
          };

          logger.info("session_start_resumed", {
            lane_id: lane.id,
            session_key: lane.session_key,
            namespace: ns,
            reactivated,
            previous_status: previousStatus,
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
        }

        // ── No lane found — create new ──
        const { rows: newRows } = await deps.pool.query(
          `INSERT INTO ob_session_lanes
  (session_key, namespace, status, agent, project, channel_id, thread_id, topic, created_by)
VALUES ($1, $2, 'active', $3, $4, $5, $6, $7, $8)
RETURNING ${LANE_COLUMNS}`,
          [
            args.session_key,
            ns,
            args.agent ?? null,
            args.project ?? null,
            args.channel_id ?? null,
            args.thread_id ?? null,
            args.topic ?? null,
            auth.clientId,
          ],
        );

        const newLane = newRows[0];

        const result = {
          lane: newLane,
          events: [] as unknown[],
          event_count: 0,
          is_new: true,
          reactivated: false,
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
