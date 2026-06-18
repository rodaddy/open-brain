import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { canDelete } from "../permissions.ts";
import { canWriteNamespace } from "../namespace-policy.ts";
import type { AuthInfo } from "../types.ts";
import { logger } from "../logger.ts";
import type { ToolDeps } from "./index.ts";
import { graphUuid } from "./graph-ids.ts";
import { LINK_RELATIONS } from "./table-constants.ts";

export function registerUnlinkEntities(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "unlink_entities",
    {
      description:
        "Soft-delete one active graph link, keyed the same way link_entities is idempotent: namespace + from_type + from_id + to_type + to_id + relation.",
      inputSchema: {
        from_type: z.string().min(1).max(200).describe("Source node type"),
        from_id: graphUuid.describe("Source node UUID"),
        to_type: z.string().min(1).max(200).describe("Target node type"),
        to_id: graphUuid.describe("Target node UUID"),
        relation: z.enum(LINK_RELATIONS).describe("Relationship type to remove"),
        namespace: z
          .string()
          .max(500)
          .optional()
          .describe("Namespace for isolation (defaults to agent's clientId)"),
      },
      annotations: {
        title: "Unlink Entities",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
      },
    },
    async (args, extra) => {
      const auth = extra.authInfo as AuthInfo | undefined;
      if (!auth || !canDelete(auth.role, "sessions")) {
        return {
          content: [{ type: "text" as const, text: "Permission denied: cannot unlink entities" }],
          isError: true,
        };
      }

      const ns = args.namespace ?? auth.clientId;
      const nsCheck = canWriteNamespace(auth, ns);
      if (!nsCheck.allowed) {
        return {
          content: [{ type: "text" as const, text: `Permission denied: ${nsCheck.reason}` }],
          isError: true,
        };
      }

      const { rows } = await deps.pool.query(
        `UPDATE ob_links
         SET archived_at = NOW(), updated_at = NOW()
         WHERE namespace = $1
           AND from_type = $2
           AND from_id = $3
           AND to_type = $4
           AND to_id = $5
           AND relation = $6
           AND archived_at IS NULL
         RETURNING id`,
        [
          ns,
          args.from_type,
          args.from_id,
          args.to_type,
          args.to_id,
          args.relation,
        ],
      );

      if (rows.length === 0) {
        logger.info("unlink_entities_noop", {
          namespace: ns,
          from_type: args.from_type,
          to_type: args.to_type,
          relation: args.relation,
        });
        return {
          content: [{ type: "text" as const, text: "Already unlinked or not found" }],
        };
      }

      const result = {
        id: rows[0].id,
        namespace: ns,
        unlinked: true,
      };
      logger.info("unlink_entities_success", result);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
      };
    },
  );
}
