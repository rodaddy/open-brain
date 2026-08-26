/**
 * `durable_lane_context` — the exact-scope active lane and its events.
 *
 * Design authority: `docs/agent-context-pack-contract.md` ("Exact Scope
 * Predicate"). This section is distinct from `durable_memory`: it does not
 * search anything. It answers "what is THIS lane's state" by binding all seven
 * scope coordinates exactly, and it returns nothing at all when they do not all
 * match. A near miss is a content-free `exact_scope` denial, never a widened
 * query that finds the "closest" lane.
 */
import type { PoolClient, QueryConfig } from "pg";
import type { AgentContextPackArgs } from "./context-pack-args.ts";
import type { MemoryToolDependencies } from "./types.ts";
import {
  UNBOUNDED,
  type DurableFailureLogger,
  asError,
  boundedText,
  errorIdentityFields,
  logDurableFailure,
  pgDiagnosticFields,
  resolveContentChars,
} from "./context-pack-shared.ts";

export {
  CONTEXT_PACK_ENVELOPE_CHAR_RESERVE,
  UNBOUNDED,
  boundedText,
} from "./context-pack-shared.ts";

export type DurableLaneContextFragment = {
  section?: Record<string, unknown>;
  scopeDenials: Array<Record<string, unknown>>;
  truncation: Array<Record<string, unknown>>;
  degradedSources: Array<Record<string, unknown>>;
  budget: Record<string, unknown>;
  citations: Array<Record<string, unknown>>;
};

type DurableLaneQuery = (
  sql: string,
  params?: unknown[],
) => Promise<{ rows: Array<Record<string, unknown>> }>;

type DurableLaneReader = {
  query: DurableLaneQuery;
  commit: () => Promise<void>;
  rollback: () => Promise<void>;
  release: () => void;
};

/**
 * Milliseconds left in the caller's latency budget, or a throw when it is spent.
 *
 * Throwing rather than clamping to zero is deliberate: a zero-length query
 * timeout is not "run instantly", it is "run forever" in most drivers, which is
 * precisely the failure a latency budget exists to prevent.
 */
function remainingLatencyMs(startedAt: number, maxLatencyMs: number): number {
  const remainingMs = Math.floor(
    maxLatencyMs - (performance.now() - startedAt),
  );
  if (remainingMs < 1) {
    throw new Error("durable lane context latency budget exhausted");
  }
  return remainingMs;
}

/**
 * Acquire a pooled client without letting pool exhaustion silently eat the
 * caller's whole latency budget. If the timer wins, the late-arriving client is
 * released rather than leaked — an abandoned checkout is how a pool starves.
 */
async function acquirePoolClient(
  dependencies: MemoryToolDependencies,
  startedAt: number,
  maxLatencyMs: number,
): Promise<PoolClient> {
  const remainingMs = remainingLatencyMs(startedAt, maxLatencyMs);
  const connectPromise = dependencies.pool.connect();

  return await new Promise<PoolClient>((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => {
      settled = true;
      reject(new Error("durable lane context latency budget exhausted"));
    }, remainingMs);

    void connectPromise
      .then(
        (client) => {
          if (settled) {
            client.release();
            return;
          }
          settled = true;
          clearTimeout(timeout);
          resolve(client);
        },
        (error: unknown) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          reject(error);
        },
      )
      .catch(() => undefined);
  });
}

type TimedQueryConfig = QueryConfig<unknown[]> & { query_timeout: number };

async function queryWithinLatencyBudget(options: {
  client: PoolClient;
  startedAt: number;
  maxLatencyMs: number;
  text: string;
  values?: unknown[];
}): Promise<{ rows: Array<Record<string, unknown>> }> {
  const { client, startedAt, maxLatencyMs, text, values } = options;
  const config: TimedQueryConfig = {
    text,
    values,
    query_timeout: remainingLatencyMs(startedAt, maxLatencyMs),
  };
  const result = await client.query(config);
  return { rows: result.rows as Array<Record<string, unknown>> };
}

