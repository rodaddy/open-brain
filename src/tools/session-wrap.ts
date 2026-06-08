import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { toSql } from "pgvector/pg";
import { canWrite } from "../permissions.ts";
import { contentHash, EMBEDDING_MODEL } from "../embedding.ts";
import type { AuthInfo } from "../types.ts";
import { logger } from "../logger.ts";
import type { ToolDeps } from "./index.ts";

export function registerSessionWrap(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "session_wrap",
    {
      description:
        "Persist a caller-provided session summary to OB and mark the lane as wrapped. " +
        "Pure DB write — no LLM calls. The caller distills the summary from events before calling this.",
      inputSchema: {
        session_key: z
          .string()
          .min(1)
          .max(500)
          .describe("Session key identifying the lane to wrap"),
        namespace: z
          .string()
          .max(500)
          .optional()
          .describe("Namespace for isolation (defaults to agent's clientId)"),
        summary: z
          .string()
          .max(100_000)
          .describe("The distilled session summary"),
        key_decisions: z
          .array(z.string().max(2000))
          .max(20)
          .optional()
          .describe("Key decisions made during this session"),
        next_steps: z
          .array(z.string().max(2000))
          .max(20)
          .optional()
          .describe("Planned next steps"),
        project: z
          .string()
          .max(500)
          .optional()
          .describe("Project name for the session record"),
        keep_active: z
          .boolean()
          .optional()
          .describe(
            "If true, persist summary but don't wrap the lane (default: false)",
          ),
      },
      annotations: {
        title: "Session Wrap",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
      },
    },
    async (args, extra) => {
      const auth = extra.authInfo as AuthInfo | undefined;

      // Auth gate
      if (!auth || !canWrite(auth.role, "sessions")) {
        logger.warn("session_wrap_denied", {
          role: auth?.role ?? "none",
          clientId: auth?.clientId ?? "none",
          session_key: args.session_key,
        });
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
      const keepActive = args.keep_active ?? false;

      logger.debug("session_wrap_begin", {
        session_key: args.session_key,
        namespace: ns,
        keep_active: keepActive,
        summary_length: args.summary.length,
        clientId: auth.clientId,
      });

      try {
        // Step 1: Look up lane
        const { rows: laneRows } = await deps.pool.query(
          `SELECT id, status, project, agent, topic
FROM ob_session_lanes
WHERE namespace = $1 AND session_key = $2`,
          [ns, args.session_key],
        );

        if (laneRows.length === 0) {
          logger.info("session_wrap_lane_not_found", {
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

        const lane = laneRows[0];

        if (lane.status === "archived") {
          return {
            content: [
              {
                type: "text" as const,
                text: `Lane "${args.session_key}" is archived; cannot wrap an archived lane`,
              },
            ],
            isError: true,
          };
        }

        // Step 2: Count events for metadata
        const { rows: countRows } = await deps.pool.query(
          `SELECT count(*)::int AS cnt FROM ob_session_events WHERE lane_id = $1`,
          [lane.id],
        );
        const eventCount: number = countRows[0].cnt;

        // Step 3: Generate embedding from summary (non-fatal on failure)
        let embedding: number[] | null = null;
        try {
          embedding = await deps.embedFn(args.summary);
        } catch (err) {
          logger.warn("session_wrap_embed_error", {
            session_key: args.session_key,
            error: err instanceof Error ? err.message : String(err),
          });
        }

        const hash = contentHash(
          args.summary + "|" + (args.project ?? lane.project ?? ""),
        );
        const embeddingVal = embedding ? toSql(embedding) : null;
        const embeddedAt = embedding ? new Date().toISOString() : null;
        const model = embedding ? EMBEDDING_MODEL : null;

        // Use lane's project as fallback when not explicitly provided
        const project = args.project ?? lane.project ?? null;

        // Step 4: Insert session record (ON CONFLICT handles double-wrap)
        const { rows: sessionRows } = await deps.pool.query(
          `INSERT INTO sessions
  (summary, key_decisions, next_steps, project, namespace, embedding, content_hash, embedded_at, embedding_model, created_by)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
ON CONFLICT (content_hash) DO NOTHING
RETURNING id, created_at`,
          [
            args.summary,
            args.key_decisions ?? [],
            args.next_steps ?? [],
            project,
            ns,
            embeddingVal,
            hash,
            embeddedAt,
            model,
            auth.clientId,
          ],
        );

        // Duplicate content_hash — session already exists
        if (sessionRows.length === 0) {
          // Still mark wrapped if requested
          if (!keepActive && lane.status !== "wrapped") {
            await deps.pool.query(
              `UPDATE ob_session_lanes SET status = 'wrapped', ended_at = COALESCE(ended_at, NOW()) WHERE id = $1`,
              [lane.id],
            );
          }

          logger.info("session_wrap_duplicate", {
            session_key: args.session_key,
            namespace: ns,
            lane_id: lane.id,
          });

          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  duplicate: true,
                  lane_id: lane.id,
                  lane_status: keepActive ? lane.status : "wrapped",
                  message:
                    "Session with identical content already exists for this lane",
                }),
              },
            ],
          };
        }

        const sessionId = sessionRows[0].id;
        const createdAt = sessionRows[0].created_at;

        // Step 5: Optionally wrap the lane
        let laneStatus = lane.status;
        if (!keepActive) {
          await deps.pool.query(
            `UPDATE ob_session_lanes SET status = 'wrapped', ended_at = COALESCE(ended_at, NOW())
WHERE id = $1`,
            [lane.id],
          );
          laneStatus = "wrapped";
        }

        const result = {
          session_id: sessionId,
          lane_id: lane.id,
          lane_status: laneStatus,
          event_count: eventCount,
          created_at: createdAt,
        };

        logger.info("session_wrap_ok", {
          session_id: sessionId,
          lane_id: lane.id,
          lane_status: laneStatus,
          event_count: eventCount,
          keep_active: keepActive,
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
        logger.error("session_wrap_db_error", {
          session_key: args.session_key,
          namespace: ns,
          error: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack : undefined,
        });
        return {
          content: [
            {
              type: "text" as const,
              text: `Database error during session wrap: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );
}
