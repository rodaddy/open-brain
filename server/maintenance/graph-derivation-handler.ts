import { z } from "zod";
import type pg from "pg";
import { logger } from "../logging/legacy-logger.ts";
import { canWriteNamespace } from "../security/namespace-policy.ts";
import { physicalNamespace } from "../security/shared-namespace-ambient.ts";
import type { AuthInfo } from "../types.ts";
import { extractMetadata } from "../domain/extraction.ts";
import {
  CrossNamespaceEndpointError,
  deriveGraphFromMetadata,
  type DerivationMetadata,
  type DerivationReceipt,
} from "../domain/graph-derivation.ts";
import { createGraphDerivationRepository } from "../db/graph-derivation-repository.ts";
import { withTransaction } from "../db/transaction.ts";
import {
  SOURCE_CONTENT_HASH_VERSION,
  SOURCE_KINDS,
  type SourceKind,
} from "../domain/source-registry.ts";
import {
  MaintenanceTerminalError,
  type EnqueueMaintenanceJob,
  type MaintenanceJob,
} from "./maintenance-job.ts";
import { type MaintenanceJobHandler } from "./maintenance-queue-runner.ts";

/**
 * Maintenance integration for graph derivation (#346 / MAINT-4): it identifies
 * approved, new-or-changed source items by their canonical content hash, and
 * drives the deterministic graph derivation primitive (graph-derivation.ts)
 * into the source's exact namespace, so the existing search_all / brain_answer
 * graph arm consumes the result without a contract change.
 *
 * Three narrow functions: selectSourcesNeedingDerivation() (read-only,
 * namespace-scoped selection), enqueueGraphDerivationJobs() (one bounded job
 * per selected source, idempotency key = source id + content hash), and
 * graphDerivationHandler() (the registered handler). Receipts and logs are
 * content-free (ids, counts, hashes, status only).
 *
 * For why the split is drawn there, what each function may do, and the
 * non-goals this integration deliberately did not take on:
 * See docs/decisions/graph-derivation-handler-responsibility-split.md
 */

/** The job kind this handler registers under. Matches the queue's kind regex. */
export const GRAPH_DERIVATION_JOB_KIND = "graph.derive" as const;
/** Payload contract version. Bump only on an incompatible payload change. */
export const GRAPH_DERIVATION_JOB_VERSION = 1 as const;
/** The anchor entity_type every derived source graph hangs from. */
export const SOURCE_ANCHOR_ENTITY_TYPE = "source" as const;

// One enqueue sweep emits at most 256 jobs. Selection may read one additional
// sentinel row so the caller reports deferral only when work actually remains.
const MAX_ENQUEUE_LIMIT = 256;
const MAX_SELECT_LIMIT = MAX_ENQUEUE_LIMIT + 1;
const DEFAULT_SELECT_LIMIT = 100;

// The stored content_hash / derivation payload hashes are lowercase sha256 hex.
const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

/**
 * A source that needs (re-)derivation: its last-observed content_hash differs
 * from the derivation hash already stamped on its anchor entity. Content-free:
 * identity, hashes, and revision only — never a title or body.
 */
export interface SourceNeedingDerivation {
  id: string;
  namespace: string;
  source_kind: SourceKind;
  external_id: string;
  content_hash: string;
  revision: number;
  /** The derivation hash currently on the anchor, if any (absent => new). */
  derived_content_hash: string | null;
}

/**
 * Namespace-scoped, read-only selection of approved+active sources whose
 * observed content_hash has not been derived into the graph, or has changed
 * since the last derivation.
 *
 * The auth-derived namespace predicate is mandatory. `namespaces === undefined`
 * (a token-sourced global admin/ob-admin) selects across namespaces; every
 * other identity is constrained to its writable namespace set. A source is
 * eligible only when it is approved AND active AND carries a well-formed
 * content_hash, mirroring the ingestion-eligibility gate in source-registry.ts.
 *
 * "Needs derivation" is decided by comparing the source's content_hash to the
 * `content_hash` recorded in its anchor entity's metadata (the derivation
 * handler stamps this on every successful run). A missing anchor (never
 * derived) is `new`; a differing recorded hash is `changed`; an equal recorded
 * hash is filtered out in SQL and never selected. The comparison lives in the
 * WHERE clause so an unchanged corpus produces an empty sweep with no work.
 */
