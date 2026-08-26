/**
 * The conversation-fact ingestion CONTRACT: schemas, guards, and the
 * duplicate-evidence merge.
 *
 * Design authority: `docs/conversation-facts-contract.md` (Issue #340).
 *
 * These pieces are pure and carry no auth or transport, which is why they live
 * apart from the handler in `ingest-conversation-facts.ts`. What is a raw
 * transcript, what a distilled unit may contain, what the seven scope
 * coordinates are, and what happens when the same content arrives twice with new
 * evidence -- each is ONE rule. Restating any of them next to a second handler
 * is how two servers come to disagree about what they accepted.
 *
 * Nothing here decides whether a caller MAY write. Authorization is the
 * handler's, checked against the server's own auth builders before any of this
 * runs.
 */
import { z } from "zod";

/**
 * The durable-memory kinds a distilled conversation produces.
 *
 * Raw event kinds like `action`/`handoff` are intentionally out of scope: this
 * contract ingests statements a caller decided are durable, not the traffic
 * they were derived from.
 */
export const CONVERSATION_FACT_EVENT_TYPES = [
  "fact",
  "decision",
  "receipt",
] as const;
export type ConversationFactEventType =
  (typeof CONVERSATION_FACT_EVENT_TYPES)[number];

/**
 * Keys whose PRESENCE anywhere in a request means a raw conversation body was
 * supplied.
 *
 * Their presence is a hard reject regardless of value. What makes a payload a
 * transcript dump is its SHAPE, not its length -- so this, the strict schemas,
 * and the runtime scan are the guard, and no size test stands in for them.
 * Matched case-insensitively against caller-supplied keys.
 */
export const RAW_TRANSCRIPT_KEYS: ReadonlySet<string> = new Set(
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
  ].map((key) => key.toLowerCase()),
);

/**
 * The six non-namespace scope coordinates, in lockstep with the durable-lane
 * scope predicate and `recallScopeSchema` (#333).
 *
 * `namespace` is supplied separately because it is the isolation boundary and
 * defaults to the caller's own. `thread_id` is the only nullable coordinate.
 */
export const conversationScopeSchema = z
  .object({
    agent: z.string().trim().min(1).max(200),
    platform: z.string().trim().min(1).max(200),
    server_id: z.string().trim().min(1).max(500),
    channel_id: z.string().trim().min(1).max(500),
    thread_id: z.string().trim().min(1).max(500).nullable(),
    session_key: z.string().trim().min(1).max(500),
  })
  .strict();

/**
 * A structural source reference: identity only, never a body.
 *
 * `source_kind` is fixed to `conversation` so this contract can only ingest
 * against an approved conversation source.
 */
export const conversationSourceRefSchema = z
  .object({
    source_kind: z.literal("conversation"),
    external_id: z.string().trim().min(1).max(1000),
  })
  .strict();

/**
 * One distilled unit.
 *
 * `.strict()` rejects any extra key outright, including a raw-body key. There is
 * no ceiling on `content`: a caller distilling one careful long decision used to
 * lose the ENTIRE call and store nothing, which is the defect `ingest_raw_turn`
 * carried and had fixed. The database chunks for embeddings on its own.
 */
export const conversationFactSchema = z
  .object({
    event_type: z.enum(CONVERSATION_FACT_EVENT_TYPES),
    content: z.string().trim().min(1),
    source_locator: z.string().trim().min(1).max(500).optional(),
    importance: z.enum(["hot", "warm", "cold"]).optional(),
  })
  .strict();

/**
 * The full top-level input schema, as a single `.strict()` OBJECT.
 *
 * The object form is required, not stylistic: passing a constructed strict
 * object to `registerTool` makes the MCP SDK reject any unrecognized top-level
 * key -- including a raw `transcript`/`messages`/`turns` body -- with a
 * caller-visible validation error BEFORE the handler runs, so nothing is
 * mutated. The SDK's other accepted form, a plain shape, would silently STRIP
 * unknown top-level keys instead, turning a rejected dump into a quietly
 * accepted one.
 */
export const conversationIngestSchema = z
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
    scope: conversationScopeSchema.describe(
      "Exact six non-namespace scope coordinates (agent, platform, server_id, " +
        "channel_id, thread_id, session_key) in lockstep with the durable-lane " +
        "scope; thread_id may be null for an unthreaded scope.",
    ),
    source_ref: conversationSourceRefSchema.describe(
      "Structural reference to the approved conversation source the facts were " +
        "distilled from. Must resolve to an approved, active conversation source " +
        "in the exact namespace. Identity-only.",
    ),
    facts: z
      .array(conversationFactSchema)
      .min(1)
      .describe(
        "Distilled conversation units: fact/decision/receipt statements only. " +
          "Never transcript turns, message arrays, or bulk conversation bodies.",
      ),
  })
  .strict();

