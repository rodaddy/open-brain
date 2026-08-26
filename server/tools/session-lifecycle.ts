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
  sessionEmbedText,
} from "./memory-helpers.ts";

const startLaneFields = `id, session_key, namespace, status, agent, source, channel_id,
  thread_id, project, topic, current_context_md, metadata, created_at, updated_at, ended_at`;
const contextLaneFields = `id, session_key, namespace, status, agent, project, topic,
  current_context_md, metadata, created_at, updated_at`;
const eventFields = `id, event_type, content, source, artifact_path, transcript_ref,
  transcript, occurred_at, importance, metadata, created_at, created_by`;

/**
 * The declared input shapes of the three lifecycle tools, lifted out of their
 * registration calls so each registration body stays readable. Values and
 * constraints are unchanged from the inline schemas they replace.
 */
const START_INPUT_SCHEMA = {
  session_key: z.string().min(1).max(500),
  namespace: z.string().max(500).optional(),
  project: z.string().max(500).optional(),
  agent: z.string().max(500).optional(),
  platform: z.string().max(500).optional(),
  server_id: z.string().max(500).optional(),
  channel_id: z.string().max(500).optional(),
  thread_id: z.string().max(500).optional(),
  topic: z.string().max(500).optional(),
};

const CONTEXT_INPUT_SCHEMA = {
  session_key: z.string().max(500).optional(),
  namespace: z.string().max(500).optional(),
  channel_id: z.string().max(500).optional(),
  thread_id: z.string().max(500).optional(),
  include_events: z.boolean().optional(),
  event_limit: z.number().int().min(1).max(200).optional(),
  event_types: z.array(z.enum(EVENT_TYPES)).optional(),
  importance: z.enum(IMPORTANCE_LEVELS).optional(),
};

const WRAP_INPUT_SCHEMA = {
  session_key: z.string().min(1).max(500),
  namespace: z.string().max(500).optional(),
  summary: z.string().min(1).max(100_000),
  key_decisions: z.array(z.string().max(2000)).max(20).optional(),
  next_steps: z.array(z.string().max(2000)).max(20).optional(),
  project: z.string().max(500).optional(),
  source_refs: z.array(z.record(z.string(), z.unknown())).max(20).optional(),
};

type StartArgs = z.infer<z.ZodObject<typeof START_INPUT_SCHEMA>>;
type ContextArgs = z.infer<z.ZodObject<typeof CONTEXT_INPUT_SCHEMA>>;
type WrapArgs = z.infer<z.ZodObject<typeof WRAP_INPUT_SCHEMA>>;

type ExactStartScope = {
  agent?: string;
  platform?: string;
  server_id?: string;
  channel_id?: string;
  thread_id?: string;
};

/** A prepared `WHERE` fragment plus the positional values it refers to. */
type SqlFilter = { conditions: string[]; values: unknown[] };

function hasCompleteExactScope(args: ExactStartScope): args is Required<
  Omit<ExactStartScope, "thread_id">
> & {
  thread_id?: string;
} {
  return (
    args.agent !== undefined &&
    args.platform !== undefined &&
    args.server_id !== undefined &&
    args.channel_id !== undefined
  );
}

/**
 * Fill in the exact-scope coordinates of an EXISTING lane, once, from a
 * session_start that supplies all of them.
 *
 * Why this exists (#646): this handler used to return an existing lane
 * verbatim, so a lane created without full scope — which is every lane a head
 * session opens, `agent` set and source/server_id/channel_id NULL — could never
 * afterwards prove the exact-scope predicate
 * (docs/agent-context-pack-contract.md:99-105). The client's own scope proof
 * then failed permanently, so EVERY capture into that lane was lost. 2009 such
 * lanes existed on the dogfood database when this was measured.
 *
 * The write is a one-way fill, never a rewrite: each COALESCE only populates a
 * NULL, and the WHERE clause refuses the update when any already-set field
 * disagrees with the request. A lane that belongs to a different scope is
 * therefore left untouched and reported, not silently re-pointed — the scope
 * predicate is an isolation boundary, so widening it here would be a security
 * defect, not a convenience.
 *
 * Ported from the equivalent logic in src/tools/session-start.ts:34-90 so the
 * two entrypoints agree; this file is the one the running service serves.
 */