export async function selectSourcesNeedingDerivation(
  pool: Pick<pg.Pool, "query">,
  writableNamespaces: string[] | undefined,
  limit = DEFAULT_SELECT_LIMIT,
): Promise<SourceNeedingDerivation[]> {
  const boundedLimit = Math.min(Math.max(Math.trunc(limit), 1), MAX_SELECT_LIMIT);

  // The statement, its auth-derived namespace predicate, and the anchor join
  // live in server/db/graph-derivation-repository.ts (issue 1209). This function
  // keeps the row bound and the mapping its callers depend on.
  const rows = await createGraphDerivationRepository(pool).readEnqueueSources({
    anchorEntityType: SOURCE_ANCHOR_ENTITY_TYPE,
    writableNamespaces,
    rowLimit: boundedLimit,
  });

  return rows.map((row) => ({
    id: row.id as string,
    namespace: row.namespace as string,
    source_kind: row.source_kind as SourceKind,
    external_id: row.external_id as string,
    content_hash: row.content_hash as string,
    revision: row.revision as number,
    derived_content_hash: (row.derived_content_hash as string | null) ?? null,
  }));
}

/**
 * The already-extracted metadata a collector observed for one source. Optional:
 * when absent, the handler runs the deterministic extractor over the source's
 * label so a source still produces its stable anchor node. Never a body.
 */
const derivationMetadataSchema = z
  .object({
    topics: z.array(z.string()).max(200).optional(),
    people: z.array(z.string()).max(200).optional(),
  })
  .strict();

/**
 * The bounded job payload. Content-free: source identity, the observed content
 * hash + revision (the snapshot guard), and optionally already-extracted
 * structural metadata (topics/people). No body, no free text.
 */
export const graphDerivationPayloadSchema = z
  .object({
    source_id: z.string().uuid(),
    source_kind: z.enum(SOURCE_KINDS),
    external_id: z.string().trim().min(1).max(1000),
    content_hash: z.string().regex(SHA256_HEX_RE),
    revision: z.number().int().min(1),
    metadata: derivationMetadataSchema.optional(),
  })
  .strict();

export type GraphDerivationPayload = z.infer<typeof graphDerivationPayloadSchema>;

/**
 * Build one bounded enqueue request for a selected source. The idempotency key
 * binds source id + content hash: a re-scan of an unchanged source resolves to
 * the SAME key (queue DO NOTHING no-op), while a changed content hash is a
 * distinct key and therefore a fresh job. The namespace and a content-free
 * provenance ride along so a handler run is namespace-scoped end to end.
 */
export function buildGraphDerivationEnqueue(
  source: SourceNeedingDerivation,
  metadata?: DerivationMetadata,
): EnqueueMaintenanceJob {
  const payload: GraphDerivationPayload = {
    source_id: source.id,
    source_kind: source.source_kind,
    external_id: source.external_id,
    content_hash: source.content_hash,
    revision: source.revision,
    ...(metadata ? { metadata: prunedMetadata(metadata) } : {}),
  };
  return {
    kind: GRAPH_DERIVATION_JOB_KIND,
    version: GRAPH_DERIVATION_JOB_VERSION,
    payload: payload as unknown as Record<string, unknown>,
    // Distinct per (source, observed content). A changed hash => new job; an
    // unchanged re-enqueue => queue no-op. Bounded well under the 256-char cap.
    idempotencyKey: `${GRAPH_DERIVATION_JOB_KIND}:${source.id}:${source.content_hash}`,
    scope: {
      namespace: source.namespace,
      provenance: {
        hash_version: SOURCE_CONTENT_HASH_VERSION,
      },
    },
  };
}

// Drop empty term arrays so the payload stays minimal and stable.
function prunedMetadata(metadata: DerivationMetadata): DerivationMetadata {
  const out: DerivationMetadata = {};
  if (metadata.topics && metadata.topics.length > 0) out.topics = metadata.topics;
  if (metadata.people && metadata.people.length > 0) out.people = metadata.people;
  return out;
}

/**
 * Queue interface this integration needs, kept minimal so the enqueue path is
 * injectable in tests without the concrete MaintenanceQueue.
 */
export interface GraphDerivationEnqueuePort {
  enqueue(input: EnqueueMaintenanceJob): Promise<MaintenanceJob>;
}

