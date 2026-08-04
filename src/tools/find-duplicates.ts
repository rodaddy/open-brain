import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { canRead } from "../permissions.ts";
import { canReadNamespace, readableNamespaces } from "../read-policy.ts";
import { physicalNamespace } from "../shared-namespace.ts";
import type { AuthInfo, Table } from "../types.ts";
import { logger } from "../logger.ts";
import type { ToolDeps } from "./index.ts";
import { ALL_TABLES } from "./table-constants.ts";

/** Simple content preview per table using a given alias */
function contentPreviewForAlias(table: Table, alias: string): string {
  switch (table) {
    case "thoughts":
      return `${alias}.content`;
    case "decisions":
      return `${alias}.title || ': ' || COALESCE(${alias}.rationale, '')`;
    case "relationships":
      return `${alias}.person_name || ': ' || COALESCE(${alias}.context, '')`;
    case "projects":
      return `${alias}.name || ': ' || COALESCE(${alias}.description, '')`;
    case "sessions":
      return `COALESCE(${alias}.project || ': ', '') || LEFT(${alias}.summary, 200)`;
  }
}

/**
 * Resolve the namespace set BOTH sides of the self-join are bound to (#485).
 *
 * This is a total function by design: it returns a non-empty list for every
 * identity, so no input produces an unscoped join. `readableNamespaces()`
 * returns `undefined` for a global role (`admin`, `ob-admin`, `promoter`),
 * which the previous `appendReadNamespacePredicate()` call site turned into an
 * empty clause on BOTH sides -- a full cross-product. Measured on a 24,845-row
 * corpus: 256.7 ms scoped, versus cancelled at 60,074 ms unscoped, with pooled
 * connections that never came back.
 *
 * A global ROLE may read every namespace, but the comparison SPACE is still
 * per-namespace: a pair drawn from two different namespaces is not a duplicate.
 * So a global role is bound to a concrete namespace -- its own by default, or
 * any one it may read when named explicitly -- rather than to no predicate.
 *
 * @param auth Authenticated caller.
 * @param requested Caller-supplied namespace, if any.
 * @returns Namespaces to scan, or `undefined` when the caller may not read the
 *   namespace it named.
 */
export function duplicateScanNamespaces(
  auth: AuthInfo,
  requested: string | undefined,
): string[] | undefined {
  if (requested !== undefined) {
    return canReadNamespace(auth, requested)
      ? [physicalNamespace(requested)]
      : undefined;
  }
  // A scoped role's own readable set is already a bounded list, and keeping it
  // preserves the pre-#485 behavior of pairing within own + shared.
  return readableNamespaces(auth) ?? [auth.clientId];
}

export function registerFindDuplicates(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "find_duplicates",
    {
      description:
        "Discover potential duplicate entries using vector similarity. Read-only -- does NOT archive anything. " +
        "The pairwise scan is always bounded to a namespace set: it defaults to the caller's readable namespaces " +
        "and can be pointed at any single namespace the caller may read.",
      inputSchema: {
        table: z
          .enum([
            "thoughts",
            "decisions",
            "relationships",
            "projects",
            "sessions",
          ])
          .optional()
          .describe("Optional: limit to a specific table (default: all)"),
        namespace: z
          .string()
          .min(1)
          .max(500)
          .optional()
          .describe(
            "Namespace to scan for duplicate pairs (defaults to the caller's readable namespaces)",
          ),
        threshold: z
          .number()
          .min(0)
          .max(1)
          .optional()
          .describe("Cosine distance threshold for duplicates (default 0.08, lower = stricter)"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe("Max duplicate pairs to return (default 20)"),
      },
      annotations: {
        title: "Find Duplicates",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async (args, extra) => {
      const auth = extra.authInfo as AuthInfo | undefined;
      if (!auth) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Permission denied: not authenticated",
            },
          ],
          isError: true,
        };
      }

      const namespaces = duplicateScanNamespaces(auth, args.namespace);
      if (namespaces === undefined) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Permission denied: cannot read namespace '${String(args.namespace)}'`,
            },
          ],
          isError: true,
        };
      }

      const threshold = args.threshold ?? 0.08;
      const limit = args.limit ?? 20;
      const tableFilter = args.table as Table | undefined;

      const tablesToScan = tableFilter ? [tableFilter] : ALL_TABLES;
      const accessibleTables = tablesToScan.filter((t) => canRead(auth.role, t));

      if (accessibleTables.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Permission denied: no readable tables",
            },
          ],
          isError: true,
        };
      }

      const duplicates: Array<{
        entry_a: { id: string; preview: string };
        entry_b: { id: string; preview: string };
        table: string;
        distance: number;
      }> = [];

      for (const table of accessibleTables) {
        if (duplicates.length >= limit) break;

        const remaining = limit - duplicates.length;
        const previewA = contentPreviewForAlias(table, "a");
        const previewB = contentPreviewForAlias(table, "b");
        // BOTH sides of the join bind the SAME resolved namespace list ($3),
        // so the predicate is never empty and the comparison space stays
        // per-namespace-set. Binding one side only still admits a
        // cross-namespace pair and still leaves the unbounded shape #485
        // measured. The `b.namespace` predicate sits on the JOIN condition so
        // the planner can cut the pair space before computing distances.
        // Table name is validated by Zod enum -- safe for interpolation
        const { rows } = await deps.pool.query(
          `SELECT
            a.id AS id_a,
            LEFT(${previewA}, 200) AS preview_a,
            b.id AS id_b,
            LEFT(${previewB}, 200) AS preview_b,
            a.embedding <=> b.embedding AS distance
          FROM ${table} a
          JOIN ${table} b ON a.id < b.id
            AND b.archived_at IS NULL
            AND b.embedding IS NOT NULL
            AND b.namespace = ANY($3::text[])
          WHERE a.archived_at IS NULL
            AND a.embedding IS NOT NULL
            AND a.namespace = ANY($3::text[])
            AND a.embedding <=> b.embedding < $1
          ORDER BY distance ASC
          LIMIT $2`,
          [threshold, remaining, namespaces],
        );

        for (const row of rows) {
          duplicates.push({
            entry_a: { id: row.id_a, preview: row.preview_a },
            entry_b: { id: row.id_b, preview: row.preview_b },
            table,
            distance: Number(row.distance),
          });
        }
      }

      logger.info("find_duplicates_success", {
        tables_scanned: accessibleTables.length,
        namespaces_scanned: namespaces.length,
        duplicates_found: duplicates.length,
      });

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              threshold,
              namespaces,
              duplicates_found: duplicates.length,
              duplicates,
            }),
          },
        ],
      };
    },
  );
}