async function establishExactStartScope(
  dependencies: MemoryToolDependencies,
  namespace: string,
  sessionKey: string,
  args: ExactStartScope,
): Promise<Record<string, unknown> | null> {
  if (!hasCompleteExactScope(args)) return null;
  const { rows } = await dependencies.pool.query(
    `UPDATE ob_session_lanes
        SET agent = COALESCE(agent, $3),
            source = COALESCE(source, $4),
            metadata = CASE
              WHEN metadata->>'server_id' IS NOT NULL THEN metadata
              ELSE jsonb_set(COALESCE(metadata, '{}'::jsonb), '{server_id}', to_jsonb($5::text), true)
            END,
            channel_id = COALESCE(channel_id, $6),
            thread_id = CASE
              WHEN $7::text IS NOT NULL AND thread_id IS NULL THEN $7
              ELSE thread_id
            END
      WHERE namespace = $1
        AND session_key = $2
        AND (agent IS NULL OR agent = $3)
        AND (source IS NULL OR source = $4)
        AND (metadata->>'server_id' IS NULL OR metadata->>'server_id' = $5)
        AND (channel_id IS NULL OR channel_id = $6)
        AND ($7::text IS NULL OR thread_id IS NULL OR thread_id = $7)
    RETURNING ${startLaneFields}`,
    [
      namespace,
      sessionKey,
      args.agent,
      args.platform,
      args.server_id,
      args.channel_id,
      args.thread_id ?? null,
    ],
  );
  return (rows[0] as Record<string, unknown> | undefined) ?? null;
}

export function registerSessionLifecycleTools(
  server: McpServer,
  dependencies: MemoryToolDependencies,
): void {
  registerSessionStart(server, dependencies);
  registerSessionContext(server, dependencies);
  registerSessionWrap(server, dependencies);
}

/** Read the most recent events on a lane, newest first. */
async function recentLaneEvents(
  dependencies: MemoryToolDependencies,
  laneId: unknown,
): Promise<unknown[]> {
  const events = await dependencies.pool.query(
    `SELECT ${eventFields} FROM ob_session_events
            WHERE lane_id = $1 ORDER BY created_at DESC LIMIT 50`,
    [laneId],
  );
  return events.rows;
}

/**
 * Resolve the lane an existing `session_start` should answer with, filling in
 * exact scope first when the request carries the complete predicate (#646).
 *
 * Returns the tool's own error response rather than the lane when the fill is
 * refused, because a conflicting lane must be reported by name rather than
 * returned unproven: returning it makes every later capture fail with a scope
 * error the caller cannot act on.
 */
async function scopeExistingLane(
  dependencies: MemoryToolDependencies,
  namespace: string,
  args: StartArgs,
  existing: Record<string, unknown>,
): Promise<
  | { lane: Record<string, unknown> }
  | { response: ReturnType<typeof errorResult> }
> {
  if (!hasCompleteExactScope(args)) return { lane: existing };
  const scopedLane = await establishExactStartScope(
    dependencies,
    namespace,
    args.session_key,
    args,
  );
  if (!scopedLane) {
    return {
      response: errorResult(
        "Existing lane exact scope does not match session_start request",
      ),
    };
  }
  return { lane: scopedLane };
}

/** Create the lane a `session_start` asked for when none existed yet. */
async function insertStartLane(
  dependencies: MemoryToolDependencies,
  namespace: string,
  args: StartArgs,
  clientId: string,
): Promise<unknown> {
  const inserted = await dependencies.pool.query(
    `INSERT INTO ob_session_lanes
           (session_key, namespace, status, agent, source, project, channel_id,
            thread_id, topic, metadata, created_by)
         VALUES ($1, $2, 'active', $3, $4, $5, $6, $7, $8, $9::jsonb, $10)
         RETURNING ${startLaneFields}`,
    [
      args.session_key,
      namespace,
      args.agent ?? null,
      args.platform ?? null,
      args.project ?? null,
      args.channel_id ?? null,
      args.thread_id ?? null,
      args.topic ?? null,
      JSON.stringify(args.server_id ? { server_id: args.server_id } : {}),
      clientId,
    ],
  );
  return inserted.rows[0];
}

