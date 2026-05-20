import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { toSql } from "pgvector/pg";
import { canWrite } from "../permissions.ts";
import { contentHash } from "../embedding.ts";
import { backgroundExtract } from "../extraction.ts";
import { shouldChunk, chunkText } from "../chunking.ts";
import type { AuthInfo } from "../types.ts";
import { logger } from "../logger.ts";
import type { ToolDeps } from "./index.ts";

export function registerLogThought(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "log_thought",
    {
      description: "Log a thought, idea, or observation to the brain",
      inputSchema: {
        content: z.string().min(1).describe("The thought content"),
        tags: z.array(z.string()).optional().describe("Optional tags"),
      },
      annotations: {
        title: "Log Thought",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
      },
    },
    async (args, extra) => {
      const auth = extra.authInfo as AuthInfo | undefined;
      if (!auth || !canWrite(auth.role, "thoughts")) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Permission denied: cannot write to thoughts",
            },
          ],
          isError: true,
        };
      }

      const hash = contentHash(args.content);
      const tags = args.tags ?? [];

      // --- Chunked path for long content ---
      if (shouldChunk(args.content)) {
        logger.info("log_thought_chunking", {
          content_length: args.content.length,
        });

        // Insert parent row: full content, NO embedding (too long for single embed)
        const { rows: parentRows } = await deps.pool.query(
          `INSERT INTO thoughts (content, tags, source, created_by, embedding, content_hash, embedded_at, embedding_model)
           VALUES ($1, $2, 'mcp', $3, NULL, $4, NULL, NULL)
           ON CONFLICT (content_hash) WHERE content_hash IS NOT NULL
           DO UPDATE SET
             tags = (
               SELECT COALESCE(array_agg(DISTINCT tag), '{}')
               FROM unnest(thoughts.tags || EXCLUDED.tags) AS tag
               WHERE tag IS NOT NULL
             ),
             updated_at = NOW()
           RETURNING id, (xmax = 0) AS is_new`,
          [args.content, tags, auth.clientId, hash],
        );

        const parentId = parentRows[0].id as string;
        const isNew = parentRows[0].is_new as boolean;

        if (isNew) {
          // Generate and insert chunks with embeddings
          const chunks = chunkText(args.content);
          let embeddedCount = 0;

          for (const chunk of chunks) {
            const chunkTextToEmbed = tags.length
              ? `${chunk.text}\n${tags.join(" ")}`
              : chunk.text;
            const chunkEmbedding = await deps.embedFn(chunkTextToEmbed);
            if (chunkEmbedding) embeddedCount++;

            await deps.pool.query(
              `INSERT INTO thoughts (content, tags, source, created_by, embedding, content_hash, embedded_at, embedding_model, parent_id, chunk_index)
               VALUES ($1, $2, 'mcp', $3, $4, NULL, $5, $6, $7, $8)`,
              [
                chunk.text,
                tags,
                auth.clientId,
                chunkEmbedding ? toSql(chunkEmbedding) : null,
                chunkEmbedding ? new Date().toISOString() : null,
                chunkEmbedding ? "gemini-embedding-001" : null,
                parentId,
                chunk.index,
              ],
            );
          }

          logger.info("log_thought_chunks_inserted", {
            parent_id: parentId,
            chunk_count: chunks.length,
            embedded_count: embeddedCount,
          });

          // backgroundExtract on parent only
          backgroundExtract(deps.pool, "thoughts", parentId, args.content, tags);

          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  id: parentId,
                  embedded: true,
                  chunked: true,
                  chunk_count: chunks.length,
                }),
              },
            ],
          };
        }

        // Existing duplicate was merged
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                id: parentId,
                embedded: false,
                merged: true,
              }),
            },
          ],
        };
      }

      // --- Short content path (unchanged) ---
      const textToEmbed = tags.length
        ? `${args.content}\n${tags.join(" ")}`
        : args.content;
      const embedding = await deps.embedFn(textToEmbed);
      logger.info("tool_embedding", {
        tool: "log_thought",
        embedded: !!embedding,
      });

      const { rows } = await deps.pool.query(
        `INSERT INTO thoughts (content, tags, source, created_by, embedding, content_hash, embedded_at, embedding_model)
         VALUES ($1, $2, 'mcp', $3, $4, $5, $6, $7)
         ON CONFLICT (content_hash) WHERE content_hash IS NOT NULL
         DO UPDATE SET
           tags = (
             SELECT COALESCE(array_agg(DISTINCT tag), '{}')
             FROM unnest(thoughts.tags || EXCLUDED.tags) AS tag
             WHERE tag IS NOT NULL
           ),
           updated_at = NOW()
         RETURNING id, (xmax = 0) AS is_new`,
        [
          args.content,
          tags,
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
        backgroundExtract(
          deps.pool,
          "thoughts",
          entryId,
          args.content,
          tags,
        );
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
