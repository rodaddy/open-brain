import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type pg from "pg";
import { toSql } from "pgvector/pg";
import { canWrite } from "../permissions.ts";
import { canWriteNamespace } from "../namespace-policy.ts";
import { physicalNamespace } from "../shared-namespace.ts";
import { contentHash, EMBEDDING_MODEL } from "../embedding.ts";
import { containsSecret } from "../sharing.ts";
import { resolveIngestionEligibility } from "../source-registry.ts";
import type { AuthInfo } from "../types.ts";
import { logger } from "../logger.ts";
import type { ToolDeps } from "./index.ts";

/**
 * Conversation-fact ingestion contract (Issue #340).
 *
 * A narrow server-side contract for writing APPROVED, distilled facts,
 * decisions, and receipts that were derived from a conversation. It is NOT a
 * transcript store and it does NOT auto-capture: the caller distills the
 * durable statements client-side, and this tool only accepts small bounded
 * distilled units bound to a structural, already-approved source.
 *
 * Every write is gated on:
 *  - server-side auth (canWrite sessions + canWriteNamespace on the exact ns),
 *  - a structural source reference (source_kind=conversation + external_id)
 *    that must resolve to an APPROVED and ACTIVE registry entry in the exact
 *    namespace via the existing source-registry authority, and
 *  - the exact seven-coordinate scope, in lockstep with the durable-lane scope.
 *
 * Raw transcript bodies, turn/message arrays, and arbitrary bulk conversation
 * payloads are rejected BEFORE any write. Accepted units land in the existing
 * ob_session_events durable journal with writer provenance and content-free
 * receipts, reusing the same table, dedup, and embedding conventions as
 * append_session_event. No transcript column is ever written by this tool.
 */

// Distilled conversation units are facts, decisions, or receipts only — the
// durable-memory event kinds a distilled conversation produces. Raw event kinds
// like "action"/"handoff" are intentionally out of scope for this contract.
const CONVERSATION_FACT_EVENT_TYPES = ["fact", "decision", "receipt"] as const;
type ConversationFactEventType = (typeof CONVERSATION_FACT_EVENT_TYPES)[number];

// Hard cap on units per call. This is a distillation contract, not a bulk
// dump: a large array is a signal the caller is trying to spill a transcript,
// so we bound it low and reject anything larger before any write.
const MAX_FACTS_PER_CALL = 20;

// Per-unit content bound. A distilled fact/decision/receipt is a single bounded
// statement, far smaller than the 50k a raw event body allows. Anything larger
// is treated as a probable transcript/message dump and rejected.
const MAX_FACT_CONTENT_CHARS = 4000;

// Keys that indicate a raw transcript / turn array / message dump was supplied.
// Their PRESENCE anywhere in the request or a unit is a hard reject, regardless
// of value — this contract never accepts a raw conversation body. Matched
// case-insensitively against caller-supplied object keys.
const RAW_TRANSCRIPT_KEYS = new Set(
  [
    "transcript",
    "transcripts",
    "turn",
    "turns",
    "message",
    "messages",
    "conversation",
    "conversations",
    "history",
    "chat",
    "chat_log",
    "chatlog",
    "log",
    "logs",
    "dialogue",
    "dialog",
    "exchange",
    "exchanges",
    "utterance",
    "utterances",
    "raw",
    "raw_body",
    "body",
    "content_raw",
  ].map((k) => k.toLowerCase()),
);

type IngestErrorCode =
  | "auth_denied"
  | "namespace_denied"
  | "scope_validation"
  | "source_not_approved"
  | "raw_transcript_rejected"
  | "secret_rejected"
  | "retryable_outage";

// Allowlisted, content-free error classes for DB / embedding failures. Raw
// provider/pg messages can echo submitted content, row values, or pg DETAIL/
// CONTEXT, so they are NEVER logged. Instead a failure is mapped to one of these
// fixed labels derived only from a pg SQLSTATE class or the Error constructor
// name — neither of which carries caller content. Anything unrecognized falls
// back to "unknown", never the message.
const SAFE_DB_ERROR_CLASSES = new Set<string>([
  "connection_error", // pg class 08 — connection exceptions
  "insufficient_resources", // pg class 53
  "operator_intervention", // pg class 57 (admin shutdown, cancel, etc.)
  "system_error", // pg class 58 (io failure)
  "integrity_constraint_violation", // pg class 23
  "transaction_rollback", // pg class 40 (serialization / deadlock)
  "data_exception", // pg class 22
  "syntax_or_access_error", // pg class 42 (should not happen with fixed SQL)
  "AbortError",
  "TimeoutError",
  "TypeError",
  "RangeError",
  "Error",
  "unknown",
] as const);

