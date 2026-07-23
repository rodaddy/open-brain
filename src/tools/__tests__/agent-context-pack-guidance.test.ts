import { describe, expect, it } from "bun:test";
import {
  loadGuidanceSection,
  type GuidanceSectionName,
} from "../agent-context-pack-guidance.ts";
import type { SectionReaderDeps } from "../agent-context-pack-sections.ts";

type Row = Record<string, unknown>;

function eventRow(overrides: Partial<Row> & { id: string }): Row {
  return {
    content: "prefer concise answers",
    created_at: "2026-07-20T10:00:00Z",
    memory_lifecycle_action: "promote",
    candidate_type: "user_preference",
    candidate_reason: "stated preference",
    candidate_confidence: 0.9,
    candidate_scope: null,
    ...overrides,
  };
}

function readerFor(
  rows: Row[],
  capture?: { sql?: string; params?: unknown[] },
): SectionReaderDeps {
  return {
    query: async (sql, params) => {
      if (capture) {
        capture.sql = sql;
        capture.params = params;
      }
      return { rows };
    },
  };
}

async function loadProfile(rows: Row[], namespace = "rico") {
  return loadGuidanceSection(
    { section: "profile_guidance", namespace },
    readerFor(rows),
  );
}

describe("guidance section discriminator", () => {
  it("selects promoted user_preference for profile_guidance by typed metadata, not content", async () => {
    const capture: { sql?: string; params?: unknown[] } = {};
    const frag = await loadGuidanceSection(
      { section: "profile_guidance", namespace: "rico" },
      readerFor([eventRow({ id: "e1" })], capture),
    );
    expect(capture.params?.slice(0, 2)).toEqual(["rico", "user_preference"]);
    expect(capture.sql).toContain("candidate_type' = $2");
    expect(capture.sql).toContain("l.namespace = $1");
    expect(frag.section?.item_count).toBe(1);
    expect((frag.section?.items as Row[])[0]!.candidate_type).toBe(
      "user_preference",
    );
  });

  it("maps process_guidance to the process_rule candidate_type", async () => {
    const capture: { sql?: string; params?: unknown[] } = {};
    await loadGuidanceSection(
      { section: "process_guidance", namespace: "rico" },
      readerFor([], capture),
    );
    expect(capture.params?.slice(0, 2)).toEqual(["rico", "process_rule"]);
  });

  it("excludes un-promoted candidates (candidate action is not durable standing guidance)", async () => {
    // Even though the row content is preference-like, a bare 'candidate' action
    // must not surface as durable guidance.
    const frag = await loadProfile([
      eventRow({ id: "e1", memory_lifecycle_action: "candidate" }),
    ]);
    expect(frag.section?.item_count).toBe(0);
    expect(frag.section?.items).toEqual([]);
  });

  it("returns a defined empty state, never fabricated guidance, when nothing is promoted", async () => {
    const frag = await loadProfile([]);
    expect(frag.section).toMatchObject({
      label: "profile_guidance",
      item_count: 0,
      items: [],
      truncated: false,
    });
    expect(frag.citations).toEqual([]);
    expect(frag.degradedSources).toEqual([]);
  });
});

