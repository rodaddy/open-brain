/**
 * `adjacent_context` — one-hop traversal of the explicit link graph.
 *
 * Design authority: `docs/decisions/privilege-isolation-closed-brain.md`
 * (namespace isolation is server-side).
 *
 * This is the EXPLICIT graph, not a similarity neighbourhood. Every edge here
 * was written deliberately by `link_entities`, so an answer from this tool means
 * "someone recorded that these are related", which is a much stronger claim than
 * "these embed near each other". The two are complementary and must not be
 * confused: `search_brain` finds what a query resembles, this finds what a record
 * was explicitly connected to.
 *
 * ONE HOP ONLY, BY DESIGN. Multi-hop traversal is not offered because there is
 * no principled decay across hops in this schema — every edge carries a weight
 * but weights are not comparable across relation types, so a two-hop path has no
 * defensible score. A caller who wants further reach calls again on the returned
 * node and decides for itself what the second hop is worth.
 *
 * DIRECTION IS RELATIVE TO THE SOURCE NODE. `ob_links` stores each edge once,
 * as from -> to. A caller asking for `incoming` wants edges pointing AT its node,
 * which are rows where its node is the `to` side. Each returned link therefore
 * reports `direction` and `linked_*` fields computed from the caller's
 * perspective, not from the row's storage order.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { canRead } from "../auth/permissions.ts";
import { authIdentity, errorResult, textResult, type MemoryToolDependencies } from "./types.ts";
import { canReadNamespace } from "./read-scope.ts";
import { physicalNamespace } from "./shared-namespace.ts";
import { LINK_RELATIONS } from "./search-constants.ts";

const DIRECTIONS = ["outgoing", "incoming", "both"] as const;
const GRAPH_READ_DENIED = "Permission denied: cannot read link graph";

/** UUID shape accepted for the source node id. */
const graphUuid = z
  .string()
  .uuid()
  .describe("UUID of the source node");

interface LinkRow {
  id: string;
  from_type: string;
  from_id: string;
  to_type: string;
  to_id: string;
  relation: string;
  weight: number;
  metadata: Record<string, unknown> | null;
  created_at: string;
  from_name: string | null;
  from_canonical_id: string | null;
  to_name: string | null;
  to_canonical_id: string | null;
}

export function registerAdjacentContextTool(
  server: McpServer,
  dependencies: MemoryToolDependencies,
): void {
  server.registerTool(
    "adjacent_context",
    {
      description:
        "Find entities and entries linked to a given node. " +
        "Traverses the knowledge graph from a source node in one or both directions.",
      inputSchema: {
        type: z.string().min(1).max(200).describe("Type of the source node"),
        id: graphUuid,
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
      const identity = authIdentity(extra.authInfo);
      // The link graph spans every table, so the broadest read permission gates
      // it: a role that cannot read sessions cannot traverse edges into them.
      if (!identity || !canRead(identity.role, "sessions")) {
        dependencies.logger.warn(
          { role: identity?.role ?? "none" },
          "adjacent_context_denied",
        );
        return errorResult(GRAPH_READ_DENIED);
      }

      const requestedNamespace = args.namespace ?? identity.clientId;
      if (!canReadNamespace(identity, requestedNamespace)) {
        return errorResult(
          `Permission denied: cannot read namespace '${requestedNamespace}'`,
        );
      }
      const namespace = physicalNamespace(requestedNamespace);
      const direction = args.direction ?? "both";
      const limit = args.limit ?? 50;

      // $1/$2 are the source node; every later index is assigned in bind order
      // so an optional filter cannot shift a predicate onto the wrong parameter.
      const params: unknown[] = [args.type, args.id];
      const edgeCondition =
        direction === "outgoing"
          ? "l.from_type = $1 AND l.from_id = $2"
          : direction === "incoming"
            ? "l.to_type = $1 AND l.to_id = $2"
            : "(l.from_type = $1 AND l.from_id = $2) OR (l.to_type = $1 AND l.to_id = $2)";

      params.push(namespace);
      const namespaceCondition = `l.namespace = $${params.length}`;

      let relationCondition = "";
      if (args.relation) {
        params.push(args.relation);
        relationCondition = ` AND l.relation = $${params.length}`;
      }

      params.push(limit);
      const limitRef = `$${params.length}`;

      // The entity joins are LEFT joins plus an IS NOT NULL guard rather than
      // inner joins: an edge whose endpoint is a non-entity row (a thought, a
      // decision) has no ob_entities match and must still be returned, while an
      // edge pointing at an archived or deleted ENTITY must be filtered out.
      // An inner join would silently drop the first case along with the second.
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
WHERE (${edgeCondition})
  AND ${namespaceCondition}
  AND l.archived_at IS NULL${relationCondition}
  AND (l.from_type <> 'entity' OR from_entity.id IS NOT NULL)
  AND (l.to_type <> 'entity' OR to_entity.id IS NOT NULL)
ORDER BY l.weight DESC, l.created_at DESC
LIMIT ${limitRef}`;

      try {
        const { rows } = await dependencies.pool.query<LinkRow>(sql, params);
        const links = rows.map((row) => {
          // Reported from the CALLER's perspective, not the row's storage order.
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
            canonical_id: isOutgoing ? row.to_canonical_id : row.from_canonical_id,
            metadata: row.metadata ?? {},
            created_at: row.created_at,
          };
        });

        dependencies.logger.info(
          { namespace, direction, count: links.length },
          "adjacent_context_ok",
        );
        return textResult({ links, count: links.length });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        dependencies.logger.error(
          { namespace, direction, error_message: message },
          "adjacent_context_db_error",
        );
        return errorResult(`Database error during adjacency lookup: ${message}`);
      }
    },
  );
}
