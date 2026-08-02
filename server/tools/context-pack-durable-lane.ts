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
import type { Logger } from "pino";
import type { AgentContextPackArgs } from "./context-pack-args.ts";
import type { MemoryToolDependencies } from "./types.ts";

/**
 * Characters reserved for the envelope (schema/scope/warnings/budget/citations)
 * before section bodies get any of a caller's token budget.
 */
export const CONTEXT_PACK_ENVELOPE_CHAR_RESERVE = 1_200;

/**
 * What the pack reports for a bound nobody imposed.
 *
 * These budget fields are typed `number` and mean "the bound that actually
 * applied to this read". When no bound applied, the honest typed value is the
 * effective one — every row, every character — not `null`. Nulling it would
 * force every consumer to handle an absence that never happens, and would say
 * "unknown" where the truth is "everything".
 */
export const UNBOUNDED = Number.MAX_SAFE_INTEGER;

/**
 * Recall means TOTAL recall.
 *
 * This path once carried four ceilings — 12,000 content chars, 6,000 context
 * chars, 8 events, 1,000 chars per event — and none was ever asked for. The
 * effect was visible in every session-start block: exactly eight handoff lines,
 * each severed mid-word, while the lane held thousands of whole events.
 *
 * A caller that genuinely needs a bounded pack still gets one by passing
 * `budget.max_tokens` explicitly, and the whole-pack fitter honours it. Absent
 * that request, the lane comes back whole. Do not reintroduce a default.
 */
function resolveDurableLaneContentChars(
  args: AgentContextPackArgs,
  contentCharLimit: number | undefined,
): number {
  // An explicit whole-pack allocation is the caller's own request; honour it.
  if (contentCharLimit !== undefined) return Math.max(0, contentCharLimit);
  if (args.budget?.max_tokens !== undefined) {
    return Math.max(
      0,
      args.budget.max_tokens * 4 - CONTEXT_PACK_ENVELOPE_CHAR_RESERVE,
    );
  }
  return UNBOUNDED;
}

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

