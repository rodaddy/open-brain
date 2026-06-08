import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { toSql } from "pgvector/pg";
import { canWrite } from "../permissions.ts";
import { contentHash, EMBEDDING_MODEL } from "../embedding.ts";
import { backgroundExtract } from "../extraction.ts";
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
      const textToEmbed = args.tags?.length
        ? `${args.content}\n${args.tags.join(" ")}`
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
          args.tags ?? [],
          auth.clientId,
          embedding ? toSql(embedding) : null,
          hash,
          embedding ? new Date().toISOString() : null,
          embedding ? EMBEDDING_MODEL : null,
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
          args.tags ?? [],
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
