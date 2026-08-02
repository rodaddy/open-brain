/**
 * `ingest_conversation_facts`: write APPROVED distilled conversation-derived
 * facts, decisions, and receipts into the durable session journal.
 *
 * Design authority: `docs/conversation-facts-contract.md` (Issue #340),
 * `docs/identity-boundary.md`, and
 * `docs/decisions/privilege-isolation-closed-brain.md`.
 *
 * This is NOT a transcript store and it does NOT auto-capture. The caller
 * distills durable statements client-side; this accepts those units bound to a
 * source that is already approved. Every write is gated on four independent
 * things, in this order:
 *
 *   1. server-side auth -- `canWrite(sessions)` plus write authority over the
 *      exact namespace,
 *   2. shape -- the strict schema, then a recursive raw-transcript key scan,
 *   3. content -- a secret scan that refuses the batch before any write,
 *   4. approval -- the cited conversation source must resolve APPROVED and
 *      ACTIVE in that exact namespace, and the seven-coordinate scope must match
 *      an existing lane.
 *
 * The contract itself -- schemas, the raw-key set, the duplicate-evidence merge,
 * the error-class allowlist -- lives in `conversation-facts-contract.ts` and is
 * shared, so both servers accept and refuse exactly the same payloads.
 *
 * Rows land in `ob_session_events` with writer provenance, reusing the same
 * table, dedup, and embedding conventions as `append_session_event`. No
 * transcript column is ever written here.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { toSql } from "pgvector/pg";
import { canWrite } from "../auth/permissions.ts";
import { canTargetNamespace } from "../auth/namespace-policy.ts";
import type { AuthIdentity } from "../auth/types.ts";
import type { AuthInfo } from "../../src/types.ts";
import { physicalNamespace } from "../../src/shared-namespace.ts";
import { contentHash, EMBEDDING_MODEL } from "../../src/embedding.ts";
import { containsSecret } from "../../src/sharing.ts";
import { resolveIngestionEligibility } from "../../src/source-registry.ts";
import { authIdentity, textResult, type MemoryToolDependencies } from "./types.ts";
import {
  conversationIngestSchema,
  findRawTranscriptKey,
  mergeDuplicateEvidence,
  safeErrorClass,
  type ConversationFactEventType,
  type ConversationIngestArgs,
  type UnitDisposition,
} from "./conversation-facts-contract.ts";

type IngestErrorCode =
  | "auth_denied"
  | "namespace_denied"
  | "scope_validation"
  | "source_not_approved"
  | "raw_transcript_rejected"
  | "secret_rejected"
  | "retryable_outage";

/**
 * A structured refusal.
 *
 * Unlike the plain-string denials elsewhere in this wave, this tool's failures
 * carry a machine-readable `error` code and a `retryable` flag, because a
 * batch-ingesting client must distinguish "your payload is wrong, fix it" from
 * "the database blinked, send it again". Free text cannot express that.
 */
function ingestError(
  code: IngestErrorCode,
  message: string,
  retryable: boolean,
  details: Record<string, unknown> = {},
) {
  return {
    ...textResult({ ok: false, error: code, message, retryable, ...details }),
    isError: true as const,
  };
}

/** Writer provenance, mirroring `append_session_event`. */
function writerProvenance(identity: AuthIdentity) {
  const namespaceSource = identity.namespaceSource === "delegated" ? "header" : "token";
  return {
    writer_identity: identity.clientId,
    token_identity: identity.tokenClientId ?? identity.clientId,
    delegated_agent_id: null,
    namespace_source: namespaceSource,
  };
}

/** Convert the server identity into the source-registry's auth shape. */
function registryAuth(identity: AuthIdentity): AuthInfo {
  return {
    role: identity.role,
    clientId: identity.clientId,
    namespaceSource: identity.namespaceSource === "delegated" ? "header" : "token",
  } as AuthInfo;
}

