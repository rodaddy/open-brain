import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { toSql } from "pgvector/pg";
import { canWrite } from "../permissions.ts";
import { contentHash } from "../embedding.ts";
import type { AuthInfo } from "../types.ts";
import type { ToolDeps } from "./index.ts";

export function registerSessionSave(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "session_save",
    {
      description:
        "Save a session summary with structured fields for session continuity across context compactions",
      inputSchema: {
        summary: z.string().min(1).describe("Full session summary text"),
        project: z
          .string()
          .optional()
          .describe("Project name this session relates to"),
        tags: z.array(z.string()).optional().describe("Optional tags"),
        blockers: z.array(z.string()).optional().describe("Current blockers"),
        next_steps: z
          .array(z.string())
          .optional()
          .describe("Planned next steps"),
        key_decisions: z
          .array(z.string())
          .optional()
          .describe("Key decisions made during this session"),
      },
      annotations: {
        title: "Save Session",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
      },
    },
    async (args, extra) => {
      const auth = extra.authInfo as AuthInfo | undefined;
      if (!auth || !canWrite(auth.role, "sessions")) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Permission denied: cannot write to sessions",
            },
          ],
          isError: true,
        };
      }

      const hash = contentHash(args.summary);
      const embedding = await deps.embedFn(args.summary);

      const { rows } = await deps.pool.query(
        `INSERT INTO sessions (project, summary, tags, blockers, next_steps, key_decisions, created_by, embedding, content_hash, embedded_at, embedding_model)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         ON CONFLICT (content_hash) WHERE content_hash IS NOT NULL DO NOTHING
         RETURNING id`,
        [
          args.project ?? null,
          args.summary,
          args.tags ?? [],
          args.blockers ?? [],
          args.next_steps ?? [],
          args.key_decisions ?? [],
          auth.clientId,
          embedding ? toSql(embedding) : null,
          hash,
          embedding ? new Date().toISOString() : null,
          embedding ? "gemini-embedding-001" : null,
        ],
      );

      if (rows.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Duplicate: session with identical content already exists",
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
