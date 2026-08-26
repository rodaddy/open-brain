/**
 * `lane_upsert` and `lane_load` — the durable session-lane surface.
 *
 * Design authority: `src/db/migrations/012_session_lanes.sql` (the row shape and
 * the `(namespace, session_key)` conflict target), `docs/memory-contract.md`
 * (lanes are the durable half of Codex session memory), and
 * `docs/decisions/channel-scoped-recall.md` (lane filters are the direct-field
 * path, distinct from semantic recall).
 *
 * BOTH TOOLS ARE NAMESPACE-SCOPED SERVER-SIDE. The namespace written and the
 * namespace read both come from `authorize`, never from the raw argument, so a
 * caller naming another tenant's namespace is refused rather than served.
 *
 * `lane_upsert` IS A MERGE, NOT A REPLACE. Every updatable column is written
 * through `COALESCE(EXCLUDED.x, ob_session_lanes.x)`, so an omitted argument
 * leaves the stored value alone instead of nulling it — that is what lets an
 * agent update one field of a live lane without restating the whole row (#162
 * is the regression where an omitted `status` wrongly failed to create a lane).
 * `metadata` is the exception: it concatenates rather than replaces.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  authIdentity,
  textResult,
  type MemoryToolDependencies,
} from "./types.ts";
import { authorize, contentHash, embeddingFields } from "./memory-helpers.ts";

const laneFields = `id, session_key, namespace, status, agent, source, channel_id,
  thread_id, project, topic, current_context_md, metadata, created_by,
  created_at, updated_at, ended_at`;

/** Frozen `lane_upsert` argument contract: the names, types, and rule values are the API. */
const laneUpsertInputSchema = {
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
};

/** Tool annotations; `lane_upsert` writes, but re-running it converges. */
const laneUpsertAnnotations = {
  title: "Upsert Session Lane",
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
};

/** Frozen `lane_load` argument contract: the names, types, and rule values are the API. */
const laneLoadInputSchema = {
  session_key: z.string().optional(),
  namespace: z.string().optional(),
  project: z.string().optional(),
  agent: z.string().optional(),
  channel_id: z.string().optional(),
  status: z.enum(["active", "wrapped", "archived"]).optional(),
};

/** Tool annotations; `lane_load` reads and never mutates. */
const laneLoadAnnotations = {
  title: "Load Session Lane",
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
};

const LANE_UPSERT_SQL = `INSERT INTO ob_session_lanes
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
         RETURNING id, (xmax = 0) AS is_new, status, updated_at`;

/** The `lane_upsert` arguments after the tool schema has parsed them. */
type LaneUpsertArgs = {
  [K in keyof typeof laneUpsertInputSchema]: z.infer<
    (typeof laneUpsertInputSchema)[K]
  >;
};

/** The `lane_load` arguments after the tool schema has parsed them. */
type LaneLoadArgs = {
  [K in keyof typeof laneLoadInputSchema]: z.infer<
    (typeof laneLoadInputSchema)[K]
  >;
};

/** The embedding columns as `embeddingFields` returns them. */
type LaneEmbedding = Awaited<ReturnType<typeof embeddingFields>>;

/**
 * The text a lane embeds on.
 *
 * The explicit context wins over the topic, and an absent pair embeds nothing —
 * that empty string is what later suppresses both the embedding and the hash.
 *
 * @returns The context text, or an empty string when the lane carries neither.
 */
function laneEmbedContext(args: LaneUpsertArgs): string {
  return args.current_context_md || args.topic || "";
}

/** The optional lane columns, with `undefined` normalized to SQL `NULL`. */
const LANE_NULLABLE_COLUMNS = [
  "agent",
  "source",
  "channel_id",
  "thread_id",
  "project",
  "topic",
  "current_context_md",
] as const;

/**
 * Normalize the optional lane columns to the values the statement binds.
 *
 * Each `undefined` becomes SQL `NULL`, which is what the statement's `COALESCE`
 * arms then read as "leave the stored value alone".
 *
 * @returns The seven optional column values, in the order the SQL names them.
 */
function laneNullableValues(args: LaneUpsertArgs): unknown[] {
  return LANE_NULLABLE_COLUMNS.map((column) => args[column] ?? null);
}

/**
 * Build the positional parameters for the upsert, in the order the SQL names them.
 *
 * @returns The 16 bind values for `LANE_UPSERT_SQL`.
 */
