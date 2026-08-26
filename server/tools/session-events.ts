import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  authIdentity,
  errorResult,
  textResult,
  type MemoryToolDependencies,
} from "./types.ts";
import {
  authorize,
  contentHash,
  embeddingFields,
  EVENT_TYPES,
  IMPORTANCE_LEVELS,
} from "./memory-helpers.ts";
import {
  openBrainWriterMetadata,
  writerProvenance,
} from "./session-event-provenance.ts";

/**
 * The tool's declared input shape, lifted out of the registration call so the
 * registration body stays readable. Values and constraints are unchanged.
 */
const INPUT_SCHEMA = {
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
};

type EventArgs = z.infer<z.ZodObject<typeof INPUT_SCHEMA>>;

type LaneRow = { id: unknown; status: unknown };

/**
 * Resolve the lane this event belongs to, creating it when the caller opted in.
 *
 * Returned separately from the insert so the handler reads as three steps
 * (resolve lane, embed, insert) rather than one branch-heavy block. `created`
 * reports whether THIS call inserted the lane, which the response echoes.
 */
async function resolveLane(
  dependencies: MemoryToolDependencies,
  args: EventArgs,
  namespace: string,
  clientId: string,
): Promise<{ lane: LaneRow | undefined; created: boolean }> {
  const lanes = await dependencies.pool.query(
    `SELECT id, status FROM ob_session_lanes
          WHERE namespace = $1 AND session_key = $2`,
    [namespace, args.session_key],
  );
  const existing = lanes.rows[0];
  if (existing || !args.create_if_missing)
    return { lane: existing, created: false };

  const created = await dependencies.pool.query(
    `INSERT INTO ob_session_lanes
             (session_key, namespace, status, agent, source, channel_id, thread_id,
              project, topic, metadata, created_by)
           VALUES ($1, $2, 'active', $3, $4, $5, $6, $7, $8, $9::jsonb, $10)
           ON CONFLICT (namespace, session_key) DO NOTHING
           RETURNING id, status`,
    [
      args.session_key,
      namespace,
      args.agent ?? null,
      args.platform ?? null,
      args.channel_id ?? null,
      args.thread_id ?? null,
      args.project ?? null,
      args.topic ?? null,
      JSON.stringify(args.server_id ? { server_id: args.server_id } : {}),
      clientId,
    ],
  );
  const lane = created.rows[0];
  return { lane, created: Boolean(lane) };
}

/**
 * Insert the event row, returning `undefined` when the idempotency conflict
 * target swallowed it -- the caller reports that as a duplicate.
 */
async function insertEvent(options: {
  dependencies: MemoryToolDependencies;
  args: EventArgs;
  laneId: unknown;
  importance: string;
  metadata: Record<string, unknown>;
  clientId: string;
}): Promise<{ id: unknown; created_at: unknown } | undefined> {
  const { dependencies, args, laneId, importance, metadata, clientId } =
    options;
  const embedded = await embeddingFields(dependencies, args.content);
  const events = await dependencies.pool.query(
    `INSERT INTO ob_session_events
           (lane_id, event_type, content, source, artifact_path, transcript_ref,
            transcript, occurred_at, importance, metadata, embedding, content_hash,
            embedded_at, embedding_model, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12, $13, $14, $15)
         ON CONFLICT (lane_id, content_hash) WHERE content_hash IS NOT NULL DO NOTHING
         RETURNING id, created_at`,
    [
      laneId,
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
      clientId,
    ],
  );
  return events.rows[0];
}

async function appendSessionEvent(
  dependencies: MemoryToolDependencies,
  args: EventArgs,
  extra: { authInfo?: unknown },
) {
  const auth = authorize(authIdentity(extra.authInfo), {
    operation: "write",
    table: "sessions",
    permissionMessage: "cannot write to session events",
    requestedNamespace: args.namespace,
  });
  if (!auth.ok) return auth.response;

  const { lane, created: laneCreated } = await resolveLane(
    dependencies,
    args,
    auth.namespace,
    auth.identity.clientId,
  );
  if (!lane) {
    return errorResult(
      JSON.stringify({
        error: "scope_validation",
        message: `Lane not found for session_key "${args.session_key}" in namespace "${auth.namespace}"`,
        retryable: false,
      }),
    );
  }

  const importance = args.importance ?? "warm";
  const provenance = writerProvenance(auth.identity);
  const event = await insertEvent({
    dependencies,
    args,
    laneId: lane.id,
    importance,
    metadata: { ...args.metadata, ...openBrainWriterMetadata(provenance) },
    clientId: auth.identity.clientId,
  });
  if (!event) return textResult({ duplicate: true, ...provenance });

  dependencies.logger.info(
    { tool: "append_session_event", event_id: event.id },
    "tool_result",
  );
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
}

export function registerSessionEventTool(
  server: McpServer,
  dependencies: MemoryToolDependencies,
): void {
  server.registerTool(
    "append_session_event",
    {
      description: "Append an idempotent event to a persistent session lane",
      inputSchema: INPUT_SCHEMA,
      annotations: {
        title: "Append Session Event",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async (args, extra) => appendSessionEvent(dependencies, args, extra),
  );
}
