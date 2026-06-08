import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { toSql } from "pgvector/pg";
import { canWrite } from "../permissions.ts";
import type { AuthInfo } from "../types.ts";
import { logger } from "../logger.ts";
import type { ToolDeps } from "./index.ts";

export function registerUpsertEntity(server: McpServer, deps: ToolDeps): void {
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
        title: "Upsert Entity",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async (args, extra) => {
      const auth = extra.authInfo as AuthInfo | undefined;

      // Auth gate
      if (!auth || !canWrite(auth.role, "sessions")) {
        logger.warn("upsert_entity_denied", {
          role: auth?.role ?? "none",
          clientId: auth?.clientId ?? "none",
          entity_type: args.entity_type,
          name: args.name,
        });
        return {
          content: [
            {
              type: "text" as const,
              text: "Permission denied: cannot write entities",
            },
          ],
          isError: true,
        };
      }

      const ns = args.namespace ?? auth.clientId;

      logger.debug("upsert_entity_start", {
        entity_type: args.entity_type,
        name: args.name,
        namespace: ns,
        clientId: auth.clientId,
      });

      try {
        // Generate embedding (non-fatal)
        const embeddingText = `${args.entity_type}: ${args.name}`;
        let embedding: number[] | null = null;
        try {
          embedding = await deps.embedFn(embeddingText);
        } catch (err) {
          logger.warn("upsert_entity_embed_error", {
            entity_type: args.entity_type,
            name: args.name,
            error: err instanceof Error ? err.message : String(err),
          });
        }

        const embeddingVal = embedding ? toSql(embedding) : null;
        const metadataJson = JSON.stringify(args.metadata ?? {});

        const { rows } = await deps.pool.query(
          `INSERT INTO ob_entities
             (entity_type, name, canonical_id, namespace, metadata, embedding, created_by)
           VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)
           ON CONFLICT (namespace, entity_type, lower(name))
           DO UPDATE SET
             canonical_id = COALESCE(EXCLUDED.canonical_id, ob_entities.canonical_id),
             metadata = ob_entities.metadata || EXCLUDED.metadata,
             embedding = COALESCE(EXCLUDED.embedding, ob_entities.embedding),
             updated_at = NOW()
           RETURNING id, (xmax = 0) AS is_new, entity_type, name, namespace, created_at, updated_at`,
          [
            args.entity_type,
            args.name,
            args.canonical_id ?? null,
            ns,
            metadataJson,
            embeddingVal,
            auth.clientId,
          ],
        );

        const row = rows[0];
        const result = {
          id: row.id,
          entity_type: row.entity_type,
          name: row.name,
          namespace: row.namespace,
          is_new: row.is_new,
          created_at: row.created_at,
          updated_at: row.updated_at,
        };

        logger.info("upsert_entity_ok", {
          id: result.id,
          entity_type: result.entity_type,
          name: result.name,
          namespace: result.namespace,
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
        logger.error("upsert_entity_db_error", {
          entity_type: args.entity_type,
          name: args.name,
          namespace: ns,
          error: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack : undefined,
        });
        return {
          content: [
            {
              type: "text" as const,
              text: `Database error during entity upsert: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );
}
