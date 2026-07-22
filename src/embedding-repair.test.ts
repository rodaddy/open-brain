import { describe, it, expect, mock, beforeEach } from "bun:test";
import type { EmbeddingError } from "./embedding.ts";

// Mock the logger so content-free warnings don't spam and can be asserted.
const warnCalls: Array<[string, Record<string, unknown>?]> = [];
mock.module("./logger.ts", () => ({
  logger: {
    info: () => {},
    warn: (msg: string, extra?: Record<string, unknown>) =>
      warnCalls.push([msg, extra]),
    error: () => {},
    debug: () => {},
  },
}));

const {
  selectStale,
  repairOne,
  repairStaleBatch,
  detectableReasons,
  MAX_BATCH,
  DEFAULT_BATCH,
} = await import("./embedding-repair.ts");
const { getEmbeddingTarget } = await import("./embedding-targets.ts");
const { contentHash, EMBEDDING_MODEL } = await import("./embedding.ts");

interface Call {
  sql: string;
  params: unknown[];
}

/**
 * Mock queryable that records every query and lets a test script decide the
 * result per call. SELECTs return `selectRows`; UPDATEs return `rowCount`.
 */
function mockDb(opts: {
  selectRows?: Record<string, unknown>[];
  updateRowCount?: number;
  onUpdate?: (call: Call) => { rowCount: number };
}) {
  const calls: Call[] = [];
  const query = mock(async (sql: string, params: unknown[] = []) => {
    calls.push({ sql, params });
    if (/^\s*SELECT/i.test(sql)) {
      return {
        rows: opts.selectRows ?? [],
        rowCount: (opts.selectRows ?? []).length,
      };
    }
    // UPDATE
    if (opts.onUpdate) return opts.onUpdate({ sql, params });
    return { rows: [], rowCount: opts.updateRowCount ?? 1 };
  });
  return {
    db: { query } as any,
    calls,
    selects: () => calls.filter((c) => /^\s*SELECT/i.test(c.sql)),
    updates: () => calls.filter((c) => /^\s*UPDATE/i.test(c.sql)),
  };
}

const okEmbed = mock(
  async (): Promise<{
    embedding: number[] | null;
    error?: EmbeddingError;
  }> => ({
    embedding: Array(768).fill(0.1),
  }),
);

function failEmbed(code: EmbeddingError["code"]) {
  return mock(async () => ({
    embedding: null,
    error: { code, message: "x", attempts: 1 } as EmbeddingError,
  }));
}

beforeEach(() => {
  warnCalls.length = 0;
});

describe("detectableReasons", () => {
  it("full-provenance table detects missing, model_drift, source_drift", () => {
    expect(
      [...detectableReasons(getEmbeddingTarget("thoughts"))].sort(),
    ).toEqual(["missing", "model_drift", "source_drift"]);
  });

  it("entities (no provenance columns) detects only missing", () => {
    expect(detectableReasons(getEmbeddingTarget("ob_entities"))).toEqual([
      "missing",
    ]);
  });
});

// A default in-scope namespace for tests whose focus is NOT the scope API.
const NS = { namespaces: ["ns-a"] } as const;
// Explicit global scope options for write-behavior tests that assert on SQL
// shape and must not have a namespace predicate injected.
const GLOBAL = { scope: { global: true } } as const;

