import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { canRead } from "../permissions.ts";
import { canReadNamespace, namespaceFilterFor } from "../read-policy.ts";
import type { AuthInfo } from "../types.ts";
import type { ToolDeps } from "./index.ts";

function namespaceClause(
  namespace: string | string[] | undefined,
  params: unknown[],
): string {
  if (namespace === undefined) return "";
  params.push(namespace);
  return Array.isArray(namespace)
    ? ` AND namespace = ANY($${params.length}::text[])`
    : ` AND namespace = $${params.length}`;
}

export function registerListEntities(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "list_entities",
    {
      description:
        "List knowledge graph entities from ob_entities, optionally filtered by entity type, name substring, namespace, or canonical ID.",
      inputSchema: {
        entity_type: z.string().min(1).max(200).optional().describe("Optional entity type filter"),
        name: z.string().min(1).max(500).optional().describe("Optional case-insensitive name substring"),
        canonical_id: z.string().min(1).max(500).optional().describe("Optional canonical ID filter"),
        namespace: z.string().trim().min(1).max(500).optional().describe("Optional namespace filter"),
        limit: z.number().int().min(1).max(250).optional().describe("Maximum entities to return (default 50)"),
        offset: z.number().int().min(0).optional().describe("Number of entities to skip (default 0)"),
      },
      annotations: {
        title: "List Entities",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async (args, extra) => {
      const auth = extra.authInfo as AuthInfo | undefined;
      if (!auth || !canRead(auth.role, "sessions")) {
        return {
          content: [{ type: "text" as const, text: "Permission denied: cannot read entities" }],
          isError: true,
        };
      }

      const requestedNamespace = args.namespace as string | undefined;
      if (requestedNamespace && !canReadNamespace(auth, requestedNamespace)) {
        return {
          content: [{ type: "text" as const, text: "Permission denied: namespace read access denied" }],
          isError: true,
        };
      }

      const params: unknown[] = [];
      const filters: string[] = ["archived_at IS NULL"];
      const namespace = namespaceFilterFor(auth, requestedNamespace);
      const ns = namespaceClause(namespace, params);
      if (ns) filters.push(ns.slice(" AND ".length));
      if (args.entity_type) {
        params.push(args.entity_type);
        filters.push(`entity_type = $${params.length}`);
      }
      if (args.name) {
        params.push(`%${args.name}%`);
        filters.push(`name ILIKE $${params.length}`);
      }
      if (args.canonical_id) {
        params.push(args.canonical_id);
        filters.push(`canonical_id = $${params.length}`);
      }

      const limit = args.limit ?? 50;
      const offset = args.offset ?? 0;
      params.push(limit, offset);
      const where = filters.length > 0 ? `WHERE ${filters.join(" AND ")}` : "";

      const { rows } = await deps.pool.query(
        `SELECT id, entity_type, name, canonical_id, namespace, metadata, created_by, created_at, updated_at
         FROM ob_entities
         ${where}
         ORDER BY updated_at DESC, created_at DESC
         LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params,
      );

      return {
        content: [{ type: "text" as const, text: JSON.stringify(rows) }],
      };
    },
  );
}