/**
 * Open the read path.
 *
 * With no latency budget this is just the pool — no transaction, no dedicated
 * client, nothing to leak. With one, it takes a dedicated client inside a
 * `READ ONLY` transaction carrying a server-side `statement_timeout`, so a query
 * that outlives the budget is cancelled by Postgres itself rather than merely
 * abandoned by the driver while the backend keeps burning CPU.
 *
 * A client that errored is released WITH the error, which destroys it instead of
 * returning a connection in an unknown transaction state to the pool.
 */
async function openDurableLaneReader(
  dependencies: MemoryToolDependencies,
  maxLatencyMs: number | undefined,
): Promise<DurableLaneReader> {
  if (maxLatencyMs === undefined) {
    return {
      query: async (sql, params) => {
        const result = await dependencies.pool.query(sql, params);
        return { rows: result.rows as Array<Record<string, unknown>> };
      },
      commit: async () => undefined,
      rollback: async () => undefined,
      release: () => undefined,
    };
  }

  const startedAt = performance.now();
  const client = await acquirePoolClient(dependencies, startedAt, maxLatencyMs);
  let transactionOpen = false;
  let released = false;
  let unsafeError: Error | undefined;
  const markUnsafe = (error: unknown) => {
    unsafeError =
      error instanceof Error
        ? error
        : new Error("durable lane context client is unsafe");
  };
  const release = () => {
    if (released) return;
    released = true;
    client.release(unsafeError);
  };
  const query = async (sql: string, params?: unknown[]) => {
    try {
      return await queryWithinLatencyBudget({
        client,
        startedAt,
        maxLatencyMs,
        text: sql,
        values: params,
      });
    } catch (error) {
      markUnsafe(error);
      throw error;
    }
  };
  try {
    await query("BEGIN READ ONLY");
    transactionOpen = true;
    await query("SELECT set_config('statement_timeout', $1, true)", [
      `${remainingLatencyMs(startedAt, maxLatencyMs)}ms`,
    ]);
  } catch (error) {
    markUnsafe(error);
    release();
    throw error;
  }

  return {
    query: async (sql, params) => await query(sql, params),
    commit: async () => {
      await query("COMMIT");
      transactionOpen = false;
    },
    rollback: async () => {
      if (!transactionOpen || unsafeError) return;
      await query("ROLLBACK");
      transactionOpen = false;
    },
    release,
  };
}

/** The content-free fragment returned when no lane matches all seven coordinates. */
function laneScopeDenial(maxContentChars: number): DurableLaneContextFragment {
  return {
    scopeDenials: [
      { source: "durable_lane_context", reasons: ["exact_scope"] },
    ],
    truncation: [],
    degradedSources: [],
    budget: {
      content_char_limit: maxContentChars,
      content_chars_used: 0,
      max_events: UNBOUNDED,
    },
    citations: [],
  };
}

/** All seven scope coordinates, in the order every query in this file binds them. */
function laneScopeParams(
  args: AgentContextPackArgs,
  namespace: string,
): unknown[] {
  // `thread_id` uses IS NOT DISTINCT FROM so a null thread matches ONLY
  // unthreaded lanes rather than every thread in the channel.
  return [
    namespace,
    args.session_key,
    args.agent,
    args.platform,
    args.server_id,
    args.channel_id,
    args.thread_id ?? null,
  ];
}

const LANE_SELECT_SQL = `SELECT id, session_key, status, agent, source, channel_id, thread_id,
              project, topic, current_context_md, updated_at
         FROM ob_session_lanes
        WHERE namespace = $1
          AND session_key = $2
          AND agent = $3
          AND source = $4
          AND metadata->>'server_id' = $5
          AND channel_id = $6
          AND thread_id IS NOT DISTINCT FROM $7::text`;

// Every event in the lane, newest-first. No row ceiling: the caller asked for
// this lane's durable context, and a partial answer that reports itself as
// complete is the silent-zero failure `docs/GOTCHAS.md` names. The join
// re-binds all seven coordinates so a lane_id alone can never widen scope.
const LANE_EVENTS_SQL = `SELECT e.id, e.event_type, e.content, e.source, e.importance,
              e.artifact_path, e.transcript_ref, e.occurred_at, e.created_at
         FROM ob_session_events e
         JOIN ob_session_lanes l ON l.id = e.lane_id
        WHERE e.lane_id = $1
          AND l.namespace = $2
          AND l.session_key = $3
          AND l.agent = $4
          AND l.source = $5
          AND l.metadata->>'server_id' = $6
          AND l.channel_id = $7
          AND l.thread_id IS NOT DISTINCT FROM $8::text
        ORDER BY e.created_at DESC, e.id DESC`;

