import { expect, test } from "vitest";

import type { RemCandidate } from "../server/maintenance/dream-rem.ts";
import { toFrozenQueueItem } from "./rem-frozen-queue-item.ts";

const candidate: Readonly<RemCandidate> = Object.freeze({
  id: "11111111-1111-4111-8111-111111111111",
  namespace: "frozen-namespace",
  candidate_type: "decision",
  content: "Keep this exact frozen claim.",
  content_hash: "frozen-content-hash",
  uncertain: true,
  uncertainty_reason: "model extraction doubt",
  model: "extractor-model",
  session_count: 3,
  occurrence_count: 7,
  reinforcement_count: 2,
});

test("projects a frozen REM candidate into the grading card's minimal render shape", () => {
  expect(toFrozenQueueItem(candidate)).toEqual({
    id: candidate.id,
    namespace: candidate.namespace,
    candidate_type: candidate.candidate_type,
    content: candidate.content,
    unit_kind: "exchange",
    source_turn_ids: [],
    context: [],
    reinforcement: {
      session_count: candidate.session_count,
      occurrence_count: candidate.occurrence_count,
      first_seen: null,
      last_seen: null,
    },
  });
});

test("is deterministic and omits every blinded or invented field", () => {
  const first = toFrozenQueueItem(candidate);
  const second = toFrozenQueueItem(candidate);

  expect(second).toEqual(first);
  expect(candidate.content).toBe("Keep this exact frozen claim.");
  expect(Object.keys(first).sort()).toEqual([
    "candidate_type",
    "content",
    "context",
    "id",
    "namespace",
    "reinforcement",
    "source_turn_ids",
    "unit_kind",
  ]);
  expect(first.context).toEqual([]);
  expect(first.source_turn_ids).toEqual([]);
  for (const key of [
    "machine_grade",
    "machine_grade_model",
    "previous_action",
    "confidence",
    "model",
    "uncertain",
    "uncertainty_reason",
    "operator_text",
  ]) {
    expect(Object.hasOwn(first, key), key).toBe(false);
  }
});
