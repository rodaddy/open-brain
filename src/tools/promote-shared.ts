import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { isPromoterIdentity } from "../namespace-policy.ts";
import { promoteEntry } from "../promotion-service.ts";
import { sharedNamespaceConfig } from "../shared-namespace.ts";
import { classifyShareCandidate } from "../sharing.ts";
import type { AuthInfo, Table } from "../types.ts";
import { logger } from "../logger.ts";
import type { ToolDeps } from "./index.ts";

/** Build the classifier content string for a source row. */
function shareContent(table: Table, row: Record<string, unknown>): string {
  if (table === "decisions") {
    const title = (row.title as string | null) ?? "";
    const rationale = (row.rationale as string | null) ?? "";
    return `${title} ${rationale}`.trim();
  }
  return (row.content as string | null) ?? "";
}

/**
 * On-demand shared-kb promotion (Issue #161). A promoter or admin identity
 * promotes a single own-namespace thought/decision into shared truth, AFTER a
 * shared-worthiness classification that hard-refuses secrets and person-private
 * content even when a promoter explicitly asks.
 *
 * Defense in depth: the tool gates on isPromoterIdentity OR admin at the entry
 * point, then promoteEntry re-checks canWriteNamespace server-side.
 */
export function registerPromoteShared(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "promote_shared",
    {
      description:
        "Promote a single own-namespace thought or decision into the shared-kb " +
        "namespace (shared truth). Requires the promoter or admin identity. " +
        "Classifies the entry first and REFUSES secrets or person-private " +
        "content. Dry-run by default.",
      inputSchema: {
        table: z
          .enum(["thoughts", "decisions"])
          .describe("Source table holding the entry to promote"),
        id: z.string().uuid().describe("Source entry id"),
        reason: z
          .string()
          .min(1)
          .max(2000)
          .optional()
          .describe("Why this entry is being promoted to shared truth"),
        dry_run: z
          .boolean()
          .optional()
          .describe("Preview without writing to shared-kb (default true)"),
      },
      annotations: {
        title: "Promote To Shared KB",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async (args, extra) => {
      const auth = extra.authInfo as AuthInfo | undefined;
      // AUTH gate (defense in depth): only a promoter identity or admin may even
      // attempt a shared-kb promotion. A normal agent token is refused here
      // before any DB read, independent of promoteEntry's own re-check.
      if (!auth || !(isPromoterIdentity(auth) || auth.role === "admin")) {
        logger.warn("promote_shared_denied", {
          role: auth?.role,
          clientId: auth?.clientId,
        });
        return {
          content: [
            {
              type: "text" as const,
              text: "Permission denied: shared-kb promotion requires the promoter or admin identity",
            },
          ],
          isError: true,
        };
      }

      const table = args.table as Table;
      const dryRun = args.dry_run ?? true;
      const targetNamespace = sharedNamespaceConfig().canonicalSharedNamespace;

      try {
        // Read the source content for classification, scoped to what the caller
        // can read. promoteEntry re-reads with its own namespace predicate, but
        // we need the content here to run the shared-worthiness gate first.
        // Column shape differs by table: thoughts has `content`; decisions has
        // `title`/`rationale` (and no `content` column). `table` is a validated
        // Zod enum, so this branch is a safe allowlist, not interpolation risk.
        const contentColumns =
          table === "decisions" ? "title, rationale" : "content";
        const { rows } = await deps.pool.query(
          `SELECT id, ${contentColumns}, tags, extracted_metadata
           FROM ${table}
           WHERE id = $1 AND archived_at IS NULL`,
          [args.id],
        );
        if (rows.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: "Source entry not found or archived",
              },
            ],
            isError: true,
          };
        }
        const row = rows[0] as Record<string, unknown>;
        const decision = classifyShareCandidate({
          content: shareContent(table, row),
          tags: (row.tags as string[] | null) ?? undefined,
          metadata:
            (row.extracted_metadata as Record<string, unknown> | null) ??
            undefined,
        });

        // Secret / private content must NEVER reach shared truth — refuse even
        // when an authorized promoter explicitly requests the promotion.
        if (decision === "reject-secret" || decision === "reject-private") {
          logger.warn("promote_shared_refused", {
            table,
            id: args.id,
            decision,
            clientId: auth.clientId,
          });
          return {
            content: [
              {
                type: "text" as const,
                text: `Refused: entry classified as ${decision} and cannot be promoted to shared truth`,
              },
            ],
            isError: true,
          };
        }

        const result = await promoteEntry(
          deps.pool,
          table,
          args.id,
          targetNamespace,
          args.reason,
          auth,
          { dryRun },
        );

        logger.info("promote_shared_ok", {
          table,
          id: args.id,
          status: result.status,
          decision,
          dry_run: dryRun,
          actor: auth.tokenClientId ?? auth.clientId,
        });

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ classification: decision, ...result }),
            },
          ],
        };
      } catch (err) {
        const statusCode = (err as { statusCode?: number }).statusCode;
        const message = err instanceof Error ? err.message : String(err);
        logger.warn("promote_shared_error", {
          table,
          id: args.id,
          statusCode,
          error: message,
        });
        return {
          content: [
            {
              type: "text" as const,
              text:
                statusCode && statusCode < 500
                  ? `Permission denied: ${message}`
                  : `Promotion failed: ${message}`,
            },
          ],
          isError: true,
        };
      }
    },
  );
}
