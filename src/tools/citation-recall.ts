import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { canRead } from "../permissions.ts";
import { canReadNamespace } from "../read-policy.ts";
import type { AuthInfo } from "../types.ts";
import type { ToolDeps } from "./index.ts";
import { logger } from "../logger.ts";

type CitationEventRow = {
  id: string;
  event_type: string;
  content: string;
  source: string | null;
  transcript_ref: string | null;
  transcript: string | null;
  occurred_at: string | Date | null;
  created_at: string | Date;
  created_by: string;
  lane_id: string;
  session_key: string;
};

function iso(value: string | Date | null): string | null {
  if (value === null) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function transcriptProjection(row: CitationEventRow, maxChars: number) {
  const transcript = row.transcript;
  const transcriptLength = transcript?.length ?? 0;
  return {
    event_id: row.id,
    event_type: row.event_type,
    speaker: row.source ?? row.created_by,
    date: iso(row.occurred_at) ?? iso(row.created_at),
    transcript: transcript?.slice(0, maxChars) ?? null,
    transcript_length: transcriptLength,
    transcript_truncated: transcriptLength > maxChars,
  };
}

const EVENT_COLUMNS = `id, event_type, content, source, transcript_ref, transcript,
  occurred_at, created_at, created_by`;
const TARGET_EVENT_COLUMNS = `e.id, e.event_type, e.content, e.source, e.transcript_ref,
  e.transcript, e.occurred_at, e.created_at, e.created_by`;
const CANDIDATE_EVENT_COLUMNS =
  `candidate.id, candidate.event_type, candidate.content, candidate.source, ` +
  `candidate.transcript_ref, candidate.transcript, candidate.occurred_at, ` +
  `candidate.created_at, candidate.created_by`;
const SAFE_DB_ERROR_CODES = new Set([
  "22001",
  "22P02",
  "23503",
  "23505",
  "42P01",
  "57014",
]);
const SAFE_DB_ERROR_NAMES = new Set(["Error", "PostgresError"]);

function citationRecallDbErrorLabel(err: unknown): string {
  if (!err || typeof err !== "object") return "unknown";
  const candidate = err as { code?: unknown; name?: unknown };
  if (
    typeof candidate.code === "string" &&
    SAFE_DB_ERROR_CODES.has(candidate.code)
  ) {
    return candidate.code;
  }
  if (
    typeof candidate.name === "string" &&
    SAFE_DB_ERROR_NAMES.has(candidate.name)
  ) {
    return candidate.name;
  }
  return "unknown";
}

export function registerCitationRecall(
  server: McpServer,
  deps: ToolDeps,
): void {
  server.registerTool(
    "citation_recall",
    {
      description:
        "Return citation evidence for one readable session event. Stored citations include a host-neutral conversation ref, speaker, date, optional transcript, and bounded neighboring exchanges; legacy events explicitly report source_not_stored.",
      inputSchema: {
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
            "Neighboring transcript exchanges to return on each side (default 2)",
          ),
        max_transcript_chars: z
          .number()
          .int()
          .min(100)
          .max(50_000)
          .optional()
          .describe(
            "Maximum characters for each returned transcript exchange (default 2000)",
          ),
      },
      annotations: {
        title: "Citation Recall",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async (args, extra) => {
      const auth = extra.authInfo as AuthInfo | undefined;
      if (!auth || !canRead(auth.role, "sessions")) {
        logger.warn("citation_recall_denied", {
          role: auth?.role ?? "none",
          clientId: auth?.clientId ?? "none",
        });
        return {
          content: [
            {
              type: "text" as const,
              text: "Permission denied: cannot recall citations",
            },
          ],
          isError: true,
        };
      }

      const namespace = args.namespace ?? auth.clientId;
      if (!canReadNamespace(auth, namespace)) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Permission denied: cannot read namespace '${namespace}'`,
            },
          ],
          isError: true,
        };
      }

      const contextLimit = args.context_limit ?? 2;
      const maxTranscriptChars = args.max_transcript_chars ?? 2_000;
      try {
        const { rows } = await deps.pool.query<CitationEventRow>(
          `SELECT ${TARGET_EVENT_COLUMNS}, e.lane_id, l.session_key
FROM ob_session_events e
JOIN ob_session_lanes l ON l.id = e.lane_id
WHERE l.namespace = $1 AND e.id = $2`,
          [namespace, args.event_id],
        );
        const event = rows[0];
        if (!event) {
          return {
            content: [
              { type: "text" as const, text: "Citation event not found" },
            ],
            isError: true,
          };
        }

        if (!event.transcript_ref) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
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
                }),
              },
            ],
          };
        }

        const contextParams = [
          event.lane_id,
          event.transcript_ref,
          event.id,
          contextLimit + 1,
        ];
        const sourceOrder =
          "COALESCE(candidate.occurred_at, candidate.created_at), candidate.created_at, candidate.id";
        const sourceOrderDescending =
          "COALESCE(candidate.occurred_at, candidate.created_at) DESC, " +
          "candidate.created_at DESC, candidate.id DESC";
        const contextTarget = `FROM ob_session_events candidate
JOIN ob_session_events target ON target.id = $3::uuid
WHERE candidate.lane_id = $1
  AND candidate.transcript_ref = $2
  AND candidate.transcript IS NOT NULL`;
        const beforePromise = deps.pool.query<CitationEventRow>(
          `SELECT ${CANDIDATE_EVENT_COLUMNS}
${contextTarget}
  AND (${sourceOrder}) < (
    COALESCE(target.occurred_at, target.created_at), target.created_at, target.id
  )
ORDER BY ${sourceOrderDescending}
LIMIT $4`,
          contextParams,
        );
        const afterPromise = deps.pool.query<CitationEventRow>(
          `SELECT ${CANDIDATE_EVENT_COLUMNS}
${contextTarget}
  AND (${sourceOrder}) > (
    COALESCE(target.occurred_at, target.created_at), target.created_at, target.id
  )
ORDER BY ${sourceOrder} ASC
LIMIT $4`,
          contextParams,
        );
        const [beforeResult, afterResult] = await Promise.all([
          beforePromise,
          afterPromise,
        ]);
        const before = beforeResult.rows
          .slice(0, contextLimit)
          .reverse()
          .map((row) => transcriptProjection(row, maxTranscriptChars));
        const after = afterResult.rows
          .slice(0, contextLimit)
          .map((row) => transcriptProjection(row, maxTranscriptChars));
        const transcriptTruncated =
          (event.transcript?.length ?? 0) > maxTranscriptChars;
        const contextTruncated =
          before.some((row) => row.transcript_truncated) ||
          after.some((row) => row.transcript_truncated);

        const result = {
          event_id: event.id,
          fact: event.content,
          citation: {
            status: "stored",
            conversation_ref: event.transcript_ref,
            speaker: event.source ?? event.created_by,
            date: iso(event.occurred_at) ?? iso(event.created_at),
            transcript: event.transcript?.slice(0, maxTranscriptChars) ?? null,
            transcript_length: event.transcript?.length ?? 0,
            transcript_truncated: transcriptTruncated,
          },
          context: {
            before,
            after,
            expandable:
              transcriptTruncated ||
              contextTruncated ||
              beforeResult.rows.length > contextLimit ||
              afterResult.rows.length > contextLimit,
          },
        };
        logger.info("citation_recall_ok", {
          event_id: event.id,
          namespace,
          context_before: result.context.before.length,
          context_after: result.context.after.length,
        });
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
        };
      } catch (err) {
        logger.error("citation_recall_db_error", {
          event_id: args.event_id,
          namespace,
          error_label: citationRecallDbErrorLabel(err),
        });
        return {
          content: [
            {
              type: "text" as const,
              text: "Database error during citation recall",
            },
          ],
          isError: true,
        };
      }
    },
  );
}
