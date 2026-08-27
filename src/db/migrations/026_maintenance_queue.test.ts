import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { Pool } from "pg";
import { requireTestDatabaseUrl } from "../../../scripts/test-support/require-test-database.ts";
import {
  cleanup,
  enqueue as enqueueWith,
  expectDefined,
  migrate,
  queue as queueWith,
} from "./026_maintenance_queue-test-helpers.ts";

const pool = new Pool({ connectionString: requireTestDatabaseUrl() });
const queue = () => queueWith(pool);
const enqueue = (input: Parameters<typeof enqueueWith>[1] = {}) =>
  enqueueWith(pool, input);

// The `it` bodies live at module scope rather than inline so the describe
// callback stays inside the repo's per-function line rule. Test names, order,
// and assertions are unchanged by the move.

async function enforcesConstraintsAndIdempotentEnqueue(): Promise<void> {
  const first = await enqueue({
    idempotencyKey: "same-key",
    payload: { a: 1 },
  });
  // Identical semantics (key order aside) is a safe idempotent replay.
  const second = await enqueue({
    idempotencyKey: "same-key",
    payload: { a: 1 },
  });
  expect(second.id).toBe(first.id);

  // Reusing the key with a divergent payload must be rejected content-free,
  // not silently return the stale job under the old contract.
  await expect(
    enqueue({ idempotencyKey: "same-key", payload: { a: 2 } }),
  ).rejects.toThrow("divergent job semantics");
  // Divergent retry semantics under the same key must also be rejected.
  await expect(
    enqueue({
      idempotencyKey: "same-key",
      payload: { a: 1 },
      retry: { maxAttempts: 5 },
    }),
  ).rejects.toThrow("divergent job semantics");

  const { rows } = await pool.query<{ conname: string }>(
    `SELECT conname
       FROM pg_constraint
      WHERE conrelid = 'maintenance_jobs'::regclass`,
  );
  expect(rows.map((row) => row.conname)).toContain("maintenance_jobs_lease_shape");
  expect(rows.map((row) => row.conname)).toContain("maintenance_jobs_terminal_shape");

  // Idempotency uniqueness is a PARTIAL UNIQUE INDEX since 047, not a table
  // constraint, so it lives in pg_indexes and never appears above. 047
  // scoped it to live states on purpose: a terminal row must stop reserving
  // its key, or a recurring batch deadlocks forever (#747).
  const { rows: indexes } = await pool.query<{
    indexname: string;
    indexdef: string;
  }>(
    `SELECT indexname, indexdef
       FROM pg_indexes
      WHERE tablename = 'maintenance_jobs'`,
  );
  const byName = new Map(indexes.map((row) => [row.indexname, row.indexdef]));

  expect([...byName.keys()]).not.toContain("maintenance_jobs_unique_kind_idempotency");

  const live = byName.get("maintenance_jobs_live_idempotency");
  expect(live).toBeDefined();
  expect(live).toContain("UNIQUE");
  // Only queued and running reserve the key.
  expect(live).toContain("'queued'");
  expect(live).toContain("'running'");
  expect(live).not.toContain("'succeeded'");
  expect(live).not.toContain("'dead_letter'");
}

async function persistsCallerForcedTerminalCategory(): Promise<void> {
  await enqueue({ idempotencyKey: "unsupported", retry: { maxAttempts: 1 } });
  const [maybeClaimed] = await queue().claimDueJobs({
    limit: 1,
    now: new Date(),
    leaseMs: 60_000,
  });
  const claimed = expectDefined(maybeClaimed, "claimed");
  const dead = await queue().fail({
    job: claimed,
    error: "unsupported_job_kind",
    category: "unsupported_job_kind",
  });
  expect(dead?.state).toBe("dead_letter");
  // Old behavior stored non_error because the sentinel is a plain string.
  expect(dead?.lastErrorCategory).toBe("unsupported_job_kind");
  const { rows } = await pool.query<{ last_error_category: string }>(
    "SELECT last_error_category FROM maintenance_jobs WHERE id = $1",
    [claimed.id],
  );
  expect(rows[0]?.last_error_category).toBe("unsupported_job_kind");
}

async function rejectsOutOfBoundsClaimLimit(): Promise<void> {
  await expect(
    queue().claimDueJobs({ limit: 1_000, now: new Date(), leaseMs: 60_000 }),
  ).rejects.toThrow("claim limit exceeds the bound");
}

async function rejectsInvalidNamespaceToken(): Promise<void> {
  await expect(
    enqueue({
      idempotencyKey: "bad-ns",
      scope: { namespace: "not a valid namespace!" },
    }),
  ).rejects.toThrow("namespace is invalid");
}

async function allowsOnlyOneConcurrentClaim(): Promise<void> {
  await enqueue({ idempotencyKey: "single-claim" });
  const now = new Date();
  const [first, second] = await Promise.all([
    queue().claimDueJobs({ limit: 1, now, leaseMs: 60_000 }),
    queue().claimDueJobs({ limit: 1, now, leaseMs: 60_000 }),
  ]);
  expect(first.length + second.length).toBe(1);
}

async function honorsLeaseExpiryAndRejectsStaleCompletion(): Promise<void> {
  await enqueue({ idempotencyKey: "leases" });
  const now = new Date("2026-07-22T12:00:00.000Z");
  const [maybeFirst] = await queue().claimDueJobs({
    limit: 1,
    now,
    leaseMs: 1_000,
  });
  expect(maybeFirst).toBeDefined();
  expect(
    await queue().claimDueJobs({
      limit: 1,
      now: new Date(now.getTime() + 999),
      leaseMs: 1_000,
    }),
  ).toHaveLength(0);

  const [maybeReclaimed] = await queue().claimDueJobs({
    limit: 1,
    now: new Date(now.getTime() + 1_000),
    leaseMs: 1_000,
  });
  expect(maybeReclaimed?.id).toBe(maybeFirst?.id);
  expect(maybeReclaimed?.attempts).toBe(2);
  const first = expectDefined(maybeFirst, "first");
  const reclaimed = expectDefined(maybeReclaimed, "reclaimed");
  expect(
    await queue().complete(
      first.id,
      expectDefined(first.leaseToken, "first.leaseToken"),
      new Date(now.getTime() + 1_001),
    ),
  ).toBe(false);
  expect(
    await queue().complete(
      reclaimed.id,
      expectDefined(reclaimed.leaseToken, "reclaimed.leaseToken"),
      new Date(now.getTime() + 1_001),
    ),
  ).toBe(true);
}

describe("026 maintenance queue enqueue and claim (live Postgres)", () => {
  beforeEach(async () => {
    await migrate(pool);
    await cleanup(pool);
  });
  afterAll(async () => {
    await cleanup(pool);
    await pool.end();
  });

  it(
    "enforces live migration constraints and idempotent enqueue",
    enforcesConstraintsAndIdempotentEnqueue,
  );

  it(
    "persists the caller-forced terminal category (unsupported kind is not non_error)",
    persistsCallerForcedTerminalCategory,
  );

  it(
    "rejects an out-of-bounds direct claim limit before touching the table",
    rejectsOutOfBoundsClaimLimit,
  );

  it("rejects an invalid namespace token content-free", rejectsInvalidNamespaceToken);

  it(
    "allows only one concurrent runner to claim a due job",
    allowsOnlyOneConcurrentClaim,
  );

  it(
    "does not steal an unexpired lease, reclaims an expired one, and rejects stale completion",
    honorsLeaseExpiryAndRejectsStaleCompletion,
  );
});
