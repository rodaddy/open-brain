import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { toSql } from "pgvector/pg";
import { canWrite } from "../permissions.ts";
import { contentHash } from "../embedding.ts";
import type { AuthInfo } from "../types.ts";
import { logger } from "../logger.ts";
import type { ToolDeps } from "./index.ts";

export function registerUpsertPerson(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "upsert_person",
    {
      description:
        "Create or update a person/contact in the brain. Matches on person_name (case-insensitive). If the person exists, updates provided fields; if not, creates a new record.",
      inputSchema: {
        name: z
          .string()
          .min(1)
          .describe("Person's full name (used as unique key)"),
        context: z
          .string()
          .optional()
          .describe("How you know them, where they work, etc."),
        relationship_type: z
          .string()
          .optional()
          .describe(
            "Relationship category: friend, family, colleague, acquaintance, etc.",
          ),
        warmth: z
          .number()
          .int()
          .min(1)
          .max(5)
          .optional()
          .describe("Closeness rating 1-5 (1=distant, 5=very close)"),
        last_contact: z
          .string()
          .optional()
          .describe("Date of last contact (ISO 8601 date, e.g. 2026-03-19)"),
        email: z.string().optional().describe("Email address"),
        phone: z.string().optional().describe("Phone number"),
        notes: z
          .string()
          .optional()
          .describe("Freeform notes about the person"),
        tags: z
          .array(z.string())
          .optional()
          .describe("Tags for categorization"),
        metadata: z
          .record(z.string(), z.unknown())
          .optional()
          .describe(
            "Additional structured data (e.g. apple_id, imessage, social handles)",
          ),
      },
      annotations: {
        title: "Upsert Person",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async (args, extra) => {
      const auth = extra.authInfo as AuthInfo | undefined;
      if (!auth || !canWrite(auth.role, "relationships")) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Permission denied: cannot write to relationships",
            },
          ],
          isError: true,
        };
      }

      // Build embeddable text: name + context + notes
      const embeddableText = [args.name, args.context ?? "", args.notes ?? ""]
        .filter(Boolean)
        .join("\n");

      const hash = contentHash(embeddableText);
      const embedding = await deps.embedFn(embeddableText);
      logger.info("tool_embedding", {
        tool: "upsert_person",
        embedded: !!embedding,
      });

      const { rows } = await deps.pool.query(
        `INSERT INTO relationships (
          person_name, context, relationship_type, warmth, last_contact,
          email, phone, notes, tags, metadata,
          created_by, embedding, content_hash, embedded_at, embedding_model
        ) VALUES (
          $1, $2, $3, $4, $5::date,
          $6, $7, $8, COALESCE($9::text[], '{}'), COALESCE($10::jsonb, '{}'),
          $11, $12, $13, $14, $15
        )
        ON CONFLICT (person_name) DO UPDATE SET
          context = COALESCE(EXCLUDED.context, relationships.context),
          relationship_type = COALESCE(EXCLUDED.relationship_type, relationships.relationship_type),
          warmth = COALESCE(EXCLUDED.warmth, relationships.warmth),
          last_contact = COALESCE(EXCLUDED.last_contact, relationships.last_contact),
          email = COALESCE(EXCLUDED.email, relationships.email),
          phone = COALESCE(EXCLUDED.phone, relationships.phone),
          notes = COALESCE(EXCLUDED.notes, relationships.notes),
          tags = CASE WHEN $9 IS NOT NULL THEN EXCLUDED.tags ELSE relationships.tags END,
          metadata = CASE WHEN $10 IS NOT NULL THEN EXCLUDED.metadata ELSE relationships.metadata END,
          embedding = EXCLUDED.embedding,
          content_hash = EXCLUDED.content_hash,
          embedded_at = EXCLUDED.embedded_at,
          embedding_model = EXCLUDED.embedding_model
        RETURNING id, (xmax = 0) AS inserted`,
        [
          args.name,
          args.context ?? null,
          args.relationship_type ?? null,
          args.warmth ?? null,
          args.last_contact ?? null,
          args.email ?? null,
          args.phone ?? null,
          args.notes ?? null,
          args.tags ?? null,
          args.metadata ? JSON.stringify(args.metadata) : null,
          auth.clientId,
          embedding ? toSql(embedding) : null,
          hash,
          embedding ? new Date().toISOString() : null,
          embedding ? "gemini-embedding-001" : null,
        ],
      );

      const row = rows[0];
      const action = row.inserted ? "created" : "updated";

      logger.info("upsert_person_success", {
        id: row.id,
        person_name: args.name,
        action,
      });

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              id: row.id,
              person_name: args.name,
              action,
              embedded: !!embedding,
            }),
          },
        ],
      };
    },
  );
}
