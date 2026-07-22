import { describe, it, expect } from "bun:test";
import {
  EMBEDDING_TARGETS,
  EMBEDDING_TARGET_NAMES,
  getEmbeddingTarget,
} from "./embedding-targets.ts";
import { contentHash } from "./embedding.ts";

describe("embedding-targets registry", () => {
  it("covers every current embedding-bearing table", () => {
    // The physical tables that carry an `embedding halfvec(768)` column today.
    // If a new one lands, add it here AND to EMBEDDING_TARGETS.
    const expected = [
      "thoughts",
      "decisions",
      "relationships",
      "projects",
      "sessions",
      "ob_session_lanes",
      "ob_session_events",
      "ob_entities",
    ].sort();
    expect([...EMBEDDING_TARGET_NAMES].sort()).toEqual(expected);
  });

  it("declares entities without model/staleness provenance (schema truth)", () => {
    const entities = getEmbeddingTarget("ob_entities");
    expect(entities.provenance.hasContentHash).toBe(false);
    expect(entities.provenance.hasEmbeddedAt).toBe(false);
    expect(entities.provenance.hasEmbeddingModel).toBe(false);
  });

  it("entities (no content_hash) declares source-column snapshot guards for its projected source", () => {
    const entities = getEmbeddingTarget("ob_entities");
    // With no content_hash to guard on, ob_entities must snapshot-guard its
    // actual source columns so a concurrent name/type edit can't be clobbered.
    expect(entities.sourceGuardColumns).toEqual(["entity_type", "name"]);
    // Every guarded column MUST be projected so its captured value is available.
    for (const col of entities.sourceGuardColumns!) {
      expect(entities.selectColumns).toContain(col);
    }
  });

  it("full-provenance (content_hash) targets do not need source-column snapshot guards", () => {
    // Targets with content_hash guard on the hash; a source snapshot is
    // redundant, so they should not declare sourceGuardColumns.
    for (const name of ["thoughts", "decisions", "ob_session_events"]) {
      const t = getEmbeddingTarget(name);
      expect(t.provenance.hasContentHash).toBe(true);
      expect(t.sourceGuardColumns).toBeUndefined();
    }
  });

  it("any no-content_hash target declares source-guard columns, all projected", () => {
    // Invariant: a target that cannot guard on a hash MUST snapshot-guard its
    // real source columns, and every such column must be in selectColumns.
    for (const name of EMBEDDING_TARGET_NAMES) {
      const t = EMBEDDING_TARGETS[name]!;
      if (t.provenance.hasContentHash) continue;
      expect(t.sourceGuardColumns?.length ?? 0).toBeGreaterThan(0);
      for (const col of t.sourceGuardColumns!) {
        expect(t.selectColumns).toContain(col);
      }
    }
  });

  it("declares full provenance for the tables whose schema has the columns", () => {
    for (const name of [
      "thoughts",
      "decisions",
      "relationships",
      "projects",
      "sessions",
      "ob_session_lanes",
      "ob_session_events",
    ]) {
      const t = getEmbeddingTarget(name);
      expect(t.provenance.hasContentHash).toBe(true);
      expect(t.provenance.hasEmbeddedAt).toBe(true);
      expect(t.provenance.hasEmbeddingModel).toBe(true);
    }
  });

  it("thoughts: embeds content+tags but hashes content alone (matches write path)", () => {
    const t = getEmbeddingTarget("thoughts");
    const row = { id: "t1", content: "a thought", tags: ["x", "y"] };
    expect(t.embedText(row)).toBe("a thought\nx y");
    // Write path (log-thought.ts) hashes args.content, NOT the embed text.
    expect(t.sourceHash(row)).toBe(contentHash("a thought"));
    expect(t.canonicalText(row)).toBe("a thought");
  });

  it("thoughts without tags: embed text equals content", () => {
    const t = getEmbeddingTarget("thoughts");
    const row = { id: "t1", content: "just content", tags: [] };
    expect(t.embedText(row)).toBe("just content");
  });

  it("decisions: title + newline + rationale", () => {
    const t = getEmbeddingTarget("decisions");
    const row = { id: "d1", title: "Use Bun", rationale: "It is fast" };
    expect(t.embedText(row)).toBe("Use Bun\nIt is fast");
    expect(t.sourceHash(row)).toBe(contentHash("Use Bun\nIt is fast"));
  });

  it("relationships: filters null parts before joining", () => {
    const t = getEmbeddingTarget("relationships");
    const row = {
      id: "r1",
      person_name: "Alice",
      context: "coworker",
      notes: null,
    };
    expect(t.embedText(row)).toBe("Alice\ncoworker");
  });

  it("projects: name + description filtered", () => {
    const t = getEmbeddingTarget("projects");
    const row = { id: "p1", name: "OpenBrain", description: "AI memory" };
    expect(t.embedText(row)).toBe("OpenBrain\nAI memory");
  });

  it("sessions: summary only", () => {
    const t = getEmbeddingTarget("sessions");
    const row = { id: "s1", summary: "session summary text" };
    expect(t.embedText(row)).toBe("session summary text");
  });

  it("lanes: embed text is topic[+project], hash is session_key|topic (matches write path)", () => {
    const t = getEmbeddingTarget("ob_session_lanes");
    const row = {
      id: "l1",
      session_key: "sk-1",
      topic: "the topic",
      project: "proj",
    };
    expect(t.embedText(row)).toBe("the topic\nproj");
    // firstWriteLaneContentHash: session_key + "|" + topic, NOT the embed text.
    expect(t.sourceHash(row)).toBe(contentHash("sk-1|the topic"));
    expect(t.sourceHash(row)).not.toBe(contentHash("the topic\nproj"));
  });

  it("session events: content only, hashed directly", () => {
    const t = getEmbeddingTarget("ob_session_events");
    const row = { id: "e1", content: "an event", lane_id: "l1" };
    expect(t.embedText(row)).toBe("an event");
    expect(t.sourceHash(row)).toBe(contentHash("an event"));
  });

  it("entities: entity_type: name (matches hydrate-entities.ts)", () => {
    const t = getEmbeddingTarget("ob_entities");
    const row = { id: "en1", entity_type: "person", name: "Alice" };
    expect(t.embedText(row)).toBe("person: Alice");
  });

  it("getEmbeddingTarget throws on unknown table (allowlist gate)", () => {
    expect(() =>
      getEmbeddingTarget("robert'); DROP TABLE thoughts;--"),
    ).toThrow();
    expect(() => getEmbeddingTarget("not_a_table")).toThrow();
  });

  it("id column is included in every target's projection", () => {
    for (const name of EMBEDDING_TARGET_NAMES) {
      const t = EMBEDDING_TARGETS[name]!;
      expect(t.selectColumns).toContain(t.idColumn);
    }
  });

  it("every target is namespace-scopable (direct column XOR FK binding)", () => {
    for (const name of EMBEDDING_TARGET_NAMES) {
      const t = EMBEDDING_TARGETS[name]!;
      const direct = Boolean(t.namespaceColumn);
      const viaFk = Boolean(t.namespaceVia);
      // Exactly one path -- never both, never neither. A target with neither
      // cannot be isolated and would fail closed on a scoped call.
      expect(direct || viaFk).toBe(true);
      expect(direct && viaFk).toBe(false);
    }
  });

  it("session events isolate via the lane_id FK, projecting lane_id for the join", () => {
    const t = getEmbeddingTarget("ob_session_events");
    expect(t.namespaceColumn).toBeUndefined();
    expect(t.namespaceVia).toEqual({
      table: "ob_session_lanes",
      localKey: "lane_id",
      remoteKey: "id",
      namespaceColumn: "namespace",
    });
    // The FK column MUST be projected so it is available for the join predicate.
    expect(t.selectColumns).toContain(t.namespaceVia!.localKey);
  });
});
