import { describe, it, expect } from "bun:test";
import type pg from "pg";
import {
  registerSource,
  updateSource,
  removeSource,
  listSources,
  resolveIngestionEligibility,
  registerSourceInputSchema,
  updateSourceInputSchema,
  hashSourceContent,
  SOURCE_CONTENT_HASH_VERSION,
  SOURCE_REGISTRY_TABLE,
} from "../source-registry.ts";
import type { AuthInfo } from "../types.ts";

// A query-capturing fake pool. Records every (sql, params) and returns queued
// row batches in order, so tests can assert both the authorization DECISION
// and the exact SQL CALL SHAPE (namespace predicate, revision guard) without a
// live database.
function fakePool(batches: Array<{ rows: unknown[] }>) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  let i = 0;
  const pool = {
    query: async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      const batch = batches[i] ?? { rows: [] };
      i += 1;
      return batch;
    },
  } as unknown as pg.Pool;
  return { pool, calls };
}

function sampleRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    namespace: "alice",
    scope: {},
    source_kind: "git",
    external_id: "https://example.test/repo.git",
    title: null,
    approval_state: "pending",
    approved_by: null,
    approved_at: null,
    lifecycle_state: "active",
    sync_state: "never_synced",
    language: null,
    config: {},
    content_hash: null,
    last_synced_at: null,
    revision: 1,
    created_by: "alice",
    created_at: new Date("2026-07-22T00:00:00Z"),
    updated_at: new Date("2026-07-22T00:00:00Z"),
    ...overrides,
  };
}

const agentAuth: AuthInfo = {
  role: "agent",
  clientId: "alice",
  namespaceSource: "token",
};
const adminAuth: AuthInfo = {
  role: "admin",
  clientId: "admin-client",
  namespaceSource: "token",
};
const headerAdminAuth: AuthInfo = {
  role: "admin",
  clientId: "alice",
  namespaceSource: "header",
};

describe("source-registry schemas", () => {
  it("rejects unknown keys and empty external ids", () => {
    expect(
      registerSourceInputSchema.safeParse({
        source_kind: "git",
        external_id: "  ",
      }).success,
    ).toBe(false);
    expect(
      registerSourceInputSchema.safeParse({
        source_kind: "git",
        external_id: "x",
        surprise: true,
      }).success,
    ).toBe(false);
  });

  it("requires an expected_revision on update", () => {
    expect(
      updateSourceInputSchema.safeParse({
        id: "11111111-1111-1111-1111-111111111111",
        title: "x",
      }).success,
    ).toBe(false);
  });

  it("rejects an arbitrary content_hash and accepts only a sha256 hex digest", () => {
    const base = {
      // A schema-valid v4 UUID (the fixture UUID used elsewhere is only ever
      // passed to updateSource(), which does not re-parse the schema).
      id: "11111111-1111-4111-8111-111111111111",
      expected_revision: 1,
    };
    // A caller cannot assert an arbitrary opaque string as an extracted hash.
    expect(
      updateSourceInputSchema.safeParse({
        ...base,
        content_hash: "totally-made-up-hash",
      }).success,
    ).toBe(false);
    // Uppercase / wrong length are also rejected.
    expect(
      updateSourceInputSchema.safeParse({ ...base, content_hash: "ABC" })
        .success,
    ).toBe(false);
    // The exact shape hashSourceContent() emits is accepted.
    const real = hashSourceContent("some observed content").content_hash;
    expect(
      updateSourceInputSchema.safeParse({ ...base, content_hash: real })
        .success,
    ).toBe(true);
    // null (clearing the hash) stays allowed.
    expect(
      updateSourceInputSchema.safeParse({ ...base, content_hash: null })
        .success,
    ).toBe(true);
  });
});

