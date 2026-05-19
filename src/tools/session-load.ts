import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { canRead } from "../permissions.ts";
import type { AuthInfo } from "../types.ts";
import type { ToolDeps } from "./index.ts";
import { logger } from "../logger.ts";

const SELECT_COLUMNS =
  "id, project, summary, tags, blockers, next_steps, key_decisions, created_by, created_at";

export function registerSessionLoad(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "session_load",
    {
      description:
        "Load the most recent session summary, optionally filtered by project",
      inputSchema: {
        project: z
          .string()
          .optional()
          .describe(
            "Project name to load session for (omit for most recent global session)",
          ),
      },
      annotations: {
        title: "Load Session",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async (args, extra) => {
      const auth = extra.authInfo as AuthInfo | undefined;
      if (!auth || !canRead(auth.role, "sessions")) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Permission denied: cannot read sessions",
            },
          ],
          isError: true,
        };
      }

      if (args.project) {
        return handleProjectLoad(deps, args.project, auth.clientId);
      }

      return handleGlobalLoad(deps, auth.clientId);
    },
  );
}

function logSessionAccess(deps: ToolDeps, sessionId: string, accessedBy?: string): void {
  void deps.pool
    .query(
      `INSERT INTO entry_access_log (entry_id, source_table, accessed_at, query_text, context, accessed_by)
       VALUES ($1::uuid, 'sessions', NOW(), NULL, 'session_load', $2)`,
      [sessionId, accessedBy ?? null],
    )
    .catch((err: unknown) => {
      logger.warn("session_load_access_log_error", {
        error: err instanceof Error ? err.message : String(err),
      });
    });
}

async function handleProjectLoad(deps: ToolDeps, project: string, accessedBy?: string) {
  const sql = `SELECT ${SELECT_COLUMNS}
FROM sessions
WHERE project = $1 AND archived_at IS NULL
ORDER BY created_at DESC
LIMIT 1`;

  const { rows } = await deps.pool.query(sql, [project]);

  if (rows.length === 0) {
    return {
      content: [
        {
          type: "text" as const,
          text: `No sessions found for project: ${project}`,
        },
      ],
    };
  }

  logSessionAccess(deps, rows[0].id, accessedBy);

  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(rows[0]),
      },
    ],
  };
}

async function handleGlobalLoad(deps: ToolDeps, accessedBy?: string) {
  const sql = `SELECT ${SELECT_COLUMNS}
FROM sessions
WHERE archived_at IS NULL
ORDER BY created_at DESC
LIMIT 1`;

  const { rows } = await deps.pool.query(sql);

  if (rows.length === 0) {
    return {
      content: [
        {
          type: "text" as const,
          text: "No sessions found",
        },
      ],
    };
  }

  logSessionAccess(deps, rows[0].id, accessedBy);

  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(rows[0]),
      },
    ],
  };
}
