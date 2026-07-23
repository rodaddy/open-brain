import type pg from "pg";

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BACKOFF_BASE_MS = 1_000;
const DEFAULT_BACKOFF_MAX_MS = 300_000;
const MAX_CONCURRENCY = 16;
// Upper bound on a single direct claim. The scheduled runner never asks for
// more than its available concurrency, but a direct caller must not be able to
// drain or lock the whole table in one statement.
const MAX_CLAIM_LIMIT = 256;
// Namespace token shape, mirroring the delegated-id/header-namespace path used
// elsewhere so the queue cannot mint exotic namespaces. Queue mechanics never
// infer a namespace; this only validates one a caller opts into.
const NAMESPACE_TOKEN_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

export type MaintenanceJobState =
  "queued" | "running" | "succeeded" | "dead_letter";
export type MaintenanceErrorCategory =
  | "syntax_error"
  | "type_error"
  | "range_error"
  | "error"
  | "non_error"
  | "unsupported_job_kind"
  // Terminal signal for a running lease that expired after the job already
  // consumed all of its execution attempts. Content-free and distinct from any
  // handler-thrown error so dead-letter analysis can tell the two apart.
  | "lease_expired"
  // A handler declared its own failure non-retryable by throwing a
  // MaintenanceTerminalError (below). The job dead-letters on this exact
  // attempt regardless of remaining retry budget. Distinct from `error` and
  // `lease_expired` so dead-letter analysis can tell a policy-driven immediate
  // dead-letter from a retry-exhaustion or an expired lease. Content-free.
  | "terminal";

/**
 * Queue-owned generic marker for a handler failure that is NON-RETRYABLE.
 *
 * A handler throws this (or a subclass) to tell the queue that retrying the
 * SAME job payload can never succeed, so the queue must dead-letter it on this
 * exact attempt instead of scheduling a bounded backoff retry to the attempt
 * bound. This marker lives at the queue boundary on purpose: handlers depend on
 * the queue, never the reverse, so a handler's own terminal-error subclass can
 * extend this without the queue importing anything from the handler.
 *
 * Everything else (transient DB failures, provider outages, unclassified
 * errors) stays retryable and follows the persisted attempts>=max_attempts
 * retry-then-dead-letter policy. Only an explicit throw of this type opts a
 * failure into immediate dead-lettering.
 */
export class MaintenanceTerminalError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "MaintenanceTerminalError";
  }
}

/** True when a thrown value is the queue's non-retryable terminal marker. */
export function isMaintenanceTerminalError(
  error: unknown,
): error is MaintenanceTerminalError {
  return error instanceof MaintenanceTerminalError;
}

