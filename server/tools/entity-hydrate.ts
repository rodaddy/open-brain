/**
 * The `hydrate_entities` tool over `ob_entities`.
 *
 * Hydration re-embeds rows whose vector is missing or stale. The vector is
 * derived data, so a provider failure is reported per row rather than failing
 * the call: the entity row itself is already durable.
 *
 * The write predicate is applied to the UPDATE statement, not checked once
 * before the loop -- selection and mutation are separate statements, so each
 * row's namespace is re-proven at the moment it is written.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { canWrite } from "../auth/permissions.ts";
import {
  canTargetNamespace,
  namespacePredicate,
} from "../auth/namespace-policy.ts";
import type { AuthIdentity } from "../auth/types.ts";
import {
  authIdentity,
  errorResult,
  textResult,
  type MemoryToolDependencies,
} from "./types.ts";
import {
  applyNamespaceScope,
  embedQuietly,
  graphUuid,
  SqlFilters,
} from "./entity-shared.ts";

interface HydrateSelection {
  id: string;
  entity_type: string;
  name: string;
}

/** Select the entity rows one `hydrate_entities` call will re-embed. */
async function selectHydrationTargets(
  dependencies: MemoryToolDependencies,
  identity: AuthIdentity,
  args: {
    id?: string;
    entity_type?: string;
    namespace?: string;
    only_missing_embedding?: boolean;
    limit?: number;
  },
): Promise<HydrateSelection[]> {
  const filters = new SqlFilters("archived_at IS NULL");
  if (args.id) {
    filters.add((placeholder) => `id = ${placeholder}`, args.id);
  }
  if (args.entity_type) {
    filters.add(
      (placeholder) => `entity_type = ${placeholder}`,
      args.entity_type,
    );
  }
  applyNamespaceScope(filters, identity, "write", args.namespace);
  if (args.only_missing_embedding ?? true) {
    filters.addBare("embedding IS NULL");
  }
  const limitPlaceholder = filters.push(args.limit ?? 100);

  const { rows } = await dependencies.pool.query<HydrateSelection>(
    `SELECT id, entity_type, name, namespace
       FROM ob_entities
      WHERE ${filters.where()}
      ORDER BY updated_at DESC, created_at DESC
      LIMIT ${limitPlaceholder}`,
    filters.values,
  );
  return rows;
}

/**
 * Write one refreshed embedding back, re-proving the row's namespace.
 *
 * The UPDATE re-applies the write predicate rather than trusting the SELECT:
 * the two run in separate statements, so the row's namespace is re-proven at
 * the moment of mutation.
 *
 * @returns How many rows the UPDATE actually touched.
 */
async function writeHydratedEmbedding(
  dependencies: MemoryToolDependencies,
  identity: AuthIdentity,
  id: string,
  embedding: string,
): Promise<number> {
  const updateValues: unknown[] = [id, embedding];
  const writePredicate = namespacePredicate(identity, "write", 1);
  let scoped = "";
  if (writePredicate.values.length > 0) {
    updateValues.push(...writePredicate.values);
    scoped = ` AND namespace = ANY($${updateValues.length}::text[])`;
  }
  const { rowCount } = await dependencies.pool.query(
    `UPDATE ob_entities
        SET embedding = $2, updated_at = NOW()
      WHERE id = $1 AND archived_at IS NULL${scoped}`,
    updateValues,
  );
  return rowCount ?? 0;
}

export function registerHydrateEntities(
  server: McpServer,
  dependencies: MemoryToolDependencies,
): void {
  server.registerTool(
    "hydrate_entities",
    {
      description:
        "Immediately refresh graph entity hydration by generating/updating embeddings for active ob_entities rows. " +
        "Use after bulk imports or schema changes when entity search should be available right away.",
      inputSchema: {
        id: graphUuid.optional().describe("Optional entity UUID to hydrate"),
        entity_type: z
          .string()
          .min(1)
          .max(200)
          .optional()
          .describe("Optional entity type filter"),
        namespace: z
          .string()
          .max(500)
          .optional()
          .describe(
            "Namespace to hydrate (defaults to caller writable namespace; admin/ob-admin may omit for all)",
          ),
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
          .describe(
            "Maximum entities to hydrate in one call (default 100, max 500)",
          ),
      },
      annotations: {
        title: "Hydrate Entities",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async (args, extra) => {
      const identity = authIdentity(extra.authInfo);
      if (!identity || !canWrite(identity.role, "sessions")) {
        return errorResult("Permission denied: cannot hydrate entities");
      }
      if (
        args.namespace &&
        !canTargetNamespace(identity, "write", args.namespace)
      ) {
        return errorResult("Permission denied: namespace write denied");
      }

      const rows = await selectHydrationTargets(dependencies, identity, args);

      let hydrated = 0;
      const failed: Array<{ id: string; error: string }> = [];
      for (const row of rows) {
        const embedding = await embedQuietly(
          dependencies,
          `${row.entity_type}: ${row.name}`,
        );
        if (!embedding) {
          failed.push({
            id: row.id,
            error: "embedding provider returned null",
          });
          continue;
        }
        hydrated += await writeHydratedEmbedding(
          dependencies,
          identity,
          row.id,
          embedding,
        );
      }

      dependencies.logger.info(
        {
          tool: "hydrate_entities",
          matched: rows.length,
          hydrated,
          failed: failed.length,
        },
        "tool_result",
      );
      return textResult({ matched: rows.length, hydrated, failed });
    },
  );
}
