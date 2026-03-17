import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { toSql } from "pgvector/pg";
import { canWrite } from "../permissions.ts";
import { contentHash } from "../embedding.ts";
import { extractMetadata, mergeTags } from "../extraction.ts";
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
      const [embedding, extracted] = await Promise.all([
        deps.embedFn(args.content),
        extractMetadata(args.content),
      ]);
      logger.info("tool_embedding", {
        tool: "log_thought",
        embedded: !!embedding,
        extracted: !!extracted,
      });

      const enrichedTags = mergeTags(args.tags ?? [], extracted);

      const { rows } = await deps.pool.query(
        `INSERT INTO thoughts (content, tags, source, created_by, embedding, content_hash, embedded_at, embedding_model, extracted_metadata)
         VALUES ($1, $2, 'mcp', $3, $4, $5, $6, $7, $8)
         ON CONFLICT (content_hash) WHERE content_hash IS NOT NULL DO NOTHING
         RETURNING id`,
        [
          args.content,
          enrichedTags,
          auth.clientId,
          embedding ? toSql(embedding) : null,
          hash,
          embedding ? new Date().toISOString() : null,
          embedding ? "gemini-embedding-001" : null,
          extracted ? JSON.stringify(extracted) : null,
        ],
      );

      if (rows.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Duplicate: thought with identical content already exists",
            },
          ],
        };
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              id: rows[0].id,
              embedded: !!embedding,
            }),
          },
        ],
      };
    },
  );
}
