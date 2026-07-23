import { z } from "zod";
import type pg from "pg";
import { logger } from "./logger.ts";
import { canWriteNamespace } from "./namespace-policy.ts";
import { physicalNamespace } from "./shared-namespace.ts";
import type { AuthInfo } from "./types.ts";
import { extractMetadata } from "./extraction.ts";
import {
  CrossNamespaceEndpointError,
  deriveGraphFromMetadata,
  type DerivationMetadata,
  type DerivationReceipt,
  type GraphDerivationPool,
} from "./graph-derivation.ts";
import {
  SOURCE_CONTENT_HASH_VERSION,
  SOURCE_REGISTRY_TABLE,
  SOURCE_KINDS,
  type SourceKind,
} from "./source-registry.ts";
import {
  MaintenanceTerminalError,
  type EnqueueMaintenanceJob,
  type MaintenanceJob,
  type MaintenanceJobHandler,
} from "./maintenance-queue.ts";

/**
 * Maintenance integration for graph derivation (#346 / MAINT-4).
 *
 * This is the concrete maintenance-queue handler #342 calls out and #343 left
 * unimplemented: it identifies approved, new-or-changed source items by their
 * canonical content hash, and drives the deterministic graph derivation
 * primitive (graph-derivation.ts) into the source's exact namespace so the
 * existing search_all / brain_answer graph arm can consume the result without a
 * contract change.
 *
 * Responsibility split (intentionally narrow):
 *  - selectSourcesNeedingDerivation(): read-only, namespace-scoped selection of
 *    approved+active ob_sources whose observed content_hash has not yet been
 *    derived into the graph (new) or differs from the last derived hash
 *    (changed). Unchanged hashes are never selected — they no-op at the source.
 *  - enqueueGraphDerivationJobs(): turns each selected source into one bounded
 *    maintenance job whose idempotency key binds (source id + content hash), so
 *    a re-scan of an unchanged source is a queue no-op and a changed hash is a
 *    distinct fresh job. Selection and extraction stay OUTSIDE any queue lock.
 *  - graphDerivationHandler(): the registered handler. It re-reads the source
 *    under a snapshot guard (the payload's content_hash + revision must still
 *    match the live approved+active row), runs bounded metadata extraction, and
 *    calls deriveGraphFromMetadata. The primitive's own content-hash check makes
 *    a redundant run converge without duplicate nodes/edges.
 *
 * Non-goals honored here: no MCP tool surface, no Dream planning or prompt
 * placement changes, no SOURCE-1 re-implementation (extraction is reused), and
 * no ranking changes. Receipts and logs are content-free (ids, counts, hashes,
 * status only).
 */

/** The job kind this handler registers under. Matches the queue's kind regex. */
export const GRAPH_DERIVATION_JOB_KIND = "graph.derive" as const;
/** Payload contract version. Bump only on an incompatible payload change. */
export const GRAPH_DERIVATION_JOB_VERSION = 1 as const;
/** The anchor entity_type every derived source graph hangs from. */
export const SOURCE_ANCHOR_ENTITY_TYPE = "source" as const;

