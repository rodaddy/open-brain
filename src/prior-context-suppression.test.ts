import { describe, expect, it } from "bun:test";
import {
  canonicalSourceRefKey,
  scopeQueryPredicate,
  suppressPriorContext,
  suppressReferencedRecords,
  type RecallScope,
  type RecalledItem,
} from "./prior-context-suppression.ts";

const scope: RecallScope = {
  namespace: "acme",
  agent: "skippy",
  platform: "discord",
  server_id: "guild-1",
  channel_id: "chan-1",
  thread_id: "thread-1",
  session_key: "sess-1",
};

function item(
  identity: RecalledItem["identity"],
  payload: unknown = { note: "opaque" },
  namespace = scope.namespace,
): RecalledItem {
  return { namespace, identity, payload };
}

describe("prior-context suppression", () => {
  it("suppresses items whose canonical id is in prior context", () => {
    const result = suppressPriorContext({
      scope,
      conceptKeys: ["deploy"],
      recalled: [
        item({ canonical_id: "session_event:1" }),
        item({ canonical_id: "session_event:2" }),
      ],
      priorContext: [{ canonical_id: "session_event:1" }],
    });
    expect(result.items.map((i) => i.identity.canonical_id)).toEqual([
      "session_event:2",
    ]);
    expect(result.suppression).toEqual({
      recalled: 2,
      suppressed: 1,
      net_new: 1,
    });
  });

  it("suppresses across canonical id, citation id, and source ref families", () => {
    const result = suppressPriorContext({
      scope,
      conceptKeys: [],
      recalled: [
        item({ canonical_id: "session_event:1" }),
        item({ citation_id: "session_event:2" }),
        item({ source_ref: "ob_session_events/3" }),
        item({ canonical_id: "session_event:4" }),
      ],
      priorContext: [
        { canonical_id: "session_event:1" },
        { citation_id: "session_event:2" },
        { source_ref: "ob_session_events/3" },
      ],
    });
    expect(result.items.map((i) => i.identity.canonical_id)).toEqual([
      "session_event:4",
    ]);
  });

  it("suppresses an item when ANY of its identity families is known", () => {
    // Item carries canonical_id + source_ref; prior context knows only the ref.
    const result = suppressPriorContext({
      scope,
      conceptKeys: [],
      recalled: [
        item({
          canonical_id: "session_event:9",
          source_ref: "ob_session_events/9",
        }),
      ],
      priorContext: [{ source_ref: "ob_session_events/9" }],
    });
    expect(result.items).toHaveLength(0);
    expect(result.suppression.suppressed).toBe(1);
  });

  it("does not cross-collide different families that share a raw string", () => {
    // A canonical_id string equal to a source_ref string must not suppress.
    const result = suppressPriorContext({
      scope,
      conceptKeys: [],
      recalled: [item({ canonical_id: "shared-string" })],
      priorContext: [{ source_ref: "shared-string" }],
    });
    expect(result.items).toHaveLength(1);
  });

  it("retains unknown relevant items", () => {
    const result = suppressPriorContext({
      scope,
      conceptKeys: ["rollout"],
      recalled: [
        item({ canonical_id: "session_event:10" }),
        item({ canonical_id: "session_event:11" }),
      ],
      priorContext: [{ canonical_id: "session_event:99" }],
    });
    expect(result.items).toHaveLength(2);
    expect(result.suppression.suppressed).toBe(0);
  });

  it("tolerates duplicate prior-context references", () => {
    const result = suppressPriorContext({
      scope,
      conceptKeys: [],
      recalled: [
        item({ canonical_id: "session_event:1" }),
        item({ canonical_id: "session_event:2" }),
      ],
      priorContext: [
        { canonical_id: "session_event:1" },
        { canonical_id: "session_event:1" },
        { canonical_id: "session_event:1" },
      ],
    });
    expect(result.items.map((i) => i.identity.canonical_id)).toEqual([
      "session_event:2",
    ]);
    expect(result.suppression.suppressed).toBe(1);
  });

  it("preserves original relevance order of net-new items", () => {
    const result = suppressPriorContext({
      scope,
      conceptKeys: [],
      recalled: [
        item({ canonical_id: "session_event:5" }),
        item({ canonical_id: "session_event:1" }),
        item({ canonical_id: "session_event:9" }),
        item({ canonical_id: "session_event:3" }),
      ],
      priorContext: [{ canonical_id: "session_event:9" }],
    });
    expect(result.items.map((i) => i.identity.canonical_id)).toEqual([
      "session_event:5",
      "session_event:1",
      "session_event:3",
    ]);
  });

  it("returns empty when nothing is recalled", () => {
    const result = suppressPriorContext({
      scope,
      conceptKeys: [],
      recalled: [],
      priorContext: [{ canonical_id: "session_event:1" }],
    });
    expect(result.items).toEqual([]);
    expect(result.suppression).toEqual({
      recalled: 0,
      suppressed: 0,
      net_new: 0,
    });
  });

  it("returns all items when prior context is empty", () => {
    const result = suppressPriorContext({
      scope,
      conceptKeys: [],
      recalled: [
        item({ canonical_id: "session_event:1" }),
        item({ canonical_id: "session_event:2" }),
      ],
      priorContext: [],
    });
    expect(result.items).toHaveLength(2);
  });

  it("does not read or compare raw payload bodies", () => {
    // Two items with identical payloads but distinct identities both survive;
    // suppression never dedupes by body.
    const body = { text: "the same durable body" };
    const result = suppressPriorContext({
      scope,
      conceptKeys: [],
      recalled: [
        item({ canonical_id: "session_event:1" }, body),
        item({ canonical_id: "session_event:2" }, body),
      ],
      priorContext: [],
    });
    expect(result.items).toHaveLength(2);
  });

  describe("malformed input", () => {
    it("rejects a recalled item with no resolvable identity", () => {
      expect(() =>
        suppressPriorContext({
          scope,
          conceptKeys: [],
          recalled: [item({} as never)],
          priorContext: [],
        }),
      ).toThrow();
    });

    it("rejects a prior-context reference with no resolvable identity", () => {
      expect(() =>
        suppressPriorContext({
          scope,
          conceptKeys: [],
          recalled: [item({ canonical_id: "session_event:1" })],
          priorContext: [{} as never],
        }),
      ).toThrow();
    });

    it("rejects an unknown scope coordinate", () => {
      expect(() =>
        suppressPriorContext({
          scope: { ...scope, extra: "leak" } as never,
          conceptKeys: [],
          recalled: [],
          priorContext: [],
        }),
      ).toThrow();
    });

    it("rejects a scope missing a coordinate", () => {
      const { thread_id: _omit, ...partial } = scope;
      void _omit;
      expect(() =>
        suppressPriorContext({
          scope: partial as never,
          conceptKeys: [],
          recalled: [],
          priorContext: [],
        }),
      ).toThrow();
    });
  });

  describe("namespace / scope isolation", () => {
    it("fails closed on a recalled item from a different namespace", () => {
      expect(() =>
        suppressPriorContext({
          scope,
          conceptKeys: [],
          recalled: [
            item({ canonical_id: "session_event:1" }, {}, "other-tenant"),
          ],
          priorContext: [],
        }),
      ).toThrow(/namespace/);
    });

    it("fails closed even when the cross-namespace item would be suppressed", () => {
      // A malicious/buggy upstream could try to hide a cross-namespace item by
      // making it look like prior context; the namespace check still throws.
      expect(() =>
        suppressPriorContext({
          scope,
          conceptKeys: [],
          recalled: [
            item({ canonical_id: "session_event:1" }, {}, "other-tenant"),
          ],
          priorContext: [{ canonical_id: "session_event:1" }],
        }),
      ).toThrow(/namespace/);
    });

    it("accepts items whose namespace exactly matches the scope namespace", () => {
      const result = suppressPriorContext({
        scope,
        conceptKeys: [],
        recalled: [item({ canonical_id: "session_event:1" })],
        priorContext: [],
      });
      expect(result.items).toHaveLength(1);
      expect(result.scope.namespace).toBe("acme");
    });
  });
});

