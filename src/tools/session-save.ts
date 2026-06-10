import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { toSql } from "pgvector/pg";
import { canWrite } from "../permissions.ts";
import { canWriteNamespace } from "../namespace-policy.ts";
import { contentHash, EMBEDDING_MODEL } from "../embedding.ts";
import type { AuthInfo } from "../types.ts";
import { logger } from "../logger.ts";
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
        session_id: z
          .string()
          .optional()
          .describe(
            "External session ID (e.g. from session-wrap uuidgen). Enables upsert: re-pushing the same session_id updates instead of duplicating.",
          ),
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
        namespace: z
          .string()
          .min(1)
          .max(500)
          .optional()
          .describe("Namespace to store in (defaults to caller's clientId)"),
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

      const hash = contentHash(args.summary + "|" + (args.project ?? ""));
      const embedParts = [args.summary];
      if (args.key_decisions?.length)
        embedParts.push(args.key_decisions.join(". "));
      if (args.next_steps?.length) embedParts.push(args.next_steps.join(". "));
      if (args.blockers?.length) embedParts.push(args.blockers.join(". "));
      const embedding = await deps.embedFn(embedParts.join("\n"));
      logger.info("tool_embedding", {
        tool: "session_save",
        embedded: !!embedding,
      });

      const embeddingVal = embedding ? toSql(embedding) : null;
      const embeddedAt = embedding ? new Date().toISOString() : null;
      const model = embedding ? EMBEDDING_MODEL : null;

      // If session_id provided, upsert: re-push updates the existing entry
      if (args.session_id) {
        const { rows } = await deps.pool.query(
          `INSERT INTO sessions (session_id, project, summary, tags, blockers, next_steps, key_decisions, created_by, namespace, embedding, content_hash, embedded_at, embedding_model)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
           ON CONFLICT (namespace, session_id) WHERE session_id IS NOT NULL
           DO UPDATE SET
             summary = EXCLUDED.summary,
             tags = EXCLUDED.tags,
             blockers = EXCLUDED.blockers,
             next_steps = EXCLUDED.next_steps,
             key_decisions = EXCLUDED.key_decisions,
             embedding = EXCLUDED.embedding,
             content_hash = EXCLUDED.content_hash,
             embedded_at = EXCLUDED.embedded_at,
             updated_at = NOW()
           RETURNING id, (xmax = 0) AS is_new`,
          [
            args.session_id,
            args.project ?? null,
            args.summary,
            args.tags ?? [],
            args.blockers ?? [],
            args.next_steps ?? [],
            args.key_decisions ?? [],
            auth.clientId,
            ns,
            embeddingVal,
            hash,
            embeddedAt,
            model,
          ],
        );

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                id: rows[0].id,
                namespace: ns,
                session_id: args.session_id,
                embedded: !!embedding,
                merged: !rows[0].is_new,
              }),
            },
          ],
        };
      }

      // Legacy path: content_hash dedup (no session_id)
      const { rows } = await deps.pool.query(
        `INSERT INTO sessions (project, summary, tags, blockers, next_steps, key_decisions, created_by, namespace, embedding, content_hash, embedded_at, embedding_model)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         ON CONFLICT (content_hash, namespace) WHERE content_hash IS NOT NULL DO NOTHING
         RETURNING id`,
        [
          args.project ?? null,
          args.summary,
          args.tags ?? [],
          args.blockers ?? [],
          args.next_steps ?? [],
          args.key_decisions ?? [],
          auth.clientId,
          ns,
          embeddingVal,
          hash,
          embeddedAt,
          model,
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
              namespace: ns,
              embedded: !!embedding,
            }),
          },
        ],
      };
    },
  );
}