/**
 * Selection + enqueue sweep. Reads the sources needing derivation (namespace
 * scoped) and enqueues one bounded job each. Optionally a metadata resolver
 * supplies already-extracted topics/people per source (the collector seam);
 * when omitted, the job carries no metadata and the handler falls back to the
 * deterministic extractor. Both selection and metadata resolution happen here,
 * OUTSIDE any queue lock. Returns the enqueued jobs plus a true deferral signal
 * derived from one sentinel selection row. Content-free logging only.
 */
export async function enqueueGraphDerivationJobs(
  pool: Pick<pg.Pool, "query">,
  queue: GraphDerivationEnqueuePort,
  writableNamespaces: string[] | undefined,
  options: {
    limit?: number;
    resolveMetadata?: (
      source: SourceNeedingDerivation,
    ) => Promise<DerivationMetadata | undefined> | DerivationMetadata | undefined;
  } = {},
): Promise<{ jobs: MaintenanceJob[]; limitReached: boolean }> {
  const enqueueLimit = Math.min(
    Math.max(Math.trunc(options.limit ?? DEFAULT_SELECT_LIMIT), 1),
    MAX_ENQUEUE_LIMIT,
  );
  const sources = await selectSourcesNeedingDerivation(
    pool,
    writableNamespaces,
    enqueueLimit + 1,
  );
  const selected = sources.slice(0, enqueueLimit);
  const enqueued: MaintenanceJob[] = [];
  let dedupedJobs = 0;
  for (const source of selected) {
    const metadata = options.resolveMetadata
      ? await options.resolveMetadata(source)
      : undefined;
    const job = await queue.enqueue(buildGraphDerivationEnqueue(source, metadata));
    // Count what the queue DID, not what was attempted. A deduped insert
    // scheduled no work, and reporting it as an enqueue is what made a wedged
    // lane read as a healthy one.
    if (job.enqueueOutcome === "deduped") {
      dedupedJobs++;
      continue;
    }
    enqueued.push(job);
  }
  const limitReached = sources.length > enqueueLimit;
  logger.info("graph_derivation_enqueue_sweep", {
    selected: selected.length,
    enqueued: enqueued.length,
    deduped: dedupedJobs,
    limit_reached: limitReached ? 1 : 0,
  });
  return { jobs: enqueued, limitReached };
}

/**
 * A terminal (non-retryable) handler failure. The source drifted out from under
 * the job (revoked approval, retired, deleted, content re-observed, or a stale
 * revision), so retrying the SAME payload can never succeed — the correct
 * disposition is to dead-letter it immediately rather than burn the retry
 * budget.
 *
 * This extends the queue-owned {@link MaintenanceTerminalError} marker, so the
 * generic MaintenanceQueueRunner recognizes it by type and MaintenanceQueue.fail
 * dead-letters the job on this exact attempt (category `terminal`) instead of
 * scheduling a bounded backoff retry to the attempt bound. The dependency points
 * the right way — this handler imports the queue's marker; the queue imports
 * nothing from this handler. Content leaves the server on neither path: the
 * category is a stable enum value and the runner's failure log is content-free.
 */
export class GraphDerivationTerminalError extends MaintenanceTerminalError {
  constructor(reason: string) {
    super(reason);
    this.name = "GraphDerivationTerminalError";
  }
}

interface GraphDerivationHandlerDeps {
  /**
   * The pool the handler's transaction runs on. A full `pg.Pool` is required
   * because the handler runs the snapshot guard and the whole graph derivation
   * inside ONE transaction on ONE checked-out client, and it now delegates that
   * client's lifecycle to server/db's withTransaction, which owns the pool —
   * see the transaction-ownership contract on {@link makeGraphDerivationHandler}.
   */
  pool: pg.Pool;
  /**
   * The server identity the handler derives under. Must be able to write the
   * job's namespace; deriveGraphFromMetadata re-checks this too. A maintenance
   * bootstrap supplies a token-sourced admin/ob-admin identity.
   */
  auth: AuthInfo;
}

