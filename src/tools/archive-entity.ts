import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { canDelete } from "../permissions.ts";
import { appendWriteNamespacePredicate } from "../namespace-policy.ts";
import type { AuthInfo } from "../types.ts";
import { logger } from "../logger.ts";
import type { ToolDeps } from "./index.ts";
import { graphUuid } from "./graph-ids.ts";

export function registerArchiveEntity(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "archive_entity",
    {
      description:
        "Soft-delete a graph entity by setting ob_entities.archived_at and archiving active ob_links that reference it.",
      inputSchema: {
        id: graphUuid.describe("Entity UUID to archive"),
      },
      annotations: {
        title: "Archive Entity",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
      },
    },
    async (args, extra) => {
      const auth = extra.authInfo as AuthInfo | undefined;
      if (!auth || !canDelete(auth.role, "sessions")) {
        return {
          content: [{ type: "text" as const, text: "Permission denied: cannot archive entities" }],
          isError: true,
        };
      }

      const client = await deps.pool.connect();
      try {
        await client.query("BEGIN");

        const entityParams: unknown[] = [args.id];
        const entityNsPredicate = appendWriteNamespacePredicate(auth, entityParams);
        const { rows } = await client.query(
          `UPDATE ob_entities
           SET archived_at = NOW(), updated_at = NOW()
           WHERE id = $1 AND archived_at IS NULL${entityNsPredicate}
           RETURNING id, namespace`,
          entityParams,
        );

        if (rows.length === 0) {
          await client.query("COMMIT");
          return {
            content: [{ type: "text" as const, text: "Already archived or not found" }],
          };
        }

        const { rowCount } = await client.query(
          `UPDATE ob_links
           SET archived_at = NOW(), updated_at = NOW()
           WHERE archived_at IS NULL
             AND ((from_type = 'entity' AND from_id = $1) OR (to_type = 'entity' AND to_id = $1))
             AND namespace = $2`,
          [args.id, rows[0].namespace],
        );

        await client.query("COMMIT");

        const result = {
          id: rows[0].id,
          namespace: rows[0].namespace,
          archived: true,
          links_archived: rowCount ?? 0,
        };

        logger.info("archive_entity_success", result);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
        };
      } catch (err) {
        await client.query("ROLLBACK");
        logger.error("archive_entity_error", {
          id: args.id,
          error: err instanceof Error ? err.message : String(err),
        });
        return {
          content: [
            {
              type: "text" as const,
              text: `Transaction failed: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      } finally {
        client.release();
      }
    },
  );
}