// Upper bound on how many sources one selection/enqueue sweep considers. The
// scheduler sweeps repeatedly; a single sweep must not scan or enqueue the whole
// table unbounded.
const MAX_SELECT_LIMIT = 256;
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
  const boundedLimit = Math.min(
    Math.max(Math.trunc(limit), 1),
    MAX_SELECT_LIMIT,
  );

  const params: unknown[] = [SOURCE_ANCHOR_ENTITY_TYPE];
  let namespacePredicate = "";
  if (writableNamespaces !== undefined) {
    // Auth-derived namespace predicate. Constrain both the source scan and the
    // anchor join to the caller's writable namespace set; never widen.
    params.push(writableNamespaces);
    namespacePredicate = ` AND s.namespace = ANY($${params.length}::text[])`;
  }
  params.push(boundedLimit);
  const limitParam = `$${params.length}`;

  // The anchor's canonical id is stable: '<entity_type>:<source id>' — matching
  // the handler's anchorCanonical below. The LEFT JOIN pulls the last derived
  // content_hash from the anchor entity's metadata (same namespace only), and
  // the WHERE keeps only sources whose observed hash is absent from the anchor
  // (new) or differs from it (changed). Parameterized throughout; the only
  // interpolated identifiers are the table-name constants (allowlisted).
  const { rows } = await pool.query(
    `SELECT s.id, s.namespace, s.source_kind, s.external_id,
            s.content_hash, s.revision,
            anchor.metadata ->> 'content_hash' AS derived_content_hash
       FROM ${SOURCE_REGISTRY_TABLE} s
       LEFT JOIN ob_entities anchor
         ON anchor.namespace = s.namespace
        AND anchor.entity_type = $1
        AND anchor.canonical_id = $1 || ':' || s.id::text
        AND anchor.archived_at IS NULL
      WHERE s.approval_state = 'approved'
        AND s.lifecycle_state = 'active'
        AND s.content_hash IS NOT NULL
        AND s.content_hash ~ '^[0-9a-f]{64}$'
        AND (
          anchor.id IS NULL
          OR anchor.metadata ->> 'content_hash' IS DISTINCT FROM s.content_hash
        )${namespacePredicate}
      ORDER BY s.updated_at ASC, s.id ASC
      LIMIT ${limitParam}`,
    params,
  );

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

export type GraphDerivationPayload = z.infer<
  typeof graphDerivationPayloadSchema
>;

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
  if (metadata.topics && metadata.topics.length > 0)
    out.topics = metadata.topics;
  if (metadata.people && metadata.people.length > 0)
    out.people = metadata.people;
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
 * OUTSIDE any queue lock. Returns the enqueued jobs. Content-free logging only.
 */
export async function enqueueGraphDerivationJobs(
  pool: Pick<pg.Pool, "query">,
  queue: GraphDerivationEnqueuePort,
  writableNamespaces: string[] | undefined,
  options: {
    limit?: number;
    resolveMetadata?: (
      source: SourceNeedingDerivation,
    ) =>
      Promise<DerivationMetadata | undefined> | DerivationMetadata | undefined;
  } = {},
): Promise<MaintenanceJob[]> {
  const sources = await selectSourcesNeedingDerivation(
    pool,
    writableNamespaces,
    options.limit,
  );
  const enqueued: MaintenanceJob[] = [];
  for (const source of sources) {
    const metadata = options.resolveMetadata
      ? await options.resolveMetadata(source)
      : undefined;
    const job = await queue.enqueue(
      buildGraphDerivationEnqueue(source, metadata),
    );
    enqueued.push(job);
  }
  logger.info("graph_derivation_enqueue_sweep", {
    selected: sources.length,
    enqueued: enqueued.length,
  });
  return enqueued;
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
   * The pool the handler checks a client out of. `connect` is required (not just
   * `query`) because the handler runs the snapshot guard and the whole graph
   * derivation inside ONE transaction on ONE checked-out client — see the
   * transaction-ownership contract on {@link makeGraphDerivationHandler}. `query`
   * is retained for callers that still hand a bare pool; the handler only uses
   * `connect`.
   */
  pool: GraphDerivationPool & Pick<pg.Pool, "query" | "connect">;
  /**
   * The server identity the handler derives under. Must be able to write the
   * job's namespace; deriveGraphFromMetadata re-checks this too. A maintenance
   * bootstrap supplies a token-sourced admin/ob-admin identity.
   */
  auth: AuthInfo;
}