describe("guidance supersession via explicit typed scope key", () => {
  it("drops a promoted item whose scope key was later relegated or discarded", async () => {
    const rows = [
      eventRow({
        id: "relegate-1",
        created_at: "2026-07-21T10:00:00Z",
        memory_lifecycle_action: "relegate",
        candidate_scope: { key: "tone" },
      }),
      eventRow({
        id: "promote-1",
        created_at: "2026-07-20T10:00:00Z",
        candidate_scope: { key: "tone" },
      }),
      eventRow({
        id: "promote-2",
        created_at: "2026-07-19T10:00:00Z",
        candidate_scope: { key: "format" },
      }),
    ];
    const frag = await loadProfile(rows);
    const ids = (frag.section?.items as Row[]).map((i) => i.id);
    expect(ids).toEqual(["promote-2"]);
  });

  it("keeps only the most recent promote per scope key (deterministic dedupe)", async () => {
    const rows = [
      eventRow({
        id: "newer",
        created_at: "2026-07-21T10:00:00Z",
        candidate_scope: { key: "tone" },
      }),
      eventRow({
        id: "older",
        created_at: "2026-07-19T10:00:00Z",
        candidate_scope: { key: "tone" },
      }),
    ];
    const frag = await loadProfile(rows);
    const items = frag.section?.items as Row[];
    expect(items.map((i) => i.id)).toEqual(["newer"]);
  });

  it("collapses several duplicate promotes of one key to the single newest", async () => {
    const rows = [
      eventRow({
        id: "p3",
        created_at: "2026-07-22T10:00:00Z",
        candidate_scope: { key: "tone" },
      }),
      eventRow({
        id: "p2",
        created_at: "2026-07-21T10:00:00Z",
        candidate_scope: { key: "tone" },
      }),
      eventRow({
        id: "p1",
        created_at: "2026-07-20T10:00:00Z",
        candidate_scope: { key: "tone" },
      }),
    ];
    const frag = await loadProfile(rows);
    expect((frag.section?.items as Row[]).map((i) => i.id)).toEqual(["p3"]);
    expect(frag.section?.item_count).toBe(1);
  });

  it("flags keyless promotes as unverifiable rather than silently trusting them", async () => {
    const frag = await loadProfile([
      eventRow({ id: "keyless", candidate_scope: null }),
    ]);
    const item = (frag.section?.items as Row[])[0]!;
    expect(item.supersession_verifiable).toBe(false);
    expect(item.scope_key).toBeNull();
    expect(frag.section?.keyless_uncertain_count).toBe(1);
  });

  it("keeps a promote that reactivated a previously retired key (newest action wins)", async () => {
    // Regression for the supersession defect: an OLDER relegate must not retire
    // a key that a NEWER promote reactivated. Rows arrive newest-first.
    const rows = [
      eventRow({
        id: "reactivate",
        created_at: "2026-07-22T10:00:00Z",
        memory_lifecycle_action: "promote",
        candidate_scope: { key: "tone" },
      }),
      eventRow({
        id: "old-relegate",
        created_at: "2026-07-21T10:00:00Z",
        memory_lifecycle_action: "relegate",
        candidate_scope: { key: "tone" },
      }),
      eventRow({
        id: "old-promote",
        created_at: "2026-07-20T10:00:00Z",
        memory_lifecycle_action: "promote",
        candidate_scope: { key: "tone" },
      }),
    ];
    const frag = await loadProfile(rows);
    // The reactivating promote stands; the superseded older promote is deduped.
    expect((frag.section?.items as Row[]).map((i) => i.id)).toEqual([
      "reactivate",
    ]);
  });

  it("still retires a key whose NEWEST action is a relegate after an earlier promote/relegate churn", async () => {
    // Newest action is a retirement -> key is currently retired even though an
    // earlier promote (and even an earlier relegate) exists in the history.
    const rows = [
      eventRow({
        id: "newest-relegate",
        created_at: "2026-07-22T10:00:00Z",
        memory_lifecycle_action: "relegate",
        candidate_scope: { key: "tone" },
      }),
      eventRow({
        id: "mid-promote",
        created_at: "2026-07-21T10:00:00Z",
        memory_lifecycle_action: "promote",
        candidate_scope: { key: "tone" },
      }),
      eventRow({
        id: "keeps-standing",
        created_at: "2026-07-20T10:00:00Z",
        memory_lifecycle_action: "promote",
        candidate_scope: { key: "format" },
      }),
    ];
    const frag = await loadProfile(rows);
    expect((frag.section?.items as Row[]).map((i) => i.id)).toEqual([
      "keeps-standing",
    ]);
  });

  it("discard then promote reactivates the key (discard is also a retirement action)", async () => {
    const rows = [
      eventRow({
        id: "reactivate-after-discard",
        created_at: "2026-07-22T10:00:00Z",
        memory_lifecycle_action: "promote",
        candidate_scope: { key: "tone" },
      }),
      eventRow({
        id: "old-discard",
        created_at: "2026-07-20T10:00:00Z",
        memory_lifecycle_action: "discard",
        candidate_scope: { key: "tone" },
      }),
    ];
    const frag = await loadProfile(rows);
    expect((frag.section?.items as Row[]).map((i) => i.id)).toEqual([
      "reactivate-after-discard",
    ]);
  });

  it("retirement of one key does not leak across to a different standing key", async () => {
    const rows = [
      eventRow({
        id: "relegate-tone",
        created_at: "2026-07-22T10:00:00Z",
        memory_lifecycle_action: "relegate",
        candidate_scope: { key: "tone" },
      }),
      eventRow({
        id: "promote-format",
        created_at: "2026-07-21T10:00:00Z",
        memory_lifecycle_action: "promote",
        candidate_scope: { key: "format" },
      }),
      eventRow({
        id: "promote-tone-old",
        created_at: "2026-07-20T10:00:00Z",
        memory_lifecycle_action: "promote",
        candidate_scope: { key: "tone" },
      }),
    ];
    const frag = await loadProfile(rows);
    // tone is retired (newest action relegate); format stands.
    expect((frag.section?.items as Row[]).map((i) => i.id)).toEqual([
      "promote-format",
    ]);
  });

  it("does not let a keyless relegate retire a keyed promote", async () => {
    const rows = [
      eventRow({
        id: "relegate-keyless",
        created_at: "2026-07-21T10:00:00Z",
        memory_lifecycle_action: "discard",
        candidate_scope: null,
      }),
      eventRow({
        id: "promote-keyed",
        created_at: "2026-07-20T10:00:00Z",
        candidate_scope: { key: "tone" },
      }),
    ];
    const frag = await loadProfile(rows);
    expect((frag.section?.items as Row[]).map((i) => i.id)).toEqual([
      "promote-keyed",
    ]);
  });
});