// Map a pg SQLSTATE (5-char) to a content-free class label. The first two
// characters are the SQLSTATE class; only the class is used so no per-row DETAIL
// leaks. Returns null when the code is absent or unrecognized.
function pgSqlstateClass(code: unknown): string | null {
  if (typeof code !== "string" || code.length < 2) return null;
  switch (code.slice(0, 2)) {
    case "08":
      return "connection_error";
    case "53":
      return "insufficient_resources";
    case "57":
      return "operator_intervention";
    case "58":
      return "system_error";
    case "23":
      return "integrity_constraint_violation";
    case "40":
      return "transaction_rollback";
    case "22":
      return "data_exception";
    case "42":
      return "syntax_or_access_error";
    default:
      return null;
  }
}

// Reduce an arbitrary thrown value to a single allowlisted, content-free class
// label. Prefers a recognized pg SQLSTATE class, then a recognized Error
// constructor name, then "unknown". The raw message is never returned.
function safeErrorClass(err: unknown): string {
  const code =
    err && typeof err === "object" && "code" in err
      ? (err as { code?: unknown }).code
      : undefined;
  const pgClass = pgSqlstateClass(code);
  if (pgClass && SAFE_DB_ERROR_CLASSES.has(pgClass)) return pgClass;
  if (err instanceof Error && SAFE_DB_ERROR_CLASSES.has(err.name)) {
    return err.name;
  }
  return "unknown";
}

function ingestError(
  code: IngestErrorCode,
  message: string,
  retryable: boolean,
  details: Record<string, unknown> = {},
) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({
          ok: false,
          error: code,
          message,
          retryable,
          ...details,
        }),
      },
    ],
    isError: true,
  };
}

function ok(payload: Record<string, unknown>) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({ ok: true, ...payload }),
      },
    ],
  };
}

// The seven exact scope coordinates, kept in lockstep with the durable-lane
// scope predicate and recallScopeSchema (#333). namespace is supplied
// separately (it is the isolation boundary and defaults to the caller's own),
// so the scope block carries the other six coordinates; thread_id is the only
// nullable one.
const scopeSchema = z
  .object({
    agent: z.string().trim().min(1).max(200),
    platform: z.string().trim().min(1).max(200),
    server_id: z.string().trim().min(1).max(500),
    channel_id: z.string().trim().min(1).max(500),
    thread_id: z.string().trim().min(1).max(500).nullable(),
    session_key: z.string().trim().min(1).max(500),
  })
  .strict();

// A structural source reference. Conversation-derived facts must cite the
// approved conversation source they were distilled from; the reference is
// identity-only (never a body). source_kind is fixed to "conversation" so this
// contract can only ingest against an approved conversation source.
const sourceRefSchema = z
  .object({
    source_kind: z.literal("conversation"),
    external_id: z.string().trim().min(1).max(1000),
  })
  .strict();

// A single distilled unit. Only a bounded content string plus its kind and an
// optional structural pointer back into the source. No transcript/turn keys are
// permitted; .strict() rejects any extra key (including a raw-body key) outright.
const factSchema = z
  .object({
    event_type: z.enum(CONVERSATION_FACT_EVENT_TYPES),
    content: z.string().trim().min(1).max(MAX_FACT_CONTENT_CHARS),
    // Optional structural pointer within the cited source (e.g. an anchor id).
    // Identity-only; never a body. Bounded and content-free.
    source_locator: z.string().trim().min(1).max(500).optional(),
    importance: z.enum(["hot", "warm", "cold"]).optional(),
  })
  .strict();

// Recursively scan a caller-supplied value for a raw-transcript key. The schema
// already rejects unknown keys via .strict(), but this is a defense-in-depth
// guard that also inspects nested objects/arrays a permissive field could carry,
// so no raw conversation body reaches the write path under any shape.
function findRawTranscriptKey(value: unknown): string | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const hit = findRawTranscriptKey(item);
      if (hit) return hit;
    }
    return null;
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(
      value as Record<string, unknown>,
    )) {
      if (RAW_TRANSCRIPT_KEYS.has(key.toLowerCase())) return key;
      const hit = findRawTranscriptKey(child);
      if (hit) return hit;
    }
  }
  return null;
}

