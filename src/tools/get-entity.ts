import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { canRead } from "../permissions.ts";
import { readableNamespaces } from "../read-policy.ts";
import type { AuthInfo } from "../types.ts";
import type { ToolDeps } from "./index.ts";

export function registerGetEntity(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "get_entity",
    {
      description:
        "Fetch a knowledge graph entity by ID from ob_entities. Use for IDs returned by upsert_entity or linked as type 'entity'.",
      inputSchema: {
        id: z.string().uuid().describe("Entity UUID from upsert_entity or graph links"),
      },
      annotations: {
        title: "Get Entity",
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

      const readable = readableNamespaces(auth);
      const namespacePredicate = readable ? " AND namespace = ANY($2::text[])" : "";
      const { rows } = await deps.pool.query(
        `SELECT id, entity_type, name, canonical_id, namespace, metadata, created_by, created_at, updated_at
         FROM ob_entities
         WHERE id = $1${namespacePredicate}`,
        readable ? [args.id, readable] : [args.id],
      );

      if (rows.length === 0) {
        return {
          content: [{ type: "text" as const, text: "Entity not found" }],
          isError: true,
        };
      }

      return {
        content: [{ type: "text" as const, text: JSON.stringify(rows[0]) }],
      };
    },
  );
}
