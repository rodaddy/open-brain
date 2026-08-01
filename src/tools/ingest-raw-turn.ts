import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { canWrite } from "../permissions.ts";
import { canWriteNamespace } from "../namespace-policy.ts";
import { contentHash } from "../embedding.ts";
import { redactText } from "../sharing.ts";
import type { AuthInfo } from "../types.ts";
import { logger } from "../logger.ts";
import type { ToolDeps } from "./index.ts";

/**
 * Full-send raw turn ingest (Issue #380, INGEST-1).
 * Spec: docs/full-send-derivation-spec.md section 2.
 *
 * The client is a DUMB PIPE. It ships what happened and decides nothing about
 * salience: no summarizing, no scoring, no "is this worth remembering". Every
 * judgment (distillation, dedupe, supersession) is server-side, asynchronous,
 * and re-runnable, because only the server runs when no session is open, sees
 * the whole corpus, survives a client crash, and serves Claude/Codex/Python
 * from one implementation instead of three divergent client heuristics.
 *
 * This replaces client-side salience filtering, which was measured to fail in
 * exactly the ways a heuristic fails: on 2026-07-25 it captured 21 of the
 * user's turns and ZERO of the assistant's, and had never once captured an
 * AskUserQuestion answer -- the densest decision content in the corpus.
 */

const MAX_BATCH = 100;

// NO CONTENT CEILING. `content` was `z.string().max(200_000)`, which REJECTED an
// oversized turn outright -- losing 100% of it rather than the overflow, and
// (because the client mirrors this check and fails the batch closed) taking up
// to 99 good turns with it.
//
// Never fired in practice: measured 2026-07-30, 31,045 stored turns, largest
// 51,283 chars, zero above 100k. But the ceiling was sized for TEXT. Change the
// encoder to take images or video and 200k stops being a generous bound and
// starts being a data-loss bug on ordinary input.
//
// Size is not this layer's decision. Postgres `text` has no practical limit,
// and chunking (src/chunking.ts) already exists for embedding oversized content
// while the full text stays whole on the parent row.
//
// Operator, 2026-07-30: "It's my decision if I want this Open Brain database to
// be 17,000 gigs because all of the data is there... If I ever do ask you to
// [make things smaller], ask me if I turned crazy."

type IngestErrorClass = "retryable_outage" | "auth_denied" | "scope_validation";

function ingestError(
  errorClass: IngestErrorClass,
  message: string,
  retryable: boolean,
  details: Record<string, unknown> = {},
) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({
          error: errorClass,
          message,
          retryable,
          ...details,
        }),
      },
    ],
    isError: true,
  };
}

/**
 * Harness control strings that are not dialogue and must never be ingested.
 *
 * This is a SHAPE filter on runtime scaffolding, NOT a salience judgment: it
 * does not ask whether a turn is worth remembering, only whether it is a turn
 * at all. Measured across 515 transcripts on 2026-07-25 -- "[Request
 * interrupted by user]" appears 270 times across 51 sessions, "[Request
 * interrupted by user for tool use]" 103 times across 33. Storing those is
 * pure noise: identical strings, no author, no decision, and they would
 * dominate any exact-content analysis.
 */
const HARNESS_NOISE: readonly RegExp[] = [
  /^\[Request interrupted by user[^\]]*\]$/,
  /^<local-command-(?:caveat|stdout|stderr)>/,
  /^<command-(?:name|message|args)>/,
  /^<bash-(?:input|stdout|stderr)>/,
  /^Continue from where you left off\.$/,
  /^The user doesn't want to proceed with this tool use\./,
];

export function isHarnessNoise(content: string): boolean {
  const trimmed = content.trim();
  if (trimmed.length === 0) return true;
  return HARNESS_NOISE.some((pattern) => pattern.test(trimmed));
}

const rawTurnSchema = z.object({
  turn_uuid: z.string().trim().min(1).max(200),
  parent_turn_uuid: z.string().trim().min(1).max(200).nullish(),
  logical_parent_turn_uuid: z.string().trim().min(1).max(200).nullish(),
  prompt_id: z.string().trim().min(1).max(200).nullish(),
  session_ref: z.string().trim().min(1).max(500).nullish(),
  repo: z.string().trim().min(1).max(200).nullish(),
  git_branch: z.string().trim().min(1).max(300).nullish(),
  turn_index: z.number().int().min(0),
  role: z.enum(["user", "assistant", "tool"]),
  is_human_prompt: z.boolean().optional(),
  content: z.string(),
  runtime: z.string().trim().min(1).max(100).nullish(),
  token_estimate: z.number().int().min(0).nullish(),
  occurred_at: z.string().datetime({ offset: true }).nullish(),
  metadata: z
    .record(z.string().max(100), z.unknown())
    .optional()
    .refine((v) => !v || JSON.stringify(v).length <= 100_000, {
      message: "metadata: max 100KB total",
    }),
});