export function registerIngestConversationFactsTool(
  server: McpServer,
  dependencies: MemoryToolDependencies,
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
      inputSchema: conversationIngestSchema,
      annotations: {
        title: "Ingest Conversation Facts",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async (rawArgs, extra) => {
      const identity = authIdentity(extra.authInfo);
      const args = rawArgs as ConversationIngestArgs;

      // Conversation facts land in the session journal, so the sessions write
      // permission is the authority. No input flag can route around it.
      if (!identity || !canWrite(identity.role, "sessions")) {
        dependencies.logger.warn(
          { tool: "ingest_conversation_facts", role: identity?.role ?? "none" },
          "ingest_conversation_facts_denied",
        );
        return ingestError(
          "auth_denied",
          "Permission denied: cannot write conversation facts",
          false,
        );
      }

      const requested = args.namespace ?? identity.clientId;
      if (!canTargetNamespace(identity, "write", requested)) {
        return ingestError(
          "namespace_denied",
          `Permission denied: ${identity.role} role cannot write to namespace '${requested}'`,
          false,
          { namespace: requested },
        );
      }
      const namespace = physicalNamespace(requested);

      // Defense in depth. The strict schema already rejects unknown keys before
      // this handler runs; the scan covers a nested raw body a future permissive
      // field could carry as opaque JSON.
      const rawKey = findRawTranscriptKey(rawArgs);
      if (rawKey) {
        dependencies.logger.warn(
          { tool: "ingest_conversation_facts", namespace },
          "ingest_conversation_facts_raw_rejected",
        );
        return ingestError(
          "raw_transcript_rejected",
          "Raw transcript bodies, turn/message arrays, and bulk conversation " +
            "payloads are not accepted; supply only distilled facts.",
          false,
          { namespace, rejected_key: rawKey },
        );
      }

      // The secret scan runs over the WHOLE batch before anything is written, so
      // a credential in the last unit cannot land after the first nine committed.
      // Only the index is surfaced; the content is never logged.
      for (let index = 0; index < args.facts.length; index += 1) {
        const fact = args.facts[index]!;
        if (
          containsSecret(fact.content) ||
          (fact.source_locator !== undefined && containsSecret(fact.source_locator))
        ) {
          dependencies.logger.warn(
            { tool: "ingest_conversation_facts", namespace, factIndex: index },
            "ingest_conversation_facts_secret_rejected",
          );
          return ingestError(
            "secret_rejected",
            "A distilled unit contains credential-like material and was rejected",
            false,
            { namespace, fact_index: index },
          );
        }
      }

      try {
        // Explicit-approval gate through the single source-registry authority.
        // `target_namespace` binds the check to the exact namespace, so it can
        // never resolve a foreign namespace's approved source.
        const eligibility = await resolveIngestionEligibility(
          dependencies.pool,
          registryAuth(identity),
          {
            source_kind: "conversation",
            external_id: args.source_ref.external_id,
            target_namespace: namespace,
          },
        );
        if (!eligibility.ok || !eligibility.data) {
          return ingestError(
            "source_not_approved",
            "Conversation source is not approved and active in this namespace",
            false,
            { namespace, code: eligibility.code ?? "not_found" },
          );
        }
        const source = eligibility.data;

        // The seven-coordinate isolation boundary, enforced as one parameterized
        // predicate. The lane must ALREADY exist: this contract does not create
        // lanes, so a scope typo cannot quietly open a new one.
        const { rows: laneRows } = await dependencies.pool.query(
          `SELECT id, status FROM ob_session_lanes
            WHERE namespace = $1
              AND session_key = $2
              AND agent = $3
              AND source = $4
              AND metadata->>'server_id' = $5
              AND channel_id = $6
              AND thread_id IS NOT DISTINCT FROM $7::text`,
          [
            namespace,
            args.scope.session_key,
            args.scope.agent,
            args.scope.platform,
            args.scope.server_id,
            args.scope.channel_id,
            args.scope.thread_id,
          ],
        );
        const lane = laneRows[0] as { id: unknown; status: unknown } | undefined;
        if (!lane) {
          return ingestError(
            "scope_validation",
            "No durable lane matches the exact seven-coordinate scope in this " +
              "namespace; conversation facts require an existing scoped lane",
            false,
            { namespace, session_key: args.scope.session_key },
          );
        }
        if (lane.status === "archived") {
          return ingestError(
            "scope_validation",
            "Target lane is archived; reactivate before ingesting facts",
            false,
            { namespace, session_key: args.scope.session_key },
          );
        }

        const laneId = String(lane.id);
        const provenance = writerProvenance(identity);

        // Embeddings are computed BEFORE the transaction opens. Embedding is a
        // slow network call, and doing it inside the transaction would hold the
        // batch's row locks for its full duration. A failure is non-fatal per
        // unit -- the row is still written, without a vector -- and is logged as
        // a content-free class.
        const prepared = args.facts.map((fact) => ({
          fact,
          eventContentHash: contentHash(fact.content),
          embedding: null as number[] | null,
        }));
        for (const unit of prepared) {
          try {
            unit.embedding = await dependencies.embedFn(unit.fact.content);
          } catch (error) {
            dependencies.logger.warn(
              {
                tool: "ingest_conversation_facts",
                namespace,
                errorClass: safeErrorClass(error),
              },
              "ingest_conversation_facts_embed_error",
            );
          }
        }

        // The batch is all-or-nothing, including the duplicate readback and any
        // evidence merge: a mid-batch failure rolls back every prior insert, so
        // the receipt can never claim progress that was discarded.
        if (typeof dependencies.pool.connect !== "function") {
          throw new Error(
            "ingest_conversation_facts requires a transactional pg pool",
          );
        }
        const client = await dependencies.pool.connect();
        const written: Array<{
          event_id: string;
          event_type: ConversationFactEventType;
          duplicate: boolean;
          disposition: UnitDisposition;
        }> = [];

        try {
          await client.query("BEGIN");

          for (const { fact, eventContentHash, embedding } of prepared) {
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
                identity.clientId,
              ],
            );

            const inserted = rows[0] as { id: unknown } | undefined;
            if (inserted) {
              written.push({
                event_id: String(inserted.id),
                event_type: fact.event_type,
                duplicate: false,
                disposition: "stored",
              });
              continue;
            }

            // Same lane, same content hash. Decide INSIDE the transaction
            // whether this unit carries structural evidence the stored row lacks,
            // and preserve it if so rather than dropping it silently.
            const merged = await mergeDuplicateEvidence(
              client,
              laneId,
              eventContentHash,
              fact,
            );
            written.push({
              event_id: merged.eventId,
              event_type: fact.event_type,
              duplicate: true,
              disposition: merged.kind,
            });
          }

          await client.query("COMMIT");
        } catch (error) {
          try {
            await client.query("ROLLBACK");
          } catch (rollbackError) {
            dependencies.logger.warn(
              {
                tool: "ingest_conversation_facts",
                namespace,
                errorClass: safeErrorClass(rollbackError),
              },
              "ingest_conversation_facts_rollback_failed",
            );
          }
          throw error;
        } finally {
          client.release();
        }

        const ingested = written.filter((unit) => !unit.duplicate).length;
        const evidenceMerged = written.filter(
          (unit) => unit.disposition === "duplicate_evidence_merged",
        ).length;
        const evidenceNotStored = written.filter(
          (unit) => unit.disposition === "evidence_not_stored",
        ).length;

        dependencies.logger.info(
          {
            tool: "ingest_conversation_facts",
            namespace,
            laneId,
            sourceId: source.id,
            submitted: args.facts.length,
            ingested,
            duplicates: written.length - ingested,
            evidenceMerged,
            evidenceNotStored,
          },
          "tool_result",
        );
        return textResult({
          ok: true,
          namespace,
          lane_id: laneId,
          source_id: source.id,
          submitted: args.facts.length,
          ingested,
          duplicates: written.length - ingested,
          evidence_merged: evidenceMerged,
          evidence_not_stored: evidenceNotStored,
          events: written,
          ...provenance,
        });
      } catch (error) {
        dependencies.logger.error(
          {
            tool: "ingest_conversation_facts",
            namespace,
            errorClass: safeErrorClass(error),
          },
          "ingest_conversation_facts_db_error",
        );
        // Marked retryable: the payload already passed every shape, content, and
        // approval gate above, so a failure here is the database, not the caller.
        return ingestError(
          "retryable_outage",
          "Database error during conversation-fact ingestion",
          true,
          { namespace },
        );
      }
    },
  );
}
