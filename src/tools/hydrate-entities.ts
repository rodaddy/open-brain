import { z } from "zod";
import { toSql } from "pgvector/pg";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { canWrite } from "../permissions.ts";
import { canWriteNamespace, writableNamespaces } from "../namespace-policy.ts";
import type { AuthInfo } from "../types.ts";
import { logger } from "../logger.ts";
import type { ToolDeps } from "./index.ts";
import { graphUuid } from "./graph-ids.ts";

type EntityHydrationRow = {
  id: string;
  entity_type: string;
  name: string;
  namespace: string;
};

function namespaceFilter(auth: AuthInfo, requested?: string): string[] | undefined {
  if (requested) {
    const check = canWriteNamespace(auth, requested);
    if (!check.allowed) throw new Error(check.reason ?? "namespace write denied");
    return [requested];
  }
  return writableNamespaces(auth);
}

export function registerHydrateEntities(
  server: McpServer,
  deps: ToolDeps,
): void {
  server.registerTool(
    "hydrate_entities",
    {
      description:
        "Immediately refresh graph entity hydration by generating/updating embeddings for active ob_entities rows. " +
        "Use after bulk imports or schema changes when entity search should be available right away.",
      inputSchema: {
        id: graphUuid.optional().describe("Optional entity UUID to hydrate"),
        entity_type: z.string().min(1).max(200).optional().describe("Optional entity type filter"),
        namespace: z
          .string()
          .max(500)
          .optional()
          .describe("Namespace to hydrate (defaults to caller writable namespace; admin/n8n may omit for all)"),
        only_missing_embedding: z
          .boolean()
          .optional()
          .describe("Only hydrate entities missing embeddings (default true)"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(500)
          .optional()
          .describe("Maximum entities to hydrate in one call (default 100, max 500)"),
      },
      annotations: {
        title: "Hydrate Entities",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async (args, extra) => {
      const auth = extra.authInfo as AuthInfo | undefined;
      if (!auth || !canWrite(auth.role, "sessions")) {
        return {
          content: [{ type: "text" as const, text: "Permission denied: cannot hydrate entities" }],
          isError: true,
        };
      }

      let namespaces: string[] | undefined;
      try {
        namespaces = namespaceFilter(auth, args.namespace);
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Permission denied: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }

      const params: unknown[] = [];
      const filters = ["archived_at IS NULL"];
      if (args.id) {
        params.push(args.id);
        filters.push(`id = $${params.length}`);
      }
      if (args.entity_type) {
        params.push(args.entity_type);
        filters.push(`entity_type = $${params.length}`);
      }
      if (namespaces) {
        params.push(namespaces);
        filters.push(`namespace = ANY($${params.length}::text[])`);
      }
      if (args.only_missing_embedding ?? true) {
        filters.push("embedding IS NULL");
      }

      const limit = args.limit ?? 100;
      params.push(limit);

      const { rows } = await deps.pool.query<EntityHydrationRow>(
        `SELECT id, entity_type, name, namespace
         FROM ob_entities
         WHERE ${filters.join(" AND ")}
         ORDER BY updated_at DESC, created_at DESC
         LIMIT $${params.length}`,
        params,
      );

      let hydrated = 0;
      const failed: Array<{ id: string; error: string }> = [];

      for (const row of rows) {
        try {
          const embedding = await deps.embedFn(`${row.entity_type}: ${row.name}`);
          if (!embedding) {
            failed.push({ id: row.id, error: "embedding provider returned null" });
            continue;
          }
          const updateParams: unknown[] = [row.id, toSql(embedding)];
          const writeNamespaces = writableNamespaces(auth);
          let nsPredicate = "";
          if (writeNamespaces) {
            updateParams.push(writeNamespaces);
            nsPredicate = ` AND namespace = ANY($${updateParams.length}::text[])`;
          }
          const { rowCount } = await deps.pool.query(
            `UPDATE ob_entities
             SET embedding = $2, updated_at = NOW()
             WHERE id = $1 AND archived_at IS NULL${nsPredicate}`,
            updateParams,
          );
          hydrated += rowCount ?? 0;
        } catch (err) {
          failed.push({
            id: row.id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      logger.info("hydrate_entities_done", {
        requested: rows.length,
        hydrated,
        failed: failed.length,
        namespace: args.namespace ?? null,
        entity_type: args.entity_type ?? null,
      });

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              matched: rows.length,
              hydrated,
              failed,
            }),
          },
        ],
      };
    },
  );
}
