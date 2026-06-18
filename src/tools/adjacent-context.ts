import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { canRead } from "../permissions.ts";
import { canReadNamespace } from "../read-policy.ts";
import type { AuthInfo } from "../types.ts";
import { logger } from "../logger.ts";
import type { ToolDeps } from "./index.ts";
import { graphUuid } from "./graph-ids.ts";
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
        id: graphUuid.describe("UUID of the source node"),
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
          conditions.push("l.from_type = $1 AND l.from_id = $2");
        } else if (direction === "incoming") {
          conditions.push("l.to_type = $1 AND l.to_id = $2");
        } else {
          // "both"
          conditions.push(
            "(l.from_type = $1 AND l.from_id = $2) OR (l.to_type = $1 AND l.to_id = $2)",
          );
        }

        // Optional namespace filter
        const nsCondition = `l.namespace = $${paramIdx++}`;
        params.push(ns);

        // Optional relation filter
        let relationCondition = "";
        if (args.relation) {
          relationCondition = ` AND l.relation = $${paramIdx++}`;
          params.push(args.relation);
        }

        params.push(limit);

        const sql = `SELECT
  l.id,
  l.from_type,
  l.from_id,
  l.to_type,
  l.to_id,
  l.relation,
  l.weight,
  l.metadata,
  l.created_at,
  from_entity.name AS from_name,
  from_entity.canonical_id AS from_canonical_id,
  to_entity.name AS to_name,
  to_entity.canonical_id AS to_canonical_id
FROM ob_links l
LEFT JOIN ob_entities from_entity
  ON l.from_type = 'entity'
 AND from_entity.id = l.from_id
 AND from_entity.namespace = l.namespace
 AND from_entity.archived_at IS NULL
LEFT JOIN ob_entities to_entity
  ON l.to_type = 'entity'
 AND to_entity.id = l.to_id
 AND to_entity.namespace = l.namespace
 AND to_entity.archived_at IS NULL
WHERE (${conditions.join("")})
  AND ${nsCondition}
  AND l.archived_at IS NULL${relationCondition}
  AND (l.from_type <> 'entity' OR from_entity.id IS NOT NULL)
  AND (l.to_type <> 'entity' OR to_entity.id IS NOT NULL)
ORDER BY l.weight DESC, l.created_at DESC
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
            linked_name: isOutgoing ? row.to_name : row.from_name,
            canonical_id: isOutgoing
              ? row.to_canonical_id
              : row.from_canonical_id,
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
