/**
 * `citation_recall`: return citation evidence for one readable session event.
 *
 * Design authority: `docs/identity-boundary.md` (token-derived lane identity)
 * and `docs/decisions/privilege-isolation-closed-brain.md`.
 *
 * A recalled fact is only as useful as its provenance, so this answers "where
 * did that come from" for exactly one event: the host-neutral conversation ref,
 * the speaker, the date, the stored transcript, and the exchanges either side of
 * it. Events captured before transcripts were stored report
 * `status: "source_not_stored"` EXPLICITLY rather than returning an empty
 * citation -- silence and "we never had it" are different answers, and a caller
 * that cannot tell them apart will read a missing source as a missing fact.
 *
 * Isolation is enforced by joining the event to its LANE and scoping on the
 * lane's namespace. Session events carry no namespace column of their own, so
 * the lane is the only place the boundary exists; matching on `e.id` alone
 * would return whichever lane happens to own the UUID.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { canRead } from "../auth/permissions.ts";
import { canTargetNamespace } from "../auth/namespace-policy.ts";
import {
  createSessionRepository,
  type CitationEventRow,
} from "../db/session-repository.ts";
import {
  authIdentity,
  errorResult,
  textResult,
  type MemoryToolDependencies,
} from "./types.ts";

/** Neighboring exchanges returned on each side when unspecified. */
const DEFAULT_CONTEXT_EXCHANGES = 2;
/** Transcript characters returned per exchange when unspecified. */
const DEFAULT_TRANSCRIPT_CHARS = 2_000;

/**
 * SQLSTATE codes and error names safe to name in a log line.
 *
 * An unrecognized driver error is reported as `unknown` rather than echoed:
 * raw driver text embeds relation names, quoted parameter values, and row
 * content, none of which belong in a log or a response.
 */
const SAFE_DB_ERROR_CODES = new Set([
  "22001",
  "22P02",
  "23503",
  "23505",
  "42P01",
  "57014",
]);
const SAFE_DB_ERROR_NAMES = new Set(["Error", "PostgresError"]);

/** @returns A stable label for this error, never caller-derived text. */
function safeErrorLabel(error: unknown): string {
  if (!error || typeof error !== "object") return "unknown";
  const candidate = error as { code?: unknown; name?: unknown };
  if (typeof candidate.code === "string" && SAFE_DB_ERROR_CODES.has(candidate.code)) {
    return candidate.code;
  }
  if (typeof candidate.name === "string" && SAFE_DB_ERROR_NAMES.has(candidate.name)) {
    return candidate.name;
  }
  return "unknown";
}

