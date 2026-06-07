import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { toSql } from "pgvector/pg";
import { canWrite } from "../permissions.ts";
import { contentHash } from "../embedding.ts";
import type { AuthInfo } from "../types.ts";
import { logger } from "../logger.ts";
import type { ToolDeps } from "./index.ts";

export function registerLaneUpsert(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "lane_upsert",
    {
      description:
        "Create or update a durable session lane. Upserts by namespace + session_key. " +
        "Use this to attach ongoing work to a stable key that survives compaction/reset.",
      inputSchema: {
        session_key: z
          .string()
          .min(1)
          .describe(
            "Stable human/agent-readable lane identifier (e.g. discord thread ID, task ID, project slug)",
          ),
        namespace: z
          .string()
          .optional()
          .describe("Namespace for isolation (defaults to agent's clientId)"),
        status: z
          .enum(["active", "wrapped", "archived"])
          .optional()
          .describe("Lane status (default: active)"),
        agent: z.string().optional().describe("Agent name/ID owning this lane"),
        source: z
          .string()
          .optional()
          .describe("Source platform (discord, telegram, cli, etc.)"),
        channel_id: z
          .string()
          .optional()
          .describe("Discord/platform channel ID"),
        thread_id: z
          .string()
          .optional()
          .describe("Discord/platform thread ID"),
        project: z
          .string()
          .optional()
          .describe("Project name this lane relates to"),
        topic: z
          .string()
          .optional()
          .describe("Human-readable topic description"),
        current_context_md: z
          .string()
          .optional()
          .describe(
            "Materialized markdown summary of current lane state — the portable context blob",
          ),
        metadata: z
          .record(z.string(), z.unknown())
          .optional()
          .describe("Arbitrary JSON metadata"),
      },
      annotations: {
        title: "Upsert Session Lane",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async (args, extra) => {
      const auth = extra.authInfo as AuthInfo | undefined;

      // Auth gate
      if (!auth || !canWrite(auth.role, "sessions")) {
        logger.warn("lane_upsert_denied", {
          role: auth?.role ?? "none",
          clientId: auth?.clientId ?? "none",
          session_key: args.session_key,
        });
        return {
          content: [
            {
              type: "text" as const,
              text: "Permission denied: cannot write to session lanes",
            },
          ],
          isError: true,
        };
      }

      const ns = args.namespace ?? auth.clientId;
      const status = args.status ?? "active";

      logger.debug("lane_upsert_start", {
        session_key: args.session_key,
        namespace: ns,
        status,
        agent: args.agent ?? null,
        project: args.project ?? null,
        clientId: auth.clientId,
        has_context: !!args.current_context_md,
        context_length: args.current_context_md?.length ?? 0,
      });

      // Build embedding from context
      const contextText = args.current_context_md ?? args.topic ?? "";
      const hash = contextText
        ? contentHash(args.session_key + "|" + contextText)
        : null;

      let embedding: number[] | null = null;
      if (contextText) {
        const embedParts = [contextText];
        if (args.topic) embedParts.push(args.topic);
        if (args.project) embedParts.push(args.project);
        try {
          embedding = await deps.embedFn(embedParts.join("\n"));
        } catch (err) {
          logger.warn("lane_upsert_embed_error", {
            session_key: args.session_key,
            error: err instanceof Error ? err.message : String(err),
          });
          // Continue without embedding — not fatal
        }
      }

      logger.debug("lane_upsert_embedding", {
        session_key: args.session_key,
        embedded: !!embedding,
        context_chars: contextText.length,
      });

      const embeddingVal = embedding ? toSql(embedding) : null;
      const embeddedAt = embedding ? new Date().toISOString() : null;
      const model = embedding ? "gemini-embedding-001" : null;

      try {
        const { rows } = await deps.pool.query(
          `INSERT INTO ob_session_lanes
             (session_key, namespace, status, agent, source, channel_id, thread_id,
              project, topic, current_context_md, metadata,
              embedding, content_hash, embedded_at, embedding_model, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
           ON CONFLICT (namespace, session_key)
           DO UPDATE SET
             status = COALESCE(EXCLUDED.status, ob_session_lanes.status),
             agent = COALESCE(EXCLUDED.agent, ob_session_lanes.agent),
             source = COALESCE(EXCLUDED.source, ob_session_lanes.source),
             channel_id = COALESCE(EXCLUDED.channel_id, ob_session_lanes.channel_id),
             thread_id = COALESCE(EXCLUDED.thread_id, ob_session_lanes.thread_id),
             project = COALESCE(EXCLUDED.project, ob_session_lanes.project),
             topic = COALESCE(EXCLUDED.topic, ob_session_lanes.topic),
             current_context_md = COALESCE(EXCLUDED.current_context_md, ob_session_lanes.current_context_md),
             metadata = ob_session_lanes.metadata || EXCLUDED.metadata,
             embedding = COALESCE(EXCLUDED.embedding, ob_session_lanes.embedding),
             content_hash = COALESCE(EXCLUDED.content_hash, ob_session_lanes.content_hash),
             embedded_at = COALESCE(EXCLUDED.embedded_at, ob_session_lanes.embedded_at),
             embedding_model = COALESCE(EXCLUDED.embedding_model, ob_session_lanes.embedding_model),
             ended_at = CASE WHEN EXCLUDED.status = 'wrapped' OR EXCLUDED.status = 'archived'
                        THEN COALESCE(ob_session_lanes.ended_at, NOW())
                        ELSE NULL END
           RETURNING id, (xmax = 0) AS is_new, status, updated_at`,
          [
            args.session_key,
            ns,
            status,
            args.agent ?? null,
            args.source ?? null,
            args.channel_id ?? null,
            args.thread_id ?? null,
            args.project ?? null,
            args.topic ?? null,
            args.current_context_md ?? null,
            JSON.stringify(args.metadata ?? {}),
            embeddingVal,
            hash,
            embeddedAt,
            model,
            auth.clientId,
          ],
        );

        const result = {
          id: rows[0].id,
          session_key: args.session_key,
          namespace: ns,
          status: rows[0].status,
          is_new: rows[0].is_new,
          embedded: !!embedding,
          updated_at: rows[0].updated_at,
        };

        logger.info("lane_upsert_ok", {
          id: result.id,
          session_key: result.session_key,
          namespace: result.namespace,
          is_new: result.is_new,
          status: result.status,
          embedded: result.embedded,
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
        logger.error("lane_upsert_db_error", {
          session_key: args.session_key,
          namespace: ns,
          error: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack : undefined,
        });
        return {
          content: [
            {
              type: "text" as const,
              text: `Database error during lane upsert: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );
}
