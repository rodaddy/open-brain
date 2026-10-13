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
import {
  createContextPackRepository,
  type ContextPackRepository,
} from "../db/context-pack-repository.ts";
import { openReadOnlySession } from "../db/read-only-session.ts";
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

type DurableLaneContextFragment = {
  section?: Record<string, unknown>;
  scopeDenials: Array<Record<string, unknown>>;
  truncation: Array<Record<string, unknown>>;
  degradedSources: Array<Record<string, unknown>>;
  budget: Record<string, unknown>;
  citations: Array<Record<string, unknown>>;
};

/**
 * The repository this section reads through, plus the session lifecycle the
 * caller must drive when one was opened.
 */
type DurableLaneReader = {
  repository: ContextPackRepository;
  commit: () => Promise<void>;
  rollback: () => Promise<void>;
  release: () => void;
};

/**
 * Open the read path.
 *
 * With no latency budget this is just the pool — no transaction, no dedicated
 * client, nothing to leak. With one, `server/db/read-only-session.ts` owns the
 * deadline-bounded connect, the `READ ONLY` transaction, the per-statement
 * timeout, and the release-with-error path; those are pool-lifecycle mechanics
 * and belong to server/db, not to this tool.
 */
async function openDurableLaneReader(
  dependencies: MemoryToolDependencies,
  maxLatencyMs: number | undefined,
): Promise<DurableLaneReader> {
  if (maxLatencyMs === undefined) {
    return {
      repository: createContextPackRepository(dependencies.pool),
      commit: async () => undefined,
      rollback: async () => undefined,
      release: () => undefined,
    };
  }

  const session = await openReadOnlySession({
    pool: dependencies.pool,
    maxLatencyMs,
    onLateArrival: (error: unknown) => {
      dependencies.logger.warn(
        {
          tool: "context_pack_durable_lane",
          errorName: error instanceof Error ? error.name : "unknown",
        },
        "durable_lane_client_acquire_settled_late",
      );
    },
  });

  return {
    repository: createContextPackRepository(session),
    commit: session.commit,
    rollback: session.rollback,
    release: session.release,
  };
}

/** The content-free fragment returned when no lane matches all seven coordinates. */
function laneScopeDenial(maxContentChars: number): DurableLaneContextFragment {
  return {
    scopeDenials: [{ source: "durable_lane_context", reasons: ["exact_scope"] }],
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
function laneScopeParams(args: AgentContextPackArgs, namespace: string): unknown[] {
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

  const { rows: laneRows } = await reader.repository.selectContextPackLane({
    scopeParams,
  });
  const lane = laneRows[0] as Record<string, unknown> | undefined;
  if (!lane) {
    await reader.commit();
    return laneScopeDenial(maxContentChars);
  }

  const context = boundedText(
    lane.current_context_md,
    laneContextShare(maxContentChars),
  );
  const startingChars = Math.max(0, maxContentChars - (context.text?.length ?? 0));

  const { rows: eventRows } = await reader.repository.selectContextPackLaneEvents({
    laneId: lane.id,
    scopeParams,
  });
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
    reader = await openDurableLaneReader(dependencies, args.budget?.max_latency_ms);
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
      ...pgDiagnosticFields(error, ["code", "detail", "hint", "constraint", "routine"]),
      stack: asError(error)?.stack ?? null,
      cause: asError(error)?.cause ? String(asError(error)?.cause) : null,
    },
  });
}