async function startSession(
  dependencies: MemoryToolDependencies,
  args: StartArgs,
  extra: { authInfo?: unknown },
) {
  const auth = authorize(authIdentity(extra.authInfo), {
    operation: "write",
    table: "sessions",
    permissionMessage: "cannot write to sessions",
    requestedNamespace: args.namespace,
  });
  if (!auth.ok) return auth.response;
  const existing = await dependencies.pool.query(
    `SELECT ${startLaneFields} FROM ob_session_lanes
          WHERE namespace = $1 AND session_key = $2`,
    [auth.namespace, args.session_key],
  );
  if (existing.rows[0]) {
    const scoped = await scopeExistingLane(
      dependencies,
      auth.namespace,
      args,
      existing.rows[0],
    );
    if ("response" in scoped) return scoped.response;
    const events = await recentLaneEvents(dependencies, scoped.lane.id);
    return textResult({
      lane: scoped.lane,
      events,
      events_returned: events.length,
      is_new: false,
    });
  }
  const lane = await insertStartLane(
    dependencies,
    auth.namespace,
    args,
    auth.identity.clientId,
  );
  dependencies.logger.info(
    { tool: "session_start", namespace: auth.namespace },
    "tool_result",
  );
  return textResult({
    lane,
    events: [],
    events_returned: 0,
    is_new: true,
  });
}