describe("registerSource authorization", () => {
  it("writes into the caller's own namespace and stays pending by default", async () => {
    const { pool, calls } = fakePool([{ rows: [sampleRow()] }]);
    const res = await registerSource(pool, agentAuth, {
      source_kind: "git",
      external_id: "https://example.test/repo.git",
    });
    expect(res.ok).toBe(true);
    expect(res.data?.approval_state).toBe("pending");
    // namespace param ($1) is the caller's own namespace; created_by (last
    // param) is bound to the acting clientId, which equals the namespace only
    // because this is a same-namespace agent.
    expect(calls[0]!.params[0]).toBe("alice");
    expect(calls[0]!.params[calls[0]!.params.length - 1]).toBe("alice");
    expect(calls[0]!.sql).toContain(SOURCE_REGISTRY_TABLE);
  });

  it("does NOT approve on a caller-supplied approved=true from an unauthorized role", async () => {
    const { pool, calls } = fakePool([{ rows: [sampleRow()] }]);
    const res = await registerSource(pool, agentAuth, {
      source_kind: "git",
      external_id: "https://example.test/repo.git",
      approved: true,
    });
    expect(res.ok).toBe(false);
    expect(res.code).toBe("approval_denied");
    // Rejected BEFORE any INSERT: no query ran.
    expect(calls.length).toBe(0);
  });

  it("approves for an admin token identity", async () => {
    const approvedRow = sampleRow({
      approval_state: "approved",
      approved_by: "admin-client",
    });
    const { pool, calls } = fakePool([{ rows: [approvedRow] }]);
    const res = await registerSource(pool, adminAuth, {
      source_kind: "git",
      external_id: "https://example.test/repo.git",
      approved: true,
    });
    expect(res.ok).toBe(true);
    expect(res.data?.approval_state).toBe("approved");
    // approved_by param carries the granting identity.
    expect(calls[0]!.params).toContain("admin-client");
  });

  it("does NOT approve for a header-delegated admin session", async () => {
    const { pool, calls } = fakePool([{ rows: [sampleRow()] }]);
    const res = await registerSource(pool, headerAdminAuth, {
      source_kind: "git",
      external_id: "https://example.test/repo.git",
      approved: true,
    });
    expect(res.ok).toBe(false);
    expect(res.code).toBe("approval_denied");
    expect(calls.length).toBe(0);
  });

  it("maps a divergent unique-violation into a conflict result", async () => {
    // INSERT throws 23505; the follow-up existence SELECT returns a row whose
    // title differs from the caller's request -> genuine conflict.
    let call = 0;
    const pool = {
      query: async () => {
        call += 1;
        if (call === 1) {
          throw Object.assign(new Error("dup"), { code: "23505" });
        }
        return { rows: [sampleRow({ title: "stored title" })] };
      },
    } as unknown as pg.Pool;
    const res = await registerSource(pool, agentAuth, {
      source_kind: "git",
      external_id: "https://example.test/repo.git",
      title: "different title",
    });
    expect(res.ok).toBe(false);
    expect(res.code).toBe("conflict");
  });

  it("is idempotent when an identical registration collides", async () => {
    // INSERT throws 23505; the follow-up SELECT returns the semantically
    // identical stored row -> ok, returning that row unchanged.
    let call = 0;
    const stored = sampleRow({ title: "chat log" });
    const pool = {
      query: async () => {
        call += 1;
        if (call === 1) {
          throw Object.assign(new Error("dup"), { code: "23505" });
        }
        return { rows: [stored] };
      },
    } as unknown as pg.Pool;
    const res = await registerSource(pool, agentAuth, {
      source_kind: "git",
      external_id: "https://example.test/repo.git",
      title: "chat log",
    });
    expect(res.ok).toBe(true);
    expect(res.data?.id).toBe(stored.id);
  });

  it("authorizes a bare global admin to target another namespace", async () => {
    // No fabricated identity: admin's clientId stays 'admin-client'; the write
    // lands in 'beta' purely because target_namespace was requested and
    // canWriteNamespace authorizes the global admin.
    const { pool, calls } = fakePool([
      { rows: [sampleRow({ namespace: "beta", created_by: "admin-client" })] },
    ]);
    const res = await registerSource(pool, adminAuth, {
      source_kind: "git",
      external_id: "https://example.test/repo.git",
      target_namespace: "beta",
    });
    expect(res.ok).toBe(true);
    // INSERT namespace param ($1) is the requested target, not the clientId.
    expect(calls[0]!.params[0]).toBe("beta");
  });

  it("attributes created_by to the real actor, not the target namespace", async () => {
    // Regression for the created_by defect: a global admin registering INTO
    // 'beta' must be attributed to its own clientId ('admin-client'), never to
    // 'beta'. The old INSERT reused $1 (namespace) for created_by, falsely
    // attributing the row to the target namespace.
    const { pool, calls } = fakePool([
      { rows: [sampleRow({ namespace: "beta", created_by: "admin-client" })] },
    ]);
    const res = await registerSource(pool, adminAuth, {
      source_kind: "git",
      external_id: "https://example.test/repo.git",
      target_namespace: "beta",
    });
    expect(res.ok).toBe(true);
    const params = calls[0]!.params;
    // namespace param is the target...
    expect(params[0]).toBe("beta");
    // ...but created_by (last INSERT param) is the acting identity, distinct
    // from the target namespace. A bare $1 reuse would make this "beta".
    expect(params[params.length - 1]).toBe("admin-client");
    expect(params[params.length - 1]).not.toBe("beta");
    // The INSERT binds created_by to its own placeholder ($10), not a reuse of
    // the namespace placeholder ($1).
    expect(calls[0]!.sql).toContain("$10)");
    expect(res.data?.created_by).toBe("admin-client");
  });

  it("rejects a header-scoped identity that requests a foreign target", async () => {
    // canWriteNamespace binds a header identity to its own namespace; a foreign
    // target_namespace is denied before any query runs.
    const { pool, calls } = fakePool([]);
    const res = await registerSource(pool, headerAdminAuth, {
      source_kind: "git",
      external_id: "https://example.test/repo.git",
      target_namespace: "beta",
    });
    expect(res.ok).toBe(false);
    expect(res.code).toBe("namespace_denied");
    expect(calls.length).toBe(0);
  });
});