type RawTurnInput = z.infer<typeof rawTurnSchema>;

interface PreparedTurn {
  turn: RawTurnInput;
  content: string;
  contentHashValue: string;
  redactionApplied: string[];
}

/**
 * Redact the VALUE, keep the STATEMENT. A turn is NEVER dropped for containing
 * a credential -- "AUTH_TOKEN_ADMIN=[REDACTED]" is itself a useful durable
 * fact, and fail-closed was explicitly rejected. `redaction_applied` records
 * only THAT redaction fired, never the removed value.
 */
function prepare(turn: RawTurnInput): PreparedTurn {
  const redacted = redactText(turn.content);
  const redactionApplied = redacted === turn.content ? [] : ["secret_value"];
  return {
    turn,
    content: redacted,
    contentHashValue: contentHash(redacted),
    redactionApplied,
  };
}

export function registerIngestRawTurn(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "ingest_raw_turn",
    {
      description:
        "Full-send ingest of raw conversation turns. The client ships what " +
        "happened and applies no salience judgment; the server owns " +
        "distillation. Re-sending an identical turn is a no-op, so hook " +
        "retries and session-resume replays are safe.",
      inputSchema: {
        namespace: z
          .string()
          .max(500)
          .optional()
          .describe(
            "Namespace for isolation (defaults to the caller's clientId)",
          ),
        turns: z
          .array(rawTurnSchema)
          .min(1)
          .max(MAX_BATCH)
          .describe(
            `Raw turns in order, max ${MAX_BATCH} per call. Batching keeps the interactive turn unblocked.`,
          ),
      },
      annotations: {
        title: "Ingest Raw Turn",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async (args, extra) => {
      const auth = extra.authInfo as AuthInfo | undefined;

      if (!auth || !canWrite(auth.role, "sessions")) {
        logger.warn("ingest_raw_turn_denied", {
          role: auth?.role ?? "none",
          clientId: auth?.clientId ?? "none",
        });
        return ingestError(
          "auth_denied",
          "Permission denied: cannot write raw turns",
          false,
        );
      }

      const ns = args.namespace ?? auth.clientId;
      const nsCheck = canWriteNamespace(auth, ns);
      if (!nsCheck.allowed) {
        return ingestError(
          "auth_denied",
          `Permission denied: ${nsCheck.reason}`,
          false,
          { namespace: ns },
        );
      }

      // Harness scaffolding is dropped before anything touches the database.
      const kept: PreparedTurn[] = [];
      let filtered = 0;
      for (const turn of args.turns) {
        if (isHarnessNoise(turn.content)) {
          filtered += 1;
          continue;
        }
        kept.push(prepare(turn));
      }

      if (kept.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                ingested: 0,
                duplicates: 0,
                filtered,
                namespace: ns,
              }),
            },
          ],
        };
      }

      try {
        // One multi-row INSERT: the whole batch is one round trip, and
        // ON CONFLICT DO NOTHING makes a replayed batch a no-op rather than an
        // error the client has to interpret.
        const values: unknown[] = [];
        const tuples: string[] = [];
        const COLS = 19;
        for (const [index, prepared] of kept.entries()) {
          const b = index * COLS;
          tuples.push(
            `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},` +
              `$${b + 7},$${b + 8},$${b + 9}::int,$${b + 10},$${b + 11}::boolean,` +
              `$${b + 12},$${b + 13},$${b + 14},$${b + 15}::int,$${b + 16}::jsonb,` +
              `$${b + 17}::jsonb,$${b + 18},$${b + 19}::timestamptz)`,
          );
          const t = prepared.turn;
          values.push(
            ns,
            t.turn_uuid,
            t.parent_turn_uuid ?? null,
            t.logical_parent_turn_uuid ?? null,
            t.prompt_id ?? null,
            t.session_ref ?? null,
            t.repo ?? null,
            t.git_branch ?? null,
            t.turn_index,
            t.role,
            t.is_human_prompt ?? false,
            prepared.content,
            prepared.contentHashValue,
            t.runtime ?? null,
            t.token_estimate ?? null,
            JSON.stringify(t.metadata ?? {}),
            JSON.stringify(prepared.redactionApplied),
            auth.clientId,
            t.occurred_at ?? null,
          );
        }

        // valid_at mirrors occurred_at: a turn became true when it happened.
        // invalid_at/expired_at stay NULL until something retracts it.
        const { rows } = await deps.pool.query<{
          id: string;
          session_ref: string | null;
        }>(
          `INSERT INTO ob_raw_turns
             (namespace, turn_uuid, parent_turn_uuid, logical_parent_turn_uuid,
              prompt_id, session_ref, repo, git_branch, turn_index, role,
              is_human_prompt, content, content_hash, runtime, token_estimate,
              metadata, redaction_applied, created_by, occurred_at, valid_at)
           SELECT v.*, v.occurred_at
             FROM (VALUES ${tuples.join(",")}) AS v(
                    namespace, turn_uuid, parent_turn_uuid,
                    logical_parent_turn_uuid, prompt_id, session_ref, repo,
                    git_branch, turn_index, role, is_human_prompt, content,
                    content_hash, runtime, token_estimate, metadata,
                    redaction_applied, created_by, occurred_at)
           ON CONFLICT (namespace, turn_uuid) DO NOTHING
           RETURNING id, session_ref`,
          values,
        );

        const ingested = rows.length;
        const duplicates = kept.length - ingested;

        // Assign session_seq server-side (migration 036). The client's
        // turn_index cannot be trusted for ordering: it is a per-invocation
        // counter, so every session in the corpus carried only 0..7 regardless
        // of length. A client cannot fix this -- it sees one batch, retries,
        // resumes, and several runtimes write the same session -- so the server
        // owns the invariant its own schema declares.
        //
        // Recomputed for the whole affected session rather than appended to.
        // Batches arrive out of order (spool replay, retries), so a late turn
        // must be able to land in the MIDDLE of the sequence; appending would
        // order by arrival instead of by when the turn happened. The
        // (session_ref, occurred_at) pair is unique across the live corpus, and
        // id breaks any tie deterministically.
        //
        // Failure here is logged, not fatal: the turn is already durably
        // stored, and a NULL session_seq is repairable by re-running this
        // statement. Losing captured conversation to a numbering error would be
        // the far worse outcome.
        //
        // Affected sessions are derived from the whole validated `kept` payload,
        // NOT only from the INSERT's RETURNING rows. If a prior call stored the
        // turns but its seq recompute failed transiently, those rows carry
        // session_seq = NULL; a replay of the same turn_uuids returns zero
        // RETURNING rows (ON CONFLICT DO NOTHING), so keying off RETURNING alone
        // would skip the recompute and the NULLs would never repair. Keying off
        // the payload's session_refs makes an ordinary replay the repair path
        // the comment above promises. The recompute is idempotent
        // (`session_seq IS DISTINCT FROM o.seq` updates only rows that change),
        // so re-running it for an already-numbered session is a no-op.
        const touchedSessions = [
          ...new Set(
            kept
              .map((p) => p.turn.session_ref ?? null)
              .filter((s): s is string => s !== null),
          ),
        ];
        if (touchedSessions.length > 0) {
          try {
            // Scoped to `ns`. session_ref is client-supplied and is NOT unique
            // across namespaces -- the only uniqueness on the table is
            // (namespace, turn_uuid) (migration 032). Two namespaces can carry
            // the same session_ref, so a recompute partitioned by session_ref
            // alone would renumber another namespace's rows by interleaving
            // this write's occurred_at values into their ordering. Adding
            // `namespace = $2` to both the ordering window's source and the
            // UPDATE keeps each namespace's session_seq computed only from its
            // own turns, which is what the per-namespace isolation boundary
            // requires (AGENTS.md: any ID-based mutation carries an
            // auth-derived namespace predicate).
            await deps.pool.query(
              `WITH ordered AS (
                 SELECT id,
                        row_number() OVER (
                          PARTITION BY session_ref
                          ORDER BY occurred_at, id
                        ) - 1 AS seq
                   FROM ob_raw_turns
                  WHERE namespace = $2
                    AND session_ref = ANY($1::text[])
               )
               UPDATE ob_raw_turns t
                  SET session_seq = o.seq
                 FROM ordered o
                WHERE t.id = o.id
                  AND t.namespace = $2
                  AND t.session_seq IS DISTINCT FROM o.seq`,
              [touchedSessions, ns],
            );
          } catch (seqErr) {
            logger.warn("ingest_raw_turn_seq_failed", {
              namespace: ns,
              sessions: touchedSessions.length,
              error: seqErr instanceof Error ? seqErr.message : String(seqErr),
            });
          }
        }

        // Content-free telemetry: counts only, never turn text.
        logger.info("ingest_raw_turn_ok", {
          namespace: ns,
          ingested,
          duplicates,
          filtered,
        });

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                ingested,
                duplicates,
                filtered,
                namespace: ns,
              }),
            },
          ],
        };
      } catch (err) {
        logger.error("ingest_raw_turn_db_error", {
          namespace: ns,
          batch_size: kept.length,
          error: err instanceof Error ? err.message : String(err),
        });
        return ingestError(
          "retryable_outage",
          `Database error during raw turn ingest: ${err instanceof Error ? err.message : String(err)}`,
          true,
          { namespace: ns },
        );
      }
    },
  );
}
