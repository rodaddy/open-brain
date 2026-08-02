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
import { toSql } from "pgvector/pg";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { canDelete, canRead, canWrite } from "../auth/permissions.ts";
import {
  canTargetNamespace,
  namespacePredicate,
} from "../auth/namespace-policy.ts";
import type { AuthIdentity } from "../auth/types.ts";
import { authIdentity, errorResult, textResult, type MemoryToolDependencies } from "./types.ts";

/**
 * Graph node UUID.
 *
 * Deliberately more permissive than `z.string().uuid()`: existing graph rows
 * carry ids that do not all set the RFC 4122 version/variant nibbles, and a
 * strict check would make those rows unfetchable. Format is still enforced.
 */
const RELAXED_UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
export const graphUuid = z.string().regex(RELAXED_UUID, "Invalid UUID");

const ENTITY_COLUMNS = `id, entity_type, name, canonical_id, namespace, metadata,
  created_by, created_at, updated_at`;

/**
 * Graph link relations from `009_knowledge_graph.sql`.
 *
 * A Zod enum rather than a free string: `relation` participates in the link
 * uniqueness key, so an unlisted value is a write that the database rejects
 * rather than one the boundary catches.
 */
const LINK_RELATIONS = [
  "artifact",
  "depends_on",
  "supersedes",
  "caused_by",
  "same_lane",
  "adjacent",
  "mentions",
  "implemented_by",
  "blocked_by",
  "decided_by",
  "relates_to",
  "contradicts",
  "duplicates",
  "supplements",
] as const;

/** Caller-supplied JSON metadata, shaped exactly as current-src shapes it. */
const metadataSchema = z
  .record(z.string().max(100), z.unknown())
  .optional()
  .refine(
    (value) =>
      !value ||
      (Object.keys(value).length <= 50 && JSON.stringify(value).length <= 100_000),
    { message: "metadata: max 50 keys, max 100KB total" },
  )
  .describe("Arbitrary JSON metadata; max 50 keys, max 100KB total");

/**
 * Resolve the namespace a graph mutation will write to.
 *
 * The default is the caller's own lane, and a requested namespace is checked
 * against the auth-derived policy rather than trusted -- a caller-supplied
 * namespace is an input, never an authorization.
 */
function resolveWriteNamespace(
  identity: AuthIdentity,
  requested: string | undefined,
): { namespace: string } | { denied: string } {
  const namespace = requested ?? identity.clientId;
  if (!canTargetNamespace(identity, "write", namespace)) {
    return { denied: "namespace write denied" };
  }
  return { namespace };
}