describe("updateSource revision + namespace binding", () => {
  it("guards on id + namespace + revision in the UPDATE WHERE clause", async () => {
    const { pool, calls } = fakePool([{ rows: [sampleRow({ revision: 2 })] }]);
    const res = await updateSource(pool, agentAuth, {
      id: "11111111-1111-1111-1111-111111111111",
      expected_revision: 1,
      title: "renamed",
    });
    expect(res.ok).toBe(true);
    const sql = calls[0]!.sql;
    expect(sql).toContain("id = $1 AND namespace = $2 AND revision = $3");
    expect(sql).toContain("revision = revision + 1");
    expect(calls[0]!.params.slice(0, 3)).toEqual([
      "11111111-1111-1111-1111-111111111111",
      "alice",
      1,
    ]);
  });

  it("distinguishes stale_revision from not_found", async () => {
    // First UPDATE returns 0 rows; existence probe finds the row -> stale.
    const stale = fakePool([{ rows: [] }, { rows: [{ revision: 5 }] }]);
    const staleRes = await updateSource(stale.pool, agentAuth, {
      id: "11111111-1111-1111-1111-111111111111",
      expected_revision: 1,
      title: "x",
    });
    expect(staleRes.code).toBe("stale_revision");
    // Existence probe is also namespace-qualified.
    expect(stale.calls[1]!.sql).toContain("namespace = $2");

    // First UPDATE returns 0 rows; existence probe empty -> not_found.
    const missing = fakePool([{ rows: [] }, { rows: [] }]);
    const missingRes = await updateSource(missing.pool, agentAuth, {
      id: "11111111-1111-1111-1111-111111111111",
      expected_revision: 1,
      title: "x",
    });
    expect(missingRes.code).toBe("not_found");
  });

  it("refuses a self-approval from an unauthorized role", async () => {
    const { pool, calls } = fakePool([]);
    const res = await updateSource(pool, agentAuth, {
      id: "11111111-1111-1111-1111-111111111111",
      expected_revision: 1,
      approval_state: "approved",
    });
    expect(res.ok).toBe(false);
    expect(res.code).toBe("approval_denied");
    expect(calls.length).toBe(0);
  });

  it("lets a bare global admin approve a requested foreign namespace", async () => {
    const { pool, calls } = fakePool([
      { rows: [sampleRow({ namespace: "beta", approval_state: "approved" })] },
    ]);
    const res = await updateSource(pool, adminAuth, {
      id: "11111111-1111-1111-1111-111111111111",
      expected_revision: 1,
      target_namespace: "beta",
      approval_state: "approved",
    });
    expect(res.ok).toBe(true);
    // WHERE namespace param ($2) is the requested target, not the clientId.
    expect(calls[0]!.params[1]).toBe("beta");
    // approved_by is the admin's real identity, never the target namespace.
    expect(calls[0]!.params).toContain("admin-client");
  });

  it("rejects a header identity approving a foreign namespace before any query", async () => {
    const { pool, calls } = fakePool([]);
    const res = await updateSource(pool, headerAdminAuth, {
      id: "11111111-1111-1111-1111-111111111111",
      expected_revision: 1,
      target_namespace: "beta",
      title: "x",
    });
    expect(res.ok).toBe(false);
    expect(res.code).toBe("namespace_denied");
    expect(calls.length).toBe(0);
  });
});