describe("scope query predicate", () => {
  it("binds all seven coordinates with exact equality and null-safe thread", () => {
    const predicate = scopeQueryPredicate(scope);
    expect(predicate.sql).toBe(
      "namespace = $1" +
        " AND agent = $2" +
        " AND platform = $3" +
        " AND server_id = $4" +
        " AND channel_id = $5" +
        " AND thread_id IS NOT DISTINCT FROM $6::text" +
        " AND session_key = $7",
    );
    expect(predicate.params).toEqual([
      "acme",
      "skippy",
      "discord",
      "guild-1",
      "chan-1",
      "thread-1",
      "sess-1",
    ]);
  });

  it("binds a null thread_id exactly", () => {
    const predicate = scopeQueryPredicate({ ...scope, thread_id: null });
    expect(predicate.params[5]).toBeNull();
  });

  it("supports column aliases and a start param offset", () => {
    const predicate = scopeQueryPredicate(
      scope,
      {
        namespace: "l.namespace",
        platform: "l.source",
        thread_id: "l.thread_id",
      },
      4,
    );
    expect(predicate.sql).toContain("l.namespace = $4");
    expect(predicate.sql).toContain("l.source = $6");
    expect(predicate.sql).toContain(
      "l.thread_id IS NOT DISTINCT FROM $9::text",
    );
    expect(predicate.sql).toContain("session_key = $10");
  });

  it("validates scope before emitting a predicate", () => {
    expect(() =>
      scopeQueryPredicate({ ...scope, namespace: "" } as never),
    ).toThrow();
  });
});