export interface MaintenanceJob {
  id: string;
  kind: string;
  version: number;
  payload: Record<string, unknown>;
  idempotencyKey: string;
  state: MaintenanceJobState;
  runAfter: Date;
  leaseToken: string | null;
  leaseUntil: Date | null;
  attempts: number;
  maxAttempts: number;
  backoffBaseMs: number;
  backoffMaxMs: number;
  lastErrorCategory: MaintenanceErrorCategory | null;
  terminalAt: Date | null;
  deadLetteredAt: Date | null;
  namespace: string | null;
  provenance: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface EnqueueMaintenanceJob {
  kind: string;
  version: number;
  payload: Record<string, unknown>;
  idempotencyKey: string;
  runAfter?: Date;
  retry?: {
    maxAttempts?: number;
    backoffBaseMs?: number;
    backoffMaxMs?: number;
  };
  // These are deliberately opt-in. Future job contracts decide whether they
  // require a namespace/provenance; queue mechanics never infer either value.
  scope?: {
    namespace?: string;
    provenance?: Record<string, unknown>;
  };
}

export interface ClaimMaintenanceJobs {
  limit: number;
  now?: Date;
  leaseMs: number;
}

export interface MaintenanceQueuePort {
  claimDueJobs(input: ClaimMaintenanceJobs): Promise<MaintenanceJob[]>;
  complete(jobId: string, leaseToken: string, now?: Date): Promise<boolean>;
  fail(input: {
    job: MaintenanceJob;
    error: unknown;
    // When set, the stored terminal/retry category is forced to this value so
    // persistence matches what the caller categorizes and logs (e.g. the
    // unsupported-job-kind sentinel, which is not a thrown Error). When unset,
    // the category is derived from `error`.
    category?: MaintenanceErrorCategory;
    // When true, the failure is non-retryable: the job dead-letters on this
    // attempt regardless of remaining retry budget (see MaintenanceQueue.fail).
    // The runner sets this from a MaintenanceTerminalError; ordinary errors
    // leave it unset and follow the persisted bounded-retry policy.
    terminal?: boolean;
    now?: Date;
  }): Promise<MaintenanceJob | null>;
}

interface MaintenanceJobRow {
  id: string;
  job_kind: string;
  job_version: number;
  payload: Record<string, unknown>;
  idempotency_key: string;
  state: MaintenanceJobState;
  run_after: Date | string;
  lease_token: string | null;
  lease_until: Date | string | null;
  attempts: number;
  max_attempts: number;
  backoff_base_ms: number;
  backoff_max_ms: number;
  last_error_category: MaintenanceErrorCategory | null;
  terminal_at: Date | string | null;
  dead_lettered_at: Date | string | null;
  namespace: string | null;
  provenance: Record<string, unknown> | null;
  created_at: Date | string;
  updated_at: Date | string;
}

const JOB_COLUMN_NAMES = [
  "id",
  "job_kind",
  "job_version",
  "payload",
  "idempotency_key",
  "state",
  "run_after",
  "lease_token",
  "lease_until",
  "attempts",
  "max_attempts",
  "backoff_base_ms",
  "backoff_max_ms",
  "last_error_category",
  "terminal_at",
  "dead_lettered_at",
  "namespace",
  "provenance",
  "created_at",
  "updated_at",
] as const;

const JOB_COLUMNS = JOB_COLUMN_NAMES.join(", ");

// Same column set qualified by a table alias. Required in the claim statement,
// whose CTE join exposes `id` on both `maintenance_jobs` and `eligible`, making
// an unqualified RETURNING list ambiguous.
function jobColumns(alias: string): string {
  return JOB_COLUMN_NAMES.map((column) => `${alias}.${column}`).join(", ");
}

function toDate(value: Date | string | null): Date | null {
  return value === null ? null : new Date(value);
}

function toJob(row: MaintenanceJobRow): MaintenanceJob {
  return {
    id: row.id,
    kind: row.job_kind,
    version: row.job_version,
    payload: row.payload,
    idempotencyKey: row.idempotency_key,
    state: row.state,
    runAfter: new Date(row.run_after),
    leaseToken: row.lease_token,
    leaseUntil: toDate(row.lease_until),
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    backoffBaseMs: row.backoff_base_ms,
    backoffMaxMs: row.backoff_max_ms,
    lastErrorCategory: row.last_error_category,
    terminalAt: toDate(row.terminal_at),
    deadLetteredAt: toDate(row.dead_lettered_at),
    namespace: row.namespace,
    provenance: row.provenance,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

function assertPositiveInteger(value: number, field: string): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`maintenance queue ${field} must be a positive integer`);
  }
}

function assertObject(
  value: unknown,
  field: string,
): asserts value is Record<string, unknown> {
  if (!value || Array.isArray(value) || typeof value !== "object") {
    throw new Error(`maintenance queue ${field} must be an object`);
  }
}

function validateEnqueue(input: EnqueueMaintenanceJob): Required<
  Pick<EnqueueMaintenanceJob, "kind" | "version" | "payload" | "idempotencyKey">
> & {
  runAfter: Date;
  maxAttempts: number;
  backoffBaseMs: number;
  backoffMaxMs: number;
  namespace: string | null;
  provenance: Record<string, unknown> | null;
} {
  if (!/^[a-z][a-z0-9_.-]{0,127}$/.test(input.kind)) {
    throw new Error("maintenance queue job kind is invalid");
  }
  if (input.idempotencyKey.length === 0 || input.idempotencyKey.length > 256) {
    throw new Error("maintenance queue idempotency key is invalid");
  }
  assertPositiveInteger(input.version, "job version");
  assertObject(input.payload, "payload");

  const maxAttempts = input.retry?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const backoffBaseMs = input.retry?.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS;
  const backoffMaxMs = input.retry?.backoffMaxMs ?? DEFAULT_BACKOFF_MAX_MS;
  assertPositiveInteger(maxAttempts, "max attempts");
  assertPositiveInteger(backoffBaseMs, "backoff base");
  assertPositiveInteger(backoffMaxMs, "backoff maximum");
  if (maxAttempts > 25 || backoffMaxMs < backoffBaseMs) {
    throw new Error("maintenance queue retry policy is invalid");
  }
  if (input.scope?.provenance !== undefined) {
    assertObject(input.scope.provenance, "provenance");
  }
  if (
    input.scope?.namespace !== undefined &&
    !NAMESPACE_TOKEN_RE.test(input.scope.namespace)
  ) {
    throw new Error("maintenance queue namespace is invalid");
  }

  return {
    kind: input.kind,
    version: input.version,
    payload: input.payload,
    idempotencyKey: input.idempotencyKey,
    runAfter: input.runAfter ?? new Date(),
    maxAttempts,
    backoffBaseMs,
    backoffMaxMs,
    namespace: input.scope?.namespace ?? null,
    provenance: input.scope?.provenance ?? null,
  };
}