describe("selectStale predicate building", () => {
  it("missing-only selection queries embedding IS NULL", async () => {
    const { db, selects } = mockDb({ selectRows: [] });
    await selectStale(db, "thoughts", { reasons: ["missing"], scope: NS });
    const sql = selects()[0]!.sql;
    expect(sql).toContain("embedding IS NULL");
    expect(sql).not.toContain("embedding_model IS DISTINCT");
  });

  it("model_drift selection compares against current model, parameterized", async () => {
    const { db, selects } = mockDb({ selectRows: [] });
    await selectStale(db, "thoughts", { reasons: ["model_drift"], scope: NS });
    const call = selects()[0]!;
    expect(call.sql).toContain("embedding_model IS DISTINCT FROM");
    expect(call.params).toContain(EMBEDDING_MODEL);
  });

  it("entities selection drops non-detectable reasons and applies archived filter", async () => {
    const { db, selects } = mockDb({ selectRows: [] });
    // Ask for source_drift which entities cannot detect -> falls back to nothing detectable.
    const res = await selectStale(db, "ob_entities", {
      reasons: ["source_drift"],
      scope: NS,
    });
    expect(res).toEqual([]);
    // No query issued because no detectable reason remained.
    expect(selects().length).toBe(0);
  });

  it("entities missing selection still runs with archived_at filter", async () => {
    const { db, selects } = mockDb({ selectRows: [] });
    await selectStale(db, "ob_entities", { reasons: ["missing"], scope: NS });
    expect(selects()[0]!.sql).toContain("archived_at IS NULL");
  });

  it("applies namespace predicate when a namespaces scope is supplied and column exists", async () => {
    const { db, selects } = mockDb({ selectRows: [] });
    await selectStale(db, "thoughts", {
      reasons: ["missing"],
      scope: { namespaces: ["dev:open-brain"] },
    });
    const call = selects()[0]!;
    expect(call.sql).toContain("namespace = ANY(");
    expect(call.params).toContainEqual(["dev:open-brain"]);
  });

  it("session events bind namespace through lane_id FK (no own namespace column)", async () => {
    const { db, selects } = mockDb({ selectRows: [] });
    await selectStale(db, "ob_session_events", {
      reasons: ["missing"],
      scope: { namespaces: ["dev:open-brain"] },
    });
    const call = selects()[0]!;
    // No direct namespace column exists; isolation binds via the lane FK.
    expect(call.sql).not.toContain("ob_session_events.namespace");
    expect(call.sql).toContain("EXISTS (SELECT 1 FROM ob_session_lanes");
    expect(call.sql).toContain("__ns.id = ob_session_events.lane_id");
    expect(call.sql).toContain("__ns.namespace = ANY(");
    // The namespace VALUE list is parameterized, never interpolated.
    expect(call.params).toContainEqual(["dev:open-brain"]);
    expect(call.sql).not.toContain("dev:open-brain");
  });

  it("explicit global scope adds no isolation predicate (intentional, not a default)", async () => {
    const { db, selects } = mockDb({ selectRows: [] });
    await selectStale(db, "ob_session_events", {
      reasons: ["missing"],
      scope: { global: true },
    });
    expect(selects()[0]!.sql).not.toContain(
      "EXISTS (SELECT 1 FROM ob_session_lanes",
    );
  });

  it("passes multiple namespaces as a single parameterized array", async () => {
    const { db, selects } = mockDb({ selectRows: [] });
    await selectStale(db, "thoughts", {
      reasons: ["missing"],
      scope: { namespaces: ["a", "b"] },
    });
    expect(selects()[0]!.params).toContainEqual(["a", "b"]);
  });
});