/** @returns The value as an ISO string, or `null` when absent or unparseable. */
function iso(value: string | Date | null): string | null {
  if (value === null) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/** Project one neighboring exchange, reporting whether its text was shortened. */
function transcriptProjection(row: CitationEventRow, maxChars: number) {
  const length = row.transcript?.length ?? 0;
  return {
    event_id: row.id,
    event_type: row.event_type,
    speaker: row.source ?? row.created_by,
    date: iso(row.occurred_at) ?? iso(row.created_at),
    transcript: row.transcript?.slice(0, maxChars) ?? null,
    transcript_length: length,
    transcript_truncated: length > maxChars,
  };
}

const CITATION_RECALL_DESCRIPTION =
  "Return citation evidence for one readable session event. Stored citations include a host-neutral conversation ref, speaker, date, optional transcript, and bounded neighboring exchanges; legacy events explicitly report source_not_stored.";

/** Frozen `citation_recall` argument contract: the names and rule values are the API. */
const citationRecallInputSchema = {
  event_id: z.string().uuid().describe("Session event UUID to cite"),
  namespace: z
    .string()
    .max(500)
    .optional()
    .describe("Namespace for isolation (defaults to agent's clientId)"),
  context_limit: z
    .number()
    .int()
    .min(0)
    .max(10)
    .optional()
    .describe(
      `Neighboring transcript exchanges to return on each side (default ${DEFAULT_CONTEXT_EXCHANGES})`,
    ),
  max_transcript_chars: z
    .number()
    .int()
    .min(100)
    .max(50_000)
    .optional()
    .describe(
      `Maximum characters for each returned transcript exchange (default ${DEFAULT_TRANSCRIPT_CHARS})`,
    ),
};

/** Tool annotations; `citation_recall` reads and never mutates. */
const citationRecallAnnotations = {
  title: "Citation Recall",
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
};

/** One authorized recall: namespace already cleared, defaults already applied. */
interface CitationRequest {
  namespace: string;
  eventId: string;
  contextLimit: number;
  maxChars: number;
}

/**
 * Fetch the cited event under lane-derived namespace scope.
 *
 * The lane join IS the isolation predicate: `l.namespace = $1` is what stops an
 * event UUID from another lane resolving here.
 *
 * @returns The event, or `undefined` when no readable row carries that id.
 */
async function fetchCitedEvent(
  dependencies: MemoryToolDependencies,
  request: CitationRequest,
): Promise<CitationEventRow | undefined> {
  const repository = createSessionRepository(dependencies.pool);
  return repository.selectCitedEvent({
    namespace: request.namespace,
    eventId: request.eventId,
  });
}

/** Both neighbor queries, each carrying one extra row purely as a "more exists" probe. */
interface NeighborRows {
  before: CitationEventRow[];
  after: CitationEventRow[];
}

/**
 * Read the exchanges either side of the cited event within its transcript.
 *
 * One extra row is fetched on each side purely to learn whether MORE exists; it
 * is dropped before projection and only sets `expandable`.
 */
async function fetchNeighbors(
  dependencies: MemoryToolDependencies,
  event: CitationEventRow,
  contextLimit: number,
): Promise<NeighborRows> {
  const repository = createSessionRepository(dependencies.pool);
  const neighborInput = {
    laneId: event.lane_id,
    transcriptRef: event.transcript_ref,
    eventId: event.id,
    limitPlusOne: contextLimit + 1,
  };

  const [before, after] = await Promise.all([
    repository.selectCitationNeighbors({ ...neighborInput, side: "before" }),
    repository.selectCitationNeighbors({ ...neighborInput, side: "after" }),
  ]);

  return { before, after };
}

/**
 * The answer for an event captured before transcripts were stored.
 *
 * A legacy event predates transcript storage. Saying so explicitly is the
 * contract: an empty citation would read as "no source exists".
 */
function sourceNotStoredResult(
  dependencies: MemoryToolDependencies,
  event: CitationEventRow,
) {
  dependencies.logger.info(
    {
      tool: "citation_recall",
      eventId: event.id,
      citation: "source_not_stored",
    },
    "tool_result",
  );
  return textResult({
    event_id: event.id,
    fact: event.content,
    citation: {
      status: "source_not_stored",
      conversation_ref: null,
      date: null,
      speaker: null,
      transcript: null,
    },
    context: { before: [], after: [], expandable: false },
  });
}

/** Everything that can leave more behind than one call returned. */
interface ExpandableInputs {
  transcriptTruncated: boolean;
  projected: { transcript_truncated: boolean }[];
  neighbors: NeighborRows;
  contextLimit: number;
}

/**
 * @returns `true` when anything was held back for any reason, so one flag tells
 * a caller whether a wider call would return more.
 */
function isExpandable(inputs: ExpandableInputs): boolean {
  const { neighbors, contextLimit } = inputs;
  return (
    inputs.transcriptTruncated ||
    inputs.projected.some((row) => row.transcript_truncated) ||
    neighbors.before.length > contextLimit ||
    neighbors.after.length > contextLimit
  );
}

/** Shape the stored-citation payload from the event and its projected neighbors. */
function storedCitationResult(
  dependencies: MemoryToolDependencies,
  event: CitationEventRow,
  neighbors: NeighborRows,
  request: CitationRequest,
) {
  const { contextLimit, maxChars } = request;
  const before = neighbors.before
    .slice(0, contextLimit)
    .reverse()
    .map((row) => transcriptProjection(row, maxChars));
  const after = neighbors.after
    .slice(0, contextLimit)
    .map((row) => transcriptProjection(row, maxChars));
  const transcriptTruncated = (event.transcript?.length ?? 0) > maxChars;

  dependencies.logger.info(
    {
      tool: "citation_recall",
      eventId: event.id,
      contextBefore: before.length,
      contextAfter: after.length,
    },
    "tool_result",
  );
  return textResult({
    event_id: event.id,
    fact: event.content,
    citation: {
      status: "stored",
      conversation_ref: event.transcript_ref,
      speaker: event.source ?? event.created_by,
      date: iso(event.occurred_at) ?? iso(event.created_at),
      transcript: event.transcript?.slice(0, maxChars) ?? null,
      transcript_length: event.transcript?.length ?? 0,
      transcript_truncated: transcriptTruncated,
    },
    context: {
      before,
      after,
      expandable: isExpandable({
        transcriptTruncated,
        projected: [...before, ...after],
        neighbors,
        contextLimit,
      }),
    },
  });
}

/** Resolve one authorized recall end to end: event, then neighbors, then payload. */
async function recallCitation(
  dependencies: MemoryToolDependencies,
  request: CitationRequest,
) {
  try {
    const event = await fetchCitedEvent(dependencies, request);
    if (!event) return errorResult("Citation event not found");

    if (!event.transcript_ref) {
      return sourceNotStoredResult(dependencies, event);
    }

    const neighbors = await fetchNeighbors(dependencies, event, request.contextLimit);
    return storedCitationResult(dependencies, event, neighbors, request);
  } catch (error) {
    dependencies.logger.error(
      {
        tool: "citation_recall",
        eventId: request.eventId,
        errorLabel: safeErrorLabel(error),
      },
      "citation_recall_db_error",
    );
    return errorResult("Database error during citation recall");
  }
}

export function registerCitationRecallTool(
  server: McpServer,
  dependencies: MemoryToolDependencies,
): void {
  server.registerTool(
    "citation_recall",
    {
      description: CITATION_RECALL_DESCRIPTION,
      inputSchema: citationRecallInputSchema,
      annotations: citationRecallAnnotations,
    },
    async (args, extra) => {
      const identity = authIdentity(extra.authInfo);
      if (!identity || !canRead(identity.role, "sessions")) {
        dependencies.logger.warn(
          { tool: "citation_recall", role: identity?.role ?? "none" },
          "citation_recall_denied",
        );
        return errorResult("Permission denied: cannot recall citations");
      }

      const namespace = args.namespace ?? identity.clientId;
      if (!canTargetNamespace(identity, "read", namespace)) {
        return errorResult(`Permission denied: cannot read namespace '${namespace}'`);
      }

      return await recallCitation(dependencies, {
        namespace,
        eventId: args.event_id,
        contextLimit: args.context_limit ?? DEFAULT_CONTEXT_EXCHANGES,
        maxChars: args.max_transcript_chars ?? DEFAULT_TRANSCRIPT_CHARS,
      });
    },
  );
}