// Minimal query surface shared by a pg Pool and a checked-out PoolClient, so the
// transactional batch below can run against either without importing the full pg
// client type into the tool.
type Queryable = {
  query: (
    sql: string,
    params?: unknown[],
  ) => Promise<{ rows: Array<Record<string, unknown>> }>;
};

// Cap on structural evidence entries retained per duplicated durable row. Each
// entry is a small content-free pointer (event_type + optional source_locator +
// writer identity); the cap keeps the metadata bounded even if the same content
// is re-cited from many distinct locators over time.
const MAX_ADDITIONAL_EVIDENCE = 32;

// Resolve a duplicate-content unit against the already-stored row. Reuses the
// existing metadata model as the owning place for evidence: when the new unit
// carries a distinct (event_type, source_locator) not already recorded on the
// stored row, that structural pointer is appended to a bounded
// `metadata.additional_evidence` array so the new citation/provenance evidence
// is preserved rather than silently dropped. When there is no new evidence it is
// a plain `duplicate`. When the row cannot be found or the bounded evidence list
// is already full, the caller is told explicitly via `evidence_not_stored`
// rather than being given a benign success that discards the evidence. Content
// is never read or written here — only structural pointers.
async function mergeDuplicateEvidence(
  client: Queryable,
  laneId: string,
  eventContentHash: string,
  fact: { event_type: ConversationFactEventType; source_locator?: string },
): Promise<{ eventId: string; kind: UnitDisposition }> {
  const { rows: existing } = await client.query(
    `SELECT id, event_type, metadata FROM ob_session_events
      WHERE lane_id = $1 AND content_hash = $2`,
    [laneId, eventContentHash],
  );
  const row = existing[0];
  if (!row) {
    // The conflicting row vanished between INSERT and readback (e.g. a
    // concurrent archive/delete). We stored nothing and cannot preserve the
    // evidence here; report it explicitly rather than a benign duplicate.
    return { eventId: "", kind: "evidence_not_stored" };
  }
  const eventId = String(row.id);
  const metadata =
    row.metadata && typeof row.metadata === "object"
      ? (row.metadata as Record<string, unknown>)
      : {};

  // The evidence this unit asserts: its kind plus the optional structural
  // locator. Both are content-free pointers.
  const candidate = {
    event_type: fact.event_type,
    ...(fact.source_locator !== undefined
      ? { source_locator: fact.source_locator }
      : {}),
  };

  // The evidence already on the stored row: the primary write's own
  // (event_type from the column + source_locator from metadata) plus any
  // previously merged entries.
  const storedType =
    typeof row.event_type === "string" ? row.event_type : undefined;
  const storedLocator =
    typeof metadata.source_locator === "string"
      ? metadata.source_locator
      : undefined;
  const existingEvidence = Array.isArray(metadata.additional_evidence)
    ? (metadata.additional_evidence as Array<Record<string, unknown>>)
    : [];

  const key = (t: string | undefined, l: string | undefined) =>
    JSON.stringify([t ?? null, l ?? null]);
  const known = new Set<string>();
  known.add(key(storedType, storedLocator));
  for (const e of existingEvidence) {
    known.add(
      key(
        typeof e.event_type === "string" ? e.event_type : undefined,
        typeof e.source_locator === "string" ? e.source_locator : undefined,
      ),
    );
  }

  if (known.has(key(candidate.event_type, candidate.source_locator))) {
    // The stored row already carries this exact structural evidence.
    return { eventId, kind: "duplicate" };
  }
  if (existingEvidence.length >= MAX_ADDITIONAL_EVIDENCE) {
    // Bounded evidence list is full; do not grow metadata unbounded. Tell the
    // caller the new evidence was not stored rather than claiming a merge.
    return { eventId, kind: "evidence_not_stored" };
  }

  const nextEvidence = [...existingEvidence, candidate];
  await client.query(
    `UPDATE ob_session_events
        SET metadata = jsonb_set(
              COALESCE(metadata, '{}'::jsonb),
              '{additional_evidence}',
              $2::jsonb,
              true
            )
      WHERE id = $1`,
    [eventId, JSON.stringify(nextEvidence)],
  );
  return { eventId, kind: "duplicate_evidence_merged" };
}