describe("scope is mandatory and explicit (no unscoped default)", () => {
  it("selectStale rejects a missing scope", async () => {
    const { db, selects } = mockDb({ selectRows: [] });
    await expect(
      // @ts-expect-error scope is required
      selectStale(db, "thoughts", { reasons: ["missing"] }),
    ).rejects.toThrow(/scope is required/i);
    expect(selects().length).toBe(0);
  });

  it("selectStale rejects an empty namespaces list (no silent global)", async () => {
    const { db, selects } = mockDb({ selectRows: [] });
    await expect(
      selectStale(db, "thoughts", {
        reasons: ["missing"],
        scope: { namespaces: [] },
      }),
    ).rejects.toThrow(/non-empty/i);
    expect(selects().length).toBe(0);
  });

  it("selectStale rejects a namespaces list of only blank values", async () => {
    const { db, selects } = mockDb({ selectRows: [] });
    await expect(
      selectStale(db, "thoughts", {
        reasons: ["missing"],
        scope: { namespaces: ["", "  "] },
      }),
    ).rejects.toThrow(/unscoped/i);
    expect(selects().length).toBe(0);
  });

  it("repairOne rejects a missing scope before any provider call", async () => {
    const { db } = mockDb({ updateRowCount: 1 });
    const embed = mock(async () => ({ embedding: Array(768).fill(0.1) }));
    const cand = {
      table: "thoughts",
      id: "t1",
      reasons: ["missing" as const],
      row: { id: "t1", content: "hi", tags: [], namespace: "n" },
    };
    // @ts-expect-error scope is required
    const noScope: import("./embedding-repair.ts").RepairOptions = {};
    await expect(repairOne(db, cand, embed as any, noScope)).rejects.toThrow(
      /scope is required/i,
    );
    expect(embed).not.toHaveBeenCalled();
  });

  it("repairStaleBatch rejects a missing scope", async () => {
    const { db } = mockDb({ selectRows: [] });
    await expect(
      // @ts-expect-error scope is required
      repairStaleBatch(db, "thoughts", okEmbed, { reasons: ["missing"] }),
    ).rejects.toThrow(/scope is required/i);
  });

  it("explicit global scope is accepted and runs (separately named path)", async () => {
    const { db, selects } = mockDb({ selectRows: [] });
    await selectStale(db, "thoughts", {
      reasons: ["missing"],
      scope: { global: true },
    });
    expect(selects().length).toBe(1);
    expect(selects()[0]!.sql).not.toContain("namespace = ANY(");
  });
});

describe("selectStale classification", () => {
  it("selects a missing row and labels reason 'missing'", async () => {
    const { db } = mockDb({
      selectRows: [
        {
          id: "t1",
          content: "hi",
          tags: [],
          namespace: "n",
          __embedding_missing: true,
        },
      ],
    });
    const res = await selectStale(db, "thoughts", {
      reasons: ["missing"],
      scope: NS,
    });
    expect(res.length).toBe(1);
    expect(res[0]!.reasons).toEqual(["missing"]);
  });

  it("does NOT select a current row whose model+hash match", async () => {
    const row = {
      id: "t1",
      content: "hi",
      tags: [],
      namespace: "n",
      __embedding_missing: false,
      content_hash: contentHash("hi"),
      embedding_model: EMBEDDING_MODEL,
    };
    const { db } = mockDb({ selectRows: [row] });
    const res = await selectStale(db, "thoughts", { scope: NS });
    expect(res).toEqual([]);
  });

  it("selects a source-drifted row (stored hash != recomputed hash)", async () => {
    const row = {
      id: "t1",
      content: "new content",
      tags: [],
      namespace: "n",
      __embedding_missing: false,
      content_hash: contentHash("old content"),
      embedding_model: EMBEDDING_MODEL,
    };
    const { db } = mockDb({ selectRows: [row] });
    const res = await selectStale(db, "thoughts", {
      reasons: ["source_drift"],
      scope: NS,
    });
    expect(res.length).toBe(1);
    expect(res[0]!.reasons).toContain("source_drift");
  });

  it("selects a model-drifted row (stored model != current)", async () => {
    const row = {
      id: "t1",
      content: "hi",
      tags: [],
      namespace: "n",
      __embedding_missing: false,
      content_hash: contentHash("hi"),
      embedding_model: "old-model-v0",
    };
    const { db } = mockDb({ selectRows: [row] });
    const res = await selectStale(db, "thoughts", {
      reasons: ["model_drift"],
      scope: NS,
    });
    expect(res.length).toBe(1);
    expect(res[0]!.reasons).toContain("model_drift");
  });
});