function laneUpsertValues(options: {
  args: LaneUpsertArgs;
  namespace: string;
  clientId: string;
  context: string;
  embedded: LaneEmbedding;
}): unknown[] {
  const { args, namespace, clientId, context, embedded } = options;
  return [
    args.session_key,
    namespace,
    args.status ?? "active",
    ...laneNullableValues(args),
    JSON.stringify(args.metadata ?? {}),
    embedded.embedding,
    context ? contentHash(`${args.session_key}|${context}`) : null,
    embedded.embeddedAt,
    embedded.model,
    clientId,
  ];
}

/** A `WHERE` clause and the values its placeholders refer to. */
interface LaneQueryPredicate {
  conditions: string[];
  values: unknown[];
}

/**
 * Build the `lane_load` predicate from the direct-field filters that were supplied.
 *
 * Namespace and status are always constrained; the remaining four are appended
 * only when present, so an omitted filter widens the query rather than matching
 * `NULL`.
 *
 * @returns The conditions and their positional values, index-aligned.
 */
function laneLoadPredicate(
  args: LaneLoadArgs,
  namespace: string,
): LaneQueryPredicate {
  const values: unknown[] = [namespace, args.status ?? "active"];
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
  return { conditions, values };
}

/**
 * Write the lane and shape the tool response.
 *
 * @returns The upsert result, or the authorization refusal when the caller
 *   may not write session lanes in the resolved namespace.
 */
async function handleLaneUpsert(
  dependencies: MemoryToolDependencies,
  args: LaneUpsertArgs,
  authInfo: unknown,
): Promise<ReturnType<typeof textResult>> {
  const auth = authorize(
    authIdentity(authInfo),
    "write",
    "sessions",
    "cannot write to session lanes",
    args.namespace,
  );
  if (!auth.ok) return auth.response;
  const context = laneEmbedContext(args);
  const embedded = await embeddingFields(dependencies, context);
  const rows = await dependencies.pool.query(
    LANE_UPSERT_SQL,
    laneUpsertValues({
      args,
      namespace: auth.namespace,
      clientId: auth.identity.clientId,
      context,
      embedded,
    }),
  );
  const row = rows.rows[0];
  dependencies.logger.info(
    { tool: "lane_upsert", namespace: auth.namespace },
    "tool_result",
  );
  return textResult({
    id: row.id,
    session_key: args.session_key,
    namespace: auth.namespace,
    status: row.status,
    is_new: row.is_new,
    embedded: embedded.embedded,
    updated_at: row.updated_at,
  });
}

/**
 * Read the matching lanes and shape the tool response.
 *
 * @returns The matching lanes, an explicit empty-with-message result when none
 *   match, or the authorization refusal.
 */
async function handleLaneLoad(
  dependencies: MemoryToolDependencies,
  args: LaneLoadArgs,
  authInfo: unknown,
): Promise<ReturnType<typeof textResult>> {
  const auth = authorize(
    authIdentity(authInfo),
    "read",
    "sessions",
    "cannot read session lanes",
    args.namespace,
  );
  if (!auth.ok) return auth.response;
  const { conditions, values } = laneLoadPredicate(args, auth.namespace);
  const rows = await dependencies.pool.query(
    `SELECT ${laneFields} FROM ob_session_lanes
          WHERE ${conditions.join(" AND ")}
          ORDER BY updated_at DESC`,
    values,
  );
  if (rows.rows.length === 0) {
    return textResult({
      lanes: [],
      message: "No lanes found matching filters",
    });
  }
  return textResult({ lanes: rows.rows, count: rows.rows.length });
}

export function registerLaneTools(
  server: McpServer,
  dependencies: MemoryToolDependencies,
): void {
  server.registerTool(
    "lane_upsert",
    {
      description:
        "Create or update a durable session lane by namespace and session key",
      inputSchema: laneUpsertInputSchema,
      annotations: laneUpsertAnnotations,
    },
    async (args, extra) => handleLaneUpsert(dependencies, args, extra.authInfo),
  );

  server.registerTool(
    "lane_load",
    {
      description: "Load durable session lanes by direct fields",
      inputSchema: laneLoadInputSchema,
      annotations: laneLoadAnnotations,
    },
    async (args, extra) => handleLaneLoad(dependencies, args, extra.authInfo),
  );
}
