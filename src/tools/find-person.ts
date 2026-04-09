import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { toSql } from "pgvector/pg";
import { canRead } from "../permissions.ts";
import type { AuthInfo } from "../types.ts";
import type { ToolDeps } from "./index.ts";

const SELECT_COLUMNS =
  "id, person_name, context, relationship_type, warmth, last_contact, email, phone, notes, tags, metadata, created_at";

export function registerFindPerson(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "find_person",
    {
      description:
        "Find a person in the brain by name (ILIKE partial match) or semantic search (embedding distance)",
      inputSchema: {
        query: z
          .string()
          .min(1)
          .describe("Person name or semantic search query"),
        mode: z
          .enum(["name", "semantic"])
          .optional()
          .describe(
            "Search mode: 'name' for ILIKE partial match (default), 'semantic' for embedding-based contextual search",
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(250)
          .optional()
          .describe("Maximum results to return (default 5)"),
        offset: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("Number of results to skip for pagination (default 0)"),
      },
      annotations: {
        title: "Find Person",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async (args, extra) => {
      const auth = extra.authInfo as AuthInfo | undefined;
      if (!auth || !canRead(auth.role, "relationships")) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Permission denied: cannot read relationships",
            },
          ],
          isError: true,
        };
      }

      const mode = args.mode ?? "name";
      const limit = args.limit ?? 5;
      const offset = args.offset ?? 0;

      if (mode === "semantic") {
        return handleSemanticSearch(deps, args.query, limit, offset);
      }

      return handleNameSearch(deps, args.query, limit, offset);
    },
  );
}

async function handleNameSearch(
  deps: ToolDeps,
  query: string,
  limit: number,
  offset: number,
) {
  // Escape ILIKE special characters before wrapping with %
  const escaped = query.replace(/%/g, "\\%").replace(/_/g, "\\_");

  const sql = `SELECT ${SELECT_COLUMNS}
FROM relationships
WHERE person_name ILIKE $1 AND archived_at IS NULL
ORDER BY warmth DESC NULLS LAST, last_contact DESC NULLS LAST
LIMIT $2 OFFSET $3`;

  const { rows } = await deps.pool.query(sql, [`%${escaped}%`, limit, offset]);

  if (rows.length === 0) {
    return {
      content: [
        {
          type: "text" as const,
          text: `No people found matching: ${query}`,
        },
      ],
    };
  }

  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(rows),
      },
    ],
  };
}

async function handleSemanticSearch(
  deps: ToolDeps,
  query: string,
  limit: number,
  offset: number,
) {
  const embedding = await deps.embedFn(query);
  if (!embedding) {
    return {
      content: [
        {
          type: "text" as const,
          text: "Failed to generate query embedding",
        },
      ],
      isError: true,
    };
  }

  const sql = `SELECT ${SELECT_COLUMNS},
  embedding <=> $1::halfvec(768) AS distance
FROM relationships
WHERE embedding IS NOT NULL AND archived_at IS NULL
ORDER BY distance ASC
LIMIT $2 OFFSET $3`;

  const { rows } = await deps.pool.query(sql, [
    toSql(embedding),
    limit,
    offset,
  ]);

  if (rows.length === 0) {
    return {
      content: [
        {
          type: "text" as const,
          text: `No people found matching: ${query}`,
        },
      ],
    };
  }

  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(rows),
      },
    ],
  };
}
