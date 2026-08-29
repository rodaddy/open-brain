import type pg from "pg";

import {
  assertPositiveInteger,
  enqueueSemanticsDiverge,
  JOB_COLUMNS,
  jobColumns,
  MAX_CLAIM_LIMIT,
  safeMaintenanceErrorCategory,
  toJob,
  validateEnqueue,
} from "./maintenance-job.ts";
import type {
  ClaimMaintenanceJobs,
  EnqueueMaintenanceJob,
  MaintenanceErrorCategory,
  MaintenanceJob,
  MaintenanceJobRow,
  MaintenanceQueuePort,
} from "./maintenance-job.ts";

export class MaintenanceQueue implements MaintenanceQueuePort {
  constructor(private readonly pool: Pick<pg.Pool, "query" | "connect">) {}

  async enqueue(input: EnqueueMaintenanceJob): Promise<MaintenanceJob> {
    const job = validateEnqueue(input);
    const inserted = await this.pool.query<MaintenanceJobRow>(
      `INSERT INTO maintenance_jobs (
         job_kind, job_version, payload, idempotency_key, run_after,
         max_attempts, backoff_base_ms, backoff_max_ms, namespace, provenance
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (job_kind, idempotency_key)
         WHERE state IN ('queued', 'running') DO NOTHING
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
    if (inserted.rows[0]) {
      return { ...toJob(inserted.rows[0]), enqueueOutcome: "created" };
    }

    // Scoped to LIVE states, matching the partial index the insert conflicts
    // against (047). An unscoped lookup would now return a terminal row from
    // any point in history, and enqueue would hand the caller a job that
    // finished days ago as though it were the one holding the key -- the same
    // confusion 047 exists to remove, reintroduced one statement later.
    const existing = await this.pool.query<MaintenanceJobRow>(
      `SELECT ${JOB_COLUMNS}
         FROM maintenance_jobs
        WHERE job_kind = $1 AND idempotency_key = $2
          AND state IN ('queued', 'running')`,
      [job.kind, job.idempotencyKey],
    );
    const existingRow = existing.rows[0];
    if (!existingRow) {
      // The live holder reached a terminal state between the insert and this
      // lookup, so the key is free again. Under the blanket constraint this
      // was impossible -- a dropped insert always had a row behind it -- and
      // throwing was correct. Under the partial index (047) it is an ordinary
      // race, and the correct response is to insert, which now succeeds.
      //
      // Retried exactly once. A second drop means a new live job took the key
      // in between, which is genuine contention and not this race; falling
      // through to the throw keeps an unbounded retry loop out of the queue.
      const retried = await this.pool.query<MaintenanceJobRow>(
        `INSERT INTO maintenance_jobs (
           job_kind, job_version, payload, idempotency_key, run_after,
           max_attempts, backoff_base_ms, backoff_max_ms, namespace, provenance
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (job_kind, idempotency_key)
           WHERE state IN ('queued', 'running') DO NOTHING
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
      if (retried.rows[0]) {
        return { ...toJob(retried.rows[0]), enqueueOutcome: "created" };
      }
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
    // The insert was dropped by ON CONFLICT DO NOTHING and this is the row that
    // already held the key. Returning it bare is what let the distill sweep
    // report `distill_jobs_enqueued: 1` every 5 seconds for hours while the
    // newest job row stayed six hours old: the caller pushed this object into
    // its jobs array and counted it, unable to tell a job it just created from
    // one that succeeded long ago. The outcome is now on the return value so a
    // caller cannot count a dropped insert as work scheduled.
    return { ...existingJob, enqueueOutcome: "deduped" };
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

  async renew(
    jobId: string,
    leaseToken: string,
    leaseMs: number,
    now = new Date(),
  ): Promise<boolean> {
    assertPositiveInteger(leaseMs, "lease duration");
    // Advance the lease under the same stale-lease guard `complete`/`fail` use:
    // the row must still be `running` under this exact minted token. If a
    // concurrent claim already reclaimed the row (state changed or token
    // rotated) the guard matches nothing and this is a no-op returning false.
    // lease_until is recomputed from the durable NOW() + leaseMs, so a renewal
    // can only ever push the deadline forward for a lease we still own. The
    // maintenance_jobs_lease_shape CHECK is preserved: a running row keeps a
    // non-null lease_token and lease_until throughout.
    const renewed = await this.pool.query(
      `UPDATE maintenance_jobs
          SET lease_until = $3::timestamptz + ($4 * interval '1 millisecond')
        WHERE id = $1
          AND state = 'running'
          AND lease_token = $2::uuid`,
      [jobId, leaseToken, now, leaseMs],
    );
    return (renewed.rowCount ?? 0) === 1;
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
