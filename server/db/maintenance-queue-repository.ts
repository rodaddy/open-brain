/**
 * Owns the seven statements the durable `maintenance_jobs` queue used to
 * execute from the maintenance tier: the enqueue INSERT, the live-state
 * idempotency lookup, its one retry, the claim CTE, the lease renewal, the
 * completion, and the failure transition.
 *
 * It exists so the maintenance tier holds no SQL text: server/maintenance/
 * maintenance-queue.ts takes this port instead of running the statements on its
 * own Pool (issue 1209). Design authority: `_plans/463-server-rewrite-charter.md`
 * reserves raw SQL for server/db repositories.
 *
 * Every method takes a {@link QuerySurface}, so the same factory serves the
 * pool for the single-statement paths and a transaction client for the claim.
 * The lease semantics -- which guard belongs on which transition, and why the
 * retry/dead-letter decision is derived from the durable row -- stay documented
 * at the call sites in the queue class, which owns them.
 */

import { JOB_COLUMNS, jobColumns } from "../maintenance/maintenance-job.ts";
import type {
  MaintenanceErrorCategory,
  MaintenanceJobRow,
} from "../maintenance/maintenance-job.ts";
import type { QuerySurface } from "./transaction.ts";

/** The ten values every enqueue INSERT binds, in column order. */
export interface EnqueueJobValues {
  kind: string;
  version: number;
  payload: unknown;
  idempotencyKey: string;
  runAfter: Date;
  maxAttempts: number;
  backoffBaseMs: number;
  backoffMaxMs: number;
  namespace: string | null;
  provenance: unknown;
}

export interface MaintenanceQueueRepository {
  /**
   * Insert one job, dropping the write when a live row already holds the key.
   *
   * Returns the inserted row, or undefined when ON CONFLICT DO NOTHING dropped
   * it. Used for both the first attempt and its single race retry.
   */
  insertJob(values: EnqueueJobValues): Promise<MaintenanceJobRow | undefined>;

  /** The live row holding (job_kind, idempotency_key), if there still is one. */
  selectLiveJobByIdempotencyKey(values: {
    kind: string;
    idempotencyKey: string;
  }): Promise<MaintenanceJobRow | undefined>;

  /** Claim due and lease-expired jobs, dead-lettering the spent ones. */
  claimDueJobs(values: {
    now: Date;
    limit: number;
    leaseToken: string;
    leaseMs: number;
  }): Promise<MaintenanceJobRow[]>;

  /** Push a lease we still own forward. Returns rows affected. */
  renewLease(values: {
    jobId: string;
    leaseToken: string;
    now: Date;
    leaseMs: number;
  }): Promise<number>;

  /** Mark a job succeeded under its lease guard. Returns rows affected. */
  completeJob(values: {
    jobId: string;
    leaseToken: string;
    now: Date;
  }): Promise<number>;

  /** Retry-or-dead-letter one failed job. Returns the row it left behind. */
  failJob(values: {
    jobId: string;
    leaseToken: string | null;
    now: Date;
    errorCategory: MaintenanceErrorCategory;
    terminal: boolean;
  }): Promise<MaintenanceJobRow | undefined>;
}

const INSERT_JOB_SQL = `INSERT INTO maintenance_jobs (
         job_kind, job_version, payload, idempotency_key, run_after,
         max_attempts, backoff_base_ms, backoff_max_ms, namespace, provenance
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (job_kind, idempotency_key)
         WHERE state IN ('queued', 'running') DO NOTHING
       RETURNING ${JOB_COLUMNS}`;

const SELECT_LIVE_JOB_SQL = `SELECT ${JOB_COLUMNS}
         FROM maintenance_jobs
        WHERE job_kind = $1 AND idempotency_key = $2
          AND state IN ('queued', 'running')`;

const CLAIM_DUE_JOBS_SQL = `WITH eligible AS (
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
         RETURNING ${jobColumns("job")}`;

const RENEW_LEASE_SQL = `UPDATE maintenance_jobs
          SET lease_until = $3::timestamptz + ($4 * interval '1 millisecond')
        WHERE id = $1
          AND state = 'running'
          AND lease_token = $2::uuid`;

const COMPLETE_JOB_SQL = `UPDATE maintenance_jobs
          SET state = 'succeeded',
              lease_token = NULL,
              lease_until = NULL,
              last_error_category = NULL,
              terminal_at = $3
        WHERE id = $1
          AND state = 'running'
          AND lease_token = $2::uuid`;

const FAIL_JOB_SQL = `UPDATE maintenance_jobs
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
       RETURNING ${JOB_COLUMNS}`;

export function createMaintenanceQueueRepository(
  db: QuerySurface,
): MaintenanceQueueRepository {
  return {
    async insertJob(values) {
      const inserted = await db.query<MaintenanceJobRow>(INSERT_JOB_SQL, [
        values.kind,
        values.version,
        JSON.stringify(values.payload),
        values.idempotencyKey,
        values.runAfter,
        values.maxAttempts,
        values.backoffBaseMs,
        values.backoffMaxMs,
        values.namespace,
        values.provenance === null ? null : JSON.stringify(values.provenance),
      ]);
      return inserted.rows[0];
    },

    async selectLiveJobByIdempotencyKey(values) {
      const existing = await db.query<MaintenanceJobRow>(SELECT_LIVE_JOB_SQL, [
        values.kind,
        values.idempotencyKey,
      ]);
      return existing.rows[0];
    },

    async claimDueJobs(values) {
      const claimed = await db.query<MaintenanceJobRow>(CLAIM_DUE_JOBS_SQL, [
        values.now,
        values.limit,
        values.leaseToken,
        values.leaseMs,
      ]);
      return claimed.rows;
    },

    async renewLease(values) {
      const renewed = await db.query(RENEW_LEASE_SQL, [
        values.jobId,
        values.leaseToken,
        values.now,
        values.leaseMs,
      ]);
      return renewed.rowCount ?? 0;
    },

    async completeJob(values) {
      const completed = await db.query(COMPLETE_JOB_SQL, [
        values.jobId,
        values.leaseToken,
        values.now,
      ]);
      return completed.rowCount ?? 0;
    },

    async failJob(values) {
      const failed = await db.query<MaintenanceJobRow>(FAIL_JOB_SQL, [
        values.jobId,
        values.leaseToken,
        values.now,
        values.errorCategory,
        values.terminal,
      ]);
      return failed.rows[0];
    },
  };
}