/**
 * Build the handler for GRAPH_DERIVATION_JOB_KIND: the MaintenanceJobHandler
 * the runner invokes per claimed job, registered by composeMaintenanceHandlers
 * (maintenance-bootstrap.ts). graph.derive jobs come from the shared
 * enqueueGraphDerivationJobs producer, which the bootstrap also calls from its
 * recurring #384 sweep.
 *
 * On each run it: (0) rejects a foreign job.version before parsing the payload
 * and (1) a malformed payload, both terminal; (2) confirms the job namespace is
 * writable by the handler identity AND matches the source's own;
 * (3) opens ONE transaction on ONE client and re-reads the live source row
 * under a snapshot guard that also locks it (`SELECT ... FOR UPDATE`) — still
 * approved + active, exact content_hash and revision, drift terminal; and
 * (4) derives the graph on that SAME client from the payload metadata, or a
 * deterministic extraction over the source label when it carried none, then
 * COMMITs — any error rolls back the graph writes and the hash stamp together.
 * For why the handler, not the primitive, owns that transaction boundary, and
 * what the row lock buys against a concurrent or obsolete job:
 * See docs/decisions/graph-derivation-handler-owns-the-transaction.md
 */
/** The job facts every derivation needs, proven valid before any database work. */
interface ValidatedDerivationJob {
  payload: GraphDerivationPayload;
  namespace: string;
}

/**
 * Run every terminal gate a derivation job must pass before it touches the
 * database, and return the facts the run needs.
 *
 * Version gate FIRST, before any payload parsing. A job whose version is not
 * the exact contract version this handler implements carries a payload under a
 * DIFFERENT (future or older) contract; parsing it against the current strict
 * schema is meaningless -- a future payload could add fields the strict schema
 * rejects, and an older payload could parse yet mean something else. A retry
 * cannot change a job's stamped version, so a mismatch is terminal:
 * dead-letter immediately rather than derive from a foreign contract. Every
 * other gate here is terminal for the same reason: no retry changes a
 * structurally invalid payload, a missing namespace, or an authorization
 * outcome for a fixed handler identity. Content-free: only the stable category
 * leaves the server.
 */
function validateDerivationJob(
  job: MaintenanceJob,
  auth: GraphDerivationHandlerDeps["auth"],
): ValidatedDerivationJob {
  if (job.version !== GRAPH_DERIVATION_JOB_VERSION) {
    throw new GraphDerivationTerminalError(
      "graph derivation job version is not supported by this handler",
    );
  }
  const parsed = graphDerivationPayloadSchema.safeParse(job.payload);
  if (!parsed.success) {
    // A structurally invalid payload can never succeed on retry.
    throw new GraphDerivationTerminalError("graph derivation payload invalid");
  }
  // The job's own namespace is the ONLY namespace this run may touch. The
  // queue stored it; a null namespace is a mis-enqueued job (terminal).
  if (job.namespace === null) {
    throw new GraphDerivationTerminalError(
      "graph derivation job is missing its namespace",
    );
  }
  const namespace = physicalNamespace(job.namespace);
  const nsCheck = canWriteNamespace(auth, namespace);
  if (!nsCheck.allowed) {
    // The handler identity cannot write this namespace. Terminal: another
    // retry with the same identity cannot change the authorization outcome.
    throw new GraphDerivationTerminalError(
      `graph derivation namespace not writable: ${nsCheck.reason}`,
    );
  }
  return { payload: parsed.data, namespace };
}

