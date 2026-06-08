import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { canRead } from "../permissions.ts";
import type { AuthInfo } from "../types.ts";
import { logger } from "../logger.ts";
import type { ToolDeps } from "./index.ts";
import { LINK_RELATIONS } from "./table-constants.ts";

const DIRECTIONS = ["outgoing", "incoming", "both"] as const;

export function registerAdjacentContext(
  server: McpServer,
  deps: ToolDeps,
): void {
  server.registerTool(
    "adjacent_context",
    {
      description:
        "Find entities and entries linked to a given node. " +
        "Traverses the knowledge graph from a source node in one or both directions.",
      inputSchema: {
        type: z.string().min(1).max(200).describe("Type of the source node"),
        id: z.string().uuid().describe("UUID of the source node"),
        namespace: z
          .string()
          .max(500)
          .optional()
          .describe("Namespace for isolation (defaults to agent's clientId)"),
        relation: z
          .enum(LINK_RELATIONS)
          .optional()
          .describe("Filter by relation type"),
        direction: z
          .enum(DIRECTIONS)
          .optional()
          .describe(
            'Traversal direction: "outgoing", "incoming", or "both" (default)',
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(200)
          .optional()
          .describe("Maximum links to return (default 50)"),
      },
      annotations: {
        title: "Adjacent Context",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async (args, extra) => {
      const auth = extra.authInfo as AuthInfo | undefined;

      // Auth gate
      if (!auth || !canRead(auth.role, "sessions")) {
        logger.warn("adjacent_context_denied", {
          role: auth?.role ?? "none",
          clientId: auth?.clientId ?? "none",
        });
        return {
          content: [
            {
              type: "text" as const,
              text: "Permission denied: cannot read link graph",
            },
          ],
          isError: true,
        };
      }

      const ns = args.namespace ?? auth.clientId;
      const direction = args.direction ?? "both";
      const limit = args.limit ?? 50;

      logger.debug("adjacent_context_start", {
        type: args.type,
        id: args.id,
        namespace: ns,
        direction,
        relation: args.relation ?? null,
        limit,
        clientId: auth.clientId,
      });

      try {
        // Build WHERE clause based on direction
        const conditions: string[] = [];
        const params: unknown[] = [args.type, args.id];
        let paramIdx = 3;

        if (direction === "outgoing") {
          conditions.push("from_type = $1 AND from_id = $2");
        } else if (direction === "incoming") {
          conditions.push("to_type = $1 AND to_id = $2");
        } else {
          // "both"
          conditions.push(
            "(from_type = $1 AND from_id = $2) OR (to_type = $1 AND to_id = $2)",
          );
        }

        // Optional namespace filter
        const nsCondition = `namespace = $${paramIdx++}`;
        params.push(ns);

        // Optional relation filter
        let relationCondition = "";
        if (args.relation) {
          relationCondition = ` AND relation = $${paramIdx++}`;
          params.push(args.relation);
        }

        params.push(limit);

        const sql = `SELECT id, from_type, from_id, to_type, to_id, relation, weight, metadata, created_at
FROM ob_links
WHERE (${conditions.join("")}) AND ${nsCondition}${relationCondition}
ORDER BY weight DESC, created_at DESC
LIMIT $${paramIdx}`;

        const { rows } = await deps.pool.query(sql, params);

        // Map results to include direction and linked node info relative to source
        const links = rows.map((row: any) => {
          const isOutgoing =
            row.from_type === args.type && row.from_id === args.id;
          return {
            id: row.id,
            direction: isOutgoing ? "outgoing" : "incoming",
            relation: row.relation,
            weight: row.weight,
            linked_type: isOutgoing ? row.to_type : row.from_type,
            linked_id: isOutgoing ? row.to_id : row.from_id,
            metadata: row.metadata ?? {},
            created_at: row.created_at,
          };
        });

        const result = {
          links,
          count: links.length,
        };

        logger.info("adjacent_context_ok", {
          type: args.type,
          id: args.id,
          namespace: ns,
          direction,
          count: result.count,
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
        logger.error("adjacent_context_db_error", {
          type: args.type,
          id: args.id,
          namespace: ns,
          error: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack : undefined,
        });
        return {
          content: [
            {
              type: "text" as const,
              text: `Database error during adjacency lookup: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );
}
