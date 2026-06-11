import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { canRead } from "../permissions.ts";
import { canReadNamespace } from "../read-policy.ts";
import type { AuthInfo } from "../types.ts";
import type { ToolDeps } from "./index.ts";
import { logger } from "../logger.ts";

const LANE_COLUMNS = `id, session_key, namespace, status, agent, source,
  channel_id, thread_id, project, topic, current_context_md,
  metadata, created_by, created_at, updated_at, ended_at`;

export function registerLaneLoad(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "lane_load",
    {
      description:
        "Load session lanes by key, project, agent, channel, or status. " +
        "Returns durable lane state without semantic search — direct key lookup.",
      inputSchema: {
        session_key: z
          .string()
          .optional()
          .describe("Exact session_key to load"),
        namespace: z
          .string()
          .optional()
          .describe("Namespace filter (defaults to agent's clientId)"),
        project: z.string().optional().describe("Filter by project name"),
        agent: z.string().optional().describe("Filter by agent name"),
        channel_id: z
          .string()
          .optional()
          .describe("Filter by channel ID"),
        status: z
          .enum(["active", "wrapped", "archived"])
          .optional()
          .describe("Filter by status (default: active)"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe("Max lanes to return (default: 10)"),
      },
      annotations: {
        title: "Load Session Lane",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async (args, extra) => {
      const auth = extra.authInfo as AuthInfo | undefined;

      // Auth gate
      if (!auth || !canRead(auth.role, "sessions")) {
        logger.warn("lane_load_denied", {
          role: auth?.role ?? "none",
          clientId: auth?.clientId ?? "none",
        });
        return {
          content: [
            {
              type: "text" as const,
              text: "Permission denied: cannot read session lanes",
            },
          ],
          isError: true,
        };
      }

      const conditions: string[] = [];
      const params: unknown[] = [];
      let paramIdx = 1;

      // Namespace filter
      const ns = args.namespace ?? auth.clientId;
      if (!canReadNamespace(auth, ns)) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Permission denied: cannot read namespace '${ns}'`,
            },
          ],
          isError: true,
        };
      }
      conditions.push(`namespace = $${paramIdx++}`);
      params.push(ns);

      // Direct key lookup — most common path
      if (args.session_key) {
        conditions.push(`session_key = $${paramIdx++}`);
        params.push(args.session_key);
      }

      // Optional filters
      if (args.project) {
        conditions.push(`project = $${paramIdx++}`);
        params.push(args.project);
      }
      if (args.agent) {
        conditions.push(`agent = $${paramIdx++}`);
        params.push(args.agent);
      }
      if (args.channel_id) {
        conditions.push(`channel_id = $${paramIdx++}`);
        params.push(args.channel_id);
      }

      // Status defaults to 'active' unless explicitly set
      const status = args.status ?? "active";
      conditions.push(`status = $${paramIdx++}`);
      params.push(status);

      const limit = args.limit ?? 10;
      params.push(limit);

      const sql = `SELECT ${LANE_COLUMNS}
FROM ob_session_lanes
WHERE ${conditions.join(" AND ")}
ORDER BY updated_at DESC
LIMIT $${paramIdx}`;

      logger.debug("lane_load_query", {
        namespace: ns,
        session_key: args.session_key ?? null,
        project: args.project ?? null,
        agent: args.agent ?? null,
        channel_id: args.channel_id ?? null,
        status,
        limit,
        param_count: params.length,
      });

      try {
        const { rows } = await deps.pool.query(sql, params);

        logger.info("lane_load_ok", {
          namespace: ns,
          session_key: args.session_key ?? null,
          status,
          results: rows.length,
        });

        if (rows.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  lanes: [],
                  message: args.session_key
                    ? `No lane found for key "${args.session_key}" in namespace "${ns}"`
                    : `No ${status} lanes found matching filters`,
                }),
              },
            ],
          };
        }

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                lanes: rows,
                count: rows.length,
              }),
            },
          ],
        };
      } catch (err) {
        logger.error("lane_load_db_error", {
          namespace: ns,
          session_key: args.session_key ?? null,
          error: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack : undefined,
        });
        return {
          content: [
            {
              type: "text" as const,
              text: `Database error during lane load: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );
}
