import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { authIdentity, errorResult, textResult, type MemoryToolDependencies } from "./types.ts";
import {
  authorize,
  contentHash,
  embeddingFields,
  EVENT_TYPES,
  IMPORTANCE_LEVELS,
  sessionEmbedText,
} from "./memory-helpers.ts";

const startLaneFields = `id, session_key, namespace, status, agent, source, channel_id,
  thread_id, project, topic, current_context_md, metadata, created_at, updated_at, ended_at`;
const contextLaneFields = `id, session_key, namespace, status, agent, project, topic,
  current_context_md, metadata, created_at, updated_at`;
const eventFields = `id, event_type, content, source, artifact_path, transcript_ref,
  transcript, occurred_at, importance, metadata, created_at, created_by`;

export function registerSessionLifecycleTools(
  server: McpServer,
  dependencies: MemoryToolDependencies,
): void {
  registerSessionStart(server, dependencies);
  registerSessionContext(server, dependencies);
  registerSessionWrap(server, dependencies);
}

function registerSessionStart(server: McpServer, dependencies: MemoryToolDependencies): void {
  server.registerTool(
    "session_start",
    {
      description: "Find or create a persistent session lane and return its current state",
      inputSchema: {
        session_key: z.string().min(1).max(500),
        namespace: z.string().max(500).optional(),
        project: z.string().max(500).optional(),
        agent: z.string().max(500).optional(),
        platform: z.string().max(500).optional(),
        server_id: z.string().max(500).optional(),
        channel_id: z.string().max(500).optional(),
        thread_id: z.string().max(500).optional(),
        topic: z.string().max(500).optional(),
      },
      annotations: {
        title: "Session Start",
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
        "cannot write to sessions",
        args.namespace,
      );
      if (!auth.ok) return auth.response;
      const existing = await dependencies.pool.query(
        `SELECT ${startLaneFields} FROM ob_session_lanes
          WHERE namespace = $1 AND session_key = $2`,
        [auth.namespace, args.session_key],
      );
      if (existing.rows[0]) {
        const events = await dependencies.pool.query(
          `SELECT ${eventFields} FROM ob_session_events
            WHERE lane_id = $1 ORDER BY created_at DESC LIMIT 50`,
          [existing.rows[0].id],
        );
        return textResult({
          lane: existing.rows[0],
          events: events.rows,
          events_returned: events.rows.length,
          is_new: false,
        });
      }
      const inserted = await dependencies.pool.query(
        `INSERT INTO ob_session_lanes
           (session_key, namespace, status, agent, source, project, channel_id,
            thread_id, topic, metadata, created_by)
         VALUES ($1, $2, 'active', $3, $4, $5, $6, $7, $8, $9::jsonb, $10)
         RETURNING ${startLaneFields}`,
        [
          args.session_key,
          auth.namespace,
          args.agent ?? null,
          args.platform ?? null,
          args.project ?? null,
          args.channel_id ?? null,
          args.thread_id ?? null,
          args.topic ?? null,
          JSON.stringify(args.server_id ? { server_id: args.server_id } : {}),
          auth.identity.clientId,
        ],
      );
      dependencies.logger.info({ tool: "session_start", namespace: auth.namespace }, "tool_result");
      return textResult({
        lane: inserted.rows[0],
        events: [],
        events_returned: 0,
        is_new: true,
      });
    },
  );
}