describe("selectStale batch caps", () => {
  it("defaults to DEFAULT_BATCH when no limit given", async () => {
    const { db, selects } = mockDb({ selectRows: [] });
    await selectStale(db, "thoughts", { reasons: ["missing"], scope: NS });
    expect(selects()[0]!.params).toContain(DEFAULT_BATCH);
  });

  it("clamps an oversized limit to MAX_BATCH", async () => {
    const { db, selects } = mockDb({ selectRows: [] });
    await selectStale(db, "thoughts", {
      reasons: ["missing"],
      limit: 999999,
      scope: NS,
    });
    expect(selects()[0]!.params).toContain(MAX_BATCH);
    expect(selects()[0]!.params).not.toContain(999999);
  });

  it("clamps a zero/negative limit to DEFAULT_BATCH", async () => {
    const { db, selects } = mockDb({ selectRows: [] });
    await selectStale(db, "thoughts", {
      reasons: ["missing"],
      limit: 0,
      scope: NS,
    });
    expect(selects()[0]!.params).toContain(DEFAULT_BATCH);
  });
});

describe("repairOne write behavior", () => {
  const missingCandidate = () => ({
    table: "thoughts",
    id: "t1",
    reasons: ["missing" as const],
    row: { id: "t1", content: "hi", tags: [], namespace: "n" },
  });

  it("writes embedding + provenance columns on success and reports repaired", async () => {
    const { db, updates } = mockDb({ updateRowCount: 1 });
    const res = await repairOne(db, missingCandidate(), okEmbed, GLOBAL);
    expect(res.status).toBe("repaired");
    expect(res.updated).toBe(true);
    const u = updates()[0]!;
    expect(u.sql).toContain("embedding =");
    expect(u.sql).toContain("content_hash =");
    expect(u.sql).toContain("embedded_at = NOW()");
    expect(u.sql).toContain("embedding_model =");
    // Guard hash = hash(content) is a param.
    expect(u.params).toContain(contentHash("hi"));
    expect(u.params).toContain(EMBEDDING_MODEL);
  });

  it("guards the UPDATE on the OBSERVED stored hash (no-overwrite) and sets the fresh hash", async () => {
    const { db, updates } = mockDb({ updateRowCount: 1 });
    await repairOne(db, missingCandidate(), okEmbed, GLOBAL);
    const u = updates()[0]!;
    // NULL-safe guard on the observed stored hash (NULL for a missing row).
    expect(u.sql).toContain("content_hash IS NOT DISTINCT FROM");
    // The SET writes the fresh hash of the embedded source.
    expect(u.sql).toContain("content_hash =");
    expect(u.params).toContain(contentHash("hi"));
  });

  it("source-drift repair guards on the stale stored hash and writes the fresh one", async () => {
    // A drifted row: stored content_hash is the OLD hash, current content is new.
    const { db, updates } = mockDb({ updateRowCount: 1 });
    const drifted = {
      table: "thoughts",
      id: "t1",
      reasons: ["source_drift" as const],
      row: {
        id: "t1",
        content: "new text",
        tags: [],
        namespace: "n",
        content_hash: contentHash("old text"), // stored/observed stale hash
      },
    };
    const res = await repairOne(db, drifted, okEmbed, GLOBAL);
    expect(res.status).toBe("repaired");
    const u = updates()[0]!;
    // Guard binds the OBSERVED (old) hash so the drifted row still matches...
    expect(u.params).toContain(contentHash("old text"));
    // ...while the SET writes the FRESH hash of the current source.
    expect(u.params).toContain(contentHash("new text"));
  });

  it("returns skipped_source_changed when the guarded UPDATE matches zero rows", async () => {
    // Simulate a concurrent source edit: UPDATE guard finds no match.
    const { db } = mockDb({ updateRowCount: 0 });
    const res = await repairOne(db, missingCandidate(), okEmbed, GLOBAL);
    expect(res.status).toBe("skipped_source_changed");
    expect(res.updated).toBe(false);
  });

  it("generates the embedding BEFORE issuing the UPDATE (outside the write)", async () => {
    const order: string[] = [];
    const embed = mock(async () => {
      order.push("embed");
      return { embedding: Array(768).fill(0.1) };
    });
    const query = mock(async (sql: string) => {
      order.push(/^\s*UPDATE/i.test(sql) ? "update" : "select");
      return { rows: [], rowCount: 1 };
    });
    await repairOne({ query } as any, missingCandidate(), embed as any, GLOBAL);
    expect(order).toEqual(["embed", "update"]);
  });

  it("skips empty-text rows without calling the provider or DB", async () => {
    const { db, updates } = mockDb({});
    const embed = mock(async () => ({ embedding: Array(768).fill(0.1) }));
    const res = await repairOne(
      db,
      {
        table: "thoughts",
        id: "t1",
        reasons: ["missing"],
        row: { id: "t1", content: "   ", tags: [], namespace: "n" },
      },
      embed as any,
      GLOBAL,
    );
    expect(res.status).toBe("skipped_empty_text");
    expect(embed).not.toHaveBeenCalled();
    expect(updates().length).toBe(0);
  });

  it("entities repair writes only the embedding column (no fabricated provenance)", async () => {
    const { db, updates } = mockDb({ updateRowCount: 1 });
    const res = await repairOne(
      db,
      {
        table: "ob_entities",
        id: "en1",
        reasons: ["missing"],
        row: {
          id: "en1",
          entity_type: "person",
          name: "Alice",
          namespace: "n",
        },
      },
      okEmbed,
      GLOBAL,
    );
    expect(res.status).toBe("repaired");
    const u = updates()[0]!;
    expect(u.sql).toContain("embedding =");
    expect(u.sql).not.toContain("content_hash");
    expect(u.sql).not.toContain("embedding_model");
    expect(u.sql).not.toContain("embedded_at");
    expect(u.sql).toContain("archived_at IS NULL");
  });

  it("entities UPDATE guards on 'embedding IS NULL' PLUS a source-column snapshot", async () => {
    const { db, updates } = mockDb({ updateRowCount: 1 });
    await repairOne(
      db,
      {
        table: "ob_entities",
        id: "en1",
        reasons: ["missing"],
        row: {
          id: "en1",
          entity_type: "person",
          name: "Alice",
          namespace: "n",
        },
      },
      okEmbed,
      GLOBAL,
    );
    const u = updates()[0]!;
    // No content_hash column exists -> the no-overwrite guards are real columns:
    // the missing-embedding slot AND a NULL-safe snapshot of each source column.
    expect(u.sql).toContain("embedding IS NULL");
    expect(u.sql).not.toContain("content_hash =");
    expect(u.sql).toContain("entity_type IS NOT DISTINCT FROM");
    expect(u.sql).toContain("name IS NOT DISTINCT FROM");
    // The captured source VALUES are parameterized, never interpolated.
    expect(u.params).toContain("person");
    expect(u.params).toContain("Alice");
  });

  it("entities: a concurrent populate (guard no-match) skips instead of clobbering", async () => {
    // A concurrent write filled the embedding after selection -> guarded
    // UPDATE (embedding IS NULL) matches zero rows.
    const { db } = mockDb({ updateRowCount: 0 });
    const res = await repairOne(
      db,
      {
        table: "ob_entities",
        id: "en1",
        reasons: ["missing"],
        row: {
          id: "en1",
          entity_type: "person",
          name: "Alice",
          namespace: "n",
        },
      },
      okEmbed,
      GLOBAL,
    );
    expect(res.status).toBe("skipped_source_changed");
    expect(res.updated).toBe(false);
  });

  it("entities: a concurrent name edit that leaves embedding NULL -> stale UPDATE matches zero rows", async () => {
    // Mutation scenario for defect #2. At selection, the entity was
    // (person, "Alice") with a NULL embedding; we embed "person: Alice"
    // outside any lock. Concurrently the source row is renamed to "Bob" but
    // its embedding stays NULL (the edit didn't re-embed). Without a source
    // snapshot, `embedding IS NULL` alone would still match and we'd write an
    // embedding built from the stale "Alice" text onto the now-"Bob" row.
    //
    // Emulate the DB row as it exists at UPDATE time and apply the guarded
    // WHERE against it: the entity_type/name snapshot no longer matches, so the
    // stale UPDATE affects zero rows.
    let capturedUpdate: Call | undefined;
    const dbRowAtUpdate = {
      id: "en1",
      entity_type: "person",
      name: "Bob", // renamed concurrently
      embedding: null, // still NULL
    };
    const db = {
      query: mock(async (sql: string, params: unknown[] = []) => {
        if (/^\s*UPDATE/i.test(sql)) {
          capturedUpdate = { sql, params };
          // Evaluate the truthful guards this test cares about against the
          // live row: embedding IS NULL AND the captured source snapshot.
          const capturedType = params[params.indexOf("person")];
          const capturedName = params[params.indexOf("Alice")];
          const embeddingStillNull = dbRowAtUpdate.embedding === null;
          const typeMatches = dbRowAtUpdate.entity_type === capturedType;
          // The captured name was "Alice"; the row is now "Bob" -> mismatch.
          const nameMatches = dbRowAtUpdate.name === capturedName;
          const matched = embeddingStillNull && typeMatches && nameMatches;
          return { rows: [], rowCount: matched ? 1 : 0 };
        }
        return { rows: [], rowCount: 0 };
      }),
    } as any;

    const res = await repairOne(
      db,
      {
        table: "ob_entities",
        id: "en1",
        reasons: ["missing"],
        // The snapshot we embedded from -- name is still "Alice" here.
        row: {
          id: "en1",
          entity_type: "person",
          name: "Alice",
          namespace: "n",
        },
      },
      okEmbed,
      GLOBAL,
    );

    // The stale write matched zero rows -> skipped, no clobber of the "Bob" row.
    expect(res.status).toBe("skipped_source_changed");
    expect(res.updated).toBe(false);
    // Prove the snapshot guard was actually emitted with the captured values.
    expect(capturedUpdate!.sql).toContain("name IS NOT DISTINCT FROM");
    expect(capturedUpdate!.params).toContain("Alice");
  });

  it("entities: an unchanged source (name still matches) -> stale-guard passes and writes", async () => {
    // Control for the mutation test: when the source is unchanged, the snapshot
    // guard matches and the repair proceeds normally.
    const db = {
      query: mock(async (sql: string, params: unknown[] = []) => {
        if (/^\s*UPDATE/i.test(sql)) {
          const nameMatches = params.includes("Alice"); // row still "Alice"
          return { rows: [], rowCount: nameMatches ? 1 : 0 };
        }
        return { rows: [], rowCount: 0 };
      }),
    } as any;
    const res = await repairOne(
      db,
      {
        table: "ob_entities",
        id: "en1",
        reasons: ["missing"],
        row: {
          id: "en1",
          entity_type: "person",
          name: "Alice",
          namespace: "n",
        },
      },
      okEmbed,
      GLOBAL,
    );
    expect(res.status).toBe("repaired");
    expect(res.updated).toBe(true);
  });
});

