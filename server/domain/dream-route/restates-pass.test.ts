/**
 * Plumbing proofs for the pairwise restates pass, on the fake Jev backend.
 * No database, no network, no paid call.
 */

import { describe, expect, it } from "vitest";
import {
  DEFAULT_JEV_MAX_REQUEST_BYTES,
  DEFAULT_JEV_MAX_STATE_QUESTION_BYTES,
  type JevAnswer,
  type JevConfig,
} from "../../integrations/jev.ts";
import {
  DEFAULT_THRESHOLDS_V2,
  DEST_V2_ID,
  LASTING_ID,
  RESTATES_AT_V2,
  RESTATES_PAIR_ID,
  decideRouteV2,
} from "./decide-v2.ts";
import { DEFAULT_MATRIX_PATH, loadMatrix } from "./matrix.ts";
import { DROVE_DECISION_ID } from "./questions.ts";
import { runRestatesPass } from "./restates-pass.ts";
import { fakeJevFetch, neighbourPairs, wouldApply } from "./run-core.ts";
import type { FrozenRow, RouteCandidate } from "./types.ts";

const CONFIG: JevConfig = {
  enabled: true,
  apiKey: "fake-key",
  baseUrl: "https://fake.invalid",
  model: "local-fake",
  timeoutMs: 1000,
  maxRequestBytes: DEFAULT_JEV_MAX_REQUEST_BYTES,
  maxStateQuestionBytes: DEFAULT_JEV_MAX_STATE_QUESTION_BYTES,
};

const candidate = (id: string, content: string): RouteCandidate => ({
  id,
  namespace: "rico",
  candidateType: "fact",
  content,
  operatorText: null,
  unitKind: "exchange",
  anchorKind: "typed",
});

function row(candidateId: string, neighbourOf: string | null): FrozenRow {
  return {
    ordinal: 0,
    candidateId,
    namespace: "rico",
    contentHash: "f".repeat(64),
    source: neighbourOf === null ? "draw" : "neighbour",
    neighbourOf,
    snapshot: {
      id: candidateId,
      namespace: "rico",
      candidate_type: "rule",
      content: "c",
      content_hash: "f".repeat(64),
      operator_text: null,
      unit_kind: "exchange",
      anchor_kind: "typed",
      first_said_at: null,
      last_said_at: null,
      source_turn_ids: [],
    },
  };
}

describe("neighbourPairs", () => {
  it("pairs each row with a present parent, in item id order", () => {
    const pairs = neighbourPairs([
      row("A", null),
      row("C", "A"),
      row("B", "A"),
      row("D", "Z"),
    ]);
    expect(pairs.map((p) => [p.item.candidateId, p.member.candidateId])).toEqual([
      ["B", "A"],
      ["C", "A"],
    ]);
  });
});

describe("runRestatesPass", () => {
  const member = candidate("m", "worktrees are removed when the branch session ends");
  it("scores a restating pair at or above the cutoff", async () => {
    const item = candidate(
      "i",
      "remove worktrees once the branch merges; the session removed them",
    );
    const scores = await runRestatesPass({
      pairs: [{ item, member }],
      config: CONFIG,
      fetchFn: fakeJevFetch(),
    });
    expect(scores.get("i")).toBeGreaterThanOrEqual(RESTATES_AT_V2);
  });

  it("scores an unrelated pair below the cutoff", async () => {
    const item = candidate("u", "deploys ship by pushing a git tag to forge");
    const scores = await runRestatesPass({
      pairs: [{ item, member }],
      config: CONFIG,
      fetchFn: fakeJevFetch(),
    });
    expect(scores.get("u")).toBeLessThan(RESTATES_AT_V2);
  });

  it("feeds decideRouteV2 so a restating item is reinforced", async () => {
    const item = candidate(
      "i",
      "remove worktrees once the branch merges; the session removed them",
    );
    const scores = await runRestatesPass({
      pairs: [{ item, member }],
      config: CONFIG,
      fetchFn: fakeJevFetch(),
    });
    const matrix = loadMatrix(DEFAULT_MATRIX_PATH);
    const answers: Record<string, JevAnswer> = {
      [DEST_V2_ID]: {
        type: "choice",
        choice: "fact",
        probabilities: { fact: 0.9 },
        confidence: 0.9,
      },
      [LASTING_ID]: { type: "noul", noul: 0.9 },
      [DROVE_DECISION_ID]: { type: "noul", noul: 0 },
      [RESTATES_PAIR_ID]: { type: "noul", noul: scores.get("i") ?? 0 },
    };
    const decision = decideRouteV2(item, answers, matrix, DEFAULT_THRESHOLDS_V2);
    expect(decision.restates).toBe(true);
    expect(wouldApply(decision, row("i", "m"), matrix).action).toBe("reinforce");
  });
});