// Order-independent structural equality for JSONB-shaped values so that two
// payloads differing only in key order are not treated as divergent.
function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, val) => {
    if (val && typeof val === "object" && !Array.isArray(val)) {
      return Object.fromEntries(
        Object.entries(val as Record<string, unknown>).sort(([a], [b]) =>
          a < b ? -1 : a > b ? 1 : 0,
        ),
      );
    }
    return val;
  });
}

type ValidatedEnqueue = ReturnType<typeof validateEnqueue>;

function enqueueSemanticsDiverge(
  requested: ValidatedEnqueue,
  existing: MaintenanceJob,
): boolean {
  return (
    requested.version !== existing.version ||
    requested.maxAttempts !== existing.maxAttempts ||
    requested.backoffBaseMs !== existing.backoffBaseMs ||
    requested.backoffMaxMs !== existing.backoffMaxMs ||
    requested.namespace !== existing.namespace ||
    canonicalJson(requested.payload) !== canonicalJson(existing.payload) ||
    canonicalJson(requested.provenance) !== canonicalJson(existing.provenance)
  );
}

export function safeMaintenanceErrorCategory(
  error: unknown,
): MaintenanceErrorCategory {
  if (error instanceof SyntaxError) return "syntax_error";
  if (error instanceof TypeError) return "type_error";
  if (error instanceof RangeError) return "range_error";
  if (error instanceof Error) return "error";
  return "non_error";
}

export function maintenanceBackoffMs(
  job: Pick<MaintenanceJob, "attempts" | "backoffBaseMs" | "backoffMaxMs">,
): number {
  const exponent = Math.min(Math.max(job.attempts - 1, 0), 30);
  return Math.min(job.backoffBaseMs * 2 ** exponent, job.backoffMaxMs);
}

export class MaintenanceQueue implements MaintenanceQueuePort {
  constructor(private readonly pool: Pick<pg.Pool, "query" | "connect">) {}

  async enqueue(input: EnqueueMaintenanceJob): Promise<MaintenanceJob> {
    const job = validateEnqueue(input);
    const inserted = await this.pool.query<MaintenanceJobRow>(
      `INSERT INTO maintenance_jobs (
         job_kind, job_version, payload, idempotency_key, run_after,
         max_attempts, backoff_base_ms, backoff_max_ms, namespace, provenance
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (job_kind, idempotency_key) DO NOTHING
       RETURNING ${JOB_COLUMNS}`,
      [
        job.kind,
        job.version,
        JSON.stringify(job.payload),
        job.idempotencyKey,
        job.runAfter,
        job.maxAttempts,
        job.backoffBaseMs,
        job.backoffMaxMs,
        job.namespace,
        job.provenance === null ? null : JSON.stringify(job.provenance),
      ],
    );
    if (inserted.rows[0]) return toJob(inserted.rows[0]);

    const existing = await this.pool.query<MaintenanceJobRow>(
      `SELECT ${JOB_COLUMNS}
         FROM maintenance_jobs
        WHERE job_kind = $1 AND idempotency_key = $2`,
      [job.kind, job.idempotencyKey],
    );
    const existingRow = existing.rows[0];
    if (!existingRow) {
      throw new Error("maintenance queue idempotency lookup failed");
    }
    const existingJob = toJob(existingRow);
    // Idempotent replay is safe only when the reused (kind, idempotency_key)
    // carries identical semantics. Any divergence in version, payload, scope, or
    // retry policy means the caller expects *different* work under an already-used
    // key; return the stale job and it silently runs the old contract. Reject
    // content-free — the divergence itself is the signal, not the payload values.
    if (enqueueSemanticsDiverge(job, existingJob)) {
      throw new Error(
        "maintenance queue idempotency key reused with divergent job semantics",
      );
    }
    return existingJob;
  }