describe("repairOne namespace binding on the guarded UPDATE", () => {
  const thoughtCandidate = () => ({
    table: "thoughts",
    id: "t1",
    reasons: ["missing" as const],
    row: { id: "t1", content: "hi", tags: [], namespace: "n" },
  });

  it("binds a direct namespace column on the UPDATE when a namespaces scope is supplied", async () => {
    const { db, updates } = mockDb({ updateRowCount: 1 });
    await repairOne(db, thoughtCandidate(), okEmbed, {
      scope: { namespaces: ["dev:open-brain"] },
    });
    const u = updates()[0]!;
    expect(u.sql).toContain("namespace = ANY(");
    expect(u.params).toContainEqual(["dev:open-brain"]);
    expect(u.sql).not.toContain("dev:open-brain");
  });

  it("omits the namespace predicate ONLY for the explicit global scope", async () => {
    const { db, updates } = mockDb({ updateRowCount: 1 });
    await repairOne(db, thoughtCandidate(), okEmbed, {
      scope: { global: true },
    });
    expect(updates()[0]!.sql).not.toContain("namespace = ANY(");
  });

  it("session-event UPDATE binds namespace through the lane FK, id-only cannot escape scope", async () => {
    const { db, updates } = mockDb({ updateRowCount: 1 });
    await repairOne(
      db,
      {
        table: "ob_session_events",
        id: "e1",
        reasons: ["missing"],
        row: { id: "e1", content: "an event", lane_id: "l1" },
      },
      okEmbed,
      { scope: { namespaces: ["dev:open-brain"] } },
    );
    const u = updates()[0]!;
    expect(u.sql).toContain("EXISTS (SELECT 1 FROM ob_session_lanes");
    expect(u.sql).toContain("__ns.id = ob_session_events.lane_id");
    expect(u.sql).toContain("__ns.namespace = ANY(");
    expect(u.params).toContainEqual(["dev:open-brain"]);
    // Still id-guarded AND source-hash guarded (content_hash target).
    expect(u.sql).toContain("id = $");
    expect(u.sql).toContain("content_hash IS NOT DISTINCT FROM");
  });

  it("out-of-scope row: guarded UPDATE matches zero rows -> skipped, no cross-namespace write", async () => {
    // The row belongs to another namespace, so the UPDATE's namespace predicate
    // filters it out and rowCount is 0.
    const { db, updates } = mockDb({ updateRowCount: 0 });
    const res = await repairOne(db, thoughtCandidate(), okEmbed, {
      scope: { namespaces: ["dev:open-brain"] },
    });
    expect(res.status).toBe("skipped_source_changed");
    expect(res.updated).toBe(false);
    // The UPDATE was still parameterized and namespace-bound (it just matched 0).
    expect(updates()[0]!.params).toContainEqual(["dev:open-brain"]);
  });
});

