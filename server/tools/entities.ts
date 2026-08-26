/**
 * Knowledge-graph entity tools over `ob_entities`.
 *
 * Entity reads are gated on the `sessions` resource permission, matching
 * observed current-src behavior: the graph is session-adjacent metadata rather
 * than its own permission surface. Namespace scope always comes from the
 * foundation's auth-derived builder, so an ID-based fetch cannot reach across
 * a namespace the caller has no read authority over -- an ID-based read without
 * that predicate is exactly the isolation bug class the repo rules call out.
 */
import { z } from "zod";
import type { PoolClient } from "pg";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { canDelete, canRead, canWrite } from "../auth/permissions.ts";
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
  registerLinkEntities,
  registerUnlinkEntities,
} from "./entity-links.ts";
import { registerHydrateEntities } from "./entity-hydrate.ts";
import {
  applyNamespaceScope,
  embedQuietly,
  ENTITY_COLUMNS,
  graphUuid,
  metadataSchema,
  resolveWriteNamespace,
  SqlFilters,
  writeNamespaceSchema,
} from "./entity-shared.ts";

export { graphUuid };

export function registerEntityTools(
  server: McpServer,
  dependencies: MemoryToolDependencies,
): void {
  registerGetEntity(server, dependencies);
  registerUpsertEntity(server, dependencies);
  registerListEntities(server, dependencies);
  registerLinkEntities(server, dependencies);
  registerUnlinkEntities(server, dependencies);
  registerHydrateEntities(server, dependencies);
  registerArchiveEntity(server, dependencies);
}