export function makeGraphDerivationHandler(
  deps: GraphDerivationHandlerDeps,
): MaintenanceJobHandler {
  return async (job: MaintenanceJob): Promise<void> => {
    const { payload, namespace } = validateDerivationJob(job, deps.auth);

    // Everything from here — the snapshot guard, the source-row lock, and the
    // full graph derivation (anchor+hash, entities, links, stale-edge prune) —
    // runs inside ONE transaction on ONE client. The handler still owns that
    // boundary; it now owns it by CALLING withTransaction (server/db) instead of
    // hand-rolling BEGIN/COMMIT/ROLLBACK here. The repository built over `tx`
    // runs the guard, and deriveGraphFromMetadata runs its statements through
    // that same repository, so its writes are enlisted in this transaction and
    // roll back atomically with the guard on any error. The primitive stays
    // transaction-agnostic (see the ownership note on makeGraphDerivationHandler).
    let receipt: DerivationReceipt;
    try {
      receipt = await withTransaction({
        pool: deps.pool,
        run: async (tx) => {
          const repository = createGraphDerivationRepository(tx);

          // Snapshot guard + row lock: re-read the live source, namespace-bound
          // by id, and prove it is still an approved+active ingestion target at
          // the exact revision and content hash the job was enqueued for. The
          // statement and its FOR UPDATE lock live in the repository; what stays
          // here is the terminal disposition when it matches zero rows.
          const guarded = await repository.lockApprovedSource({
            id: payload.source_id,
            namespace,
            sourceKind: payload.source_kind,
            externalId: payload.external_id,
            contentHash: payload.content_hash,
            revision: payload.revision,
          });
          if (guarded.length === 0) {
            throw new GraphDerivationTerminalError(
              "source snapshot changed since enqueue; derivation obsolete",
            );
          }
          const title: string | null = guarded[0]?.title ?? null;

          // Resolve the metadata to derive from. The already-extracted metadata
          // the collector observed rides in the payload; when absent, run the
          // deterministic (zero-network) extractor over the source label so the
          // source still yields its stable anchor node. Extraction is CPU-only
          // and networkless; running it while the source row is locked keeps the
          // derive atomic with the guard without any external wait inside the
          // transaction.
          const metadata = await resolveDerivationMetadata(payload, title);

          // The anchor label names the anchor entity node. Prefer the source
          // title; fall back to the external id so an untitled source still
          // names its anchor.
          const anchorName =
            title && title.trim().length > 0 ? title : payload.external_id;

          // Derive on the SAME client, INSIDE this transaction. Every
          // anchor/hash, entity, link, and prune write the primitive issues is
          // part of the atomic unit and rolls back together on any failure.
          return await deriveGraphFromMetadata(repository, deps.auth, {
            anchorType: SOURCE_ANCHOR_ENTITY_TYPE,
            anchorId: payload.source_id,
            anchorName,
            namespace,
            metadata,
            // Stamp the source snapshot digest on the anchor so the selection
            // sweep can read it back and skip this source until its
            // content_hash changes. The guard above already proved this hash
            // matches the locked source row.
            anchorContentHash: payload.content_hash,
          });
        },
        // Rolling back undoes any mutation the primitive made — including the
        // anchor hash stamp — so a transient later failure leaves NO partial
        // graph and NO stamped hash for a retry to short-circuit past. When the
        // rollback ITSELF fails that undo is not guaranteed; the original error
        // still classifies below, so name the degraded path here.
        onRollbackFailure: (rollbackErr: unknown) => {
          logger.warn("graph_derivation_rollback_failed", {
            reason: rollbackErr instanceof Error ? rollbackErr.name : "non_error",
          });
        },
      });
    } catch (err) {
      if (err instanceof CrossNamespaceEndpointError) {
        // An isolation breach or an un-writable namespace is terminal: the same
        // payload will breach again. Surface content-free and dead-letter.
        throw new GraphDerivationTerminalError(
          "graph derivation rejected a cross-namespace endpoint",
        );
      }
      // A GraphDerivationTerminalError (e.g. the snapshot guard above) stays
      // terminal; any other error (e.g. a transient DB failure) stays retryable
      // — both simply propagate after the rollback.
      throw err;
    }

    // Content-free: only the stable source_kind category, the derivation
    // status, and structural counts. No namespace value, no content_hash /
    // derivation_hash value, no source id — the maintenance queue's own
    // completion log already carries the (content-free) job_id / job_kind.
    logger.info("graph_derivation_handler_ok", {
      source_kind: payload.source_kind,
      status: receipt.status,
      entities_upserted: receipt.entities_upserted,
      entities_new: receipt.entities_new,
      links_upserted: receipt.links_upserted,
      links_new: receipt.links_new,
      links_archived: receipt.links_archived,
    });
  };
}

/**
 * Turn the payload (and optionally the source label) into the derivation
 * metadata. Already-extracted topics/people from the collector are used as-is;
 * absent metadata falls back to the deterministic extractor over the label,
 * which never networks and never logs content. The derivation primitive only
 * consumes topics/people, so action_items/dates are intentionally dropped here.
 */
async function resolveDerivationMetadata(
  payload: GraphDerivationPayload,
  title: string | null,
): Promise<DerivationMetadata> {
  if (payload.metadata) {
    return prunedMetadata({
      topics: payload.metadata.topics ?? [],
      people: payload.metadata.people ?? [],
    });
  }
  if (title && title.trim().length > 0) {
    const extracted = await extractMetadata(title);
    if (extracted) {
      return prunedMetadata({
        topics: extracted.topics,
        people: extracted.people,
      });
    }
  }
  return {};
}