type LaneEventCollection = {
  events: Array<Record<string, unknown>>;
  citations: Array<Record<string, unknown>>;
  remainingChars: number;
  eventsTruncated: boolean;
};

/**
 * Whether an event row held a body that the char allocation could not admit.
 * That is a genuine drop and must be reported; an empty body is not.
 */
function droppedNonEmptyContent(content: unknown): boolean {
  return typeof content === "string" && content.length > 0;
}

/**
 * Shape the lane's events into the emitted collection.
 *
 * Rows arrive newest-first (so a constrained read keeps the NEWEST events) and
 * are emitted oldest-first, so the caller reads the lane in chronological
 * order.
 */
function collectLaneEvents(
  eventRows: Array<Record<string, unknown>>,
  laneId: unknown,
  startingChars: number,
): LaneEventCollection {
  const events: Array<Record<string, unknown>> = [];
  const citations: Array<Record<string, unknown>> = [
    {
      id: `session_lane:${String(laneId)}`,
      kind: "session_lane",
      source_ref: `ob_session_lanes/${String(laneId)}`,
    },
  ];
  let remainingChars = startingChars;
  let eventsTruncated = false;

  for (const row of eventRows) {
    const eventContent = boundedText(row.content, remainingChars);
    if (!eventContent.text) {
      if (droppedNonEmptyContent(row.content)) eventsTruncated = true;
      break;
    }
    const citationId = `session_event:${String(row.id)}`;
    events.push({
      id: row.id,
      event_type: row.event_type,
      content: eventContent.text,
      source: row.source,
      importance: row.importance,
      artifact_path: row.artifact_path,
      transcript_ref: row.transcript_ref,
      occurred_at: row.occurred_at,
      created_at: row.created_at,
      citation_id: citationId,
    });
    citations.push({
      id: citationId,
      kind: "session_event",
      source_ref: `ob_session_events/${String(row.id)}`,
      transcript_ref: row.transcript_ref ?? null,
      artifact_path: row.artifact_path ?? null,
    });
    remainingChars -= eventContent.text.length;
    if (eventContent.truncated) eventsTruncated = true;
  }
  events.reverse();

  return { events, citations, remainingChars, eventsTruncated };
}

/** What was dropped, if anything. Only reachable when the caller asked for a bounded pack. */
function laneTruncationEntries(options: {
  contextTruncated: boolean;
  eventsTruncated: boolean;
  maxContentChars: number;
}): Array<Record<string, unknown>> {
  const { contextTruncated, eventsTruncated, maxContentChars } = options;
  const truncation: Array<Record<string, unknown>> = [];
  if (contextTruncated) {
    truncation.push({
      source: "durable_lane_context.current_context_md",
      max_chars: maxContentChars,
    });
  }
  if (eventsTruncated) {
    truncation.push({
      source: "durable_lane_context.events",
      max_events: UNBOUNDED,
      max_event_chars: UNBOUNDED,
      content_char_limit: maxContentChars,
    });
  }
  return truncation;
}

/**
 * The share of the allocation the checkpoint may take.
 *
 * With nothing imposed the checkpoint arrives whole. Under an explicit request
 * it takes at most HALF, leaving the rest for what actually happened: a
 * constrained read that returns a full checkpoint and zero events is the same
 * silent-nothing failure in a different costume. Removing the old fixed
 * 6,000-char ceiling exposed exactly that — a 3,000-token request produced a
 * 9,000-char checkpoint and no events at all.
 */
function laneContextShare(maxContentChars: number): number {
  if (maxContentChars === UNBOUNDED) return UNBOUNDED;
  return Math.max(0, Math.floor(maxContentChars / 2));
}