describe("canonicalSourceRefKey", () => {
  // The structural key joins identity coordinates with the UNIT SEPARATOR
  // control char, which a trimmed non-empty field can never contain.
  const SEP = String.fromCharCode(0x1f);

  it("tags string vs structural refs into distinct key families that never collide", () => {
    // A string ref keys verbatim under `s:`; a structural ref reduces to identity
    // coordinates under `o:`, so a bare string and an object never collide.
    expect(canonicalSourceRefKey("ob_session_events/9")).toBe(
      "s:ob_session_events/9",
    );
    expect(
      canonicalSourceRefKey({ source: "brain", type: "decisions", id: "d1" }),
    ).toBe(`o:brain${SEP}decisions${SEP}d1${SEP}`);
  });

  it("ignores display-only fields and key ordering on structural refs", () => {
    const a = canonicalSourceRefKey({
      source: "brain",
      type: "decisions",
      id: "d1",
      namespace: "acme",
      // display-only fields must not affect the key
      label: "a label",
      preview: "a preview",
    } as never);
    const b = canonicalSourceRefKey({
      id: "d1",
      namespace: "acme",
      type: "decisions",
      source: "brain",
    } as never);
    expect(a).toBe(b);
    expect(a).toBe(`o:brain${SEP}decisions${SEP}d1${SEP}acme`);
  });

  it("distinguishes refs that differ only in namespace", () => {
    expect(
      canonicalSourceRefKey({
        source: "brain",
        type: "decisions",
        id: "d1",
        namespace: "acme",
      }),
    ).not.toBe(
      canonicalSourceRefKey({
        source: "brain",
        type: "decisions",
        id: "d1",
        namespace: "other",
      }),
    );
  });
});

