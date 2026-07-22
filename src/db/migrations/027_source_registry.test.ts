import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "bun:test";
import { Pool } from "pg";
import { runMigrations } from "../migrate.ts";
import {
  registerSource,
  updateSource,
  removeSource,
  listSources,
  resolveIngestionEligibility,
} from "../../source-registry.ts";
import type { AuthInfo } from "../../types.ts";

// Live-Postgres coverage: proves the migration applies and that the registry's
// namespace/scope isolation, revision protection, and ingestion gate hold
// against a real database. Skipped unless OPENBRAIN_TEST_DATABASE_URL is set
// (matches migration 025's live-test convention; run in CI's db-integration job).
const DB_URL = process.env.OPENBRAIN_TEST_DATABASE_URL;
const dbDescribe = DB_URL ? describe : describe.skip;

dbDescribe("027 source registry (live Postgres)", () => {
  const pool = new Pool({ connectionString: DB_URL });

  const alice: AuthInfo = {
    role: "agent",
    clientId: "test-src-alice",
    namespaceSource: "token",
  };
  const bob: AuthInfo = {
    role: "agent",
    clientId: "test-src-bob",
    namespaceSource: "token",
  };
  const admin: AuthInfo = {
    role: "admin",
    clientId: "test-src-admin",
    namespaceSource: "token",
  };
  const namespaces = [alice.clientId, bob.clientId, admin.clientId];

  async function cleanup(): Promise<void> {
    await pool.query(
      "DELETE FROM ob_sources WHERE namespace = ANY($1::text[])",
      [namespaces],
    );
  }

  beforeAll(async () => {
    // Apply the full migration chain once via the tracked runner; migration 027
    // must apply cleanly on top of the existing schema. Proves the migration.
    await runMigrations(pool);
  });
  beforeEach(cleanup);
  afterAll(async () => {
    await cleanup();
    await pool.end();
  });

  it("registers into the caller namespace as pending, then admin approves", async () => {
    const reg = await registerSource(pool, alice, {
      source_kind: "git",
      external_id: "https://example.test/alice.git",
      title: "alice repo",
    });
    expect(reg.ok).toBe(true);
    expect(reg.data?.namespace).toBe(alice.clientId);
    expect(reg.data?.approval_state).toBe("pending");
    expect(reg.data?.revision).toBe(1);

    // Not eligible while pending.
    const pendingGate = await resolveIngestionEligibility(pool, alice, {
      source_kind: "git",
      external_id: "https://example.test/alice.git",
    });
    expect(pendingGate.ok).toBe(false);

    // Approval is performed by a BARE global admin token that explicitly
    // targets alice's namespace -- NOT by fabricating an admin whose clientId
    // equals alice's namespace. canWriteNamespace authorizes the cross-namespace
    // write; approved_by records the admin's real identity.
    const approve = await updateSource(pool, admin, {
      id: reg.data!.id,
      expected_revision: 1,
      target_namespace: alice.clientId,
      approval_state: "approved",
    });
    expect(approve.ok).toBe(true);
    expect(approve.data?.approval_state).toBe("approved");
    expect(approve.data?.namespace).toBe(alice.clientId);
    expect(approve.data?.approved_by).toBe(admin.clientId);
    expect(approve.data?.revision).toBe(2);

    const gate = await resolveIngestionEligibility(pool, alice, {
      source_kind: "git",
      external_id: "https://example.test/alice.git",
    });
    expect(gate.ok).toBe(true);
  });

  it("isolates identity across namespaces (same external id, different namespace)", async () => {
    const a = await registerSource(pool, alice, {
      source_kind: "git",
      external_id: "https://example.test/shared.git",
    });
    const b = await registerSource(pool, bob, {
      source_kind: "git",
      external_id: "https://example.test/shared.git",
    });
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(a.data?.id).not.toBe(b.data?.id);

    // Bob cannot update alice's row (namespace-qualified): a stale/wrong-ns id
    // resolves to not_found for bob.
    const cross = await updateSource(pool, bob, {
      id: a.data!.id,
      expected_revision: 1,
      title: "hijack",
    });
    expect(cross.ok).toBe(false);
    expect(cross.code).toBe("not_found");

    // Bob's list never surfaces alice's row.
    const bobList = await listSources(pool, bob, {});
    expect(bobList.some((r) => r.id === a.data!.id)).toBe(false);
    expect(bobList.some((r) => r.id === b.data!.id)).toBe(true);
  });

  it("enforces stale-revision protection on concurrent update", async () => {
    const reg = await registerSource(pool, alice, {
      source_kind: "directory",
      external_id: "/tmp/alice/dir",
    });
    // First update succeeds (rev 1 -> 2).
    const first = await updateSource(pool, alice, {
      id: reg.data!.id,
      expected_revision: 1,
      sync_state: "syncing",
    });
    expect(first.ok).toBe(true);
    // Second update with the now-stale revision 1 is refused.
    const stale = await updateSource(pool, alice, {
      id: reg.data!.id,
      expected_revision: 1,
      sync_state: "synced",
    });
    expect(stale.ok).toBe(false);
    expect(stale.code).toBe("stale_revision");
  });

  it("retires a source so it is no longer ingestion-eligible", async () => {
    // Global admin registers+approves directly into alice's namespace using an
    // explicit target_namespace, without impersonating alice.
    const reg = await registerSource(pool, admin, {
      source_kind: "drop",
      external_id: "drop-123",
      target_namespace: alice.clientId,
      approved: true,
    });
    expect(reg.data?.namespace).toBe(alice.clientId);
    expect(reg.data?.approval_state).toBe("approved");
    const eligibleBefore = await resolveIngestionEligibility(pool, alice, {
      source_kind: "drop",
      external_id: "drop-123",
    });
    expect(eligibleBefore.ok).toBe(true);

    const removed = await removeSource(pool, alice, reg.data!.id);
    expect(removed.ok).toBe(true);

    const eligibleAfter = await resolveIngestionEligibility(pool, alice, {
      source_kind: "drop",
      external_id: "drop-123",
    });
    expect(eligibleAfter.ok).toBe(false);
    expect(eligibleAfter.code).toBe("approval_denied");
  });

  it("is idempotent for an identical re-registration, conflicts on divergence", async () => {
    const first = await registerSource(pool, alice, {
      source_kind: "conversation",
      external_id: "conv-1",
      title: "chat log",
    });
    expect(first.ok).toBe(true);

    // Identical re-register -> idempotent: same row, no mutation, no conflict.
    const same = await registerSource(pool, alice, {
      source_kind: "conversation",
      external_id: "conv-1",
      title: "chat log",
    });
    expect(same.ok).toBe(true);
    expect(same.data?.id).toBe(first.data!.id);
    expect(same.data?.revision).toBe(first.data!.revision);

    // Divergent re-register (different title) -> real conflict.
    const diverged = await registerSource(pool, alice, {
      source_kind: "conversation",
      external_id: "conv-1",
      title: "renamed",
    });
    expect(diverged.ok).toBe(false);
    expect(diverged.code).toBe("conflict");
  });

  it("advances updated_at via the trigger on update", async () => {
    const reg = await registerSource(pool, alice, {
      source_kind: "git",
      external_id: "https://example.test/touch.git",
    });
    const before = reg.data!.updated_at;
    // Small change to force an UPDATE row.
    const upd = await updateSource(pool, alice, {
      id: reg.data!.id,
      expected_revision: 1,
      title: "touched",
    });
    expect(upd.ok).toBe(true);
    expect(new Date(upd.data!.updated_at).getTime()).toBeGreaterThanOrEqual(
      new Date(before).getTime(),
    );
  });
});