export type ConversationIngestArgs = z.infer<typeof conversationIngestSchema>;
export type ConversationFact = z.infer<typeof conversationFactSchema>;

/**
 * Recursively scan a caller-supplied value for a raw-transcript key.
 *
 * Defense in depth. The strict schemas already reject unknown keys, so this
 * exists for the case where a future permissive field carries a nested raw body
 * that the schema would accept as opaque JSON.
 *
 * @returns The offending key, or `null` when the payload is clean.
 */
export function findRawTranscriptKey(value: unknown): string | null {
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

/**
 * Per-unit disposition on the content-free receipt.
 *
 * `evidence_not_stored` exists so a caller is never handed a benign success for
 * evidence that was actually discarded -- silently dropping a new citation is
 * indistinguishable from having stored it, and only one of those is true.
 */
export type UnitDisposition =
  "stored" | "duplicate" | "duplicate_evidence_merged" | "evidence_not_stored";

/**
 * Structural evidence entries retained per duplicated durable row.
 *
 * Each entry is a content-free pointer (event type plus optional locator). This
 * bound is what the contract already publishes and is reproduced here unchanged.
 */
const RETAINED_EVIDENCE_ENTRIES = 32;

/**
 * The query surface shared by a `pg.Pool` and a checked-out `PoolClient`.
 *
 * Narrowed to what the merge needs so a caller can pass either, and so a test
 * can drive it without a pool at all.
 */
export interface Queryable {
  query: (
    sql: string,
    params?: unknown[],
  ) => Promise<{ rows: Array<Record<string, unknown>> }>;
}

/** @returns A stable identity for one piece of structural evidence. */
function evidenceKey(
  eventType: string | undefined,
  locator: string | undefined,
): string {
  return JSON.stringify([eventType ?? null, locator ?? null]);
}

/** @returns The value at `key` when it is a string, else `undefined`. */
function stringField(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

/** @returns The row's `metadata` object, or an empty one when it is absent. */
function rowMetadata(row: Record<string, unknown>): Record<string, unknown> {
  return row.metadata && typeof row.metadata === "object"
    ? (row.metadata as Record<string, unknown>)
    : {};
}

/**
 * The structural evidence already merged onto a stored row.
 *
 * Read separately from the primary write's own `(event_type, source_locator)`,
 * because only this list grows and only its length is compared against
 * `RETAINED_EVIDENCE_ENTRIES`.
 *
 * @returns The stored `metadata.additional_evidence` entries, or an empty list.
 */
function additionalEvidence(
  metadata: Record<string, unknown>,
): Array<Record<string, unknown>> {
  return Array.isArray(metadata.additional_evidence)
    ? (metadata.additional_evidence as Array<Record<string, unknown>>)
    : [];
}

/**
 * Every evidence identity the stored row already asserts.
 *
 * That is the primary write's own event type and locator, plus each entry
 * merged onto it since. A candidate whose key is in here adds no new provenance
 * and is a plain duplicate.
 *
 * @returns The set of `evidenceKey` values already present on the row.
 */
function knownEvidenceKeys(
  row: Record<string, unknown>,
  metadata: Record<string, unknown>,
  existingEvidence: ReadonlyArray<Record<string, unknown>>,
): Set<string> {
  const known = new Set<string>([
    evidenceKey(
      stringField(row, "event_type"),
      stringField(metadata, "source_locator"),
    ),
  ]);
  for (const entry of existingEvidence) {
    known.add(
      evidenceKey(
        stringField(entry, "event_type"),
        stringField(entry, "source_locator"),
      ),
    );
  }
  return known;
}

/**
 * Resolve a duplicate-content unit against the row already stored.
 *
 * When the new unit carries structural evidence the stored row does not already
 * have -- a distinct `(event_type, source_locator)` -- that pointer is appended
 * to `metadata.additional_evidence` so the new provenance survives instead of
 * being dropped. Content is never read or written here, only pointers.
 *
 * The conflicting row is locked `FOR UPDATE` because this is a read-modify-write.
 * Without the lock, two transactions merging distinct locators onto the same row
 * both read the same base metadata, both append their own, and the later UPDATE
 * overwrites the earlier -- a lost update while BOTH callers report
 * `duplicate_evidence_merged`. The lock makes the second merge wait and then
 * append to what the first actually wrote.
 *
 * @param client A queryable already inside the caller's transaction.
 * @returns The stored row's id and what happened to this unit's evidence.
 */
export async function mergeDuplicateEvidence(
  client: Queryable,
  laneId: string,
  eventContentHash: string,
  fact: { event_type: ConversationFactEventType; source_locator?: string },
): Promise<{ eventId: string; kind: UnitDisposition }> {
  const { rows } = await client.query(
    `SELECT id, event_type, metadata FROM ob_session_events
      WHERE lane_id = $1 AND content_hash = $2
      FOR UPDATE`,
    [laneId, eventContentHash],
  );
  const row = rows[0];
  if (!row) {
    // The conflicting row vanished between the INSERT and this readback (a
    // concurrent archive or delete). Nothing was stored and the evidence cannot
    // be preserved, so say so rather than reporting a benign duplicate.
    return { eventId: "", kind: "evidence_not_stored" };
  }

  const eventId = String(row.id);
  const metadata = rowMetadata(row);
  const candidate = {
    event_type: fact.event_type,
    ...(fact.source_locator !== undefined
      ? { source_locator: fact.source_locator }
      : {}),
  };

  const existingEvidence = additionalEvidence(metadata);
  const known = knownEvidenceKeys(row, metadata, existingEvidence);

  if (known.has(evidenceKey(candidate.event_type, candidate.source_locator))) {
    return { eventId, kind: "duplicate" };
  }
  if (existingEvidence.length >= RETAINED_EVIDENCE_ENTRIES) {
    return { eventId, kind: "evidence_not_stored" };
  }

  await client.query(
    `UPDATE ob_session_events
        SET metadata = jsonb_set(
              COALESCE(metadata, '{}'::jsonb),
              '{additional_evidence}',
              $2::jsonb,
              true
            )
      WHERE id = $1`,
    [eventId, JSON.stringify([...existingEvidence, candidate])],
  );
  return { eventId, kind: "duplicate_evidence_merged" };
}

/**
 * Allowlisted, content-free error classes.
 *
 * Raw driver and provider messages echo submitted content, row values, and pg
 * `DETAIL`/`CONTEXT`, so a failure is reduced to one of these fixed labels --
 * derived only from a SQLSTATE class or an `Error` constructor name, neither of
 * which carries caller content.
 */
const SAFE_DB_ERROR_CLASSES: ReadonlySet<string> = new Set([
  "connection_error",
  "insufficient_resources",
  "operator_intervention",
  "system_error",
  "integrity_constraint_violation",
  "transaction_rollback",
  "data_exception",
  "syntax_or_access_error",
  "AbortError",
  "TimeoutError",
  "TypeError",
  "RangeError",
  "Error",
  "unknown",
]);

/**
 * The recognized SQLSTATE classes, keyed by the two-character CLASS.
 *
 * A finite table rather than a chain of branches: the mapping is data, and one
 * unrecognized class is an absent key rather than a fallthrough to reason about.
 * Every value here is also a member of `SAFE_DB_ERROR_CLASSES`.
 */
const SQLSTATE_CLASS_LABELS: Readonly<Record<string, string>> = {
  "08": "connection_error",
  "22": "data_exception",
  "23": "integrity_constraint_violation",
  "40": "transaction_rollback",
  "42": "syntax_or_access_error",
  "53": "insufficient_resources",
  "57": "operator_intervention",
  "58": "system_error",
};

/**
 * Map a SQLSTATE to a content-free class label.
 *
 * Only the two-character CLASS is used, never the full code, so no per-row
 * detail leaks through the label.
 */
function sqlstateClass(code: unknown): string | null {
  if (typeof code !== "string" || code.length < 2) return null;
  return SQLSTATE_CLASS_LABELS[code.slice(0, 2)] ?? null;
}

/**
 * Reduce any thrown value to one allowlisted, content-free label.
 *
 * @returns A recognized SQLSTATE class, then a recognized `Error` name, then
 *   `"unknown"`. The raw message is never returned.
 */
export function safeErrorClass(error: unknown): string {
  const code =
    error && typeof error === "object" && "code" in error
      ? (error as { code?: unknown }).code
      : undefined;
  const mapped = sqlstateClass(code);
  if (mapped && SAFE_DB_ERROR_CLASSES.has(mapped)) return mapped;
  if (error instanceof Error && SAFE_DB_ERROR_CLASSES.has(error.name)) {
    return error.name;
  }
  return "unknown";
}