describe("guidance budgets, order, and degradation", () => {
  it("caps items to the budget and marks truncation deterministically", async () => {
    const rows = Array.from({ length: 5 }, (_, i) =>
      eventRow({
        id: `e${i}`,
        created_at: `2026-07-2${i}T10:00:00Z`,
        candidate_scope: { key: `k${i}` },
      }),
    );
    const frag = await loadGuidanceSection(
      {
        section: "profile_guidance",
        namespace: "rico",
        budget: { maxItems: 2 },
      },
      readerFor(rows),
    );
    expect(frag.section?.item_count).toBe(2);
    // Order: query yields created_at DESC; module preserves it.
    expect((frag.section?.items as Row[]).map((i) => i.id)).toEqual([
      "e0",
      "e1",
    ]);
    expect(frag.section?.truncated).toBe(true);
    expect(frag.truncation).not.toEqual([]);
  });

  it("truncates over-long guidance content to the char budget", async () => {
    const frag = await loadGuidanceSection(
      {
        section: "profile_guidance",
        namespace: "rico",
        budget: { maxItemChars: 10 },
      },
      readerFor([eventRow({ id: "e1", content: "x".repeat(50) })]),
    );
    const item = (frag.section?.items as Row[])[0]!;
    expect((item.guidance as string).length).toBe(10);
    expect(frag.section?.truncated).toBe(true);
  });

  it("flags lifecycle-scan overflow as truncation without silently dropping", async () => {
    // 502 rows > the 500-row scan cap (query fetches cap+1 to detect overflow).
    const rows = Array.from({ length: 502 }, (_, i) =>
      eventRow({
        id: `e${i}`,
        created_at: `2026-07-20T10:00:00Z`,
        candidate_scope: { key: `k${i}` },
      }),
    );
    const frag = await loadProfile(rows);
    const t = frag.truncation[0] as Row;
    expect(t.lifecycle_scan_capped).toBe(500);
    expect(frag.section?.truncated).toBe(true);
  });

  it("degrades content-free when the database query throws", async () => {
    const frag = await loadGuidanceSection(
      { section: "profile_guidance", namespace: "rico" },
      {
        query: async () => {
          throw new Error("connection reset");
        },
      },
    );
    expect(frag.section).toBeUndefined();
    expect(frag.degradedSources).toEqual([
      { source: "profile_guidance", reason: "database_unavailable" },
    ]);
    expect(JSON.stringify(frag)).not.toContain("connection reset");
  });

  it("binds guidance reads to the supplied namespace", async () => {
    const capture: { sql?: string; params?: unknown[] } = {};
    await loadGuidanceSection(
      { section: "process_guidance", namespace: "king-capital" },
      readerFor([], capture),
    );
    expect(capture.params?.[0]).toBe("king-capital");
  });

  it("carries distinct namespace binds for two namespaces sharing the same scope key", async () => {
    // Two namespaces may both promote a 'tone' key; isolation is enforced by the
    // per-read namespace predicate, so each read must carry its own namespace.
    const ricoCapture: { sql?: string; params?: unknown[] } = {};
    const kingCapture: { sql?: string; params?: unknown[] } = {};
    await loadGuidanceSection(
      { section: "profile_guidance", namespace: "rico" },
      readerFor(
        [eventRow({ id: "rico-tone", candidate_scope: { key: "tone" } })],
        ricoCapture,
      ),
    );
    await loadGuidanceSection(
      { section: "profile_guidance", namespace: "king-capital" },
      readerFor(
        [eventRow({ id: "king-tone", candidate_scope: { key: "tone" } })],
        kingCapture,
      ),
    );
    expect(ricoCapture.params?.[0]).toBe("rico");
    expect(kingCapture.params?.[0]).toBe("king-capital");
    expect(ricoCapture.sql).toContain("l.namespace = $1");
  });
});

describe.each<GuidanceSectionName>(["profile_guidance", "process_guidance"])(
  "%s citations",
  (section) => {
    it("emits one citation per included item", async () => {
      const candidate_type =
        section === "profile_guidance" ? "user_preference" : "process_rule";
      const frag = await loadGuidanceSection(
        { section, namespace: "rico" },
        readerFor([
          eventRow({ id: "e1", candidate_type }),
          eventRow({ id: "e2", candidate_type, candidate_scope: { key: "x" } }),
        ]),
      );
      expect(frag.citations).toHaveLength(frag.section?.item_count as number);
      expect(frag.citations[0]).toMatchObject({
        kind: "session_event",
        source_ref: "ob_session_events/e1",
      });
    });
  },
);
