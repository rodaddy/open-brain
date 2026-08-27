/**
 * Live-Postgres coverage for migration 027 and the source registry it backs.
 *
 * Proves the migration applies on top of the existing chain, and that the
 * registry's namespace isolation, revision protection, retirement rules, and
 * ingestion gate hold against a real database rather than a mock.
 *
 * REQUIRES `OPENBRAIN_TEST_DATABASE_URL`, and fails hard without it (operator
 * ruling 2026-08-27, issue #878). It must point at an isolated test/playground
 * database, never the dogfood database. `bun run test:isolated` sets it.
 *
 * The describes below split by SUBJECT over one shared fixture: the revision
 * and approval machinery, the isolation and retirement rules, and the
 * background tag-merge enrichment that writes to the same database. All three
 * are registered in `scripts/assert-db-tests-ran.ts`.
 */
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
import { requireTestDatabaseUrl } from "../../../scripts/test-support/require-test-database.ts";
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

const pool = new Pool({ connectionString: requireTestDatabaseUrl() });

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

/** Namespace used by the background-enrichment describe, on `thoughts`. */
const EXTRACT_NS = "test-bgextract-337";

async function cleanup(): Promise<void> {
  await pool.query("DELETE FROM ob_sources WHERE namespace = ANY($1::text[])", [
    namespaces,
  ]);
  await pool.query("DELETE FROM thoughts WHERE namespace = $1", [EXTRACT_NS]);
}

/** Registers a source and returns the row, failing the test when it is absent. */
async function register(
  auth: AuthInfo,
  input: Parameters<typeof registerSource>[2],
) {
  const result = await registerSource(pool, auth, input);
  expect(result.ok).toBe(true);
  const row = result.data;
  if (!row) throw new Error("register_source returned no row");
  return row;
}

/** Reads one row back out of the caller's own list, or throws. */
async function readBack(auth: AuthInfo, id: string) {
  const row = (await listSources(pool, auth, {})).find((r) => r.id === id);
  if (!row) throw new Error(`source ${id} not visible to ${auth.clientId}`);
  return row;
}

/**
 * Attempts a lifecycle_state transition as alice and returns the refusal code
 * (or "ok" when the update unexpectedly succeeded).
 */
