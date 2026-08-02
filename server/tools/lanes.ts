import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { authIdentity, textResult, type MemoryToolDependencies } from "./types.ts";
import { authorize, contentHash, embeddingFields } from "./memory-helpers.ts";

const laneFields = `id, session_key, namespace, status, agent, source, channel_id,
  thread_id, project, topic, current_context_md, metadata, created_by,
  created_at, updated_at, ended_at`;

export function registerLaneTools(
  server: McpServer,
  dependencies: MemoryToolDependencies,
): void {
  server.registerTool(
    "lane_upsert",
    {
      description: "Create or update a durable session lane by namespace and session key",
      inputSchema: {
        session_key: z.string().min(1).max(500),
        namespace: z.string().optional(),
        status: z.enum(["active", "wrapped", "archived"]).optional(),
        agent: z.string().max(500).optional(),
        source: z.string().max(500).optional(),
        channel_id: z.string().max(500).optional(),
        thread_id: z.string().max(500).optional(),
        project: z.string().max(500).optional(),
        topic: z.string().max(500).optional(),
        current_context_md: z.string().max(100_000).optional(),
        metadata: z.record(z.string().max(100), z.unknown()).optional(),
      },
      annotations: {
        title: "Upsert Session Lane",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async (args, extra) => {
      const auth = authorize(
        authIdentity(extra.authInfo),
        "write",
        "sessions",
        "cannot write to session lanes",
        args.namespace,
      );
      if (!auth.ok) return auth.response;
      const context = args.current_context_md || args.topic || "";
      const embedded = await embeddingFields(dependencies, context);
      const rows = await dependencies.pool.query(
        `INSERT INTO ob_session_lanes
           (session_key, namespace, status, agent, source, channel_id, thread_id,
            project, topic, current_context_md, metadata, embedding, content_hash,
            embedded_at, embedding_model, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13, $14, $15, $16)
         ON CONFLICT (namespace, session_key)
         DO UPDATE SET status = COALESCE(EXCLUDED.status, ob_session_lanes.status),
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
           embedding_model = COALESCE(EXCLUDED.embedding_model, ob_session_lanes.embedding_model)
         RETURNING id, (xmax = 0) AS is_new, status, updated_at`,
        [
          args.session_key,
          auth.namespace,
          args.status ?? "active",
          args.agent ?? null,
          args.source ?? null,
          args.channel_id ?? null,
          args.thread_id ?? null,
          args.project ?? null,
          args.topic ?? null,
          args.current_context_md ?? null,
          JSON.stringify(args.metadata ?? {}),
          embedded.embedding,
          context ? contentHash(`${args.session_key}|${context}`) : null,
          embedded.embeddedAt,
          embedded.model,
          auth.identity.clientId,
        ],
      );
      const row = rows.rows[0];
      dependencies.logger.info({ tool: "lane_upsert", namespace: auth.namespace }, "tool_result");
      return textResult({
        id: row.id,
        session_key: args.session_key,
        namespace: auth.namespace,
        status: row.status,
        is_new: row.is_new,
        embedded: embedded.embedded,
        updated_at: row.updated_at,
      });
    },
  );

  server.registerTool(
    "lane_load",
    {
      description: "Load durable session lanes by direct fields",
      inputSchema: {
        session_key: z.string().optional(),
        namespace: z.string().optional(),
        project: z.string().optional(),
        agent: z.string().optional(),
        channel_id: z.string().optional(),
        status: z.enum(["active", "wrapped", "archived"]).optional(),
      },
      annotations: {
        title: "Load Session Lane",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async (args, extra) => {
      const auth = authorize(
        authIdentity(extra.authInfo),
        "read",
        "sessions",
        "cannot read session lanes",
        args.namespace,
      );
      if (!auth.ok) return auth.response;
      const values: unknown[] = [auth.namespace, args.status ?? "active"];
      const conditions = ["namespace = $1", "status = $2"];
      const filters: Array<[unknown, string]> = [
        [args.session_key, "session_key"],
        [args.project, "project"],
        [args.agent, "agent"],
        [args.channel_id, "channel_id"],
      ];
      for (const [value, column] of filters) {
        if (value === undefined) continue;
        values.push(value);
        conditions.push(`${column} = $${values.length}`);
      }
      const rows = await dependencies.pool.query(
        `SELECT ${laneFields} FROM ob_session_lanes
          WHERE ${conditions.join(" AND ")}
          ORDER BY updated_at DESC`,
        values,
      );
      if (rows.rows.length === 0) {
        return textResult({ lanes: [], message: "No lanes found matching filters" });
      }
      return textResult({ lanes: rows.rows, count: rows.rows.length });
    },
  );
}