function registerGetEntity(
  server: McpServer,
  dependencies: MemoryToolDependencies,
): void {
  server.registerTool(
    "get_entity",
    {
      description:
        "Fetch a knowledge graph entity by ID from ob_entities. Use for IDs returned by upsert_entity or linked as type 'entity'.",
      inputSchema: {
        id: graphUuid,
      },
      annotations: {
        title: "Get Entity",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async (args, extra) => {
      const identity = authIdentity(extra.authInfo);
      if (!identity || !canRead(identity.role, "sessions")) {
        return errorResult("Permission denied: cannot read entities");
      }
      const predicate = namespacePredicate(identity, "read", 2);
      const { rows } = await dependencies.pool.query(
        `SELECT ${ENTITY_COLUMNS} FROM ob_entities
          WHERE id = $1 AND archived_at IS NULL${predicate.clause}`,
        [args.id, ...predicate.values],
      );
      if (rows.length === 0) return errorResult("Entity not found");
      dependencies.logger.info({ tool: "get_entity" }, "tool_result");
      return textResult(rows[0]);
    },
  );
}

function registerUpsertEntity(
  server: McpServer,
  dependencies: MemoryToolDependencies,
): void {
  server.registerTool(
    "upsert_entity",
    {
      description:
        "Create or update an entity in the knowledge graph. " +
        "Idempotent by namespace + entity_type + name (case-insensitive).",
      inputSchema: {
        entity_type: z
          .string()
          .min(1)
          .max(200)
          .describe(
            'Entity type, e.g. "host", "workflow", "service", "agent", "project"',
          ),
        name: z.string().min(1).max(500).describe("Entity name"),
        namespace: writeNamespaceSchema,
        canonical_id: z
          .string()
          .max(500)
          .optional()
          .describe('Optional canonical identifier, e.g. "host:ct235"'),
        metadata: metadataSchema,
      },
      annotations: {
        title: "Upsert Entity",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async (args, extra) => {
      const identity = authIdentity(extra.authInfo);
      if (!identity || !canWrite(identity.role, "sessions")) {
        return errorResult("Permission denied: cannot write entities");
      }
      const target = resolveWriteNamespace(identity, args.namespace);
      if ("denied" in target) {
        return errorResult(`Permission denied: ${target.denied}`);
      }

      // A failed embedding must not fail the write: the row is the durable
      // fact and the vector is derived, so it is refreshed later by
      // `hydrate_entities` rather than blocking the upsert here.
      const embedding = await embedQuietly(
        dependencies,
        `${args.entity_type}: ${args.name}`,
      );

      const { rows } = await dependencies.pool.query(
        `INSERT INTO ob_entities
           (entity_type, name, canonical_id, namespace, metadata, embedding, created_by)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)
         ON CONFLICT (namespace, entity_type, lower(name))
         WHERE archived_at IS NULL
         DO UPDATE SET
           canonical_id = COALESCE(EXCLUDED.canonical_id, ob_entities.canonical_id),
           metadata = ob_entities.metadata || EXCLUDED.metadata,
           embedding = COALESCE(EXCLUDED.embedding, ob_entities.embedding),
           archived_at = NULL,
           updated_at = NOW()
         RETURNING id, (xmax = 0) AS is_new, entity_type, name, namespace, created_at, updated_at`,
        [
          args.entity_type,
          args.name,
          args.canonical_id ?? null,
          target.namespace,
          JSON.stringify(args.metadata ?? {}),
          embedding,
          identity.clientId,
        ],
      );

      const row = rows[0];
      dependencies.logger.info(
        { tool: "upsert_entity", id: row.id, isNew: row.is_new },
        "tool_result",
      );
      return textResult({
        id: row.id,
        entity_type: row.entity_type,
        name: row.name,
        namespace: row.namespace,
        is_new: row.is_new,
        created_at: row.created_at,
        updated_at: row.updated_at,
      });
    },
  );
}

/** `list_entities` arguments, named so the handler reads as one screen of logic. */
const LIST_ENTITIES_SCHEMA = {
  entity_type: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe("Optional entity type filter"),
  name: z
    .string()
    .min(1)
    .max(500)
    .optional()
    .describe("Optional case-insensitive name substring"),
  canonical_id: z
    .string()
    .min(1)
    .max(500)
    .optional()
    .describe("Optional canonical ID filter"),
  namespace: z
    .string()
    .trim()
    .min(1)
    .max(500)
    .optional()
    .describe("Optional namespace filter"),
  limit: z
    .number()
    .int()
    .min(1)
    .max(250)
    .optional()
    .describe("Maximum entities to return (default 50)"),
  offset: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Number of entities to skip (default 0)"),
};

function registerListEntities(
  server: McpServer,
  dependencies: MemoryToolDependencies,
): void {
  server.registerTool(
    "list_entities",
    {
      description:
        "List knowledge graph entities from ob_entities, optionally filtered by entity type, name substring, namespace, or canonical ID.",
      inputSchema: LIST_ENTITIES_SCHEMA,
      annotations: {
        title: "List Entities",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async (args, extra) => {
      const identity = authIdentity(extra.authInfo);
      if (!identity || !canRead(identity.role, "sessions")) {
        return errorResult("Permission denied: cannot read entities");
      }
      // A named namespace is checked BEFORE it narrows anything, so asking for
      // a foreign lane is refused rather than silently returning nothing.
      if (
        args.namespace &&
        !canTargetNamespace(identity, "read", args.namespace)
      ) {
        return errorResult("Permission denied: namespace read access denied");
      }

      const filters = new SqlFilters("archived_at IS NULL");
      applyNamespaceScope(filters, identity, "read", args.namespace);
      if (args.entity_type) {
        filters.add(
          (placeholder) => `entity_type = ${placeholder}`,
          args.entity_type,
        );
      }
      if (args.name) {
        filters.add(
          (placeholder) => `name ILIKE ${placeholder}`,
          `%${args.name}%`,
        );
      }
      if (args.canonical_id) {
        filters.add(
          (placeholder) => `canonical_id = ${placeholder}`,
          args.canonical_id,
        );
      }
      const limitPlaceholder = filters.push(args.limit ?? 50);
      const offsetPlaceholder = filters.push(args.offset ?? 0);

      const { rows } = await dependencies.pool.query(
        `SELECT ${ENTITY_COLUMNS}
           FROM ob_entities
          WHERE ${filters.where()}
          ORDER BY updated_at DESC, created_at DESC
          LIMIT ${limitPlaceholder} OFFSET ${offsetPlaceholder}`,
        filters.values,
      );
      dependencies.logger.info(
        { tool: "list_entities", returned: rows.length },
        "tool_result",
      );
      return textResult(rows);
    },
  );
}

/**
 * Archive one entity and every active link that references it, in a caller-
 * supplied transaction.
 *
 * @returns The tool result payload, or `null` when nothing matched.
 */
async function archiveEntityInTransaction(
  client: PoolClient,
  identity: AuthIdentity,
  id: string,
): Promise<{
  id: string;
  namespace: string;
  archived: true;
  links_archived: number;
} | null> {
  // The mutation predicate is applied to the UPDATE itself, not checked
  // beforehand: an ID-based write that authorizes in a separate statement
  // is the isolation bug class this repo's rules name explicitly.
  const entityPredicate = namespacePredicate(identity, "delete", 2);
  const { rows } = await client.query(
    `UPDATE ob_entities
        SET archived_at = NOW(), updated_at = NOW()
      WHERE id = $1 AND archived_at IS NULL${entityPredicate.clause}
      RETURNING id, namespace`,
    [id, ...entityPredicate.values],
  );

  if (rows.length === 0) return null;

  // The link sweep matches on the namespace the entity was actually found
  // in, taken from the RETURNING row rather than re-derived from the
  // caller, so the cascade cannot reach a neighbouring namespace.
  const { rowCount } = await client.query(
    `UPDATE ob_links
        SET archived_at = NOW(), updated_at = NOW()
      WHERE archived_at IS NULL
        AND ((from_type = 'entity' AND from_id = $1) OR (to_type = 'entity' AND to_id = $1))
        AND namespace = $2`,
    [id, rows[0].namespace],
  );

  return {
    id: rows[0].id,
    namespace: rows[0].namespace,
    archived: true,
    links_archived: rowCount ?? 0,
  };
}

function registerArchiveEntity(
  server: McpServer,
  dependencies: MemoryToolDependencies,
): void {
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
      const identity = authIdentity(extra.authInfo);
      if (!identity || !canDelete(identity.role, "sessions")) {
        return errorResult("Permission denied: cannot archive entities");
      }

      // Entity and link archival are ONE transaction. A half-applied archive
      // leaves live links pointing at a dead node, which reads as a graph edge
      // to every traversal while the node it names is gone.
      const client = await dependencies.pool.connect();
      try {
        await client.query("BEGIN");
        const result = await archiveEntityInTransaction(
          client,
          identity,
          args.id,
        );
        await client.query("COMMIT");

        if (!result) {
          // Already-archived and unreadable-namespace collapse to ONE non-error
          // string. Distinguishing them would let a caller probe which entity
          // ids exist in namespaces it has no authority over.
          return textResult("Already archived or not found");
        }

        dependencies.logger.info(
          { tool: "archive_entity", ...result },
          "tool_result",
        );
        return textResult(result);
      } catch (error) {
        await client.query("ROLLBACK");
        const message = error instanceof Error ? error.message : String(error);
        dependencies.logger.error(
          { tool: "archive_entity", id: args.id, error: message },
          "tool_error",
        );
        return errorResult(`Transaction failed: ${message}`);
      } finally {
        client.release();
      }
    },
  );
}