function registerSessionStart(
  server: McpServer,
  dependencies: MemoryToolDependencies,
): void {
  server.registerTool(
    "session_start",
    {
      description:
        "Find or create a persistent session lane and return its current state",
      inputSchema: START_INPUT_SCHEMA,
      annotations: {
        title: "Session Start",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async (args, extra) => startSession(dependencies, args, extra),
  );
}

/**
 * Build the lane lookup predicate. `session_key` is exact and wins outright;
 * only in its absence do `channel_id`/`thread_id` narrow the match, which is
 * why both are guarded on `!args.session_key`.
 */
function laneLookupFilter(namespace: string, args: ContextArgs): SqlFilter {
  const values: unknown[] = [namespace];
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
  return { conditions, values };
}

/**
 * Build the event predicate for one lane. `$2` is reserved for the row count
 * up front so it can be referenced by the `ORDER BY ... LIMIT $2` tail while
 * the optional filters keep appending after it.
 */
function laneEventFilter(laneId: unknown, args: ContextArgs): SqlFilter {
  const conditions = ["lane_id = $1"];
  const values: unknown[] = [laneId, args.event_limit ?? 50];
  if (args.event_types && args.event_types.length > 0) {
    values.push(args.event_types);
    conditions.push(`event_type = ANY($${values.length})`);
  }
  if (args.importance) {
    values.push(args.importance);
    conditions.push(`importance = $${values.length}`);
  }
  return { conditions, values };
}

async function loadSessionContext(
  dependencies: MemoryToolDependencies,
  args: ContextArgs,
  extra: { authInfo?: unknown },
) {
  const auth = authorize(authIdentity(extra.authInfo), {
    operation: "read",
    table: "sessions",
    permissionMessage: "cannot read session context",
    requestedNamespace: args.namespace,
  });
  if (!auth.ok) return auth.response;
  if (!args.session_key && !args.channel_id) {
    return errorResult("At least one of session_key or channel_id is required");
  }
  const laneFilter = laneLookupFilter(auth.namespace, args);
  const lanes = await dependencies.pool.query(
    `SELECT ${contextLaneFields} FROM ob_session_lanes
          WHERE ${laneFilter.conditions.join(" AND ")} ORDER BY updated_at DESC`,
    laneFilter.values,
  );
  const lane = lanes.rows[0];
  if (!lane) return textResult({ lane: null, events: [], event_count: 0 });
  let events: { rows: unknown[] } = { rows: [] };
  if (args.include_events !== false) {
    const eventFilter = laneEventFilter(lane.id, args);
    events = await dependencies.pool.query(
      `SELECT ${eventFields} FROM ob_session_events
            WHERE ${eventFilter.conditions.join(" AND ")}
            ORDER BY created_at DESC LIMIT $2`,
      eventFilter.values,
    );
  }
  return textResult({
    lane,
    events: events.rows,
    event_count: events.rows.length,
  });
}

function registerSessionContext(
  server: McpServer,
  dependencies: MemoryToolDependencies,
): void {
  server.registerTool(
    "session_context",
    {
      description: "Load lane state and recent events for a session",
      inputSchema: CONTEXT_INPUT_SCHEMA,
      annotations: {
        title: "Session Context",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async (args, extra) => loadSessionContext(dependencies, args, extra),
  );
}

/** Insert the durable session row, or `undefined` when it deduplicated away. */
async function insertWrapSession(options: {
  dependencies: MemoryToolDependencies;
  args: WrapArgs;
  namespace: string;
  project: string | null;
  embedded: Awaited<ReturnType<typeof embeddingFields>>;
  clientId: string;
}): Promise<Record<string, unknown> | undefined> {
  const { dependencies, args, namespace, project, embedded, clientId } =
    options;
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
      namespace,
      embedded.embedding,
      contentHash(`${args.summary}|${project ?? ""}`),
      embedded.embeddedAt,
      embedded.model,
      clientId,
      JSON.stringify(args.source_refs ?? []),
    ],
  );
  return sessions.rows[0];
}

/** Point the lane's current context at this checkpoint, leaving it active. */
async function updateLaneContext(options: {
  dependencies: MemoryToolDependencies;
  args: WrapArgs;
  namespace: string;
  laneId: unknown;
  embedded: Awaited<ReturnType<typeof embeddingFields>>;
}): Promise<void> {
  const { dependencies, args, namespace, laneId, embedded } = options;
  await dependencies.pool.query(
    `UPDATE ob_session_lanes
            SET current_context_md = $2, embedding = $3, content_hash = $4,
                embedded_at = $5, embedding_model = $6
          WHERE id = $1 AND namespace = $7 AND session_key = $8`,
    [
      laneId,
      args.summary,
      embedded.embedding,
      contentHash(`${args.session_key}|${args.summary}`),
      embedded.embeddedAt,
      embedded.model,
      namespace,
      args.session_key,
    ],
  );
}

async function wrapSession(
  dependencies: MemoryToolDependencies,
  args: WrapArgs,
  extra: { authInfo?: unknown },
) {
  const auth = authorize(authIdentity(extra.authInfo), {
    operation: "write",
    table: "sessions",
    permissionMessage: "cannot write to sessions",
    requestedNamespace: args.namespace,
  });
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
  const session = await insertWrapSession({
    dependencies,
    args,
    namespace: auth.namespace,
    project,
    embedded,
    clientId: auth.identity.clientId,
  });
  await updateLaneContext({
    dependencies,
    args,
    namespace: auth.namespace,
    laneId: lane.id,
    embedded,
  });
  if (!session) {
    return textResult({
      duplicate: true,
      lane_id: lane.id,
      lane_status: lane.status,
      context_updated: true,
    });
  }
  return textResult({
    session_id: session.id,
    lane_id: lane.id,
    lane_status: lane.status,
    event_count: events.rows[0].cnt,
    created_at: session.created_at,
    source_refs: session.source_refs,
    context_updated: true,
  });
}

function registerSessionWrap(
  server: McpServer,
  dependencies: MemoryToolDependencies,
): void {
  server.registerTool(
    "session_wrap",
    {
      description: "Checkpoint a session lane while leaving the lane active",
      inputSchema: WRAP_INPUT_SCHEMA,
      annotations: {
        title: "Session Wrap",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
      },
    },
    async (args, extra) => wrapSession(dependencies, args, extra),
  );
}