function registerSessionContext(server: McpServer, dependencies: MemoryToolDependencies): void {
  server.registerTool(
    "session_context",
    {
      description: "Load lane state and recent events for a session",
      inputSchema: {
        session_key: z.string().max(500).optional(),
        namespace: z.string().max(500).optional(),
        channel_id: z.string().max(500).optional(),
        thread_id: z.string().max(500).optional(),
        include_events: z.boolean().optional(),
        event_limit: z.number().int().min(1).max(200).optional(),
        event_types: z.array(z.enum(EVENT_TYPES)).optional(),
        importance: z.enum(IMPORTANCE_LEVELS).optional(),
      },
      annotations: {
        title: "Session Context",
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
        "cannot read session context",
        args.namespace,
      );
      if (!auth.ok) return auth.response;
      if (!args.session_key && !args.channel_id) {
        return errorResult("At least one of session_key or channel_id is required");
      }
      const values: unknown[] = [auth.namespace];
      const conditions = ["namespace = $1"];
      if (args.session_key) {
        values.push(args.session_key);
        conditions.push(`session_key = $${values.length}`);
      }
      if (!args.session_key && args.channel_id) {
        values.push(args.channel_id);
        conditions.push(`channel_id = $${values.length}`);
      }
      if (!args.session_key && args.thread_id) {
        values.push(args.thread_id);
        conditions.push(`thread_id = $${values.length}`);
      }
      const lanes = await dependencies.pool.query(
        `SELECT ${contextLaneFields} FROM ob_session_lanes
          WHERE ${conditions.join(" AND ")} ORDER BY updated_at DESC`,
        values,
      );
      const lane = lanes.rows[0];
      if (!lane) return textResult({ lane: null, events: [], event_count: 0 });
      let events: { rows: unknown[] } = { rows: [] };
      if (args.include_events !== false) {
        const eventConditions = ["lane_id = $1"];
        const eventValues: unknown[] = [lane.id, args.event_limit ?? 50];
        if (args.event_types && args.event_types.length > 0) {
          eventValues.push(args.event_types);
          eventConditions.push(`event_type = ANY($${eventValues.length})`);
        }
        if (args.importance) {
          eventValues.push(args.importance);
          eventConditions.push(`importance = $${eventValues.length}`);
        }
        events = await dependencies.pool.query(
          `SELECT ${eventFields} FROM ob_session_events
            WHERE ${eventConditions.join(" AND ")}
            ORDER BY created_at DESC LIMIT $2`,
          eventValues,
        );
      }
      return textResult({ lane, events: events.rows, event_count: events.rows.length });
    },
  );
}

function registerSessionWrap(server: McpServer, dependencies: MemoryToolDependencies): void {
  server.registerTool(
    "session_wrap",
    {
      description: "Checkpoint a session lane while leaving the lane active",
      inputSchema: {
        session_key: z.string().min(1).max(500),
        namespace: z.string().max(500).optional(),
        summary: z.string().min(1).max(100_000),
        key_decisions: z.array(z.string().max(2000)).max(20).optional(),
        next_steps: z.array(z.string().max(2000)).max(20).optional(),
        project: z.string().max(500).optional(),
        source_refs: z.array(z.record(z.string(), z.unknown())).max(20).optional(),
      },
      annotations: {
        title: "Session Wrap",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
      },
    },
    async (args, extra) => {
      const auth = authorize(
        authIdentity(extra.authInfo),
        "write",
        "sessions",
        "cannot write to sessions",
        args.namespace,
      );
      if (!auth.ok) return auth.response;
      const lanes = await dependencies.pool.query(
        `SELECT id, status, project FROM ob_session_lanes
          WHERE namespace = $1 AND session_key = $2`,
        [auth.namespace, args.session_key],
      );
      const lane = lanes.rows[0];
      if (!lane) {
        return errorResult(
          `Lane not found for session_key "${args.session_key}" in namespace "${auth.namespace}"`,
        );
      }
      const events = await dependencies.pool.query(
        "SELECT count(*)::int AS cnt FROM ob_session_events WHERE lane_id = $1",
        [lane.id],
      );
      const project = args.project ?? lane.project ?? null;
      const embedded = await embeddingFields(dependencies, sessionEmbedText(args));
      const sessions = await dependencies.pool.query(
        `INSERT INTO sessions
           (summary, key_decisions, next_steps, project, namespace, embedding,
            content_hash, embedded_at, embedding_model, created_by, source_refs)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)
         ON CONFLICT (content_hash, namespace) WHERE content_hash IS NOT NULL DO NOTHING
         RETURNING id, created_at, source_refs`,
        [
          args.summary,
          args.key_decisions ?? [],
          args.next_steps ?? [],
          project,
          auth.namespace,
          embedded.embedding,
          contentHash(`${args.summary}|${project ?? ""}`),
          embedded.embeddedAt,
          embedded.model,
          auth.identity.clientId,
          JSON.stringify(args.source_refs ?? []),
        ],
      );
      await dependencies.pool.query(
        `UPDATE ob_session_lanes
            SET current_context_md = $2, embedding = $3, content_hash = $4,
                embedded_at = $5, embedding_model = $6
          WHERE id = $1 AND namespace = $7 AND session_key = $8`,
        [
          lane.id,
          args.summary,
          embedded.embedding,
          contentHash(`${args.session_key}|${args.summary}`),
          embedded.embeddedAt,
          embedded.model,
          auth.namespace,
          args.session_key,
        ],
      );
      const session = sessions.rows[0];
      if (!session) return textResult({ duplicate: true, lane_id: lane.id, lane_status: lane.status, context_updated: true });
      return textResult({
        session_id: session.id,
        lane_id: lane.id,
        lane_status: lane.status,
        event_count: events.rows[0].cnt,
        created_at: session.created_at,
        source_refs: session.source_refs,
        context_updated: true,
      });
    },
  );
}
