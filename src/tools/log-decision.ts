import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { toSql } from "pgvector/pg";
import { canWrite } from "../permissions.ts";
import { contentHash } from "../embedding.ts";
import { extractMetadata, mergeTags } from "../extraction.ts";
import type { AuthInfo } from "../types.ts";
import { logger } from "../logger.ts";
import type { ToolDeps } from "./index.ts";

export function registerLogDecision(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "log_decision",
    {
      description:
        "Record a decision with rationale and alternatives considered",
      inputSchema: {
        title: z.string().min(1).describe("Decision title"),
        rationale: z.string().min(1).describe("Why this decision was made"),
        alternatives: z
          .array(z.string())
          .optional()
          .describe("Alternatives that were considered"),
        tags: z.array(z.string()).optional().describe("Optional tags"),
        context: z.string().optional().describe("Additional context"),
      },
      annotations: {
        title: "Log Decision",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
      },
    },
    async (args, extra) => {
      const auth = extra.authInfo as AuthInfo | undefined;
      if (!auth || !canWrite(auth.role, "decisions")) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Permission denied: cannot write to decisions",
            },
          ],
          isError: true,
        };
      }

      const textToEmbed = `${args.title}\n${args.rationale}`;
      const hash = contentHash(textToEmbed);
      const embedding = await deps.embedFn(textToEmbed);
      logger.info("tool_embedding", {
        tool: "log_decision",
        embedded: !!embedding,
      });

      const { rows } = await deps.pool.query(
        `INSERT INTO decisions (title, rationale, alternatives, tags, context, created_by, embedding, content_hash, embedded_at, embedding_model)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (content_hash) WHERE content_hash IS NOT NULL
         DO UPDATE SET
           tags = (
             SELECT COALESCE(array_agg(DISTINCT tag), '{}')
             FROM unnest(decisions.tags || EXCLUDED.tags) AS tag
             WHERE tag IS NOT NULL
           ),
           updated_at = NOW()
         RETURNING id, (xmax = 0) AS is_new`,
        [
          args.title,
          args.rationale,
          JSON.stringify(args.alternatives ?? []),
          args.tags ?? [],
          args.context ?? null,
          auth.clientId,
          embedding ? toSql(embedding) : null,
          hash,
          embedding ? new Date().toISOString() : null,
          embedding ? "gemini-embedding-001" : null,
        ],
      );

      const entryId = rows[0].id as string;
      const isNew = rows[0].is_new as boolean;

      if (isNew) {
        extractMetadata(textToEmbed)
          .then((extracted) => {
            if (!extracted) return;
            const enrichedTags = mergeTags(args.tags ?? [], extracted);
            deps.pool
              .query(
                `UPDATE decisions SET tags = $1, extracted_metadata = $2 WHERE id = $3`,
                [enrichedTags, JSON.stringify(extracted), entryId],
              )
              .catch((err: unknown) => {
                logger.warn("extraction_update_error", {
                  id: entryId,
                  error: err instanceof Error ? err.message : String(err),
                });
              });
          })
          .catch(() => {});
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              id: entryId,
              embedded: !!embedding,
              merged: !isNew,
            }),
          },
        ],
      };
    },
  );
}