// Writer provenance for the durable event, mirroring append_session_event so
// readback can audit who authored a conversation-derived fact without trusting
// caller-supplied metadata. Bounded and content-free.
function conversationWriterProvenance(auth: AuthInfo) {
  const namespaceSource = auth.namespaceSource ?? "token";
  return {
    writer_identity: auth.clientId,
    token_identity: auth.tokenClientId ?? auth.clientId,
    delegated_agent_id:
      namespaceSource === "header" ? (auth.agentId ?? null) : null,
    namespace_source: namespaceSource,
  };
}

// The full, top-level input schema as a single .strict() object. This is the
// owning public boundary for raw-payload rejection: passing a constructed strict
// object (not a raw shape) to registerTool makes the MCP SDK reject any
// UNRECOGNIZED top-level key — including a raw `transcript` / `messages` /
// `turns` body — with a caller-visible input-validation error BEFORE the handler
// runs, so no raw conversation body can reach the write path and nothing is
// mutated. A raw shape (the SDK's other accepted form) would silently STRIP
// unknown top-level keys instead, which is why the strict object is required
// here rather than a plain shape.
const ingestInputSchema = z
  .object({
    namespace: z
      .string()
      .trim()
      .min(1)
      .max(500)
      .optional()
      .describe(
        "Namespace for isolation (defaults to the caller's own clientId). " +
          "The exact namespace the approved source and lane are bound to.",
      ),
    scope: scopeSchema.describe(
      "Exact six non-namespace scope coordinates (agent, platform, " +
        "server_id, channel_id, thread_id, session_key) in lockstep with the " +
        "durable-lane scope; thread_id may be null for an unthreaded scope.",
    ),
    source_ref: sourceRefSchema.describe(
      "Structural reference to the approved conversation source the facts " +
        "were distilled from. Must resolve to an approved, active " +
        "conversation source in the exact namespace. Identity-only.",
    ),
    facts: z
      .array(factSchema)
      .min(1)
      .max(MAX_FACTS_PER_CALL)
      .describe(
        "Distilled conversation units: bounded fact/decision/receipt " +
          "statements only. Never transcript turns, message arrays, or bulk " +
          "conversation bodies.",
      ),
  })
  .strict();

type IngestArgs = z.infer<typeof ingestInputSchema>;

// Per-unit disposition on the content-free receipt. `stored` — a new durable
// row was written. `duplicate` — identical content already present, no new
// evidence. `duplicate_evidence_merged` — identical content already present but
// this unit carried new structural evidence (a distinct source_locator/
// event_type), which was preserved on the existing row's metadata. `
// evidence_not_stored` — identical content with new evidence that could NOT be
// safely preserved; the caller is told explicitly rather than given a benign
// success that silently drops the evidence.
type UnitDisposition =
  "stored" | "duplicate" | "duplicate_evidence_merged" | "evidence_not_stored";

