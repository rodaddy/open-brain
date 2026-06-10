import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { canWrite } from "../permissions.ts";
import { canWriteNamespace } from "../namespace-policy.ts";
import type { AuthInfo } from "../types.ts";
import { logger } from "../logger.ts";
import type { ToolDeps } from "./index.ts";
import { LINK_RELATIONS } from "./table-constants.ts";

export function registerLinkEntities(server: McpServer, deps: ToolDeps): void {
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
        from_id: z.string().uuid().describe("Source node UUID"),
        to_type: z.string().min(1).max(200).describe("Target node type"),
        to_id: z.string().uuid().describe("Target node UUID"),
        relation: z
          .enum(LINK_RELATIONS)
          .describe("Relationship type between the two nodes"),
        namespace: z
          .string()
          .max(500)
          .optional()
          .describe("Namespace for isolation (defaults to agent's clientId)"),
        weight: z
          .number()
          .min(0)
          .max(100)
          .optional()
          .describe("Relationship weight (default 1.0)"),
        metadata: z
          .record(z.string().max(100), z.unknown())
          .optional()
          .refine(
            (v) =>
              !v ||
              (Object.keys(v).length <= 50 &&
                JSON.stringify(v).length <= 100_000),
            { message: "metadata: max 50 keys, max 100KB total" },
          )
          .describe("Arbitrary JSON metadata; max 50 keys, max 100KB total"),
      },
      annotations: {
        title: "Link Entities",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async (args, extra) => {
      const auth = extra.authInfo as AuthInfo | undefined;

      // Auth gate
      if (!auth || !canWrite(auth.role, "sessions")) {
        logger.warn("link_entities_denied", {
          role: auth?.role ?? "none",
          clientId: auth?.clientId ?? "none",
        });
        return {
          content: [
            {
              type: "text" as const,
              text: "Permission denied: cannot write links",
            },
          ],
          isError: true,
        };
      }

      // Self-link prevention (app-layer; DB CHECK also covers this)
      if (args.from_type === args.to_type && args.from_id === args.to_id) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Invalid link: cannot link a node to itself",
            },
          ],
          isError: true,
        };
      }

      const ns = args.namespace ?? auth.clientId;
      const nsCheck = canWriteNamespace(auth, ns);
      if (!nsCheck.allowed) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Permission denied: ${nsCheck.reason}`,
            },
          ],
          isError: true,
        };
      }
      const weight = args.weight ?? 1.0;

      logger.debug("link_entities_start", {
        from_type: args.from_type,
        from_id: args.from_id,
        to_type: args.to_type,
        to_id: args.to_id,
        relation: args.relation,
        namespace: ns,
        weight,
        clientId: auth.clientId,
      });

      try {
        const metadataJson = JSON.stringify(args.metadata ?? {});

        const { rows } = await deps.pool.query(
          `INSERT INTO ob_links
             (from_type, from_id, to_type, to_id, relation, weight, namespace, metadata, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)
           ON CONFLICT (namespace, from_type, from_id, to_type, to_id, relation)
           DO UPDATE SET
             weight = EXCLUDED.weight,
             metadata = ob_links.metadata || EXCLUDED.metadata,
             updated_at = NOW()
           RETURNING id, (xmax = 0) AS is_new, relation, weight, created_at`,
          [
            args.from_type,
            args.from_id,
            args.to_type,
            args.to_id,
            args.relation,
            weight,
            ns,
            metadataJson,
            auth.clientId,
          ],
        );

        const row = rows[0];
        const result = {
          id: row.id,
          from_type: args.from_type,
          from_id: args.from_id,
          to_type: args.to_type,
          to_id: args.to_id,
          relation: row.relation,
          weight: row.weight,
          is_new: row.is_new,
          created_at: row.created_at,
        };

        logger.info("link_entities_ok", {
          id: result.id,
          from_type: result.from_type,
          to_type: result.to_type,
          relation: result.relation,
          is_new: result.is_new,
        });

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(result),
            },
          ],
        };
      } catch (err) {
        logger.error("link_entities_db_error", {
          from_type: args.from_type,
          from_id: args.from_id,
          to_type: args.to_type,
          to_id: args.to_id,
          namespace: ns,
          error: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack : undefined,
        });
        return {
          content: [
            {
              type: "text" as const,
              text: `Database error during link upsert: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );
}
