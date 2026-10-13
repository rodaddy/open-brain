import { expect, test, vi } from "vitest";

import type { JevConfig } from "../integrations/jev.ts";
import {
  CANDIDATE_TYPES,
  type CandidateType,
  type PreparedCandidate,
} from "../domain/distiller.ts";
import { retypeCandidatesWithJev } from "./distill-jev-type.ts";

const config: JevConfig = {
  enabled: true,
  apiKey: "test-key",
  baseUrl: "https://jev.example.test/v1/systemone",
  model: "jev-1.13.0",
  timeoutMs: 1_000,
  maxRequestBytes: 64_000,
  maxStateQuestionBytes: 32_000,
};

function candidate(
  id: string,
  type: CandidateType,
  reason: string | null = null,
): PreparedCandidate {
  return {
    candidate_type: type,
    content: `OPERATOR: statement ${id}`,
    source_turn_ids: [`turn-${id}`],
    uncertain: reason !== null,
    ...(reason !== null ? { uncertainty_reason: reason } : {}),
    namespace: "owner",
    content_hash: `hash-${id}`,
    model: "rule-based",
  };
}

function logger() {
  return { info: vi.fn(), warn: vi.fn() };
}

function requestBody(init?: RequestInit): { questions: Record<string, unknown> } {
  if (typeof init?.body !== "string") throw new Error("expected a string request body");
  return JSON.parse(init.body) as { questions: Record<string, unknown> };
}

/** One answer per record, in order: [choice, confidence]. */
function fakeFetch(answers: ReadonlyArray<readonly [string, number]>) {
  return vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const body = requestBody(init);
    const expectedIds = answers.map((_answer, index) => `r${index}_c0`);
    expect(Object.keys(body.questions).sort()).toEqual([...expectedIds].sort());
    const out: Record<string, unknown> = {};
    answers.forEach(([choice, confidence], index) => {
      const id = `r${index}_c0`;
      const question = body.questions[id] as { criteria: Record<string, unknown> };
      const keys = Object.keys(question.criteria);
      expect([...keys].sort()).toEqual([...CANDIDATE_TYPES].sort());
      out[id] = {
        type: "choice",
        choice,
        probabilities: Object.fromEntries(
          keys.map((key) => [key, key === choice ? 1 : 0]),
        ),
        confidence,
      };
    });
    return new Response(
      JSON.stringify({
        model: "jev-served",
        answers: out,
        usage: { input_tokens: 10, output_tokens: 4 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  });
}

test("confidence at or above the bar replaces the type and leaves uncertain alone", async () => {
  const log = logger();
  const [out] = await retypeCandidatesWithJev({
    candidates: [candidate("a", "fact")],
    config,
    fetchFn: fakeFetch([["decision", 0.95]]),
    logger: log,
  });
  expect(out?.candidate_type).toBe("decision");
  expect(out?.uncertain).toBe(false);
  expect(out?.uncertainty_reason).toBeUndefined();
});

test("mid confidence replaces the type and flags uncertain with the note", async () => {
  const [out] = await retypeCandidatesWithJev({
    candidates: [candidate("a", "fact")],
    config,
    fetchFn: fakeFetch([["decision", 0.7]]),
    logger: logger(),
  });
  expect(out?.candidate_type).toBe("decision");
  expect(out?.uncertain).toBe(true);
  expect(out?.uncertainty_reason).toBe("jev typed decision at 0.7, rule said fact");
});

test("below the floor keeps the rule type and flags uncertain", async () => {
  const [out] = await retypeCandidatesWithJev({
    candidates: [candidate("a", "fact")],
    config,
    fetchFn: fakeFetch([["decision", 0.3]]),
    logger: logger(),
  });
  expect(out?.candidate_type).toBe("fact");
  expect(out?.uncertain).toBe(true);
  expect(out?.uncertainty_reason).toContain("rule said");
});

test("a rejected fetch keeps every candidate with its rule type (no drop)", async () => {
  const log = logger();
  const input = [candidate("a", "fact"), candidate("b", "decision", "producer note")];
  const fetchFn = vi.fn(async () => {
    throw new Error("network down");
  });
  const out = await retypeCandidatesWithJev({
    candidates: input,
    config,
    fetchFn,
    logger: log,
  });
  expect(out).toHaveLength(input.length);
  expect(out).toEqual(input);
  expect(log.warn).toHaveBeenCalledTimes(1);
  expect(log.warn.mock.calls[0]?.[0]).toBe("distill_jev_type_failed");
  expect(log.info).not.toHaveBeenCalled();
});

test("a choice outside CANDIDATE_TYPES falls back like a failure, never coerced", async () => {
  const log = logger();
  const input = [candidate("a", "fact"), candidate("b", "preference")];
  const out = await retypeCandidatesWithJev({
    candidates: input,
    config,
    fetchFn: fakeFetch([
      ["decision", 0.99],
      ["question", 0.99],
    ]),
    logger: log,
  });
  expect(out).toEqual(input);
  expect(log.warn).toHaveBeenCalledTimes(1);
  expect(log.warn.mock.calls[0]?.[0]).toBe("distill_jev_type_failed");
});

test("flag off never calls fetch and returns the input unchanged", async () => {
  const input = [candidate("a", "fact")];
  const fetchFn = vi.fn();
  const out = await retypeCandidatesWithJev({
    candidates: input,
    config: { ...config, enabled: false },
    fetchFn,
    logger: logger(),
  });
  expect(fetchFn).not.toHaveBeenCalled();
  expect(out).toEqual(input);
  expect(out).not.toBe(input);
});

test("an existing producer reason is preserved and the note appended", async () => {
  const [out] = await retypeCandidatesWithJev({
    candidates: [candidate("a", "fact", "producer note")],
    config,
    fetchFn: fakeFetch([["correction", 0.6]]),
    logger: logger(),
  });
  expect(out?.candidate_type).toBe("correction");
  expect(out?.uncertainty_reason).toBe(
    "producer note; jev typed correction at 0.6, rule said fact",
  );
});

test("a mixed batch keeps order and announces replaced/flagged/kept counts", async () => {
  const log = logger();
  const input = [
    candidate("a", "fact"),
    candidate("b", "fact"),
    candidate("c", "preference"),
  ];
  const out = await retypeCandidatesWithJev({
    candidates: input,
    config,
    fetchFn: fakeFetch([
      ["decision", 0.95],
      ["correction", 0.7],
      ["fact", 0.2],
    ]),
    logger: log,
  });
  expect(out.map((c) => c.content_hash)).toEqual(["hash-a", "hash-b", "hash-c"]);
  expect(out.map((c) => c.candidate_type)).toEqual([
    "decision",
    "correction",
    "preference",
  ]);
  expect(out.map((c) => c.source_turn_ids)).toEqual(
    input.map((c) => c.source_turn_ids),
  );
  expect(log.info).toHaveBeenCalledTimes(1);
  expect(log.info).toHaveBeenCalledWith("distill_jev_type_applied", {
    candidate_count: 3,
    replaced: 2,
    flagged: 2,
    kept: 1,
    rubric: "distill-candidate-type-v1",
  });
});
