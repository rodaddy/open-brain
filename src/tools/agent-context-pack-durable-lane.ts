import type { PoolClient, QueryConfig } from "pg";
import type { ToolDeps } from "./index.ts";
import type { AgentContextPackArgs } from "./agent-context-pack.ts";
import { logger } from "../logger.ts";

export const CONTEXT_PACK_ENVELOPE_CHAR_RESERVE = 1_200;

/**
 * What the pack reports for a bound that nobody imposed.
 *
 * The reported budget fields are typed `number` and mean "the bound that
 * actually applied to this read". When no bound applied, the honest typed value
 * is the effective one -- every row, every character -- not `null`. Nulling the
 * field would force every consumer to handle an absence that never happens and
 * would say "unknown" where the truth is "everything".
 */
export const UNBOUNDED = Number.MAX_SAFE_INTEGER;

/**
 * Recall means TOTAL recall. This file used to carry four ceilings --
 * 12,000 content chars, 6,000 context chars, 8 events, 1,000 chars per event --
 * and none of them was ever asked for. Their effect was visible in every
 * session-start block: exactly eight handoff lines, each severed mid-word
 * around a thousand characters, while the lane held thousands of whole events
 * in the database. The write path was de-capped on 2026-07-30; these were the
 * same defect on the other side of the same pipe, and they survived that pass
 * only because nobody looked in this file.
 *
 * Operator, 2026-07-30: "I don't care if this thing ends up being 2, 7, 12 gigs
 * in the database. What I need is for it to WORK PROPERLY, and then we can
 * figure out how to pare it down."
 *
 * So: no event ceiling, no per-event ceiling, no content ceiling. A caller that
 * genuinely needs a bounded pack still gets one -- it passes `budget.max_tokens`
 * explicitly and the whole-pack fitter honours it. Absent that request, the lane
 * comes back whole. Do not reintroduce a default; `.claude/hooks/design-lookup-gate.ts`
 * blocks it, and the standing rule outranks the hook.
 */
function resolveDurableLaneContentChars(
  args: AgentContextPackArgs,
  contentCharLimit: number | undefined,
): number {
  // An explicit whole-pack allocation is a caller's own request; honour it.
  if (contentCharLimit !== undefined) return Math.max(0, contentCharLimit);
  // A caller that asked for a token budget gets one derived from it.
  if (args.budget?.max_tokens !== undefined) {
    return Math.max(
      0,
      args.budget.max_tokens * 4 - CONTEXT_PACK_ENVELOPE_CHAR_RESERVE,
    );
  }
  // Nobody asked for a bound. Return everything.
  return Number.MAX_SAFE_INTEGER;
}

type DurableLaneContextFragment = {
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

function remainingLatencyMs(startedAt: number, maxLatencyMs: number): number {
  const remainingMs = Math.floor(
    maxLatencyMs - (performance.now() - startedAt),
  );
  if (remainingMs < 1) {
    throw new Error("durable lane context latency budget exhausted");
  }
  return remainingMs;
}

async function acquirePoolClient(
  deps: ToolDeps,
  startedAt: number,
  maxLatencyMs: number,
): Promise<PoolClient> {
  const remainingMs = remainingLatencyMs(startedAt, maxLatencyMs);
  const connectPromise = deps.pool.connect();

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

type TimedQueryConfig = QueryConfig<unknown[]> & {
  query_timeout: number;
};

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

async function openDurableLaneReader(
  deps: ToolDeps,
  maxLatencyMs: number | undefined,
): Promise<DurableLaneReader> {
  if (maxLatencyMs === undefined) {
    return {
      query: async (sql, params) => {
        const result = await deps.pool.query(sql, params);
        return { rows: result.rows as Array<Record<string, unknown>> };
      },
      commit: async () => undefined,
      rollback: async () => undefined,
      release: () => undefined,
    };
  }

  const startedAt = performance.now();
  const client = await acquirePoolClient(deps, startedAt, maxLatencyMs);
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
    query: async (sql, params) => {
      return await query(sql, params);
    },
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
 * Shared with the durable-memory loader ({@link ./agent-context-pack-durable-memory.ts})
 * so both context-pack recall paths bound content the same way.
 */
export function boundedText(
  value: unknown,
  maxChars: number,
): {
  text: string | null;
  truncated: boolean;
} {
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
  deps: ToolDeps,
  contentCharLimit?: number,
): Promise<DurableLaneContextFragment> {
  const maxContentChars = resolveDurableLaneContentChars(
    args,
    contentCharLimit,
  );
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
    reader = await openDurableLaneReader(deps, args.budget?.max_latency_ms);
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
          {
            source: "durable_lane_context",
            reasons: ["exact_scope"],
          },
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

    // When nobody asked for a bound, maxContentChars is UNBOUNDED and the
    // checkpoint arrives whole. When a caller DID ask for one, the checkpoint
    // must not eat the entire allocation and starve the events: a bounded read
    // that returns a full checkpoint and zero events is the same silent-nothing
    // failure in a different costume. Removing the old fixed 6,000-char context
    // ceiling exposed exactly that -- a 3,000-token request produced a 9,000-char
    // checkpoint and no events at all. So under an explicit budget the checkpoint
    // takes at most half, leaving the rest for what actually happened.
    const contextShare =
      maxContentChars === UNBOUNDED
        ? UNBOUNDED
        : Math.max(0, Math.floor(maxContentChars / 2));
    const context = boundedText(lane.current_context_md, contextShare);
    let remainingChars = Math.max(
      0,
      maxContentChars - (context.text?.length ?? 0),
    );
    // Every event in the lane. No row ceiling: the caller asked for this lane's
    // durable context, and a partial answer that reports itself as complete is
    // the silent-zero failure this repo names in docs/GOTCHAS.md.
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
    const omittedEvents = false;

    const events: Array<Record<string, unknown>> = [];
    const citations: Array<Record<string, unknown>> = [
      {
        id: `session_lane:${String(lane.id)}`,
        kind: "session_lane",
        source_ref: `ob_session_lanes/${String(lane.id)}`,
      },
    ];
    let eventsTruncated = omittedEvents;
    for (const row of eventRows) {
      // Whole event. The only bound left is whatever the caller explicitly
      // asked for via budget.max_tokens; with no request, remainingChars is
      // effectively unbounded and every event arrives intact.
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
      if (eventContent.truncated) {
        eventsTruncated = true;
      }
    }
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
    // This catch used to be bare: the lane read failed, the envelope said
    // "database_unavailable", and the actual reason went in the bin. ERROR
    // states what broke; DEBUG carries the whole autopsy so a later reader is
    // not reconstructing it from an empty section.
    const err = error instanceof Error ? error : undefined;
    logger.error("durable_lane_context read failed", {
      namespace: args.namespace,
      session_key: args.session_key,
      error: err?.message ?? String(error),
    });
    logger.debug("durable_lane_context read failure detail", {
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
    });
    return {
      scopeDenials: [],
      truncation: [],
      degradedSources: [
        {
          source: "durable_lane_context",
          reason: "database_unavailable",
        },
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
