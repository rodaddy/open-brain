import {
  IDLE_LOG_INTERVAL_MS,
  isMaintenanceTerminalError,
  LEASE_RENEW_DIVISOR,
  MAX_CONCURRENCY,
  safeMaintenanceErrorCategory,
} from "./maintenance-job.ts";
import type { MaintenanceJob, MaintenanceQueuePort } from "./maintenance-job.ts";

/**
 * A claimed job always carries the lease token its claim minted; the field is
 * nullable only because the same shape describes queued and finished rows.
 */
function requireLeaseToken(token: string | null): string {
  if (token === null) {
    throw new Error("maintenance queue claim is missing its lease token");
  }
  return token;
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
  /**
   * Heartbeat cadence for renewing a held lease WHILE its handler runs. Defaults
   * to leaseMs / LEASE_RENEW_DIVISOR (a fraction of the lease window) so a renew
   * always lands well before the deadline. Clamped to [1, leaseMs - 1] so a
   * renew never coincides with or trails expiry. Injectable for tests that drive
   * multiple short lease windows deterministically.
   */
  leaseRenewMs?: number;
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
  private readonly leaseRenewMs: number;
  private readonly now: () => Date;
  private readonly active = new Set<Promise<void>>();
  private interval: ReturnType<typeof setInterval> | null = null;
  private tickPromise: Promise<void> | null = null;
  private stopping = false;
  // Liveness counters. `ticks` proves the poll loop is turning; `lastIdleLogAt`
  // rate-limits the idle line so an alive-but-idle runner is visible without
  // flooding the log. 0 means "not yet logged", so the first idle tick always
  // emits and startup is provable immediately.
  private ticks = 0;
  private lastIdleLogAt = 0;

  constructor(private readonly options: MaintenanceQueueRunnerOptions) {
    this.concurrency = Math.min(Math.max(options.concurrency ?? 2, 1), MAX_CONCURRENCY);
    this.pollIntervalMs = Math.max(options.pollIntervalMs ?? 5_000, 1);
    this.leaseMs = Math.max(options.leaseMs ?? 30_000, 1);
    // Heartbeat cadence: renew at a fraction of the lease window so a renewal
    // always lands before the deadline, and clamp to [1, leaseMs - 1] so it can
    // never sit at or past expiry. With the default 30s lease this renews every
    // 10s. This is a CADENCE, not a longer lease — leaseMs itself is unchanged.
    const renewDefault = Math.max(Math.floor(this.leaseMs / LEASE_RENEW_DIVISOR), 1);
    this.leaseRenewMs = Math.min(
      Math.max(options.leaseRenewMs ?? renewDefault, 1),
      Math.max(this.leaseMs - 1, 1),
    );
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
      await Promise.all(this.active);
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

    // Liveness signal. Without this, an idle runner and a dead runner are
    // indistinguishable in the log: the only lines emitted were completion and
    // failure, so "no output" meant either "polling normally, nothing to do" or
    // "not polling at all". Silence must never be the only evidence.
    //
    // NOT one line per poll: at the 5s default that is ~17k lines/day of noise,
    // which is its own way of hiding a signal. Instead a claim is always logged,
    // and an empty poll is logged on the first tick and then only once per
    // heartbeat window, so an idle runner still proves it is alive.
    this.ticks += 1;
    if (jobs.length > 0) {
      this.options.logger.info("maintenance queue claimed jobs", {
        claimed: jobs.length,
        available,
        active: this.active.size,
        job_kinds: [...new Set(jobs.map((job) => job.kind))].join(","),
        ticks_since_start: this.ticks,
      });
      this.lastIdleLogAt = 0;
    } else {
      const nowMs = this.now().getTime();
      if (
        this.lastIdleLogAt === 0 ||
        nowMs - this.lastIdleLogAt >= IDLE_LOG_INTERVAL_MS
      ) {
        this.options.logger.info("maintenance queue idle", {
          polls: this.ticks,
          poll_interval_ms: this.pollIntervalMs,
          concurrency: this.concurrency,
          active: this.active.size,
        });
        this.lastIdleLogAt = nowMs;
      }
    }

    // No mid-loop stopping guard: these rows are already leased to this runner,
    // so each one is dispatched and tracked even if stop() began after the
    // claim committed.
    for (const job of jobs.slice(0, available)) {
      const active: Promise<void> = this.execute(job).finally(() =>
        this.active.delete(active),
      );
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

    // Renew this lease on a heartbeat WHILE the handler runs, so a handler that
    // blocks on a long/contended transaction past the lease window is not
    // reclaimed or dead-lettered out from under its live owner. The heartbeat is
    // bound to the immutable claim (id + minted lease token), so a handler that
    // mutated job.id/job.leaseToken cannot redirect it. It is cleared and awaited
    // BEFORE complete/fail below so no renewal races the terminal transition, and
    // drained again in stop() via `active`.
    // null when this queue/claim cannot heartbeat (no renew capability or no
    // lease token). We only await stop() when a heartbeat actually started, so a
    // queue without renewal keeps its exact pre-existing execute timing.
    const heartbeat = this.startHeartbeat(claim);
    try {
      await handler(job);
      // Stop and await the heartbeat before completing: a renewal must never run
      // concurrently with (or after) the complete UPDATE on the same row.
      if (heartbeat) await heartbeat.stop();
      const completed = await this.options.queue.complete(
        claim.id,
        requireLeaseToken(claim.leaseToken),
        this.now(),
      );
      this.options.logger.info("maintenance queue job completed", {
        job_id: claim.id,
        job_kind: claim.kind,
        status: completed ? "succeeded" : "stale_lease",
        duration_ms: this.now().getTime() - startedAt,
      });
    } catch (error) {
      // Same ordering on the failure path: quiesce the heartbeat before fail().
      if (heartbeat) await heartbeat.stop();
      await this.fail(job, claim, error, startedAt);
    }
  }

  /**
   * Start a lease-renewal heartbeat for one claimed job and return a handle whose
   * `stop()` clears the timer and awaits any in-flight renewal. The heartbeat:
   *  - renews under the IMMUTABLE claim (id + minted lease token), never a
   *    handler-mutable field, so it addresses exactly the row the claim leased;
   *  - NEVER overlaps its own renewal: a `renewing` guard skips a tick while the
   *    previous renew is still awaiting, so a slow DB cannot stack renew calls;
   *  - stops heartbeating the moment it observes it no longer owns the lease
   *    (renew returned false — reclaimed/completed/failed elsewhere), or a renew
   *    threw, so a lost lease does not spin; and
   *  - logs content-free only (job id/kind + a stable status token), never the
   *    payload, error message, or lease values.
   */
  private startHeartbeat(claim: {
    id: string;
    kind: string;
    leaseToken: string | null;
  }): { stop(): Promise<void> } | null {
    // A null lease token means the claim carried no lease to renew (defensive;
    // claimDueJobs always mints one for a running row). And a queue without a
    // `renew` capability cannot heartbeat. Either way: no heartbeat at all.
    const renew = this.options.queue.renew;
    if (claim.leaseToken === null || typeof renew !== "function") {
      return null;
    }
    const leaseToken = claim.leaseToken;
    let inFlight: Promise<void> | null = null;
    let stopped = false;

    const renewOnce = async (): Promise<void> => {
      // Overlap guard: a previous renew is still awaiting; skip this tick.
      if (inFlight || stopped) return;
      const run = (async () => {
        try {
          const held = await renew.call(
            this.options.queue,
            claim.id,
            leaseToken,
            this.leaseMs,
            this.now(),
          );
          if (!held) {
            // We no longer own the lease (reclaimed/completed/failed elsewhere).
            // Stop heartbeating; the terminal transition is owned elsewhere.
            stopped = true;
            if (timer) clearInterval(timer);
            this.options.logger.warn("maintenance queue lease renewal lost", {
              job_id: claim.id,
              job_kind: claim.kind,
              status: "lease_lost",
            });
          }
        } catch (error) {
          // A transient renewal failure is contained content-free. Do not crash
          // the run; the next tick retries, or the lease simply expires.
          this.options.logger.error("maintenance queue lease renewal failed", {
            job_id: claim.id,
            job_kind: claim.kind,
            error_category: safeMaintenanceErrorCategory(error),
          });
        }
      })();
      inFlight = run;
      try {
        await run;
      } finally {
        inFlight = null;
      }
    };

    const timer: ReturnType<typeof setInterval> | null = setInterval(() => {
      void renewOnce();
    }, this.leaseRenewMs);

    return {
      stop: async (): Promise<void> => {
        stopped = true;
        if (timer) clearInterval(timer);
        // Await any renewal already in flight so it can never land concurrently
        // with (or after) the complete/fail UPDATE the caller runs next.
        if (inFlight) await inFlight;
      },
    };
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
