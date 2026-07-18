import type { ToolDeps } from "./index.ts";
import type { AgentContextPackArgs } from "./agent-context-pack.ts";

const DURABLE_LANE_MAX_CONTENT_CHARS = 12_000;
const DURABLE_LANE_MAX_CONTEXT_CHARS = 6_000;
const DURABLE_LANE_MAX_EVENTS = 8;
const DURABLE_LANE_MAX_EVENT_CHARS = 1_000;
const CONTEXT_PACK_ENVELOPE_CHAR_RESERVE = 1_200;

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
  const client = await deps.pool.connect();
  let transactionOpen = false;
  try {
    await client.query("BEGIN READ ONLY");
    transactionOpen = true;
  } catch (error) {
    client.release();
    throw error;
  }

  return {
    query: async (sql, params) => {
      const remainingMs = Math.floor(
        maxLatencyMs - (performance.now() - startedAt),
      );
      if (remainingMs < 1) {
        throw new Error("durable lane context latency budget exhausted");
      }
      await client.query(
        "SELECT set_config('statement_timeout', $1, true)",
        [`${remainingMs}ms`],
      );
      const result = await client.query(sql, params);
      return { rows: result.rows as Array<Record<string, unknown>> };
    },
    commit: async () => {
      await client.query("COMMIT");
      transactionOpen = false;
    },
    rollback: async () => {
      if (!transactionOpen) return;
      await client.query("ROLLBACK").catch(() => undefined);
      transactionOpen = false;
    },
    release: () => client.release(),
  };
}

function boundedText(value: unknown, maxChars: number): {
  text: string | null;
  truncated: boolean;
} {
  if (typeof value !== "string" || value.length === 0 || maxChars <= 0) {
    return { text: null, truncated: typeof value === "string" && value.length > 0 };
  }
  if (value.length <= maxChars) return { text: value, truncated: false };
  return { text: value.slice(0, maxChars), truncated: true };
}

export async function loadDurableLaneContext(
  args: AgentContextPackArgs,
  namespace: string,
  deps: ToolDeps,
): Promise<DurableLaneContextFragment> {
  const maxContentChars = Math.max(
    0,
    Math.min(
      DURABLE_LANE_MAX_CONTENT_CHARS,
      (args.budget?.max_tokens ?? 4000) * 4 -
        CONTEXT_PACK_ENVELOPE_CHAR_RESERVE,
    ),
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
          max_events: DURABLE_LANE_MAX_EVENTS,
        },
        citations: [],
      };
    }

    const contextLimit = Math.min(
      DURABLE_LANE_MAX_CONTEXT_CHARS,
      maxContentChars,
    );
    const context = boundedText(lane.current_context_md, contextLimit);
    let remainingChars = Math.max(
      0,
      maxContentChars - (context.text?.length ?? 0),
    );
    const { rows: fetchedEventRows } = await reader.query(
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
        ORDER BY e.created_at DESC, e.id DESC
        LIMIT $9`,
      [lane.id, ...scopeParams, DURABLE_LANE_MAX_EVENTS + 1],
    );
    const omittedEvents = fetchedEventRows.length > DURABLE_LANE_MAX_EVENTS;
    const eventRows = fetchedEventRows.slice(0, DURABLE_LANE_MAX_EVENTS);

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
      const eventContent = boundedText(
        row.content,
        Math.min(DURABLE_LANE_MAX_EVENT_CHARS, remainingChars),
      );
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
    events.sort((left, right) => {
      const createdAtDifference =
        new Date(String(left.created_at)).getTime() -
        new Date(String(right.created_at)).getTime();
      if (createdAtDifference) return createdAtDifference;
      const leftId = String(left.id);
      const rightId = String(right.id);
      return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
    });

    const truncation: Array<Record<string, unknown>> = [];
    if (context.truncated) {
      truncation.push({
        source: "durable_lane_context.current_context_md",
        max_chars: contextLimit,
      });
    }
    if (eventsTruncated) {
      truncation.push({
        source: "durable_lane_context.events",
        max_events: DURABLE_LANE_MAX_EVENTS,
        max_event_chars: DURABLE_LANE_MAX_EVENT_CHARS,
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
        max_context_chars: DURABLE_LANE_MAX_CONTEXT_CHARS,
        max_events: DURABLE_LANE_MAX_EVENTS,
        max_event_chars: DURABLE_LANE_MAX_EVENT_CHARS,
      },
      citations,
    };
  } catch {
    await reader?.rollback();
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
        max_events: DURABLE_LANE_MAX_EVENTS,
      },
      citations: [],
    };
  } finally {
    reader?.release();
  }
}