describe("hashSourceContent envelope", () => {
  it("is deterministic and content-free for identical input", () => {
    const a = hashSourceContent("hello world");
    const b = hashSourceContent("hello world");
    expect(a).toEqual(b);
    expect(a.hash_version).toBe(SOURCE_CONTENT_HASH_VERSION);
    expect(a.byte_length).toBe(11);
    // A hex sha256 digest; the envelope never carries the content itself.
    expect(a.content_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(a)).not.toContain("hello world");
  });

  it("differs for different content and matches string/bytes encodings", () => {
    expect(hashSourceContent("a").content_hash).not.toBe(
      hashSourceContent("b").content_hash,
    );
    const bytes = new TextEncoder().encode("some source text");
    expect(hashSourceContent("some source text").content_hash).toBe(
      hashSourceContent(bytes).content_hash,
    );
  });
});

describe("removeSource", () => {
  it("soft-retires within the caller namespace", async () => {
    const { pool, calls } = fakePool([
      { rows: [{ id: "11111111-1111-1111-1111-111111111111" }] },
    ]);
    const res = await removeSource(
      pool,
      agentAuth,
      "11111111-1111-1111-1111-111111111111",
    );
    expect(res.ok).toBe(true);
    expect(calls[0]!.sql).toContain("lifecycle_state = 'retired'");
    expect(calls[0]!.sql).toContain("id = $1 AND namespace = $2");
    expect(calls[0]!.params).toEqual([
      "11111111-1111-1111-1111-111111111111",
      "alice",
    ]);
  });
});

describe("listSources read isolation", () => {
  it("constrains a non-admin read to readable namespaces", async () => {
    const { pool, calls } = fakePool([{ rows: [] }]);
    await listSources(pool, agentAuth, {});
    expect(calls[0]!.sql).toContain("namespace = ANY($1::text[])");
    expect(calls[0]!.params[0]).toContain("alice");
  });

  it("does not add a namespace predicate for an unconstrained admin read", async () => {
    const { pool, calls } = fakePool([{ rows: [] }]);
    await listSources(pool, adminAuth, {});
    expect(calls[0]!.sql).not.toContain("namespace = ANY");
  });
});

describe("resolveIngestionEligibility", () => {
  it("rejects an unregistered source for this namespace", async () => {
    const { pool, calls } = fakePool([{ rows: [] }]);
    const res = await resolveIngestionEligibility(pool, agentAuth, {
      source_kind: "git",
      external_id: "https://example.test/repo.git",
    });
    expect(res.ok).toBe(false);
    expect(res.code).toBe("not_found");
    expect(calls[0]!.params[0]).toBe("alice");
  });

  it("rejects a registered-but-unapproved source", async () => {
    const { pool } = fakePool([
      { rows: [sampleRow({ approval_state: "pending" })] },
    ]);
    const res = await resolveIngestionEligibility(pool, agentAuth, {
      source_kind: "git",
      external_id: "https://example.test/repo.git",
    });
    expect(res.ok).toBe(false);
    expect(res.code).toBe("approval_denied");
  });

  it("accepts an approved active source", async () => {
    const { pool } = fakePool([
      { rows: [sampleRow({ approval_state: "approved" })] },
    ]);
    const res = await resolveIngestionEligibility(pool, agentAuth, {
      source_kind: "git",
      external_id: "https://example.test/repo.git",
    });
    expect(res.ok).toBe(true);
    expect(res.data?.approval_state).toBe("approved");
  });
});