async function lifecycleAttempt(
  id: string,
  expectedRevision: number,
  lifecycleState: "active" | "paused",
): Promise<string> {
  const result = await updateSource(pool, alice, {
    id,
    expected_revision: expectedRevision,
    lifecycle_state: lifecycleState,
  });
  return result.ok ? "ok" : (result.code ?? "unknown");
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

describe("source registry revision and approval (live Postgres)", () => {
  it("registers into the caller namespace as pending, then admin approves", async () => {
    const reg = await register(alice, {
      source_kind: "git",
      external_id: "https://example.test/alice.git",
      title: "alice repo",
    });
    expect(reg.namespace).toBe(alice.clientId);
    expect(reg.approval_state).toBe("pending");
    expect(reg.revision).toBe(1);

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
      id: reg.id,
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

  it("enforces stale-revision protection on concurrent update", async () => {
    const reg = await register(alice, {
      source_kind: "directory",
      external_id: "/srv/alice/dir",
    });
    // First update succeeds (rev 1 -> 2).
    const first = await updateSource(pool, alice, {
      id: reg.id,
      expected_revision: 1,
      sync_state: "syncing",
    });
    expect(first.ok).toBe(true);
    // Second update with the now-stale revision 1 is refused.
    const stale = await updateSource(pool, alice, {
      id: reg.id,
      expected_revision: 1,
      sync_state: "synced",
    });
    expect(stale.ok).toBe(false);
    expect(stale.code).toBe("stale_revision");
  });

  it("is idempotent for an identical re-registration", async () => {
    const first = await register(alice, {
      source_kind: "conversation",
      external_id: "conv-1",
      title: "chat log",
    });

    // Identical re-register -> idempotent: same row, no mutation, no conflict.
    const same = await register(alice, {
      source_kind: "conversation",
      external_id: "conv-1",
      title: "chat log",
    });
    expect(same.id).toBe(first.id);
    expect(same.revision).toBe(first.revision);
  });

  it("conflicts when a re-registration diverges from the stored row", async () => {
    await register(alice, {
      source_kind: "conversation",
      external_id: "conv-2",
      title: "chat log",
    });

    const diverged = await registerSource(pool, alice, {
      source_kind: "conversation",
      external_id: "conv-2",
      title: "renamed",
    });
    expect(diverged.ok).toBe(false);
    expect(diverged.code).toBe("conflict");
  });

  it("advances updated_at via the trigger on update", async () => {
    const reg = await register(alice, {
      source_kind: "git",
      external_id: "https://example.test/touch.git",
    });
    const before = reg.updated_at;
    // Small change to force an UPDATE row.
    const upd = await updateSource(pool, alice, {
      id: reg.id,
      expected_revision: 1,
      title: "touched",
    });
    expect(upd.ok).toBe(true);
    const after = upd.data?.updated_at ?? before;
    expect(new Date(after).getTime()).toBeGreaterThanOrEqual(
      new Date(before).getTime(),
    );
  });
});

describe("source registry isolation and retirement (live Postgres)", () => {
  it("isolates identity across namespaces (same external id, different namespace)", async () => {
    const a = await register(alice, {
      source_kind: "git",
      external_id: "https://example.test/shared.git",
    });
    const b = await register(bob, {
      source_kind: "git",
      external_id: "https://example.test/shared.git",
    });
    expect(a.id).not.toBe(b.id);

    // Bob cannot update alice's row (namespace-qualified): a stale/wrong-ns id
    // resolves to not_found for bob.
    const cross = await updateSource(pool, bob, {
      id: a.id,
      expected_revision: 1,
      title: "hijack",
    });
    expect(cross.ok).toBe(false);
    expect(cross.code).toBe("not_found");

    // Bob's list never surfaces alice's row.
    const bobList = await listSources(pool, bob, {});
    expect(bobList.some((r) => r.id === a.id)).toBe(false);
    expect(bobList.some((r) => r.id === b.id)).toBe(true);
  });

  it("retires a source so it is no longer ingestion-eligible", async () => {
    // Global admin registers+approves directly into alice's namespace using an
    // explicit target_namespace, without impersonating alice.
    const reg = await register(admin, {
      source_kind: "drop",
      external_id: "drop-123",
      target_namespace: alice.clientId,
      approved: true,
    });
    expect(reg.namespace).toBe(alice.clientId);
    expect(reg.approval_state).toBe("approved");
    const eligibleBefore = await resolveIngestionEligibility(pool, alice, {
      source_kind: "drop",
      external_id: "drop-123",
    });
    expect(eligibleBefore.ok).toBe(true);

    const removed = await removeSource(pool, alice, reg.id);
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
    const reg = await register(admin, {
      source_kind: "drop",
      external_id: "drop-permanent",
      target_namespace: alice.clientId,
      approved: true,
    });
    expect(reg.approval_state).toBe("approved");

    // Retire it, then read the post-retire revision.
    expect((await removeSource(pool, alice, reg.id)).ok).toBe(true);
    const retiredRow = await readBack(alice, reg.id);
    expect(retiredRow.lifecycle_state).toBe("retired");
    const retiredRevision = retiredRow.revision;

    // Attempts to move it back to 'active' or 'paused' at the correct revision
    // are both refused with the same code.
    expect(await lifecycleAttempt(reg.id, retiredRevision, "active")).toBe(
      "retired",
    );
    expect(await lifecycleAttempt(reg.id, retiredRevision, "paused")).toBe(
      "retired",
    );

    // The row is untouched: still retired, revision unchanged, and never
    // ingestion-eligible again.
    const stillRetired = await readBack(alice, reg.id);
    expect(stillRetired.lifecycle_state).toBe("retired");
    expect(stillRetired.revision).toBe(retiredRevision);
    const eligibility = await resolveIngestionEligibility(pool, alice, {
      source_kind: "drop",
      external_id: "drop-permanent",
    });
    expect(eligibility.ok).toBe(false);
  });

  it("remove is idempotent and a foreign or missing id stays not_found", async () => {
    // Regression for issue #337 P3: repeating remove_source on an existing
    // already-retired row must return truthful success without advancing the
    // revision; a missing/wrong-namespace id stays not_found.
    const reg = await register(alice, {
      source_kind: "git",
      external_id: "https://example.test/idempotent-remove.git",
    });
    expect((await removeSource(pool, alice, reg.id)).ok).toBe(true);
    const revisionAfterRetire = (await readBack(alice, reg.id)).revision;

    // Repeat remove -> truthful success, no revision advance.
    const secondRemove = await removeSource(pool, alice, reg.id);
    expect(secondRemove.ok).toBe(true);
    expect(secondRemove.data?.id).toBe(reg.id);
    expect((await readBack(alice, reg.id)).revision).toBe(revisionAfterRetire);

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
    const bobReg = await register(bob, {
      source_kind: "git",
      external_id: "https://example.test/bob-remove.git",
    });
    const crossNs = await removeSource(pool, alice, bobReg.id);
    expect(crossNs.ok).toBe(false);
    expect(crossNs.code).toBe("not_found");
    // Bob's row is untouched (still active, not retired).
    expect((await readBack(bob, bobReg.id)).lifecycle_state).toBe("active");
  });
});

/**
 * Inserts a thought into the enrichment namespace and returns its id.
 */
async function insertThought(content: string, tags: string[]): Promise<string> {
  const { rows } = await pool.query(
    `INSERT INTO thoughts (content, tags, created_by, namespace)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [content, tags, "tester", EXTRACT_NS],
  );
  return rows[0].id as string;
}

/**
 * Awaits the fire-and-forget enrichment by polling for the extracted_metadata
 * landing (the last field the UPDATE sets), then returns the live tags. The
 * poll count is finite so a bug fails the test rather than hanging.
 */
async function waitForEnrichment(id: string): Promise<string[]> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const { rows } = await pool.query(
      "SELECT tags, extracted_metadata FROM thoughts WHERE id = $1",
      [id],
    );
    if (rows[0]?.extracted_metadata) return rows[0].tags as string[];
    await new Promise((r) => setTimeout(r, 20));
  }
  const { rows } = await pool.query("SELECT tags FROM thoughts WHERE id = $1", [
    id,
  ]);
  return rows[0].tags as string[];
}

// Real-Postgres coverage for the issue #337 tag-clobber fix: the background
// enrichment UPDATE must union extracted tags onto the LIVE thoughts.tags
// column, so a tag a concurrent writer added between the durable write and this
// fire-and-forget enrichment is never lost. Uses the real thoughts table (from
// migration 001 + namespace/archived_at from 002/006).
describe("backgroundExtract tag merge against live row (live Postgres)", () => {
  afterEach(resetMetadataProvider);

  it("preserves a concurrently-added tag while adding extracted tags", async () => {
    const body = "a long enough thought body to extract from";
    const id = await insertThought(body, ["original"]);

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
    backgroundExtract(pool, "thoughts", id, EXTRACT_NS, body, ["original"]);

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
    const body = "another sufficiently long thought body here";
    const id = await insertThought(body, ["typescript"]);

    setMetadataProvider({ extract: () => ({ topics: ["TypeScript"] }) });
    backgroundExtract(pool, "thoughts", id, EXTRACT_NS, body, ["typescript"]);

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