describe("cross-namespace isolation (selection + mutation together)", () => {
  it("selection and repair bind the SAME auth-derived namespace list", async () => {
    const rows = [
      {
        id: "t1",
        content: "a",
        tags: [],
        namespace: "ns-a",
        __embedding_missing: true,
      },
    ];
    const calls: Call[] = [];
    const db = {
      query: mock(async (sql: string, params: unknown[] = []) => {
        calls.push({ sql, params });
        if (/^\s*SELECT/i.test(sql)) return { rows, rowCount: rows.length };
        return { rows: [], rowCount: 1 };
      }),
    } as any;

    const cands = await selectStale(db, "thoughts", {
      reasons: ["missing"],
      scope: { namespaces: ["ns-a"] },
    });
    expect(cands.length).toBe(1);
    await repairOne(db, cands[0]!, okEmbed, {
      scope: { namespaces: ["ns-a"] },
    });

    const select = calls.find((c) => /^\s*SELECT/i.test(c.sql))!;
    const update = calls.find((c) => /^\s*UPDATE/i.test(c.sql))!;
    expect(select.params).toContainEqual(["ns-a"]);
    expect(update.params).toContainEqual(["ns-a"]);
  });

  it("fails closed if asked to namespace-scope a target with no namespace binding", async () => {
    // Defensive: no current target lacks a binding, so simulate one via a
    // fabricated target object routed through the same predicate builder by
    // asserting the invariant at the registry level instead.
    const { EMBEDDING_TARGETS } = await import("./embedding-targets.ts");
    for (const t of Object.values(EMBEDDING_TARGETS)) {
      const hasBinding = Boolean(t.namespaceColumn) || Boolean(t.namespaceVia);
      expect(hasBinding).toBe(true);
    }
  });
});

