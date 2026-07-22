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
  | "unsupported_job_kind";

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
      const claimed = await client.query<MaintenanceJobRow>(
        `WITH eligible AS (
           SELECT id
             FROM maintenance_jobs
            WHERE (state = 'queued' AND run_after <= $1)
               OR (state = 'running' AND lease_until <= $1)
            ORDER BY run_after, created_at, id
            FOR UPDATE SKIP LOCKED
            LIMIT $2
         )
         UPDATE maintenance_jobs AS job
            SET state = 'running',
                lease_token = $3::uuid,
                lease_until = $1 + ($4 * interval '1 millisecond'),
                attempts = job.attempts + 1
           FROM eligible
          WHERE job.id = eligible.id
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
    now?: Date;
  }): Promise<MaintenanceJob | null> {
    const now = input.now ?? new Date();
    const errorCategory =
      input.category ?? safeMaintenanceErrorCategory(input.error);
    const nextRunAfter = new Date(
      now.getTime() + maintenanceBackoffMs(input.job),
    );
    const failed = await this.pool.query<MaintenanceJobRow>(
      `UPDATE maintenance_jobs
          SET state = CASE WHEN attempts >= $3 THEN 'dead_letter' ELSE 'queued' END,
              run_after = CASE WHEN attempts >= $3 THEN run_after ELSE $4::timestamptz END,
              lease_token = NULL,
              lease_until = NULL,
              last_error_category = $5,
              terminal_at = CASE WHEN attempts >= $3 THEN $6::timestamptz ELSE NULL END,
              dead_lettered_at = CASE WHEN attempts >= $3 THEN $6::timestamptz ELSE NULL END
        WHERE id = $1
          AND state = 'running'
          AND lease_token = $2::uuid
       RETURNING ${JOB_COLUMNS}`,
      [
        input.job.id,
        input.job.leaseToken,
        input.job.maxAttempts,
        nextRunAfter,
        errorCategory,
        now,
      ],
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

    for (const job of jobs.slice(0, available)) {
      if (this.stopping) return;
      let active: Promise<void>;
      active = this.execute(job).finally(() => this.active.delete(active));
      this.active.add(active);
    }
  }

  private async execute(job: MaintenanceJob): Promise<void> {
    const startedAt = this.now().getTime();
    const handler = this.options.handlers.get(job.kind);
    if (!handler) {
      await this.fail(job, "unsupported_job_kind", startedAt);
      return;
    }

    try {
      await handler(job);
      const completed = await this.options.queue.complete(
        job.id,
        job.leaseToken!,
        this.now(),
      );
      this.options.logger.info("maintenance queue job completed", {
        job_id: job.id,
        job_kind: job.kind,
        status: completed ? "succeeded" : "stale_lease",
        duration_ms: this.now().getTime() - startedAt,
      });
    } catch (error) {
      await this.fail(job, error, startedAt);
    }
  }

  private async fail(
    job: MaintenanceJob,
    error: unknown,
    startedAt: number,
  ): Promise<void> {
    const errorCategory =
      error === "unsupported_job_kind"
        ? "unsupported_job_kind"
        : safeMaintenanceErrorCategory(error);
    try {
      const failed = await this.options.queue.fail({
        job,
        error,
        category: errorCategory,
        now: this.now(),
      });
      this.options.logger.warn("maintenance queue job failed", {
        job_id: job.id,
        job_kind: job.kind,
        status: failed?.state ?? "stale_lease",
        error_category: errorCategory,
        duration_ms: this.now().getTime() - startedAt,
      });
    } catch (recordingError) {
      this.options.logger.error("maintenance queue failure recording failed", {
        job_id: job.id,
        job_kind: job.kind,
        error_category: safeMaintenanceErrorCategory(recordingError),
        duration_ms: this.now().getTime() - startedAt,
      });
    }
  }
}
