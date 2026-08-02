import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { authIdentity, errorResult, textResult, type MemoryToolDependencies } from "./types.ts";
import {
  authorize,
  contentHash,
  embeddingFields,
  EVENT_TYPES,
  IMPORTANCE_LEVELS,
} from "./memory-helpers.ts";

export function registerSessionEventTool(
  server: McpServer,
  dependencies: MemoryToolDependencies,
): void {
  server.registerTool(
    "append_session_event",
    {
      description: "Append an idempotent event to a persistent session lane",
      inputSchema: {
        session_key: z.string().min(1).max(500),
        namespace: z.string().max(500).optional(),
        create_if_missing: z.boolean().optional(),
        agent: z.string().max(500).optional(),
        platform: z.string().max(500).optional(),
        server_id: z.string().max(500).optional(),
        channel_id: z.string().max(500).optional(),
        thread_id: z.string().max(500).optional(),
        project: z.string().max(500).optional(),
        topic: z.string().max(500).optional(),
        event_type: z.enum(EVENT_TYPES),
        content: z.string().min(1).max(50_000),
        source: z.string().max(500).optional(),
        artifact_path: z.string().max(2000).optional(),
        transcript_ref: z.string().max(2000).optional(),
        transcript: z.string().max(50_000).optional(),
        occurred_at: z.string().datetime({ offset: true }).optional(),
        importance: z.enum(IMPORTANCE_LEVELS).optional(),
        metadata: z.record(z.string().max(100), z.unknown()).optional(),
      },
      annotations: {
        title: "Append Session Event",
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
        "cannot write to session events",
        args.namespace,
      );
      if (!auth.ok) return auth.response;
      const lanes = await dependencies.pool.query(
        `SELECT id, status FROM ob_session_lanes
          WHERE namespace = $1 AND session_key = $2`,
        [auth.namespace, args.session_key],
      );
      let lane = lanes.rows[0];
      let laneCreated = false;
      if (!lane && args.create_if_missing) {
        const created = await dependencies.pool.query(
          `INSERT INTO ob_session_lanes
             (session_key, namespace, status, agent, source, channel_id, thread_id,
              project, topic, metadata, created_by)
           VALUES ($1, $2, 'active', $3, $4, $5, $6, $7, $8, $9::jsonb, $10)
           ON CONFLICT (namespace, session_key) DO NOTHING
           RETURNING id, status`,
          [
            args.session_key,
            auth.namespace,
            args.agent ?? null,
            args.platform ?? null,
            args.channel_id ?? null,
            args.thread_id ?? null,
            args.project ?? null,
            args.topic ?? null,
            JSON.stringify(args.server_id ? { server_id: args.server_id } : {}),
            auth.identity.clientId,
          ],
        );
        lane = created.rows[0];
        laneCreated = Boolean(lane);
      }
      if (!lane) {
        return errorResult(JSON.stringify({
          error: "scope_validation",
          message: `Lane not found for session_key "${args.session_key}" in namespace "${auth.namespace}"`,
          retryable: false,
        }));
      }
      const importance = args.importance ?? "warm";
      const embedded = await embeddingFields(dependencies, args.content);
      const provenance = {
        writer_identity: auth.identity.clientId,
        token_identity: auth.identity.tokenClientId,
        delegated_agent_id: null,
        namespace_source: auth.identity.namespaceSource === "delegated" ? "header" : "token",
      };
      const metadata = {
        ...(args.metadata ?? {}),
        _openbrain: {
          writer: {
            client_id: provenance.writer_identity,
            token_client_id: provenance.token_identity,
            agent_id: provenance.delegated_agent_id,
            namespace_source: provenance.namespace_source,
          },
        },
      };
      const events = await dependencies.pool.query(
        `INSERT INTO ob_session_events
           (lane_id, event_type, content, source, artifact_path, transcript_ref,
            transcript, occurred_at, importance, metadata, embedding, content_hash,
            embedded_at, embedding_model, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12, $13, $14, $15)
         ON CONFLICT (lane_id, content_hash) WHERE content_hash IS NOT NULL DO NOTHING
         RETURNING id, created_at`,
        [
          lane.id,
          args.event_type,
          args.content,
          args.source ?? null,
          args.artifact_path ?? null,
          args.transcript_ref ?? null,
          args.transcript ?? null,
          args.occurred_at ?? null,
          importance,
          JSON.stringify(metadata),
          embedded.embedding,
          contentHash(args.content),
          embedded.embeddedAt,
          embedded.model,
          auth.identity.clientId,
        ],
      );
      const event = events.rows[0];
      if (!event) return textResult({ duplicate: true, ...provenance });
      dependencies.logger.info({ tool: "append_session_event", event_id: event.id }, "tool_result");
      return textResult({
        event_id: event.id,
        lane_id: lane.id,
        lane_created: laneCreated,
        event_type: args.event_type,
        importance,
        created_at: event.created_at,
        transcript_ref: args.transcript_ref ?? null,
        ...provenance,
      });
    },
  );
}