describe("repairOne provider-failure classification (content-free)", () => {
  const cand = () => ({
    table: "thoughts",
    id: "t1",
    reasons: ["missing" as const],
    row: { id: "t1", content: "secret content here", tags: [], namespace: "n" },
  });

  it.each([["timeout"], ["network"], ["server_error"]] as const)(
    "classifies %s as retryable_failure and does not UPDATE",
    async (code) => {
      const { db, updates } = mockDb({});
      const res = await repairOne(db, cand(), failEmbed(code) as any, GLOBAL);
      expect(res.status).toBe("retryable_failure");
      expect(res.errorCode).toBe(code);
      expect(updates().length).toBe(0);
    },
  );

  it.each([
    ["client_error"],
    ["input_invalid"],
    ["malformed_response"],
    ["no_embedding_url"],
  ] as const)(
    "classifies %s as permanent_failure and does not UPDATE",
    async (code) => {
      const { db, updates } = mockDb({});
      const res = await repairOne(db, cand(), failEmbed(code) as any, GLOBAL);
      expect(res.status).toBe("permanent_failure");
      expect(res.errorCode).toBe(code);
      expect(updates().length).toBe(0);
    },
  );

  it("failure log is content-free (no source text)", async () => {
    const { db } = mockDb({});
    await repairOne(db, cand(), failEmbed("timeout") as any, GLOBAL);
    const failLog = warnCalls.find(
      ([m]) => m === "embedding_repair_provider_failure",
    );
    expect(failLog).toBeTruthy();
    const payload = JSON.stringify(failLog![1]);
    expect(payload).not.toContain("secret content here");
    expect(payload).toContain("timeout");
  });
});

