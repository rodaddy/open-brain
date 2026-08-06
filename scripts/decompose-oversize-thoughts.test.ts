import { describe, expect, test } from "bun:test";
import {
  buildTargetPlan,
  isRawTranscriptDump,
  REMEDIATION_VERSION,
} from "./decompose-oversize-thoughts.ts";

function transcript(records: number, messageChars = 20): string {
  return Array.from({ length: records }, (_, index) =>
    JSON.stringify({
      type: index % 2 === 0 ? "user" : "assistant",
      uuid: `turn-${index}`,
      sessionId: "session-604",
      message: { role: "user", content: "x".repeat(messageChars) },
    }),
  ).join("\n");
}

describe("decompose-oversize-thoughts", () => {
  test("recognizes the raw Claude transcript JSONL class", () => {
    expect(isRawTranscriptDump(transcript(120))).toEqual({
      matched: true,
      recordCount: 120,
    });
  });

  test("rejects prose, short JSONL, and malformed transcript rows", () => {
    expect(isRawTranscriptDump("ordinary thought prose").matched).toBe(false);
    expect(isRawTranscriptDump(transcript(10)).matched).toBe(false);
    expect(
      isRawTranscriptDump(`${transcript(120)}\nnot-json`).matched,
    ).toBe(false);
  });

  test("plans linked pieces through the existing decomposition chunker", () => {
    const content = transcript(120, 100);
    const plan = buildTargetPlan({
      id: "00000000-0000-4000-8000-000000000604",
      content,
      tags: ["planning"],
      source: "planning-skippy-agentspace",
      created_by: "skippy",
      namespace: "rico",
      tier: "warm",
      created_at: "2026-03-17T00:00:00Z",
      archived_at: null,
    });

    expect(plan).not.toBeNull();
    expect(plan?.decomposition.would_write).toBeGreaterThan(1);
    expect(plan?.decomposition.source_ref.id).toBe(
      "00000000-0000-4000-8000-000000000604",
    );
    expect(
      plan?.decomposition.proposed_replacements.every(
        (proposal) =>
          proposal.provenance.source === "dreamengine-decomposition" &&
          proposal.source_ref.id === plan.decomposition.source_ref.id,
      ),
    ).toBe(true);
    expect(REMEDIATION_VERSION).toBe("issue-604-v1");
  });
});
