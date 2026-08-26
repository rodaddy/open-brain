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
import {
  authIdentity,
  errorResult,
  textResult,
  type MemoryToolDependencies,
} from "./types.ts";
import { canReadNamespace } from "./read-scope.ts";
import { physicalNamespace } from "./shared-namespace.ts";
import { LINK_RELATIONS } from "./search-constants.ts";

const DIRECTIONS = ["outgoing", "incoming", "both"] as const;
type Direction = (typeof DIRECTIONS)[number];
const GRAPH_READ_DENIED = "Permission denied: cannot read link graph";

/** UUID shape accepted for the source node id. */
const graphUuid = z.string().uuid().describe("UUID of the source node");

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

/** One returned edge, already restated from the source node's perspective. */
interface AdjacentLink {
  id: string;
  direction: string;
  relation: string;
  weight: number;
  linked_type: string;
  linked_id: string;
  linked_name: string | null;
  canonical_id: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

/** Frozen `adjacent_context` argument contract: the names, types, and rule values are the API. */
const adjacentContextInputSchema = {
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
};

/** Tool annotations; `adjacent_context` reads and never mutates. */
const adjacentContextAnnotations = {
  title: "Adjacent Context",
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
};

/** The handler's arguments after the documented defaults are applied. */
interface AdjacentContextRequest {
  type: string;
  id: string;
  relation: string | undefined;
  direction: Direction;
  limit: number;
}

/**
 * Apply the documented argument defaults.
 *
 * @returns The normalized request; the defaults are part of the frozen contract.
 */
function normalizeAdjacentArgs(args: {
  type: string;
  id: string;
  relation?: string;
  direction?: Direction;
  limit?: number;
}): AdjacentContextRequest {
  return {
    type: args.type,
    id: args.id,
    relation: args.relation,
    direction: args.direction ?? "both",
    limit: args.limit ?? 50,
  };
}

/** A parameterized statement: the SQL text and the values bound to it, in order. */
interface AdjacencyQuery {
  sql: string;
  params: unknown[];
}

/**
 * Build the one-hop adjacency statement for a request.
 *
 * @returns The SQL and its bind values, in the order the placeholders were assigned.
 */
function buildAdjacencyQuery(
  request: AdjacentContextRequest,
  namespace: string,
): AdjacencyQuery {
  // $1/$2 are the source node; every later index is assigned in bind order
  // so an optional filter cannot shift a predicate onto the wrong parameter.
  const params: unknown[] = [request.type, request.id];
  const edgeCondition =
    request.direction === "outgoing"
      ? "l.from_type = $1 AND l.from_id = $2"
      : request.direction === "incoming"
        ? "l.to_type = $1 AND l.to_id = $2"
        : "(l.from_type = $1 AND l.from_id = $2) OR (l.to_type = $1 AND l.to_id = $2)";

  params.push(namespace);
  const namespaceCondition = `l.namespace = $${params.length}`;

  let relationCondition = "";
  if (request.relation) {
    params.push(request.relation);
    relationCondition = ` AND l.relation = $${params.length}`;
  }

  params.push(request.limit);
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

  return { sql, params };
}

/**
 * Restate one stored edge from the perspective of the node that was asked about.
 *
 * @returns The link with `direction` and `linked_*` fields relative to the source node.
 */
function linkFromSourcePerspective(
  row: LinkRow,
  request: AdjacentContextRequest,
): AdjacentLink {
  // Reported from the CALLER's perspective, not the row's storage order.
  const isOutgoing =
    row.from_type === request.type && row.from_id === request.id;
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
}

/**
 * Resolve the namespace this request may read, or the denial that stops it.
 *
 * @returns The physical namespace to bind, or the error response to return instead.
 */
function authorizeAdjacencyRead(
  identity: ReturnType<typeof authIdentity>,
  dependencies: MemoryToolDependencies,
  requestedFromArgs: string | undefined,
): { namespace: string } | { denied: ReturnType<typeof errorResult> } {
  // The link graph spans every table, so the broadest read permission gates
  // it: a role that cannot read sessions cannot traverse edges into them.
  if (!identity || !canRead(identity.role, "sessions")) {
    dependencies.logger.warn(
      { role: identity?.role ?? "none" },
      "adjacent_context_denied",
    );
    return { denied: errorResult(GRAPH_READ_DENIED) };
  }

  const requestedNamespace = requestedFromArgs ?? identity.clientId;
  if (!canReadNamespace(identity, requestedNamespace)) {
    return {
      denied: errorResult(
        `Permission denied: cannot read namespace '${requestedNamespace}'`,
      ),
    };
  }
  return { namespace: physicalNamespace(requestedNamespace) };
}

/**
 * Run the adjacency statement and shape its rows into the tool response.
 *
 * @returns The link payload, or the error response when the query fails.
 */
async function runAdjacencyLookup(options: {
  dependencies: MemoryToolDependencies;
  request: AdjacentContextRequest;
  namespace: string;
}): Promise<ReturnType<typeof textResult>> {
  const { dependencies, request, namespace } = options;
  const { sql, params } = buildAdjacencyQuery(request, namespace);
  const { direction } = request;

  try {
    const { rows } = await dependencies.pool.query<LinkRow>(sql, params);
    const links = rows.map((row) => linkFromSourcePerspective(row, request));

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
      inputSchema: adjacentContextInputSchema,
      annotations: adjacentContextAnnotations,
    },
    async (args, extra) => {
      const identity = authIdentity(extra.authInfo);
      const scope = authorizeAdjacencyRead(
        identity,
        dependencies,
        args.namespace,
      );
      if ("denied" in scope) return scope.denied;

      return await runAdjacencyLookup({
        dependencies,
        request: normalizeAdjacentArgs(args),
        namespace: scope.namespace,
      });
    },
  );
}
