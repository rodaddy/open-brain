import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { toSql } from "pgvector/pg";
import { canWrite } from "../permissions.ts";
import { contentHash, EMBEDDING_MODEL } from "../embedding.ts";
import type { AuthInfo } from "../types.ts";
import { logger } from "../logger.ts";
import type { ToolDeps } from "./index.ts";
import { EVENT_TYPES, IMPORTANCE_LEVELS } from "./table-constants.ts";

export function registerAppendSessionEvent(
  server: McpServer,
  deps: ToolDeps,
): void {
  server.registerTool(
    "append_session_event",
    {
      description:
        "Append an event to a session lane's journal. Events are append-only " +
        "and capture discrete facts, decisions, blockers, actions, etc.",
      inputSchema: {
        session_key: z
          .string()
          .min(1)
          .max(500)
          .describe(
            "Session key identifying the lane to append to (looked up by namespace + session_key)",
          ),
        namespace: z
          .string()
          .max(500)
          .optional()
          .describe("Namespace for isolation (defaults to agent's clientId)"),
        event_type: z
          .enum(EVENT_TYPES)
          .describe(
            "Type of event: fact, decision, blocker, action, artifact, receipt, question, correction, handoff",
          ),
        content: z
          .string()
          .min(1)
          .max(50_000)
          .describe("Event content — what happened"),
        source: z
          .string()
          .max(500)
          .optional()
          .describe("Source of the event (agent name, tool, user, etc.)"),
        artifact_path: z
          .string()
          .max(2000)
          .optional()
          .describe("Path to related artifact (file, URL, etc.)"),
        importance: z
          .enum(IMPORTANCE_LEVELS)
          .optional()
          .describe("Event importance: hot, warm (default), cold"),
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
        title: "Append Session Event",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async (args, extra) => {
      const auth = extra.authInfo as AuthInfo | undefined;

      // Auth gate
      if (!auth || !canWrite(auth.role, "sessions")) {
        logger.warn("append_session_event_denied", {
          role: auth?.role ?? "none",
          clientId: auth?.clientId ?? "none",
          session_key: args.session_key,
        });
        return {
          content: [
            {
              type: "text" as const,
              text: "Permission denied: cannot write to session events",
            },
          ],
          isError: true,
        };
      }

      const ns = args.namespace ?? auth.clientId;
      const importance = args.importance ?? "warm";

      logger.debug("append_session_event_start", {
        session_key: args.session_key,
        namespace: ns,
        event_type: args.event_type,
        importance,
        clientId: auth.clientId,
        content_length: args.content.length,
      });

      try {
        // Look up the lane
        const { rows: laneRows } = await deps.pool.query(
          `SELECT id, status FROM ob_session_lanes WHERE namespace = $1 AND session_key = $2`,
          [ns, args.session_key],
        );

        if (laneRows.length === 0) {
          logger.info("append_session_event_lane_not_found", {
            session_key: args.session_key,
            namespace: ns,
          });
          return {
            content: [
              {
                type: "text" as const,
                text: `Lane not found for session_key "${args.session_key}" in namespace "${ns}"`,
              },
            ],
            isError: true,
          };
        }

        if (laneRows[0].status === "archived") {
          return {
            content: [
              {
                type: "text" as const,
                text: `Lane "${args.session_key}" is archived; reactivate before appending events`,
              },
            ],
            isError: true,
          };
        }

        const laneId = laneRows[0].id;

        // Generate embedding (non-fatal)
        let embedding: number[] | null = null;
        try {
          embedding = await deps.embedFn(args.content);
        } catch (err) {
          logger.warn("append_session_event_embed_error", {
            session_key: args.session_key,
            error: err instanceof Error ? err.message : String(err),
          });
        }

        const hash = contentHash(args.content);
        const embeddingVal = embedding ? toSql(embedding) : null;
        const embeddedAt = embedding ? new Date().toISOString() : null;
        const model = embedding ? EMBEDDING_MODEL : null;

        const { rows } = await deps.pool.query(
          `INSERT INTO ob_session_events
             (lane_id, event_type, content, source, artifact_path, importance,
              metadata, embedding, content_hash, embedded_at, embedding_model, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
           ON CONFLICT (lane_id, content_hash) WHERE content_hash IS NOT NULL DO NOTHING
           RETURNING id, created_at`,
          [
            laneId,
            args.event_type,
            args.content,
            args.source ?? null,
            args.artifact_path ?? null,
            importance,
            JSON.stringify(args.metadata ?? {}),
            embeddingVal,
            hash,
            embeddedAt,
            model,
            auth.clientId,
          ],
        );

        if (rows.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  duplicate: true,
                  message:
                    "Event with identical content already exists in this lane",
                }),
              },
            ],
          };
        }

        const result = {
          event_id: rows[0].id,
          lane_id: laneId,
          event_type: args.event_type,
          importance,
          created_at: rows[0].created_at,
        };

        logger.info("append_session_event_ok", {
          event_id: result.event_id,
          lane_id: result.lane_id,
          event_type: result.event_type,
          importance: result.importance,
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
        logger.error("append_session_event_db_error", {
          session_key: args.session_key,
          namespace: ns,
          error: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack : undefined,
        });
        return {
          content: [
            {
              type: "text" as const,
              text: `Database error during event append: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );
}