  async claimDueJobs(input: ClaimMaintenanceJobs): Promise<MaintenanceJob[]> {
    assertPositiveInteger(input.limit, "claim limit");
    if (input.limit > MAX_CLAIM_LIMIT) {
      throw new Error("maintenance queue claim limit exceeds the bound");
    }
    assertPositiveInteger(input.leaseMs, "lease duration");
    const now = input.now ?? new Date();
    const client = await this.pool.connect();
    const leaseToken = crypto.randomUUID();

    try {
      await client.query("BEGIN");
      // A queued-due row and an expired running row are both eligible, but an
      // expired running row whose already-consumed execution attempts have
      // reached max_attempts must terminate, not be reclaimed for another
      // handler run — otherwise a job that keeps blowing its lease is retried
      // forever, past its bound. `attempts` counts execution leases: a running
      // row already ran `attempts` handler executions, so attempts >= max means
      // no budget is left. Such rows dead-letter in the same statement (clearing
      // the lease, stamping terminal/dead-letter timestamps, and recording the
      // content-free `lease_expired` category) and are excluded from RETURNING
      // so the runner never treats a terminated job as claimed.
      const claimed = await client.query<MaintenanceJobRow>(
        `WITH eligible AS (
           SELECT id, state, attempts, max_attempts
             FROM maintenance_jobs
            WHERE (state = 'queued' AND run_after <= $1)
               OR (state = 'running' AND lease_until <= $1)
            ORDER BY run_after, created_at, id
            FOR UPDATE SKIP LOCKED
            LIMIT $2
         ),
         reclaim AS (
           SELECT id FROM eligible
            WHERE state = 'queued' OR attempts < max_attempts
         ),
         expire AS (
           SELECT id FROM eligible
            WHERE state = 'running' AND attempts >= max_attempts
         ),
         dead AS (
           UPDATE maintenance_jobs AS job
              SET state = 'dead_letter',
                  lease_token = NULL,
                  lease_until = NULL,
                  last_error_category = 'lease_expired',
                  terminal_at = $1,
                  dead_lettered_at = $1
             FROM expire
            WHERE job.id = expire.id
         )
         UPDATE maintenance_jobs AS job
            SET state = 'running',
                lease_token = $3::uuid,
                lease_until = $1 + ($4 * interval '1 millisecond'),
                attempts = job.attempts + 1
           FROM reclaim
          WHERE job.id = reclaim.id
         RETURNING ${jobColumns("job")}`,
        [now, input.limit, leaseToken, input.leaseMs],
      );
      await client.query("COMMIT");
      return claimed.rows.map(toJob);
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async complete(
    jobId: string,
    leaseToken: string,
    now = new Date(),
  ): Promise<boolean> {
    const completed = await this.pool.query(
      `UPDATE maintenance_jobs
          SET state = 'succeeded',
              lease_token = NULL,
              lease_until = NULL,
              last_error_category = NULL,
              terminal_at = $3
        WHERE id = $1
          AND state = 'running'
          AND lease_token = $2::uuid`,
      [jobId, leaseToken, now],
    );
    return (completed.rowCount ?? 0) === 1;
  }

  async fail(input: {
    job: MaintenanceJob;
    error: unknown;
    category?: MaintenanceErrorCategory;
    terminal?: boolean;
    now?: Date;
  }): Promise<MaintenanceJob | null> {
    const now = input.now ?? new Date();
    // A non-retryable failure dead-letters on this attempt regardless of
    // remaining retry budget. The flag is derived from a MaintenanceTerminalError
    // at the runner boundary, never from the caller-supplied `input.job` fields;
    // it forces the dead-letter branch below without touching backoff math.
    const terminal = input.terminal === true;
    const errorCategory =
      input.category ??
      (terminal ? "terminal" : safeMaintenanceErrorCategory(input.error));
    // The terminal decision and the retry schedule are derived from the durable
    // row, never from the caller-supplied `input.job` retry fields. A registered
    // handler receives the same job object it is failing and could mutate
    // maxAttempts/backoff before throwing; deriving the transition from
    // `input.job.maxAttempts`/`backoffBaseMs`/`backoffMaxMs` would let that
    // mutation override the persisted policy and bypass the terminal bound.
    // `attempts`, `max_attempts`, `backoff_base_ms`, and `backoff_max_ms` below
    // are the row's own columns; `input.job` is used only for the lease-token
    // guard (id + lease_token), which claimDueJobs minted and no handler owns.
    //
    // The SQL backoff mirrors maintenanceBackoffMs() exactly: the first retry
    // (attempts = 1) uses backoff_base_ms, the exponent is (attempts - 1)
    // clamped to [0, 30], and the result is capped at backoff_max_ms. attempts
    // is bounded [0, 25] and the exponent [0, 30], so 2 ^ exponent stays within
    // numeric range with no overflow.
    //
    // The dead-letter branch fires when the row has exhausted its bounded retry
    // budget (attempts >= max_attempts) OR the caller flagged the failure
    // terminal ($5). A terminal failure short-circuits to dead_letter on this
    // attempt without consulting attempts/max_attempts and without scheduling a
    // backoff retry; an ordinary failure keeps the persisted bounded-retry
    // policy verbatim. The stale-lease guard (state='running' AND lease_token)
    // and content-free category are preserved on both paths.
    const failed = await this.pool.query<MaintenanceJobRow>(
      `UPDATE maintenance_jobs
          SET state = CASE WHEN $5::boolean OR attempts >= max_attempts
                           THEN 'dead_letter' ELSE 'queued' END,
              run_after = CASE WHEN $5::boolean OR attempts >= max_attempts
                               THEN run_after
                               ELSE $3::timestamptz + (
                                 LEAST(
                                   backoff_base_ms::numeric
                                     * (2 ^ LEAST(GREATEST(attempts - 1, 0), 30)),
                                   backoff_max_ms::numeric
                                 ) * interval '1 millisecond'
                               ) END,
              lease_token = NULL,
              lease_until = NULL,
              last_error_category = $4,
              terminal_at = CASE WHEN $5::boolean OR attempts >= max_attempts
                                 THEN $3::timestamptz ELSE NULL END,
              dead_lettered_at = CASE WHEN $5::boolean OR attempts >= max_attempts
                                      THEN $3::timestamptz ELSE NULL END
        WHERE id = $1
          AND state = 'running'
          AND lease_token = $2::uuid
       RETURNING ${JOB_COLUMNS}`,
      [input.job.id, input.job.leaseToken, now, errorCategory, terminal],
    );
    return failed.rows[0] ? toJob(failed.rows[0]) : null;
  }
}

export interface MaintenanceQueueLogger {
  info(message: string, fields: Record<string, string | number>): void;
  warn(message: string, fields: Record<string, string | number>): void;
  error(message: string, fields: Record<string, string | number>): void;
}

export type MaintenanceJobHandler = (job: MaintenanceJob) => Promise<void>;

export interface MaintenanceQueueRunnerOptions {
  queue: MaintenanceQueuePort;
  handlers: ReadonlyMap<string, MaintenanceJobHandler>;
  logger: MaintenanceQueueLogger;
  concurrency?: number;
  pollIntervalMs?: number;
  leaseMs?: number;
  now?: () => Date;
}

/**
 * Private lifecycle runner for a future server-owned maintenance bootstrap.
 * Do not start it until concrete handlers are registered. The bootstrap must
 * await runner.stop() before calling pool.end() during shutdown.
 */
export class MaintenanceQueueRunner {
  private readonly concurrency: number;
  private readonly pollIntervalMs: number;
  private readonly leaseMs: number;
  private readonly now: () => Date;
  private readonly active = new Set<Promise<void>>();
  private interval: ReturnType<typeof setInterval> | null = null;
  private tickPromise: Promise<void> | null = null;
  private stopping = false;

  constructor(private readonly options: MaintenanceQueueRunnerOptions) {
    this.concurrency = Math.min(
      Math.max(options.concurrency ?? 2, 1),
      MAX_CONCURRENCY,
    );
    this.pollIntervalMs = Math.max(options.pollIntervalMs ?? 5_000, 1);
    this.leaseMs = Math.max(options.leaseMs ?? 30_000, 1);
    this.now = options.now ?? (() => new Date());
  }

  start(): void {
    if (this.options.handlers.size === 0) {
      throw new Error("maintenance queue runner requires a registered handler");
    }
    if (this.interval || this.stopping) return;
    void this.runOnce();
    this.interval = setInterval(() => {
      void this.runOnce();
    }, this.pollIntervalMs);
  }

  async runOnce(): Promise<void> {
    if (this.stopping || this.tickPromise) return this.tickPromise ?? undefined;
    this.tickPromise = this.tick();
    try {
      await this.tickPromise;
    } finally {
      this.tickPromise = null;
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.interval) clearInterval(this.interval);
    this.interval = null;
    await this.tickPromise;
    while (this.active.size > 0) {
      await Promise.all([...this.active]);
    }
  }

  private async tick(): Promise<void> {
    // Never begin a new claim once shutdown has started: a claim leases rows in
    // the database, so starting one during stop would strand freshly-leased
    // jobs. But a claim already in flight when stop() flips this flag has (or
    // will) commit its leases, so every job it returns must still be dispatched
    // and tracked in `active` below — stop() waits on `active`, and abandoning a
    // leased job here would leave it stuck running until its lease expired.
    if (this.stopping) return;
    const available = this.concurrency - this.active.size;
    if (available <= 0) return;

    let jobs: MaintenanceJob[];
    try {
      jobs = await this.options.queue.claimDueJobs({
        limit: available,
        now: this.now(),
        leaseMs: this.leaseMs,
      });
    } catch (error) {
      this.options.logger.error("maintenance queue claim failed", {
        error_category: safeMaintenanceErrorCategory(error),
      });
      return;
    }

    // No mid-loop stopping guard: these rows are already leased to this runner,
    // so each one is dispatched and tracked even if stop() began after the
    // claim committed.
    for (const job of jobs.slice(0, available)) {
      let active: Promise<void>;
      active = this.execute(job).finally(() => this.active.delete(active));
      this.active.add(active);
    }
  }

  private async execute(job: MaintenanceJob): Promise<void> {
    const startedAt = this.now().getTime();
    // Capture the claim identity before the handler runs. The handler receives
    // the same `job` object and may mutate it (deliberately or accidentally);
    // the lease-token guard and completion call shape must bind to the id/kind
    // and lease token claimDueJobs actually minted, not to whatever the handler
    // left on the object. The durable row remains the retry-policy authority
    // (see MaintenanceQueue.fail); this only keeps the row we address stable.
    const claim = {
      id: job.id,
      kind: job.kind,
      leaseToken: job.leaseToken,
    };
    const handler = this.options.handlers.get(claim.kind);
    if (!handler) {
      await this.fail(job, claim, "unsupported_job_kind", startedAt);
      return;
    }

    try {
      await handler(job);
      const completed = await this.options.queue.complete(
        claim.id,
        claim.leaseToken!,
        this.now(),
      );
      this.options.logger.info("maintenance queue job completed", {
        job_id: claim.id,
        job_kind: claim.kind,
        status: completed ? "succeeded" : "stale_lease",
        duration_ms: this.now().getTime() - startedAt,
      });
    } catch (error) {
      await this.fail(job, claim, error, startedAt);
    }
  }

  private async fail(
    job: MaintenanceJob,
    claim: { id: string; kind: string; leaseToken: string | null },
    error: unknown,
    startedAt: number,
  ): Promise<void> {
    // A handler that threw the queue-owned non-retryable marker opts this
    // failure into immediate dead-lettering: the queue skips the bounded-retry
    // schedule and dead-letters on this attempt. The classification is made
    // here from the thrown value's TYPE, not from any handler import — the
    // marker lives on the queue and a handler's own subclass extends it.
    const terminal = isMaintenanceTerminalError(error);
    const errorCategory =
      error === "unsupported_job_kind"
        ? "unsupported_job_kind"
        : terminal
          ? "terminal"
          : safeMaintenanceErrorCategory(error);
    try {
      // Pass the immutable claim id/leaseToken as the lease-token guard so a
      // handler that mutated job.id/job.leaseToken cannot redirect the fail
      // UPDATE to a different row or make it a no-op. The retry-policy fields
      // this UPDATE consults come from the durable row, not this object.
      const failed = await this.options.queue.fail({
        job: { ...job, id: claim.id, leaseToken: claim.leaseToken },
        error,
        category: errorCategory,
        terminal,
        now: this.now(),
      });
      this.options.logger.warn("maintenance queue job failed", {
        job_id: claim.id,
        job_kind: claim.kind,
        status: failed?.state ?? "stale_lease",
        error_category: errorCategory,
        duration_ms: this.now().getTime() - startedAt,
      });
    } catch (recordingError) {
      this.options.logger.error("maintenance queue failure recording failed", {
        job_id: claim.id,
        job_kind: claim.kind,
        error_category: safeMaintenanceErrorCategory(recordingError),
        duration_ms: this.now().getTime() - startedAt,
      });
    }
  }
}
