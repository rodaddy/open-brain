const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BACKOFF_BASE_MS = 1_000;
const DEFAULT_BACKOFF_MAX_MS = 300_000;
export const MAX_CONCURRENCY = 16;
// A held lease is renewed every leaseMs / LEASE_RENEW_DIVISOR while its handler
// runs, so a renewal always lands with a safe margin before the deadline. Three
// gives two renewal opportunities per lease window before expiry.
export const LEASE_RENEW_DIVISOR = 3;
// Upper bound on a single direct claim. The scheduled runner never asks for
// more than its available concurrency, but a direct caller must not be able to
// drain or lock the whole table in one statement.
export const MAX_CLAIM_LIMIT = 256;
// How often an IDLE runner re-proves it is alive. Long enough that a healthy
// idle queue costs ~48 lines/day instead of ~17k at the 5s poll cadence, short
// enough that a stalled runner is obvious within one window.
export const IDLE_LOG_INTERVAL_MS = 1_800_000;
// Namespace token shape, mirroring the delegated-id/header-namespace path used
// elsewhere so the queue cannot mint exotic namespaces. Queue mechanics never
// infer a namespace; this only validates one a caller opts into.
const NAMESPACE_TOKEN_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

export type MaintenanceJobState = "queued" | "running" | "succeeded" | "dead_letter";
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
  /**
   * What `enqueue` actually DID: `created` minted this row, `deduped` means the
   * insert was dropped by ON CONFLICT DO NOTHING and this is the row that
   * already held the key.
   *
   * WHY IT EXISTS. `enqueue` returns a job either way, and for hours the distill
   * sweep logged `distill_jobs_enqueued: 1` every 5 seconds while the newest
   * job row in the table stayed six hours old. The caller pushed the returned
   * object into its jobs array and counted the length, with no way to tell a
   * job it had just created from one that succeeded long ago. A dropped insert
   * and a scheduled job were the same value.
   *
   * Optional so every existing reader and queue fake keeps compiling; a caller
   * that reports counts is expected to read it. Absent means "not reported by
   * this producer", never "created".
   */
  enqueueOutcome?: "created" | "deduped";
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
  /**
   * Extend a still-owned running lease. Guarded by the immutable (id, lease
   * token) the claim minted: it advances lease_until to now + leaseMs ONLY while
   * the row is still `running` under that exact token. A job whose lease was
   * already reclaimed, completed, failed, or dead-lettered no longer matches the
   * token guard, so renewal is a safe no-op that returns false — the runner then
   * knows it no longer owns the job. The new lease_until is derived here from the
   * durable row + the passed leaseMs, never from any handler-mutable state.
   *
   * Optional on the port so a minimal/legacy queue fake need not implement it;
   * the runner heartbeats only when a queue provides `renew`. The concrete
   * MaintenanceQueue always implements it.
   */
  renew?(
    jobId: string,
    leaseToken: string,
    leaseMs: number,
    now?: Date,
  ): Promise<boolean>;
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

export interface MaintenanceJobRow {
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

export const JOB_COLUMNS = JOB_COLUMN_NAMES.join(", ");

// Same column set qualified by a table alias. Required in the claim statement,
// whose CTE join exposes `id` on both `maintenance_jobs` and `eligible`, making
// an unqualified RETURNING list ambiguous.
export function jobColumns(alias: string): string {
  return JOB_COLUMN_NAMES.map((column) => `${alias}.${column}`).join(", ");
}

function toDate(value: Date | string | null): Date | null {
  return value === null ? null : new Date(value);
}

export function toJob(row: MaintenanceJobRow): MaintenanceJob {
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

export function assertPositiveInteger(value: number, field: string): void {
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

interface ValidatedRetryPolicy {
  maxAttempts: number;
  backoffBaseMs: number;
  backoffMaxMs: number;
}

/** Applies the queue retry defaults and rejects an out-of-range policy. */
function validateRetryPolicy(
  retry: EnqueueMaintenanceJob["retry"],
): ValidatedRetryPolicy {
  const maxAttempts = retry?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const backoffBaseMs = retry?.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS;
  const backoffMaxMs = retry?.backoffMaxMs ?? DEFAULT_BACKOFF_MAX_MS;
  assertPositiveInteger(maxAttempts, "max attempts");
  assertPositiveInteger(backoffBaseMs, "backoff base");
  assertPositiveInteger(backoffMaxMs, "backoff maximum");
  if (maxAttempts > 25 || backoffMaxMs < backoffBaseMs) {
    throw new Error("maintenance queue retry policy is invalid");
  }
  return { maxAttempts, backoffBaseMs, backoffMaxMs };
}

/** Rejects a malformed opt-in namespace or provenance on an enqueue. */
function validateScope(scope: EnqueueMaintenanceJob["scope"]): void {
  if (scope?.provenance !== undefined) {
    assertObject(scope.provenance, "provenance");
  }
  if (scope?.namespace !== undefined && !NAMESPACE_TOKEN_RE.test(scope.namespace)) {
    throw new Error("maintenance queue namespace is invalid");
  }
}

/** Rejects a malformed job kind or idempotency key on an enqueue. */
function validateJobIdentity(input: EnqueueMaintenanceJob): void {
  if (!/^[a-z][a-z0-9_.-]{0,127}$/.test(input.kind)) {
    throw new Error("maintenance queue job kind is invalid");
  }
  if (input.idempotencyKey.length === 0 || input.idempotencyKey.length > 256) {
    throw new Error("maintenance queue idempotency key is invalid");
  }
  assertPositiveInteger(input.version, "job version");
  assertObject(input.payload, "payload");
}

export function validateEnqueue(input: EnqueueMaintenanceJob): Required<
  Pick<EnqueueMaintenanceJob, "kind" | "version" | "payload" | "idempotencyKey">
> & {
  runAfter: Date;
  maxAttempts: number;
  backoffBaseMs: number;
  backoffMaxMs: number;
  namespace: string | null;
  provenance: Record<string, unknown> | null;
} {
  validateJobIdentity(input);
  const retry = validateRetryPolicy(input.retry);
  validateScope(input.scope);

  return {
    kind: input.kind,
    version: input.version,
    payload: input.payload,
    idempotencyKey: input.idempotencyKey,
    runAfter: input.runAfter ?? new Date(),
    maxAttempts: retry.maxAttempts,
    backoffBaseMs: retry.backoffBaseMs,
    backoffMaxMs: retry.backoffMaxMs,
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

export function enqueueSemanticsDiverge(
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

export function safeMaintenanceErrorCategory(error: unknown): MaintenanceErrorCategory {
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
