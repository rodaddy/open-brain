import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { toSql } from "pgvector/pg";
import { canWrite } from "../permissions.ts";
import { canWriteNamespace } from "../namespace-policy.ts";
import { contentHash, EMBEDDING_MODEL } from "../embedding.ts";
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
          .max(500)
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
        agent: z
          .string()
          .max(500)
          .optional()
          .describe("Agent name/ID owning this lane"),
        source: z
          .string()
          .max(500)
          .optional()
          .describe("Source platform (discord, telegram, cli, etc.)"),
        channel_id: z
          .string()
          .max(500)
          .optional()
          .describe("Discord/platform channel ID"),
        thread_id: z
          .string()
          .max(500)
          .optional()
          .describe("Discord/platform thread ID"),
        project: z
          .string()
          .max(500)
          .optional()
          .describe("Project name this lane relates to"),
        topic: z
          .string()
          .max(500)
          .optional()
          .describe("Human-readable topic description"),
        current_context_md: z
          .string()
          .max(100_000)
          .optional()
          .describe(
            "Materialized markdown summary of current lane state — the portable context blob",
          ),
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
          .describe(
            "Arbitrary JSON metadata — merged into existing via || on update; max 50 keys",
          ),
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
      // $3 stays nullable so the ON CONFLICT CASE branches can detect
      // "status omitted" and preserve the existing lane status. insertStatus
      // is used only for the INSERT VALUES, where the NOT NULL column must
      // receive the 'active' default for brand-new lanes (an explicit NULL
      // overrides the column default and trips the NOT NULL constraint).
      const status = args.status ?? null;
      const insertStatus = args.status ?? "active";

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
      const contextText = args.current_context_md || args.topic || "";
      const hash = contextText
        ? contentHash(args.session_key + "|" + contextText)
        : null;

      let embedding: number[] | null = null;
      if (contextText) {
        const embedParts = [contextText];
        // Only append topic separately when contextText came from current_context_md
        // to avoid double-weighting topic when topic IS the contextText
        if (args.topic && args.current_context_md) embedParts.push(args.topic);
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
      const model = embedding ? EMBEDDING_MODEL : null;

      try {
        // Helper: convert explicit empty string to SQL NULL for intentional
        // field clearing. COALESCE in the ON CONFLICT clause preserves existing
        // values when the EXCLUDED value is NULL, so we use CASE WHEN flags
        // to allow explicit clearing when the caller passes "".
        const clearable = (v: string | undefined | null): string | null =>
          v === "" ? null : (v ?? null);

        const { rows } = await deps.pool.query(
          `INSERT INTO ob_session_lanes
             (session_key, namespace, status, agent, source, channel_id, thread_id,
              project, topic, current_context_md, metadata,
              embedding, content_hash, embedded_at, embedding_model, created_by)
           VALUES ($1, $2, $24, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
           ON CONFLICT (namespace, session_key)
           DO UPDATE SET
             status = CASE WHEN $3 IS NULL THEN ob_session_lanes.status ELSE EXCLUDED.status END,
             agent = CASE WHEN $17 THEN EXCLUDED.agent ELSE COALESCE(EXCLUDED.agent, ob_session_lanes.agent) END,
             source = CASE WHEN $18 THEN EXCLUDED.source ELSE COALESCE(EXCLUDED.source, ob_session_lanes.source) END,
             channel_id = CASE WHEN $19 THEN EXCLUDED.channel_id ELSE COALESCE(EXCLUDED.channel_id, ob_session_lanes.channel_id) END,
             thread_id = CASE WHEN $20 THEN EXCLUDED.thread_id ELSE COALESCE(EXCLUDED.thread_id, ob_session_lanes.thread_id) END,
             project = CASE WHEN $21 THEN EXCLUDED.project ELSE COALESCE(EXCLUDED.project, ob_session_lanes.project) END,
             topic = CASE WHEN $22 THEN EXCLUDED.topic ELSE COALESCE(EXCLUDED.topic, ob_session_lanes.topic) END,
             current_context_md = CASE WHEN $23 THEN EXCLUDED.current_context_md ELSE COALESCE(EXCLUDED.current_context_md, ob_session_lanes.current_context_md) END,
             metadata = CASE WHEN EXCLUDED.metadata = '{}'::jsonb
                        THEN ob_session_lanes.metadata
                        ELSE ob_session_lanes.metadata || EXCLUDED.metadata END,
             embedding = COALESCE(EXCLUDED.embedding, ob_session_lanes.embedding),
             content_hash = COALESCE(EXCLUDED.content_hash, ob_session_lanes.content_hash),
             embedded_at = COALESCE(EXCLUDED.embedded_at, ob_session_lanes.embedded_at),
             embedding_model = COALESCE(EXCLUDED.embedding_model, ob_session_lanes.embedding_model),
             ended_at = CASE WHEN $3 = 'wrapped' OR $3 = 'archived'
                        THEN COALESCE(ob_session_lanes.ended_at, NOW())
                        WHEN $3 = 'active'
                        THEN NULL
                        ELSE ob_session_lanes.ended_at END
           RETURNING id, (xmax = 0) AS is_new, status, updated_at`,
          [
            args.session_key,
            ns,
            status,
            clearable(args.agent),
            clearable(args.source),
            clearable(args.channel_id),
            clearable(args.thread_id),
            clearable(args.project),
            clearable(args.topic),
            clearable(args.current_context_md),
            JSON.stringify(args.metadata ?? {}),
            embeddingVal,
            hash,
            embeddedAt,
            model,
            auth.clientId,
            // Explicit-clear flags ($17-$23): true when the caller passed ""
            args.agent === "",
            args.source === "",
            args.channel_id === "",
            args.thread_id === "",
            args.project === "",
            args.topic === "",
            args.current_context_md === "",
            // $24 — INSERT VALUES status; never NULL so new lanes satisfy the
            // NOT NULL constraint. ON CONFLICT logic keys off $3 (nullable).
            insertStatus,
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
