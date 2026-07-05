import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { appendWriteNamespacePredicate } from "../namespace-policy.ts";
import { appendReadNamespacePredicate } from "../read-policy.ts";
import type { AuthInfo, Table } from "../types.ts";
import { logger } from "../logger.ts";
import type { ToolDeps } from "./index.ts";

export function registerDemoteEntry(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "demote_entry",
    {
      description:
        "Archive a previously promoted entry, reversing a promotion. " +
        "Only works on entries that have promoted_from provenance metadata. Admin and ob-admin only.",
      inputSchema: {
        table: z.enum(["thoughts", "decisions", "relationships", "projects", "sessions"]).describe("Table name"),
        id: z.string().uuid().describe("UUID of the promoted entry to demote"),
      },
      annotations: {
        title: "Demote Entry",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
      },
    },
    async (args, extra) => {
      const auth = extra.authInfo as AuthInfo | undefined;
      if (!auth || (auth.role !== "admin" && auth.role !== "ob-admin")) {
        return {
          content: [{ type: "text" as const, text: "Permission denied: admin or ob-admin role required" }],
          isError: true,
        };
      }

      const table = args.table as Table;

      const selectParams: unknown[] = [args.id];
      const readPredicate = appendReadNamespacePredicate(auth, selectParams);
      const { rows } = await deps.pool.query(
        `SELECT id, namespace, promoted_from FROM ${table} WHERE id = $1 AND archived_at IS NULL${readPredicate}`,
        selectParams,
      );

      if (rows.length === 0) {
        return {
          content: [{ type: "text" as const, text: "Entry not found or already archived" }],
          isError: true,
        };
      }

      if (!rows[0].promoted_from) {
        return {
          content: [{ type: "text" as const, text: "Entry was not promoted — cannot demote" }],
          isError: true,
        };
      }

      const provenance = rows[0].promoted_from;

      const updateParams: unknown[] = [args.id];
      const writePredicate = appendWriteNamespacePredicate(auth, updateParams);
      const { rowCount } = await deps.pool.query(
        `UPDATE ${table} SET archived_at = NOW() WHERE id = $1${writePredicate}`,
        updateParams,
      );
      if ((rowCount ?? 0) === 0) {
        return {
          content: [{ type: "text" as const, text: "Entry not found or already archived" }],
          isError: true,
        };
      }

      logger.info("demote_entry_ok", {
        table,
        id: args.id,
        source_id: provenance.source_id,
        source_namespace: provenance.source_namespace,
      });

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            status: "demoted",
            archived_id: args.id,
            source_id: provenance.source_id,
            source_namespace: provenance.source_namespace,
          }),
        }],
      };
    },
  );
}
