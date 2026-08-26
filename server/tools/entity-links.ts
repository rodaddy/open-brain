/**
 * Graph link tools over `ob_links`.
 *
 * Links are gated on the `sessions` resource permission, matching the entity
 * tools they connect: an edge is session-adjacent metadata rather than its own
 * permission surface. Every mutation resolves its namespace through the
 * auth-derived policy, so a caller-supplied namespace narrows a write it was
 * already authorized for and never widens one.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { canDelete, canWrite } from "../auth/permissions.ts";
import {
  authIdentity,
  errorResult,
  textResult,
  type MemoryToolDependencies,
} from "./types.ts";
import {
  graphUuid,
  LINK_RELATIONS,
  metadataSchema,
  resolveWriteNamespace,
  writeNamespaceSchema,
} from "./entity-shared.ts";

export function registerLinkEntities(
  server: McpServer,
  dependencies: MemoryToolDependencies,
): void {
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
          .describe(
            'Source node type, e.g. "thought", "decision", "entity", "session"',
          ),
        from_id: graphUuid.describe("Source node UUID"),
        to_type: z.string().min(1).max(200).describe("Target node type"),
        to_id: graphUuid.describe("Target node UUID"),
        relation: z
          .enum(LINK_RELATIONS)
          .describe("Relationship type between the two nodes"),
        namespace: writeNamespaceSchema,
        weight: z
          .number()
          .min(0)
          .max(100)
          .optional()
          .describe("Relationship weight (default 1.0)"),
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
}

export function registerUnlinkEntities(
  server: McpServer,
  dependencies: MemoryToolDependencies,
): void {
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
        relation: z
          .enum(LINK_RELATIONS)
          .describe("Relationship type to remove"),
        namespace: writeNamespaceSchema,
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
        dependencies.logger.info(
          { tool: "unlink_entities", noop: true },
          "tool_result",
        );
        // Not an error: unlinking something already unlinked is the requested
        // end state, so a retry is safe.
        return textResult("Already unlinked or not found");
      }
      dependencies.logger.info(
        { tool: "unlink_entities", id: rows[0].id },
        "tool_result",
      );
      return textResult({
        id: rows[0].id,
        namespace: target.namespace,
        unlinked: true,
      });
    },
  );
}
