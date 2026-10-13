import { describe, expect, it } from "vitest";

import { remFrozenHumanLabelSchema } from "./rem-frozen-human-label.ts";

const CANDIDATE_ID = "8c0d3a16-44bc-4ca5-b0a2-c7967b1d30be";

describe("remFrozenHumanLabelSchema", () => {
  it.each(["promoted", "rejected", "duplicate", "inconclusive"] as const)(
    "accepts the human grade %s",
    (grade) => {
      expect(
        remFrozenHumanLabelSchema.parse({ candidate_id: CANDIDATE_ID, grade }),
      ).toEqual({ candidate_id: CANDIDATE_ID, grade });
    },
  );

  it("accepts an optional note", () => {
    expect(
      remFrozenHumanLabelSchema.parse({
        candidate_id: CANDIDATE_ID,
        grade: "inconclusive",
        note: "Needs more source context.",
      }),
    ).toEqual({
      candidate_id: CANDIDATE_ID,
      grade: "inconclusive",
      note: "Needs more source context.",
    });
  });

  it("rejects an unknown grade at the grade field", () => {
    const result = remFrozenHumanLabelSchema.safeParse({
      candidate_id: CANDIDATE_ID,
      grade: "approved",
    });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues[0]?.path).toEqual(["grade"]);
  });

  it("rejects an invalid candidate UUID at the candidate_id field", () => {
    const result = remFrozenHumanLabelSchema.safeParse({
      candidate_id: "candidate-1",
      grade: "promoted",
    });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues[0]?.path).toEqual(["candidate_id"]);
  });

  it.each(["machine_grade", "reviewer", "namespace", "snapshot_hash"])(
    "rejects caller-supplied %s",
    (field) => {
      const result = remFrozenHumanLabelSchema.safeParse({
        candidate_id: CANDIDATE_ID,
        grade: "promoted",
        [field]: "caller-controlled",
      });

      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.error.issues[0]?.code).toBe("unrecognized_keys");
    },
  );
});