/** Read the lane and its events, and assemble the populated fragment. */
async function readLaneFragment(options: {
  args: AgentContextPackArgs;
  reader: DurableLaneReader;
  scopeParams: unknown[];
  maxContentChars: number;
}): Promise<DurableLaneContextFragment> {
  const { args, reader, scopeParams, maxContentChars } = options;

  const { rows: laneRows } = await reader.query(LANE_SELECT_SQL, scopeParams);
  const lane = laneRows[0] as Record<string, unknown> | undefined;
  if (!lane) {
    await reader.commit();
    return laneScopeDenial(maxContentChars);
  }

  const context = boundedText(
    lane.current_context_md,
    laneContextShare(maxContentChars),
  );
  const startingChars = Math.max(
    0,
    maxContentChars - (context.text?.length ?? 0),
  );

  const { rows: eventRows } = await reader.query(LANE_EVENTS_SQL, [
    lane.id,
    ...scopeParams,
  ]);
  const collected = collectLaneEvents(eventRows, lane.id, startingChars);

  const truncation = laneTruncationEntries({
    contextTruncated: context.truncated,
    eventsTruncated: collected.eventsTruncated,
    maxContentChars,
  });

  await reader.commit();
  return {
    section: {
      label: "durable_lane_context",
      exact_scope_required: true,
      lane: {
        id: lane.id,
        session_key: lane.session_key,
        status: lane.status,
        agent: lane.agent,
        platform: lane.source,
        server_id: args.server_id,
        channel_id: lane.channel_id,
        thread_id: lane.thread_id,
        project: lane.project,
        topic: lane.topic,
        current_context_md: context.text,
        updated_at: lane.updated_at,
        citation_id: `session_lane:${String(lane.id)}`,
      },
      events: collected.events,
      event_count: collected.events.length,
      truncated: truncation.length > 0,
    },
    scopeDenials: [],
    truncation,
    degradedSources: [],
    budget: {
      content_char_limit: maxContentChars,
      content_chars_used: maxContentChars - collected.remainingChars,
      max_context_chars: UNBOUNDED,
      max_events: UNBOUNDED,
      max_event_chars: UNBOUNDED,
    },
    citations: collected.citations,
  };
}

export async function loadDurableLaneContext(
  args: AgentContextPackArgs,
  namespace: string,
  dependencies: MemoryToolDependencies,
  contentCharLimit?: number,
): Promise<DurableLaneContextFragment> {
  const maxContentChars = resolveContentChars(args, contentCharLimit);
  const scopeParams = laneScopeParams(args, namespace);

  let reader: DurableLaneReader | undefined;
  try {
    reader = await openDurableLaneReader(
      dependencies,
      args.budget?.max_latency_ms,
    );
    return await readLaneFragment({
      args,
      reader,
      scopeParams,
      maxContentChars,
    });
  } catch (error) {
    await reader?.rollback();
    logDurableLaneFailure(dependencies.logger, args, maxContentChars, error);
    return {
      scopeDenials: [],
      truncation: [],
      degradedSources: [
        { source: "durable_lane_context", reason: "database_unavailable" },
      ],
      budget: {
        content_char_limit: maxContentChars,
        content_chars_used: 0,
        max_events: UNBOUNDED,
      },
      citations: [],
    };
  } finally {
    reader?.release();
  }
}

/**
 * Log a failed lane read. See {@link logDurableFailure} for why it is two lines
 * and why the driver's fields are named individually rather than spread.
 */
function logDurableLaneFailure(
  logger: DurableFailureLogger,
  args: AgentContextPackArgs,
  maxContentChars: number,
  error: unknown,
): void {
  logDurableFailure({
    logger,
    event: "durable_lane_context_read_failed",
    error,
    errorFields: {
      namespace: args.namespace,
      session_key: args.session_key,
    },
    detailFields: {
      namespace: args.namespace,
      agent: args.agent,
      platform: args.platform,
      server_id: args.server_id,
      channel_id: args.channel_id,
      thread_id: args.thread_id ?? null,
      session_key: args.session_key,
      repo: args.repo ?? null,
      requested_max_tokens: args.budget?.max_tokens ?? null,
      content_char_limit: maxContentChars,
      ...errorIdentityFields(error),
      ...pgDiagnosticFields(error, [
        "code",
        "detail",
        "hint",
        "constraint",
        "routine",
      ]),
      stack: asError(error)?.stack ?? null,
      cause: asError(error)?.cause ? String(asError(error)?.cause) : null,
    },
  });
}