async function queryWithinLatencyBudget(
  client: PoolClient,
  startedAt: number,
  maxLatencyMs: number,
  text: string,
  values?: unknown[],
): Promise<{ rows: Array<Record<string, unknown>> }> {
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
      return await queryWithinLatencyBudget(
        client,
        startedAt,
        maxLatencyMs,
        sql,
        params,
      );
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

/**
 * Bound a text value to `maxChars`, reporting whether anything was dropped.
 * Shared with the durable-memory loader so both recall paths bound content
 * identically.
 */
export function boundedText(
  value: unknown,
  maxChars: number,
): { text: string | null; truncated: boolean } {
  if (typeof value !== "string" || value.length === 0 || maxChars <= 0) {
    return {
      text: null,
      truncated: typeof value === "string" && value.length > 0,
    };
  }
  if (value.length <= maxChars) return { text: value, truncated: false };
  return { text: value.slice(0, maxChars), truncated: true };
}

export async function loadDurableLaneContext(
  args: AgentContextPackArgs,
  namespace: string,
  dependencies: MemoryToolDependencies,
  contentCharLimit?: number,
): Promise<DurableLaneContextFragment> {
  const maxContentChars = resolveDurableLaneContentChars(
    args,
    contentCharLimit,
  );
  // All seven coordinates, bound as parameters. `thread_id` uses
  // IS NOT DISTINCT FROM so a null thread matches ONLY unthreaded lanes rather
  // than every thread in the channel.
  const scopeParams = [
    namespace,
    args.session_key,
    args.agent,
    args.platform,
    args.server_id,
    args.channel_id,
    args.thread_id ?? null,
  ];

  let reader: DurableLaneReader | undefined;
  try {
    reader = await openDurableLaneReader(
      dependencies,
      args.budget?.max_latency_ms,
    );
    const { rows: laneRows } = await reader.query(
      `SELECT id, session_key, status, agent, source, channel_id, thread_id,
              project, topic, current_context_md, updated_at
         FROM ob_session_lanes
        WHERE namespace = $1
          AND session_key = $2
          AND agent = $3
          AND source = $4
          AND metadata->>'server_id' = $5
          AND channel_id = $6
          AND thread_id IS NOT DISTINCT FROM $7::text`,
      scopeParams,
    );
    const lane = laneRows[0] as Record<string, unknown> | undefined;
    if (!lane) {
      await reader.commit();
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

    // With no bound, the checkpoint arrives whole. Under an explicit budget it
    // takes at most HALF, leaving the rest for what actually happened: a bounded
    // read that returns a full checkpoint and zero events is the same
    // silent-nothing failure in a different costume. Removing the old fixed
    // 6,000-char ceiling exposed exactly that — a 3,000-token request produced a
    // 9,000-char checkpoint and no events at all.
    const contextShare =
      maxContentChars === UNBOUNDED
        ? UNBOUNDED
        : Math.max(0, Math.floor(maxContentChars / 2));
    const context = boundedText(lane.current_context_md, contextShare);
    let remainingChars = Math.max(
      0,
      maxContentChars - (context.text?.length ?? 0),
    );

    // Every event in the lane, newest-first. No row ceiling: the caller asked for
    // this lane's durable context, and a partial answer that reports itself as
    // complete is the silent-zero failure `docs/GOTCHAS.md` names. The join
    // re-binds all seven coordinates so a lane_id alone can never widen scope.
    const { rows: eventRows } = await reader.query(
      `SELECT e.id, e.event_type, e.content, e.source, e.importance,
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
        ORDER BY e.created_at DESC, e.id DESC`,
      [lane.id, ...scopeParams],
    );

    const events: Array<Record<string, unknown>> = [];
    const citations: Array<Record<string, unknown>> = [
      {
        id: `session_lane:${String(lane.id)}`,
        kind: "session_lane",
        source_ref: `ob_session_lanes/${String(lane.id)}`,
      },
    ];
    let eventsTruncated = false;
    for (const row of eventRows) {
      const eventContent = boundedText(row.content, remainingChars);
      if (!eventContent.text) {
        if (typeof row.content === "string" && row.content.length > 0) {
          eventsTruncated = true;
        }
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
    // Fetched newest-first (so a budget keeps the NEWEST events), emitted
    // oldest-first so the caller reads the lane in chronological order.
    events.reverse();

    const truncation: Array<Record<string, unknown>> = [];
    // Only reachable when the caller itself asked for a bounded pack.
    if (context.truncated) {
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
        events,
        event_count: events.length,
        truncated: truncation.length > 0,
      },
      scopeDenials: [],
      truncation,
      degradedSources: [],
      budget: {
        content_char_limit: maxContentChars,
        content_chars_used: maxContentChars - remainingChars,
        max_context_chars: UNBOUNDED,
        max_events: UNBOUNDED,
        max_event_chars: UNBOUNDED,
      },
      citations,
    };
  } catch (error) {
    await reader?.rollback();
    // This catch was once bare: the read failed, the envelope said
    // "database_unavailable", and the actual reason went in the bin. ERROR names
    // what broke at the default level; DEBUG carries the whole autopsy, because
    // a "database_unavailable" envelope on its own tells a later reader nothing
    // and by then the inputs that produced it are gone.
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
 * Two lines on purpose. ERROR states what broke, briefly, so it is visible at
 * the default level. DEBUG carries every input that shaped the call plus the
 * driver's own fields — sifting a large log is a later reader's problem; having
 * no log at all is a later reader's disaster.
 *
 * The raw pg fields are named individually rather than spread, so no driver
 * string carrying query fragments reaches the log wholesale.
 */
function logDurableLaneFailure(
  logger: Logger,
  args: AgentContextPackArgs,
  maxContentChars: number,
  error: unknown,
): void {
  const err = error instanceof Error ? error : undefined;
  logger.error(
    {
      namespace: args.namespace,
      session_key: args.session_key,
      error_message: err?.message ?? String(error),
    },
    "durable_lane_context_read_failed",
  );
  logger.debug(
    {
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
      error_name: err?.name ?? typeof error,
      error_message: err?.message ?? String(error),
      pg_code: (error as { code?: unknown })?.code ?? null,
      pg_detail: (error as { detail?: unknown })?.detail ?? null,
      pg_hint: (error as { hint?: unknown })?.hint ?? null,
      pg_constraint: (error as { constraint?: unknown })?.constraint ?? null,
      pg_routine: (error as { routine?: unknown })?.routine ?? null,
      stack: err?.stack ?? null,
      cause: err?.cause ? String(err.cause) : null,
    },
    "durable_lane_context_read_failed_detail",
  );
}
