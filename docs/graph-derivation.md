# Graph derivation from approved sources

Deterministic, server-side derivation of the entity/link graph from approved
source items, driven through the durable maintenance queue. Issue #346
(MAINT-4).

- `src/graph-derivation.ts` — the primitive `deriveGraphFromMetadata`:
  content-hash idempotent (new / unchanged / changed), cross-namespace-rejecting,
  self-link-guarded, with defense-in-depth namespace re-verification on every
  persisted row. It derives into the source's **exact** namespace so the existing
  `search_all` / `brain_answer` graph arm consumes the result with no contract
  change. It runs and adds no migration.
- `src/graph-derivation-handler.ts` — selection sweep + enqueue + the registered
  `graph.derive` handler (`selectSourcesNeedingDerivation` /
  `enqueueGraphDerivationJobs` / `makeGraphDerivationHandler`), with a
  source-snapshot guard and terminal-vs-retryable failure classification.

## Server-owned runtime and the terminal dead-letter path

The handler is composed into the live server's maintenance runner by
`src/maintenance-bootstrap.ts` (started from `src/index.ts`), alongside the #345
`embedding.repair` handler. `composeMaintenanceHandlers` builds one handler map —
no second bootstrap or framework — and registers `graph.derive` under a
**deliberate, server-owned global maintenance identity** (`MAINTENANCE_GRAPH_AUTH`:
`ob-admin`, `namespaceSource: "token"`). That identity grants only the
cross-namespace *write capability* one runner needs; it is **not** the authority.
The authority is the persisted job payload's namespace, which the handler
re-checks with `canWriteNamespace` and re-validates against the live source row
(the snapshot guard) before deriving. The handler **cannot be registered without
a clear auth identity** — a missing role/clientId throws at startup (fail closed).

**Terminal (non-retryable) failures dead-letter immediately.** When the source
drifts out from under a job (revoked approval, retired, deleted, content
re-observed, stale revision, malformed payload, cross-namespace endpoint), the
handler throws `GraphDerivationTerminalError`, which **extends the queue-owned
`MaintenanceTerminalError`** marker. The `MaintenanceQueueRunner` identifies that
type at dispatch and passes an explicit `terminal` flag into
`MaintenanceQueue.fail`, which dead-letters the job on that exact attempt —
regardless of remaining retry budget — recording the content-free `terminal`
category (distinct from `error` and `lease_expired`). Ordinary errors (transient
DB failures) keep the persisted bounded backoff/retry policy verbatim. The queue
owns the marker; the handler depends on the queue, never the reverse.

The `terminal` category is added to the `maintenance_jobs.last_error_category`
CHECK by migration 029 (a named re-derive mirroring the 028 `lease_expired`
compat migration) plus the fresh inline 026/028 bodies, so fresh and
already-upgraded databases converge.

## No automatic recurrence — enqueue is an explicit bounded producer

The maintenance queue has **no recurrence primitive**: the runner only claims
and dispatches jobs that are already enqueued. Registering `graph.derive` makes
the server able to *run* graph jobs; it does **not** make derivation automatic or
continuous. `enqueueGraphDerivationJobs` is the only, explicit, bounded producer
(namespace-scoped selection + one idempotent job per changed source, bound to
`source id + content hash`). Sweeps must be driven by an operator or a future
scheduler (**#347**). There is no automatic continuous derivation, and the
bootstrap enqueues nothing.