/**
 * Build the handler for GRAPH_DERIVATION_JOB_KIND. The returned function is the
 * MaintenanceJobHandler the runner invokes per claimed job. It is registered by
 * composeMaintenanceHandlers (maintenance-bootstrap.ts) and dispatched by the
 * runner started in startMaintenanceQueue — the queue/index wiring is present.
 * graph.derive jobs are produced only by the explicit, bounded
 * enqueueGraphDerivationJobs producer (an operator or the future #347
 * scheduler); the bootstrap enqueues nothing and defines no recurring sweep, so
 * there is no automatic continuous derivation.
 *
 * On each run it:
 *  1. Validates the payload shape (a malformed payload is terminal — a retry
 *     cannot fix it).
 *  2. Confirms the job's namespace is writable by the handler identity, and
 *     that it matches the source's own namespace (defense in depth against a
 *     payload whose namespace was tampered with; both are cross-checked).
 *  3. Opens ONE database transaction on ONE checked-out client and, inside it,
 *     re-reads the live source row under a snapshot guard that ALSO locks it
 *     (`SELECT ... FOR UPDATE`): the row must still be approved + active in the
 *     job namespace AND carry the exact content_hash and revision the job was
 *     enqueued for. Any drift is terminal — the world moved on and this exact
 *     unit of work is obsolete.
 *  4. In the SAME transaction and on the SAME client, derives the graph from
 *     the (already-extracted) metadata, or from a deterministic extraction over
 *     the source label when the payload carried none. The primitive's
 *     content-hash short-circuit makes a redundant run a no-op; a changed hash
 *     converges without duplicate nodes/edges.
 *  5. COMMITs. Any error — the guard, extraction, or any derivation write —
 *     ROLLs BACK every graph mutation AND the anchor hash stamp together, so a
 *     transient failure never leaves a partial graph with a completed hash that
 *     a retry would falsely short-circuit past.
 *
 * Transaction ownership (the fix for the coupled P1 atomicity findings):
 *  - The HANDLER owns the transaction boundary. It checks out the client, runs
 *    BEGIN, holds the source-row lock, calls the derivation primitive on that
 *    client, and runs COMMIT/ROLLBACK. deriveGraphFromMetadata does NOT open a
 *    transaction of its own — it runs every statement through the `query` of
 *    whatever client/pool it is handed, so handing it this client enlists all
 *    of its writes (anchor+hash, entities, links, stale-edge prune) in the one
 *    transaction. The primitive stays a reusable, transaction-agnostic
 *    primitive and its unit-test injectability is unchanged (a fake pool with a
 *    `query` still drives it directly).
 *  - The `SELECT ... FOR UPDATE` in step 3 serializes concurrent derivations
 *    for one source AND against the source registry's own row updates. An OLDER
 *    job that already holds the lock finishes and commits before the source can
 *    advance (the registry UPDATE blocks on the lock), so a later fresh-hash job
 *    runs after it; a job that starts AFTER a newer revision committed re-reads
 *    under its stale content_hash/revision predicate, matches zero rows, and
 *    terminal-stops. An obsolete job therefore can never overwrite a newer
 *    committed graph, and the succeeded current-hash queue key never blocks a
 *    genuine repair because a rolled-back failure stamps no hash at all.
 */
