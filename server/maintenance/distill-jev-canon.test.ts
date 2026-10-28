import { describe, expect, it, vi } from "vitest";

import type { JevConfig } from "../integrations/jev.ts";
import type { CandidateType, PreparedCandidate } from "../domain/distiller.ts";
import {
  canonEntriesFromItems,
  flagCanonConflictsWithJev,
  type EmbeddedCanonEntry,
} from "./distill-jev-type.ts";

const config: JevConfig = {
  enabled: true,
  apiKey: "test-key",
  baseUrl: "https://jev.example.test/v1/systemone",
  model: "jev-1.13.0",
  timeoutMs: 1_000,
  maxRequestBytes: 64_000,
  maxStateQuestionBytes: 32_000,
};

function candidate(id: string, type: CandidateType): PreparedCandidate {
  return {
    candidate_type: type,
    content: `OPERATOR: statement ${id}`,
    source_turn_ids: [`turn-${id}`],
    uncertain: false,
    namespace: "owner",
    content_hash: `hash-${id}`,
    model: "rule-based",
  };
}

function canonEntry(key: string, embedding: number[]): EmbeddedCanonEntry {
  return {
    scopeKey: key,
    content: `canon rule ${key}`,
    section: "process_guidance",
    embedding,
  };
}

function logger() {
  return { info: vi.fn(), warn: vi.fn() };
}

function requestBody(init?: RequestInit): { questions: Record<string, unknown> } {
  if (typeof init?.body !== "string") throw new Error("expected a string request body");
  return JSON.parse(init.body) as { questions: Record<string, unknown> };
}

/** Answers every question in the request with the same noul. */
function noulFetch(noul: number, seen: string[] = []) {
  return vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    if (typeof init?.body === "string") seen.push(init.body);
    const body = requestBody(init);
    const answers = Object.fromEntries(
      Object.keys(body.questions).map((id) => [id, { type: "noul", noul }]),
    );
    return new Response(
      JSON.stringify({
        model: "jev-served",
        answers,
        usage: { input_tokens: 10, output_tokens: 4 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  });
}

const CANON = [canonEntry("rule-a", [1, 0])];

describe("flagCanonConflictsWithJev", () => {
  it("flags a correction at noul 0.9 with the scope key", async () => {
    const [out] = await flagCanonConflictsWithJev({
      candidates: [candidate("a", "correction")],
      embeddings: [[1, 0]],
      canon: CANON,
      config,
      fetchFn: noulFetch(0.9),
      logger: logger(),
    });
    expect(out?.uncertain).toBe(true);
    expect(out?.uncertainty_reason).toContain("rule-a");
    expect(out?.uncertainty_reason).toContain("0.9");
  });

  it("leaves a correction at noul 0.2 unchanged", async () => {
    const input = candidate("a", "correction");
    const [out] = await flagCanonConflictsWithJev({
      candidates: [input],
      embeddings: [[1, 0]],
      canon: CANON,
      config,
      fetchFn: noulFetch(0.2),
      logger: logger(),
    });
    expect(out).toEqual(input);
  });

  it("never calls Jev when there is no correction", async () => {
    const input = [candidate("a", "fact"), candidate("b", "decision")];
    const fetchFn = noulFetch(0.9);
    const out = await flagCanonConflictsWithJev({
      candidates: input,
      embeddings: [
        [1, 0],
        [1, 0],
      ],
      canon: CANON,
      config,
      fetchFn,
      logger: logger(),
    });
    expect(fetchFn).not.toHaveBeenCalled();
    expect(out).toEqual(input);
  });

  it("never calls Jev when canon is empty", async () => {
    const fetchFn = noulFetch(0.9);
    await flagCanonConflictsWithJev({
      candidates: [candidate("a", "correction")],
      embeddings: [[1, 0]],
      canon: [],
      config,
      fetchFn,
      logger: logger(),
    });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("returns the input unchanged and warns once when fetch rejects", async () => {
    const log = logger();
    const input = [candidate("a", "correction")];
    const fetchFn = vi.fn(async () => {
      throw new Error("network down");
    });
    const out = await flagCanonConflictsWithJev({
      candidates: input,
      embeddings: [[1, 0]],
      canon: CANON,
      config,
      fetchFn,
      logger: log,
    });
    expect(out).toEqual(input);
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn.mock.calls[0]?.[0]).toBe("distill_jev_canon_conflict_failed");
  });

  it("never calls Jev when the flag is off", async () => {
    const fetchFn = noulFetch(0.9);
    await flagCanonConflictsWithJev({
      candidates: [candidate("a", "correction")],
      embeddings: [[1, 0]],
      canon: CANON,
      config: { ...config, enabled: false },
      fetchFn,
      logger: logger(),
    });
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe("flagCanonConflictsWithJev pairing", () => {
  it("pairs a correction with only its 3 most similar canon entries", async () => {
    const seen: string[] = [];
    const canon = [
      canonEntry("far-1", [0, 1]),
      canonEntry("near-1", [1, 0]),
      canonEntry("far-2", [-1, 0]),
      canonEntry("near-2", [1, 0.2]),
      canonEntry("near-3", [1, 0.5]),
    ];
    await flagCanonConflictsWithJev({
      candidates: [candidate("a", "correction")],
      embeddings: [[1, 0]],
      canon,
      config,
      fetchFn: noulFetch(0.1, seen),
      logger: logger(),
    });
    const body = seen.join("\n");
    expect(Object.keys(requestBody({ body: seen[0] }).questions)).toHaveLength(3);
    for (const key of ["near-1", "near-2", "near-3"]) {
      expect(body).toContain(`canon rule ${key}`);
    }
    for (const key of ["far-1", "far-2"]) {
      expect(body).not.toContain(`canon rule ${key}`);
    }
  });

  it("ranks only canon entries of matching dimension and announces the mismatch", async () => {
    const seen: string[] = [];
    const log = logger();
    const fetchFn = noulFetch(0.1, seen);
    const canon = [
      canonEntry("dim3-a", [1, 0, 0]),
      canonEntry("dim2-odd", [1, 0]),
      canonEntry("dim3-b", [0, 1, 0]),
      canonEntry("dim3-c", [0, 0, 1]),
    ];
    await flagCanonConflictsWithJev({
      candidates: [candidate("a", "correction")],
      embeddings: [[1, 0, 0]],
      canon,
      config,
      fetchFn,
      logger: log,
    });
    expect(fetchFn).toHaveBeenCalled();
    expect(Object.keys(requestBody({ body: seen[0] }).questions)).toHaveLength(3);
    expect(seen.join("\n")).not.toContain("canon rule dim2-odd");
    expect(log.info).toHaveBeenCalledWith(
      "distill_jev_canon_conflict_applied",
      expect.objectContaining({ canon_dimension_mismatch: 1, skipped_no_embedding: 0 }),
    );
  });
});

describe("canonEntriesFromItems", () => {
  it("drops a keyless item and announces the count", () => {
    const log = { warn: vi.fn() };
    const entries = canonEntriesFromItems({
      section: "process_guidance",
      items: [{ scope_key: "k1", guidance: "g1" }, { guidance: "g2" }],
      logger: log,
    });
    expect(entries).toHaveLength(1);
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith("distill_jev_canon_keyless_skipped", {
      section: "process_guidance",
      skipped: 1,
    });
  });
});