export function registerEntityTools(
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
          .describe('Entity type, e.g. "host", "workflow", "service", "agent", "project"'),
        name: z.string().min(1).max(500).describe("Entity name"),
        namespace: z
          .string()
          .max(500)
          .optional()
          .describe("Namespace for isolation (defaults to agent's clientId)"),
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

  server.registerTool(
    "list_entities",
    {
      description:
        "List knowledge graph entities from ob_entities, optionally filtered by entity type, name substring, namespace, or canonical ID.",
      inputSchema: {
        entity_type: z.string().min(1).max(200).optional().describe("Optional entity type filter"),
        name: z
          .string()
          .min(1)
          .max(500)
          .optional()
          .describe("Optional case-insensitive name substring"),
        canonical_id: z.string().min(1).max(500).optional().describe("Optional canonical ID filter"),
        namespace: z.string().trim().min(1).max(500).optional().describe("Optional namespace filter"),
        limit: z.number().int().min(1).max(250).optional().describe("Maximum entities to return (default 50)"),
        offset: z.number().int().min(0).optional().describe("Number of entities to skip (default 0)"),
      },
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
      if (args.namespace && !canTargetNamespace(identity, "read", args.namespace)) {
        return errorResult("Permission denied: namespace read access denied");
      }

      const values: unknown[] = [];
      const filters = ["archived_at IS NULL"];
      if (args.namespace) {
        values.push(args.namespace);
        filters.push(`namespace = $${values.length}`);
      } else {
        const predicate = namespacePredicate(identity, "read", values.length + 1);
        if (predicate.values.length > 0) {
          values.push(...predicate.values);
          filters.push(`namespace = ANY($${values.length}::text[])`);
        }
      }
      if (args.entity_type) {
        values.push(args.entity_type);
        filters.push(`entity_type = $${values.length}`);
      }
      if (args.name) {
        values.push(`%${args.name}%`);
        filters.push(`name ILIKE $${values.length}`);
      }
      if (args.canonical_id) {
        values.push(args.canonical_id);
        filters.push(`canonical_id = $${values.length}`);
      }
      values.push(args.limit ?? 50, args.offset ?? 0);

      const { rows } = await dependencies.pool.query(
        `SELECT ${ENTITY_COLUMNS}
           FROM ob_entities
          WHERE ${filters.join(" AND ")}
          ORDER BY updated_at DESC, created_at DESC
          LIMIT $${values.length - 1} OFFSET $${values.length}`,
        values,
      );
      dependencies.logger.info(
        { tool: "list_entities", returned: rows.length },
        "tool_result",
      );
      return textResult(rows);
    },
  );

  server.registerTool(
    "link_entities",
    {
      description:
        "Create a link between two entities or entries in the knowledge graph. " +
        "Idempotent by namespace + from_type + from_id + to_type + to_id + relation.",
      inputSchema: {
        from_type: z
          .string()
          .min(1)
          .max(200)
          .describe('Source node type, e.g. "thought", "decision", "entity", "session"'),
        from_id: graphUuid.describe("Source node UUID"),
        to_type: z.string().min(1).max(200).describe("Target node type"),
        to_id: graphUuid.describe("Target node UUID"),
        relation: z.enum(LINK_RELATIONS).describe("Relationship type between the two nodes"),
        namespace: z
          .string()
          .max(500)
          .optional()
          .describe("Namespace for isolation (defaults to agent's clientId)"),
        weight: z.number().min(0).max(100).optional().describe("Relationship weight (default 1.0)"),
        metadata: metadataSchema,
      },
      annotations: {
        title: "Link Entities",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async (args, extra) => {
      const identity = authIdentity(extra.authInfo);
      if (!identity || !canWrite(identity.role, "sessions")) {
        return errorResult("Permission denied: cannot write links");
      }
      // Refused at the boundary as well as by the table's own check, so the
      // caller gets an explanation instead of a database error string.
      if (args.from_type === args.to_type && args.from_id === args.to_id) {
        return errorResult("Invalid link: cannot link a node to itself");
      }
      const target = resolveWriteNamespace(identity, args.namespace);
      if ("denied" in target) {
        return errorResult(`Permission denied: ${target.denied}`);
      }

      const { rows } = await dependencies.pool.query(
        `INSERT INTO ob_links
           (from_type, from_id, to_type, to_id, relation, weight, namespace, metadata, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)
         ON CONFLICT (namespace, from_type, from_id, to_type, to_id, relation)
         WHERE archived_at IS NULL
         DO UPDATE SET
           weight = EXCLUDED.weight,
           metadata = ob_links.metadata || EXCLUDED.metadata,
           archived_at = NULL,
           updated_at = NOW()
         RETURNING id, (xmax = 0) AS is_new, relation, weight, created_at`,
        [
          args.from_type,
          args.from_id,
          args.to_type,
          args.to_id,
          args.relation,
          args.weight ?? 1.0,
          target.namespace,
          JSON.stringify(args.metadata ?? {}),
          identity.clientId,
        ],
      );

      const row = rows[0];
      dependencies.logger.info(
        { tool: "link_entities", id: row.id, isNew: row.is_new },
        "tool_result",
      );
      return textResult({
        id: row.id,
        from_type: args.from_type,
        from_id: args.from_id,
        to_type: args.to_type,
        to_id: args.to_id,
        relation: row.relation,
        weight: row.weight,
        is_new: row.is_new,
        created_at: row.created_at,
      });
    },
  );

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
      const identity = authIdentity(extra.authInfo);
      if (!identity || !canDelete(identity.role, "sessions")) {
        return errorResult("Permission denied: cannot unlink entities");
      }
      const target = resolveWriteNamespace(identity, args.namespace);
      if ("denied" in target) {
        return errorResult(`Permission denied: ${target.denied}`);
      }

      // Soft delete: the row is retained with an `archived_at` stamp so the
      // graph's history stays reconstructible.
      const { rows } = await dependencies.pool.query(
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
          target.namespace,
          args.from_type,
          args.from_id,
          args.to_type,
          args.to_id,
          args.relation,
        ],
      );

      if (rows.length === 0) {
        dependencies.logger.info({ tool: "unlink_entities", noop: true }, "tool_result");
        // Not an error: unlinking something already unlinked is the requested
        // end state, so a retry is safe.
        return textResult("Already unlinked or not found");
      }
      dependencies.logger.info(
        { tool: "unlink_entities", id: rows[0].id },
        "tool_result",
      );
      return textResult({ id: rows[0].id, namespace: target.namespace, unlinked: true });
    },
  );

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
      const identity = authIdentity(extra.authInfo);
      if (!identity || !canWrite(identity.role, "sessions")) {
        return errorResult("Permission denied: cannot hydrate entities");
      }
      if (args.namespace && !canTargetNamespace(identity, "write", args.namespace)) {
        return errorResult("Permission denied: namespace write denied");
      }

      const values: unknown[] = [];
      const filters = ["archived_at IS NULL"];
      if (args.id) {
        values.push(args.id);
        filters.push(`id = $${values.length}`);
      }
      if (args.entity_type) {
        values.push(args.entity_type);
        filters.push(`entity_type = $${values.length}`);
      }
      const writePredicate = namespacePredicate(identity, "write", 1);
      if (args.namespace) {
        values.push(args.namespace);
        filters.push(`namespace = $${values.length}`);
      } else if (writePredicate.values.length > 0) {
        values.push(...writePredicate.values);
        filters.push(`namespace = ANY($${values.length}::text[])`);
      }
      if (args.only_missing_embedding ?? true) {
        filters.push("embedding IS NULL");
      }
      values.push(args.limit ?? 100);

      const { rows } = await dependencies.pool.query<{
        id: string;
        entity_type: string;
        name: string;
      }>(
        `SELECT id, entity_type, name, namespace
           FROM ob_entities
          WHERE ${filters.join(" AND ")}
          ORDER BY updated_at DESC, created_at DESC
          LIMIT $${values.length}`,
        values,
      );

      let hydrated = 0;
      const failed: Array<{ id: string; error: string }> = [];
      for (const row of rows) {
        const embedding = await embedQuietly(
          dependencies,
          `${row.entity_type}: ${row.name}`,
        );
        if (!embedding) {
          failed.push({ id: row.id, error: "embedding provider returned null" });
          continue;
        }
        // The UPDATE re-applies the write predicate rather than trusting the
        // SELECT: the two run in separate statements, so the row's namespace
        // is re-proven at the moment of mutation.
        const updateValues: unknown[] = [row.id, embedding];
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
        hydrated += rowCount ?? 0;
      }

      dependencies.logger.info(
        { tool: "hydrate_entities", matched: rows.length, hydrated, failed: failed.length },
        "tool_result",
      );
      return textResult({ matched: rows.length, hydrated, failed });
    },
  );
}

/**
 * Embed text, treating provider failure as absence rather than an error.
 *
 * @returns The pgvector literal, or `null` when the provider gave nothing.
 */
async function embedQuietly(
  dependencies: MemoryToolDependencies,
  text: string,
): Promise<string | null> {
  try {
    const embedding = await dependencies.embedFn(text);
    return embedding ? toSql(embedding) : null;
  } catch (error) {
    dependencies.logger.warn(
      { error: error instanceof Error ? error.message : String(error) },
      "entity_embed_failed",
    );
    return null;
  }
}