export function registerIngestConversationFacts(
  server: McpServer,
  deps: ToolDeps,
): void {
  server.registerTool(
    "ingest_conversation_facts",
    {
      description:
        "Ingest APPROVED distilled conversation-derived facts, decisions, and " +
        "receipts into the durable session journal. Requires a structural " +
        "conversation source_ref that is already approved and active in the " +
        "exact namespace, plus the exact seven-coordinate scope. Raw transcript " +
        "bodies, turn/message arrays, and bulk conversation payloads are rejected " +
        "before any write. This is not a transcript store and does not " +
        "auto-capture; the caller distills the durable statements client-side.",
      inputSchema: ingestInputSchema,
      annotations: {
        title: "Ingest Conversation Facts",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async (rawArgs, extra) => {
      const auth = extra.authInfo as AuthInfo | undefined;
      const args = rawArgs as IngestArgs;

      // Auth gate (server-side). Conversation facts land in the session journal,
      // so the sessions write permission is the authority; a caller cannot
      // bypass it via any input flag.
      if (!auth || !canWrite(auth.role, "sessions")) {
        logger.warn("ingest_conversation_facts_denied", {
          role: auth?.role ?? "none",
          clientId: auth?.clientId ?? "none",
        });
        return ingestError(
          "auth_denied",
          "Permission denied: cannot write conversation facts",
          false,
        );
      }

      const ns = physicalNamespace(args.namespace ?? auth.clientId);
      const nsCheck = canWriteNamespace(auth, ns);
      if (!nsCheck.allowed) {
        return ingestError(
          "namespace_denied",
          `Permission denied: ${nsCheck.reason}`,
          false,
          { namespace: ns },
        );
      }

      // Defense-in-depth raw-transcript rejection. The top-level input schema is
      // a single .strict() object and every nested object is .strict() too, so
      // the MCP SDK already rejects any unknown key (including a raw
      // transcript/turns/messages body) with a caller-visible validation error
      // BEFORE this handler runs. This scan is a belt-and-braces guard over the
      // parsed shape in case a future permissive field ever carries a nested
      // raw-body key; it is no longer the sole or primary defense.
      const rawKey = findRawTranscriptKey(rawArgs);
      if (rawKey) {
        logger.warn("ingest_conversation_facts_raw_rejected", {
          namespace: ns,
          clientId: auth.clientId,
        });
        return ingestError(
          "raw_transcript_rejected",
          "Raw transcript bodies, turn/message arrays, and bulk conversation " +
            "payloads are not accepted; supply only distilled facts.",
          false,
          { namespace: ns, rejected_key: rawKey },
        );
      }

      // Reject any secret-bearing distilled content before the write. Content is
      // never logged; only the unit index is surfaced.
      for (let i = 0; i < args.facts.length; i += 1) {
        const fact = args.facts[i]!;
        if (
          containsSecret(fact.content) ||
          (fact.source_locator !== undefined &&
            containsSecret(fact.source_locator))
        ) {
          logger.warn("ingest_conversation_facts_secret_rejected", {
            namespace: ns,
            clientId: auth.clientId,
            fact_index: i,
          });
          return ingestError(
            "secret_rejected",
            "A distilled unit contains credential-like material and was rejected",
            false,
            { namespace: ns, fact_index: i },
          );
        }
      }

      try {
        // Explicit-approval gate: the cited conversation source must be
        // approved AND active in the exact namespace. This reuses the single
        // server-side source-registry authority; a caller-supplied approval flag
        // never reaches this path. target_namespace binds the check to the exact
        // ns so it can never resolve a foreign namespace's source.
        const eligibility = await resolveIngestionEligibility(deps.pool, auth, {
          source_kind: "conversation",
          external_id: args.source_ref.external_id,
          target_namespace: ns,
        });
        if (!eligibility.ok || !eligibility.data) {
          return ingestError(
            "source_not_approved",
            "Conversation source is not approved and active in this namespace",
            false,
            {
              namespace: ns,
              code: eligibility.code ?? "not_found",
            },
          );
        }
        const source = eligibility.data;

        // Locate the exact-scope durable lane. The lane must already exist for
        // this namespace + session_key; this contract does not create lanes or
        // capture automatically. The stored lane scope must match the asserted
        // six coordinates exactly (thread_id null-safe) — the seven-coordinate
        // isolation boundary is enforced here, parameterized.
        const { rows: laneRows } = await deps.pool.query(
          `SELECT id, status, agent, source, channel_id, thread_id, metadata
             FROM ob_session_lanes
            WHERE namespace = $1
              AND session_key = $2
              AND agent = $3
              AND source = $4
              AND metadata->>'server_id' = $5
              AND channel_id = $6
              AND thread_id IS NOT DISTINCT FROM $7::text`,
          [
            ns,
            args.scope.session_key,
            args.scope.agent,
            args.scope.platform,
            args.scope.server_id,
            args.scope.channel_id,
            args.scope.thread_id,
          ],
        );
        const lane = laneRows[0] as Record<string, unknown> | undefined;
        if (!lane) {
          return ingestError(
            "scope_validation",
            "No durable lane matches the exact seven-coordinate scope in this " +
              "namespace; conversation facts require an existing scoped lane",
            false,
            { namespace: ns, session_key: args.scope.session_key },
          );
        }
        if (lane.status === "archived") {
          return ingestError(
            "scope_validation",
            "Target lane is archived; reactivate before ingesting facts",
            false,
            { namespace: ns, session_key: args.scope.session_key },
          );
        }

        const laneId = String(lane.id);
        const provenance = conversationWriterProvenance(auth);

        // Compute all embeddings BEFORE opening the write transaction. Embedding
        // is a slow network call; doing it inside a pg transaction would hold the
        // batch's locks open for its full duration. Results are staged here and
        // only the durable rows are written atomically below. An embedding
        // failure is non-fatal for a unit (the row is still written without a
        // vector), and is logged with a content-free class only.
        const prepared = args.facts.map((fact) => ({
          fact,
          eventContentHash: contentHash(fact.content),
          embedding: null as number[] | null,
        }));
        for (const unit of prepared) {
          try {
            unit.embedding = await deps.embedFn(unit.fact.content);
          } catch (err) {
            logger.warn("ingest_conversation_facts_embed_error", {
              namespace: ns,
              error_class: safeErrorClass(err),
            });
          }
        }

        // The whole batch is written in a single all-or-nothing transaction,
        // including the duplicate readback and any evidence-merge update: a
        // mid-batch failure rolls back every prior insert so the receipt can
        // never claim partial progress that was actually discarded. A
        // transactional pg pool is required (the tool never autocommits a partial
        // batch).
        if (typeof deps.pool.connect !== "function") {
          throw new Error(
            "ingest_conversation_facts requires a transactional pg pool",
          );
        }
        const client = await deps.pool.connect();

        const written: Array<{
          event_id: string;
          event_type: ConversationFactEventType;
          duplicate: boolean;
          disposition: UnitDisposition;
        }> = [];

        try {
          await client.query("BEGIN");

          for (const unit of prepared) {
            const { fact, eventContentHash, embedding } = unit;
            const metadata = {
              conversation_ingest: true,
              source_id: source.id,
              source_kind: source.source_kind,
              source_external_id: source.external_id,
              ...(fact.source_locator !== undefined
                ? { source_locator: fact.source_locator }
                : {}),
              _openbrain: {
                writer: {
                  client_id: provenance.writer_identity,
                  token_client_id: provenance.token_identity,
                  agent_id: provenance.delegated_agent_id,
                  namespace_source: provenance.namespace_source,
                },
              },
            };

            const { rows } = await client.query(
              `INSERT INTO ob_session_events
                 (lane_id, event_type, content, source, importance, metadata,
                  embedding, content_hash, embedded_at, embedding_model, created_by)
               VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, $11)
               ON CONFLICT (lane_id, content_hash) WHERE content_hash IS NOT NULL
                 DO NOTHING
               RETURNING id`,
              [
                laneId,
                fact.event_type,
                fact.content,
                args.scope.platform,
                fact.importance ?? "warm",
                JSON.stringify(metadata),
                embedding ? toSql(embedding) : null,
                eventContentHash,
                embedding ? new Date().toISOString() : null,
                embedding ? EMBEDDING_MODEL : null,
                auth.clientId,
              ],
            );

            if (rows.length > 0) {
              written.push({
                event_id: String(rows[0].id),
                event_type: fact.event_type,
                duplicate: false,
                disposition: "stored",
              });
              continue;
            }

            // Duplicate content (same lane + content_hash). Read the existing row
            // INSIDE the transaction and decide whether this unit carries new
            // structural evidence (a distinct source_locator or event_type) that
            // the stored row does not already have. If so, preserve it on the
            // existing metadata rather than silently dropping it.
            const disposition = await mergeDuplicateEvidence(
              client,
              laneId,
              eventContentHash,
              fact,
            );
            written.push({
              event_id: disposition.eventId,
              event_type: fact.event_type,
              duplicate: true,
              disposition: disposition.kind,
            });
          }

          await client.query("COMMIT");
        } catch (err) {
          try {
            await client.query("ROLLBACK");
          } catch (rollbackErr) {
            logger.warn("ingest_conversation_facts_rollback_failed", {
              namespace: ns,
              error_class: safeErrorClass(rollbackErr),
            });
          }
          throw err;
        } finally {
          client.release();
        }

        const ingestedCount = written.filter((w) => !w.duplicate).length;
        const mergedCount = written.filter(
          (w) => w.disposition === "duplicate_evidence_merged",
        ).length;
        const evidenceNotStoredCount = written.filter(
          (w) => w.disposition === "evidence_not_stored",
        ).length;
        logger.info("ingest_conversation_facts_ok", {
          namespace: ns,
          lane_id: laneId,
          source_id: source.id,
          submitted: args.facts.length,
          ingested: ingestedCount,
          duplicates: written.length - ingestedCount,
          evidence_merged: mergedCount,
          evidence_not_stored: evidenceNotStoredCount,
        });

        return ok({
          namespace: ns,
          lane_id: laneId,
          source_id: source.id,
          submitted: args.facts.length,
          ingested: ingestedCount,
          duplicates: written.length - ingestedCount,
          evidence_merged: mergedCount,
          evidence_not_stored: evidenceNotStoredCount,
          events: written,
          ...provenance,
        });
      } catch (err) {
        logger.error("ingest_conversation_facts_db_error", {
          namespace: ns,
          error_class: safeErrorClass(err),
        });
        return ingestError(
          "retryable_outage",
          "Database error during conversation-fact ingestion",
          true,
          { namespace: ns },
        );
      }
    },
  );
}