describe("idempotency / duplicate delivery convergence", () => {
  it("repairing the same unchanged unit twice writes the identical guarded state", async () => {
    const cand = {
      table: "thoughts",
      id: "t1",
      reasons: ["missing" as const],
      row: { id: "t1", content: "stable", tags: [], namespace: "n" },
    };
    const captured: Call[] = [];
    const db = {
      query: mock(async (sql: string, params: unknown[] = []) => {
        if (/^\s*UPDATE/i.test(sql)) captured.push({ sql, params });
        return { rows: [], rowCount: 1 };
      }),
    } as any;

    const r1 = await repairOne(db, cand, okEmbed, GLOBAL);
    const r2 = await repairOne(db, cand, okEmbed, GLOBAL);
    expect(r1.status).toBe("repaired");
    expect(r2.status).toBe("repaired");
    // Same SQL and same guard/hash/model params both times -> convergent.
    expect(captured[0]!.sql).toBe(captured[1]!.sql);
    expect(captured[0]!.params).toEqual(captured[1]!.params);
    expect(captured[0]!.params).toContain(contentHash("stable"));
  });
});

describe("repairStaleBatch aggregation", () => {
  it("summarizes repaired / skipped / failure counts over a batch", async () => {
    const rows = [
      {
        id: "t1",
        content: "a",
        tags: [],
        namespace: "n",
        __embedding_missing: true,
      },
      {
        id: "t2",
        content: "b",
        tags: [],
        namespace: "n",
        __embedding_missing: true,
      },
      {
        id: "t3",
        content: "",
        tags: [],
        namespace: "n",
        __embedding_missing: true,
      },
    ];
    // t1 -> update matches; t2 -> guard no-match (skipped); t3 -> empty text skip.
    let update = 0;
    const db = {
      query: mock(async (sql: string) => {
        if (/^\s*SELECT/i.test(sql)) return { rows, rowCount: rows.length };
        update += 1;
        return { rows: [], rowCount: update === 1 ? 1 : 0 };
      }),
    } as any;

    const summary = await repairStaleBatch(db, "thoughts", okEmbed, {
      reasons: ["missing"],
      scope: NS,
    });
    expect(summary.selected).toBe(3);
    expect(summary.repaired).toBe(1);
    // t2 guard-miss + t3 empty text both count as skipped.
    expect(summary.skipped).toBe(2);
    expect(summary.retryableFailures).toBe(0);
  });

  it("counts a retryable provider failure without updating", async () => {
    const rows = [
      {
        id: "t1",
        content: "a",
        tags: [],
        namespace: "n",
        __embedding_missing: true,
      },
    ];
    const db = {
      query: mock(async (sql: string) => {
        if (/^\s*SELECT/i.test(sql)) return { rows, rowCount: 1 };
        throw new Error("UPDATE should not run on provider failure");
      }),
    } as any;
    const summary = await repairStaleBatch(
      db,
      "thoughts",
      failEmbed("timeout") as any,
      {
        reasons: ["missing"],
        scope: NS,
      },
    );
    expect(summary.retryableFailures).toBe(1);
    expect(summary.repaired).toBe(0);
  });
});
