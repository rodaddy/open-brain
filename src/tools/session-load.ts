import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { canRead } from "../permissions.ts";
import type { AuthInfo } from "../types.ts";
import type { ToolDeps } from "./index.ts";

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
        return handleProjectLoad(deps, args.project);
      }

      return handleGlobalLoad(deps);
    },
  );
}

async function handleProjectLoad(deps: ToolDeps, project: string) {
  const sql = `SELECT ${SELECT_COLUMNS}
FROM sessions
WHERE project = $1
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

  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(rows[0]),
      },
    ],
  };
}

async function handleGlobalLoad(deps: ToolDeps) {
  const sql = `SELECT ${SELECT_COLUMNS}
FROM sessions
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

  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(rows[0]),
      },
    ],
  };
}
