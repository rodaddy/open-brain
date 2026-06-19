import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AuthInfo, Table } from "../types.ts";
import { logger } from "../logger.ts";
import { promoteEntry } from "../promotion-service.ts";
import { sharedNamespaceConfig } from "../shared-namespace.ts";
import type { ToolDeps } from "./index.ts";

export function registerPromoteEntry(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "promote_entry",
    {
      description:
        "Promote an entry from an agent namespace to shared-kb or another target namespace. " +
        "Copies the entry with provenance tracking and detects duplicate target rows.",
      inputSchema: {
        table: z.enum(["thoughts", "decisions", "relationships", "projects", "sessions"]).describe("Source table"),
        id: z.string().uuid().describe("Source entry UUID"),
        reason: z.string().max(1000).optional().describe("Why this entry is being promoted"),
        target_namespace: z
          .string()
          .min(1)
          .max(500)
          .optional()
          .describe("Target namespace (default: shared-kb)"),
        dry_run: z
          .boolean()
          .optional()
          .describe("Return a promotion report without inserting into the target namespace"),
      },
      annotations: {
        title: "Promote Entry",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async (args, extra) => {
      const auth = extra.authInfo as AuthInfo | undefined;
      if (
        !auth ||
        (auth.role !== "admin" &&
          auth.role !== "n8n" &&
          auth.role !== "promoter")
      ) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Permission denied: admin, n8n, or promoter role required",
            },
          ],
          isError: true,
        };
      }

      const table = args.table as Table;
      let result;
      try {
        result = await promoteEntry(
          deps.pool,
          table,
          args.id,
          args.target_namespace ?? sharedNamespaceConfig().sharedNamespace,
          args.reason,
          auth,
          {
            dryRun: args.dry_run ?? false,
          },
        );
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: (err as Error).message }],
          isError: true,
        };
      }

      logger.info("promote_entry_ok", {
        table,
        source_id: args.id,
        new_id: result.new_id,
        existing_id: result.existing_id,
        target_namespace: result.target_namespace,
        status: result.status,
        dry_run: result.dry_run,
      });

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify(result),
        }],
      };
    },
  );
}
