import {
  afterAll,
  afterEach,
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
import {
  backgroundExtract,
  setMetadataProvider,
  resetMetadataProvider,
} from "../../extraction.ts";
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

  it("retirement is permanent: an attempted reactivate fails and eligibility stays false", async () => {
    // Regression for issue #337 P3: a retired source must not be moved back to
    // active/paused or otherwise mutated into ingestion eligibility.
    const reg = await registerSource(pool, admin, {
      source_kind: "drop",
      external_id: "drop-permanent",
      target_namespace: alice.clientId,
      approved: true,
    });
    expect(reg.data?.approval_state).toBe("approved");
    expect(
      (
        await resolveIngestionEligibility(pool, alice, {
          source_kind: "drop",
          external_id: "drop-permanent",
        })
      ).ok,
    ).toBe(true);

    // Retire it, then read the post-retire revision.
    const removed = await removeSource(pool, alice, reg.data!.id);
    expect(removed.ok).toBe(true);
    const afterRetire = await listSources(pool, alice, {});
    const retiredRow = afterRetire.find((r) => r.id === reg.data!.id)!;
    expect(retiredRow.lifecycle_state).toBe("retired");
    const retiredRevision = retiredRow.revision;

    // Attempt to reactivate to 'active' at the correct revision -> refused.
    const reactivate = await updateSource(pool, alice, {
      id: reg.data!.id,
      expected_revision: retiredRevision,
      lifecycle_state: "active",
    });
    expect(reactivate.ok).toBe(false);
    expect(reactivate.code).toBe("retired");

    // Attempt to nudge it to 'paused' as well -> still refused.
    const pauseAttempt = await updateSource(pool, alice, {
      id: reg.data!.id,
      expected_revision: retiredRevision,
      lifecycle_state: "paused",
    });
    expect(pauseAttempt.code).toBe("retired");

    // The row is untouched: still retired, revision unchanged, and never
    // ingestion-eligible again.
    const stillRetired = (await listSources(pool, alice, {})).find(
      (r) => r.id === reg.data!.id,
    )!;
    expect(stillRetired.lifecycle_state).toBe("retired");
    expect(stillRetired.revision).toBe(retiredRevision);
    const eligibility = await resolveIngestionEligibility(pool, alice, {
      source_kind: "drop",
      external_id: "drop-permanent",
    });
    expect(eligibility.ok).toBe(false);
  });

  it("remove is idempotent: repeat remove is a no-op success without bumping revision; missing id stays not_found", async () => {
    // Regression for issue #337 P3: repeating remove_source on an existing
    // already-retired row must return truthful success without bumping the
    // revision; a missing/wrong-namespace id stays not_found.
    const reg = await registerSource(pool, alice, {
      source_kind: "git",
      external_id: "https://example.test/idempotent-remove.git",
    });
    const firstRemove = await removeSource(pool, alice, reg.data!.id);
    expect(firstRemove.ok).toBe(true);
    const afterFirst = (await listSources(pool, alice, {})).find(
      (r) => r.id === reg.data!.id,
    )!;
    const revisionAfterRetire = afterFirst.revision;

    // Repeat remove -> truthful success, no revision bump.
    const secondRemove = await removeSource(pool, alice, reg.data!.id);
    expect(secondRemove.ok).toBe(true);
    expect(secondRemove.data?.id).toBe(reg.data!.id);
    const afterSecond = (await listSources(pool, alice, {})).find(
      (r) => r.id === reg.data!.id,
    )!;
    expect(afterSecond.revision).toBe(revisionAfterRetire);

    // A missing id (never registered) -> not_found.
    const missing = await removeSource(
      pool,
      alice,
      "00000000-0000-4000-8000-000000000000",
    );
    expect(missing.ok).toBe(false);
    expect(missing.code).toBe("not_found");

    // Bob's row is invisible to alice: removing it via alice is not_found,
    // indistinguishable from a genuinely absent id.
    const bobReg = await registerSource(pool, bob, {
      source_kind: "git",
      external_id: "https://example.test/bob-remove.git",
    });
    const crossNs = await removeSource(pool, alice, bobReg.data!.id);
    expect(crossNs.ok).toBe(false);
    expect(crossNs.code).toBe("not_found");
    // Bob's row is untouched (still active, not retired).
    const bobRow = (await listSources(pool, bob, {})).find(
      (r) => r.id === bobReg.data!.id,
    )!;
    expect(bobRow.lifecycle_state).toBe("active");
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

// Real-Postgres coverage for the issue #337 tag-clobber fix: the background
// enrichment UPDATE must union extracted tags onto the LIVE thoughts.tags
// column, so a tag a concurrent writer added between the durable write and this
// fire-and-forget enrichment is never lost. Uses the real thoughts table (from
// migration 001 + namespace/archived_at from 002/006).
dbDescribe("backgroundExtract tag merge against live row (issue #337)", () => {
  const pool = new Pool({ connectionString: DB_URL });
  const NS = "test-bgextract-337";

  async function cleanup(): Promise<void> {
    await pool.query("DELETE FROM thoughts WHERE namespace = $1", [NS]);
  }

  beforeAll(async () => {
    await runMigrations(pool);
  });
  afterEach(async () => {
    resetMetadataProvider();
    await cleanup();
  });
  afterAll(async () => {
    await cleanup();
    await pool.end();
  });

  // Await the fire-and-forget enrichment by polling for the extracted_metadata
  // landing (the last field the UPDATE sets). Bounded so a bug fails the test
  // rather than hanging.
  async function waitForEnrichment(id: string): Promise<string[]> {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const { rows } = await pool.query(
        "SELECT tags, extracted_metadata FROM thoughts WHERE id = $1",
        [id],
      );
      if (rows[0]?.extracted_metadata) return rows[0].tags as string[];
      await new Promise((r) => setTimeout(r, 20));
    }
    const { rows } = await pool.query(
      "SELECT tags FROM thoughts WHERE id = $1",
      [id],
    );
    return rows[0].tags as string[];
  }

  it("preserves a concurrently-added tag while adding extracted tags", async () => {
    const { rows } = await pool.query(
      `INSERT INTO thoughts (content, tags, created_by, namespace)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [
        "a long enough thought body to extract from",
        ["original"],
        "tester",
        NS,
      ],
    );
    const id = rows[0].id as string;

    // Simulate a concurrent same-content upsert merging a NEW tag into the live
    // row AFTER the (stale) snapshot ["original"] was captured at write time.
    await pool.query(
      "UPDATE thoughts SET tags = array_append(tags, $2) WHERE id = $1",
      [id, "concurrent-tag"],
    );

    setMetadataProvider({
      extract: () => ({ topics: ["Extracted"], people: ["Carol"] }),
    });
    // The snapshot handed to backgroundExtract is the STALE one, missing
    // "concurrent-tag" -- the exact clobber setup.
    backgroundExtract(
      pool,
      "thoughts",
      id,
      NS,
      "a long enough thought body to extract from",
      ["original"],
    );

    const finalTags = await waitForEnrichment(id);
    // The concurrently-added tag SURVIVES (not clobbered by the stale snapshot).
    expect(finalTags).toContain("concurrent-tag");
    // The originally-present tag survives too.
    expect(finalTags).toContain("original");
    // The extracted tags are added.
    expect(finalTags).toContain("Extracted");
    expect(finalTags).toContain("person:Carol");
  });

  it("does not duplicate a tag the live row already has (case-insensitive)", async () => {
    const { rows } = await pool.query(
      `INSERT INTO thoughts (content, tags, created_by, namespace)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [
        "another sufficiently long thought body here",
        ["typescript"],
        "tester",
        NS,
      ],
    );
    const id = rows[0].id as string;

    setMetadataProvider({ extract: () => ({ topics: ["TypeScript"] }) });
    backgroundExtract(
      pool,
      "thoughts",
      id,
      NS,
      "another sufficiently long thought body here",
      ["typescript"],
    );

    const finalTags = await waitForEnrichment(id);
    // "TypeScript" is not appended because the live row already has
    // "typescript" (case-insensitive); the original spelling is preserved.
    const lowerCounts = finalTags
      .map((t) => t.toLowerCase())
      .filter((t) => t === "typescript").length;
    expect(lowerCounts).toBe(1);
    expect(finalTags).toContain("typescript");
  });
});
