/**
 * Knowledge-graph entity tools over `ob_entities`.
 *
 * Entity reads are gated on the `sessions` resource permission, matching
 * observed current-src behavior: the graph is session-adjacent metadata rather
 * than its own permission surface. Namespace scope always comes from the
 * foundation's auth-derived builder, so an ID-based fetch cannot reach across
 * a namespace the caller has no read authority over -- an ID-based read without
 * that predicate is exactly the isolation bug class the repo rules call out.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { canRead } from "../auth/permissions.ts";
import { namespacePredicate } from "../auth/namespace-policy.ts";
import { authIdentity, errorResult, textResult, type MemoryToolDependencies } from "./types.ts";

/**
 * Graph node UUID.
 *
 * Deliberately more permissive than `z.string().uuid()`: existing graph rows
 * carry ids that do not all set the RFC 4122 version/variant nibbles, and a
 * strict check would make those rows unfetchable. Format is still enforced.
 */
const RELAXED_UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
export const graphUuid = z.string().regex(RELAXED_UUID, "Invalid UUID");

const ENTITY_COLUMNS = `id, entity_type, name, canonical_id, namespace, metadata,
  created_by, created_at, updated_at`;

export function registerEntityTools(
  server: McpServer,
  dependencies: MemoryToolDependencies,
): void {
  server.registerTool(
    "get_entity",
    {
      description:
        "Fetch a knowledge graph entity by ID from ob_entities. Use for IDs returned by upsert_entity or linked as type 'entity'.",
      inputSchema: {
        id: graphUuid,
      },
      annotations: {
        title: "Get Entity",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async (args, extra) => {
      const identity = authIdentity(extra.authInfo);
      if (!identity || !canRead(identity.role, "sessions")) {
        return errorResult("Permission denied: cannot read entities");
      }
      const predicate = namespacePredicate(identity, "read", 2);
      const { rows } = await dependencies.pool.query(
        `SELECT ${ENTITY_COLUMNS} FROM ob_entities
          WHERE id = $1 AND archived_at IS NULL${predicate.clause}`,
        [args.id, ...predicate.values],
      );
      if (rows.length === 0) return errorResult("Entity not found");
      dependencies.logger.info({ tool: "get_entity" }, "tool_result");
      return textResult(rows[0]);
    },
  );
}
