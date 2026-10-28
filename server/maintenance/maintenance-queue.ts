/**
 * The durable `maintenance_jobs` queue: enqueue, claim, lease renewal,
 * completion, and failure. Every lease transition is guarded by the (id, lease
 * token) the claim minted, and the retry/dead-letter decision is derived from
 * the durable row rather than from any caller-supplied object.
 *
 * The statements themselves live in ../db/maintenance-queue-repository.ts and
 * the transaction in ../db/transaction.ts (issue 1209); this class owns the
 * ordering, the guards, and the semantics documented below.
 */
import type pg from "pg";

import {
  assertPositiveInteger,
  enqueueSemanticsDiverge,
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
  MaintenanceQueuePort,
} from "./maintenance-job.ts";
import {
  createMaintenanceQueueRepository,
  type EnqueueJobValues,
  type MaintenanceQueueRepository,
} from "../db/maintenance-queue-repository.ts";
import { withTransaction } from "../db/transaction.ts";

export class MaintenanceQueue implements MaintenanceQueuePort {
  private readonly repository: MaintenanceQueueRepository;
  private readonly pool: pg.Pool;

  constructor(pool: pg.Pool) {
    this.pool = pool;
    this.repository = createMaintenanceQueueRepository(pool);
  }

  async enqueue(input: EnqueueMaintenanceJob): Promise<MaintenanceJob> {
    const job = validateEnqueue(input);
    const values: EnqueueJobValues = {
      kind: job.kind,
      version: job.version,
      payload: job.payload,
      idempotencyKey: job.idempotencyKey,
      runAfter: job.runAfter,
      maxAttempts: job.maxAttempts,
      backoffBaseMs: job.backoffBaseMs,
      backoffMaxMs: job.backoffMaxMs,
      namespace: job.namespace,
      provenance: job.provenance,
    };
    const inserted = await this.repository.insertJob(values);
    if (inserted) {
      return { ...toJob(inserted), enqueueOutcome: "created" };
    }

    // Scoped to LIVE states, matching the partial index the insert conflicts
    // against (047). An unscoped lookup would now return a terminal row from
    // any point in history, and enqueue would hand the caller a job that
    // finished days ago as though it were the one holding the key -- the same
    // confusion 047 exists to remove, reintroduced one statement later.
    const existingRow = await this.repository.selectLiveJobByIdempotencyKey({
      kind: job.kind,
      idempotencyKey: job.idempotencyKey,
    });
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
      const retried = await this.repository.insertJob(values);
      if (retried) {
        return { ...toJob(retried), enqueueOutcome: "created" };
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
    const leaseToken = crypto.randomUUID();

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
    //
    // onRollbackFailure is deliberately a no-op: this path swallowed rollback
    // errors with `.catch(() => undefined)` before the transaction moved to
    // ../db/transaction.ts, and the hook keeps that behavior visible rather
    // than changing it under a refactor.
    //
    // The pool is a pg.Pool by declaration (issue 1209, session 35).
    const claimed = await withTransaction({
      pool: this.pool,
      onRollbackFailure: () => undefined,
      run: async (tx) =>
        createMaintenanceQueueRepository(tx).claimDueJobs({
          now,
          limit: input.limit,
          leaseToken,
          leaseMs: input.leaseMs,
        }),
    });
    return claimed.map(toJob);
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
    const renewed = await this.repository.renewLease({
      jobId,
      leaseToken,
      now,
      leaseMs,
    });
    return renewed === 1;
  }

  async complete(
    jobId: string,
    leaseToken: string,
    now = new Date(),
  ): Promise<boolean> {
    const completed = await this.repository.completeJob({
      jobId,
      leaseToken,
      now,
    });
    return completed === 1;
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
    // `attempts`, `max_attempts`, `backoff_base_ms`, and `backoff_max_ms` in the
    // statement are the row's own columns; `input.job` is used only for the
    // lease-token guard (id + lease_token), which claimDueJobs minted and no
    // handler owns.
    //
    // The SQL backoff mirrors maintenanceBackoffMs() exactly: the first retry
    // (attempts = 1) uses backoff_base_ms, the exponent is (attempts - 1)
    // clamped to [0, 30], and the result is capped at backoff_max_ms. attempts
    // is bounded [0, 25] and the exponent [0, 30], so 2 ^ exponent stays within
    // numeric range with no overflow.
    //
    // The dead-letter branch fires when the row has exhausted its bounded retry
    // budget (attempts >= max_attempts) OR the caller flagged the failure
    // terminal. A terminal failure short-circuits to dead_letter on this
    // attempt without consulting attempts/max_attempts and without scheduling a
    // backoff retry; an ordinary failure keeps the persisted bounded-retry
    // policy verbatim. The stale-lease guard (state='running' AND lease_token)
    // and content-free category are preserved on both paths.
    const failed = await this.repository.failJob({
      jobId: input.job.id,
      leaseToken: input.job.leaseToken,
      now,
      errorCategory,
      terminal,
    });
    return failed ? toJob(failed) : null;
  }
}