export function makeGraphDerivationHandler(
  deps: GraphDerivationHandlerDeps,
): MaintenanceJobHandler {
  return async (job: MaintenanceJob): Promise<void> => {
    const parsed = graphDerivationPayloadSchema.safeParse(job.payload);
    if (!parsed.success) {
      // A structurally invalid payload can never succeed on retry.
      throw new GraphDerivationTerminalError(
        "graph derivation payload invalid",
      );
    }
    const payload = parsed.data;

    // The job's own namespace is the ONLY namespace this run may touch. The
    // queue stored it; a null namespace is a mis-enqueued job (terminal).
    if (job.namespace === null) {
      throw new GraphDerivationTerminalError(
        "graph derivation job is missing its namespace",
      );
    }
    const namespace = physicalNamespace(job.namespace);

    const nsCheck = canWriteNamespace(deps.auth, namespace);
    if (!nsCheck.allowed) {
      // The handler identity cannot write this namespace. Terminal: another
      // retry with the same identity cannot change the authorization outcome.
      throw new GraphDerivationTerminalError(
        `graph derivation namespace not writable: ${nsCheck.reason}`,
      );
    }

    // Everything from here — the snapshot guard, the source-row lock, and the
    // full graph derivation (anchor+hash, entities, links, stale-edge prune) —
    // runs inside ONE transaction on ONE client. deps.pool.connect() hands us a
    // dedicated client; deriveGraphFromMetadata runs its statements through this
    // client's `query`, so its writes are enlisted in this transaction and roll
    // back atomically with the guard on any error. The handler owns COMMIT and
    // ROLLBACK; the primitive stays transaction-agnostic (see the ownership note
    // on makeGraphDerivationHandler).
    const client = await deps.pool.connect();
    let receipt: DerivationReceipt;
    try {
      await client.query("BEGIN");

      // Snapshot guard + row lock: re-read the live source, namespace-bound by
      // id, and prove it is still an approved+active ingestion target at the
      // exact revision and content hash the job was enqueued for. FOR UPDATE
      // locks the matched row FOR THE LIFE OF THIS TRANSACTION, which is what
      // serializes concurrent/racing derivations and the registry's own source
      // updates: a stale job (content re-observed, approval revoked, retired,
      // deleted, or a revision bump) resolves to zero rows and terminates
      // without deriving from an obsolete snapshot; a newer source revision
      // cannot commit over us while we hold the lock, and a job that starts
      // after a newer revision committed sees zero rows here and stops. The
      // predicate is unchanged from the pre-fix read — only FOR UPDATE is added.
      const guarded = await client.query(
        `SELECT title
           FROM ${SOURCE_REGISTRY_TABLE}
          WHERE id = $1
            AND namespace = $2
            AND source_kind = $3
            AND external_id = $4
            AND content_hash = $5
            AND revision = $6
            AND approval_state = 'approved'
            AND lifecycle_state = 'active'
          FOR UPDATE`,
        [
          payload.source_id,
          namespace,
          payload.source_kind,
          payload.external_id,
          payload.content_hash,
          payload.revision,
        ],
      );
      if (guarded.rows.length === 0) {
        throw new GraphDerivationTerminalError(
          "source snapshot changed since enqueue; derivation obsolete",
        );
      }
      const title: string | null =
        (guarded.rows[0].title as string | null) ?? null;

      // Resolve the metadata to derive from. The already-extracted metadata the
      // collector observed rides in the payload; when absent, run the
      // deterministic (zero-network) extractor over the source label so the
      // source still yields its stable anchor node. Extraction is CPU-only and
      // networkless; running it while the source row is locked keeps the derive
      // atomic with the guard without any external wait inside the transaction.
      const metadata = await resolveDerivationMetadata(payload, title);

      // The anchor label names the anchor entity node. Prefer the source title;
      // fall back to the external id so an untitled source still names its anchor.
      const anchorName = (
        title && title.trim().length > 0 ? title : payload.external_id
      ).slice(0, 500);

      // Derive on the SAME client, INSIDE this transaction. Every anchor/hash,
      // entity, link, and prune write the primitive issues is now part of the
      // atomic unit below and rolls back together on any failure.
      receipt = await deriveGraphFromMetadata(client, deps.auth, {
        anchorType: SOURCE_ANCHOR_ENTITY_TYPE,
        anchorId: payload.source_id,
        anchorName,
        namespace,
        metadata,
        // Stamp the source snapshot digest on the anchor so the selection sweep
        // can read it back and skip this source until its content_hash changes.
        // The guard above already proved this hash matches the locked source row.
        anchorContentHash: payload.content_hash,
      });

      await client.query("COMMIT");
    } catch (err) {
      // Roll back the entire unit: any mutation the primitive made — including
      // the anchor hash stamp — is undone, so a transient later failure leaves
      // NO partial graph and NO stamped hash for a retry to short-circuit past.
      await client.query("ROLLBACK").catch(() => undefined);
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
    } finally {
      client.release();
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