describe("suppressReferencedRecords (durable_memory integration)", () => {
  type Row = { citation_id?: string; source_ref?: unknown; note?: string };
  const identify = (row: Row) => ({
    citation_id: row.citation_id,
    source_ref: row.source_ref as never,
  });

  it("suppresses a record whose citation id is in prior context", () => {
    const rows: Row[] = [
      { citation_id: "brain_record:decisions:1" },
      { citation_id: "brain_record:decisions:2" },
    ];
    const result = suppressReferencedRecords(rows, identify, [
      { citation_id: "brain_record:decisions:1" },
    ]);
    expect(result.kept.map((r) => r.citation_id)).toEqual([
      "brain_record:decisions:2",
    ]);
    expect(result.suppression).toEqual({
      recalled: 2,
      suppressed: 1,
      net_new: 1,
    });
  });

  it("suppresses a record by a structural source_ref echoed from prior context", () => {
    const rows: Row[] = [
      {
        citation_id: "brain_record:decisions:1",
        source_ref: { source: "brain", type: "decisions", id: "1" },
      },
      {
        citation_id: "brain_record:decisions:2",
        source_ref: { source: "brain", type: "decisions", id: "2" },
      },
    ];
    // Prior context knows only the structural source_ref of record 1 (with
    // display fields that must be ignored) — it still suppresses.
    const result = suppressReferencedRecords(rows, identify, [
      {
        source_ref: {
          source: "brain",
          type: "decisions",
          id: "1",
          label: "ignored",
        } as never,
      },
    ]);
    expect(result.kept.map((r) => r.citation_id)).toEqual([
      "brain_record:decisions:2",
    ]);
  });

  it("keeps a record with no resolvable identity rather than dropping it", () => {
    const rows: Row[] = [{ note: "no ids" }, { citation_id: "c:2" }];
    const result = suppressReferencedRecords(rows, identify, [
      { citation_id: "c:2" },
    ]);
    // The identity-less record cannot be proven prior context, so it survives;
    // only the referenced one is removed.
    expect(result.kept).toEqual([{ note: "no ids" }]);
    expect(result.suppression.suppressed).toBe(1);
  });

  it("preserves original relevance order of net-new records", () => {
    const rows: Row[] = [
      { citation_id: "c:5" },
      { citation_id: "c:1" },
      { citation_id: "c:9" },
      { citation_id: "c:3" },
    ];
    const result = suppressReferencedRecords(rows, identify, [
      { citation_id: "c:9" },
    ]);
    expect(result.kept.map((r) => r.citation_id)).toEqual([
      "c:5",
      "c:1",
      "c:3",
    ]);
  });

  it("is deterministic and tolerates duplicate prior references", () => {
    const rows: Row[] = [{ citation_id: "c:1" }, { citation_id: "c:2" }];
    const prior = [
      { citation_id: "c:1" },
      { citation_id: "c:1" },
      { citation_id: "c:1" },
    ];
    const a = suppressReferencedRecords(rows, identify, prior);
    const b = suppressReferencedRecords(rows, identify, prior);
    expect(a.kept).toEqual(b.kept);
    expect(a.kept.map((r) => r.citation_id)).toEqual(["c:2"]);
    expect(a.suppression.suppressed).toBe(1);
  });

  it("returns all records net-new when prior context is empty", () => {
    const rows: Row[] = [{ citation_id: "c:1" }, { citation_id: "c:2" }];
    const result = suppressReferencedRecords(rows, identify, []);
    expect(result.kept).toHaveLength(2);
    expect(result.suppression).toEqual({
      recalled: 2,
      suppressed: 0,
      net_new: 2,
    });
  });

  it("rejects a prior-context reference with no resolvable identity", () => {
    expect(() =>
      suppressReferencedRecords([{ citation_id: "c:1" }], identify, [
        {} as never,
      ]),
    ).toThrow();
  });

  it("does not cross-collide a citation id string with a source_ref string", () => {
    const rows: Row[] = [{ citation_id: "shared-string" }];
    // Prior context references a string source_ref equal to the citation id;
    // families are tagged, so it must NOT suppress.
    const result = suppressReferencedRecords(rows, identify, [
      { source_ref: "shared-string" },
    ]);
    expect(result.kept).toHaveLength(1);
  });
});
