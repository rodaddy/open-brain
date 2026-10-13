import { describe, expect, it } from "vitest";
import { DEFAULT_MATRIX_PATH, loadMatrix } from "./matrix.ts";
import {
  DEST_ID,
  DROVE_DECISION_ID,
  RESTATES_ID,
  buildRouteClassifierSet,
  ynId,
} from "./questions.ts";
import { DESTINATIONS } from "./types.ts";

const matrix = loadMatrix(DEFAULT_MATRIX_PATH);
const set = buildRouteClassifierSet(matrix);

describe("buildRouteClassifierSet", () => {
  it("names and versions the set by the matrix fingerprint", () => {
    expect(set.name).toBe("dream-route");
    expect(set.version).toBe(`dream-route-v1-${matrix.fingerprint}`);
  });

  it("asks one choice over every destination, keyed by the matrix lines", () => {
    const question = set.classifiers[DEST_ID];
    expect(question?.type).toBe("choice");
    if (question?.type !== "choice") throw new Error("expected a choice question");
    expect(Object.keys(question.criteria)).toEqual([...DESTINATIONS]);
    expect(question.criteria.rule).toBe(
      matrix.rows.find((row) => row.name === "rule")?.line,
    );
    expect(question.instructions).toContain("the operator's words decide");
  });

  it("asks one criteria-free yes/no per destination", () => {
    for (const row of matrix.rows) {
      const question = set.classifiers[ynId(row.name)];
      expect(question?.type).toBe("noul");
      expect(question?.instructions).toBe(`Does this describe the item: ${row.line}?`);
      if (question?.type !== "noul") throw new Error("expected a noul question");
      expect(question.criteria).toBeUndefined();
    }
  });

  it("asks the restates and drove-decision flags without criteria", () => {
    for (const id of [RESTATES_ID, DROVE_DECISION_ID]) {
      const question = set.classifiers[id];
      expect(question?.type).toBe("noul");
      if (question?.type !== "noul") throw new Error("expected a noul question");
      expect(question.criteria).toBeUndefined();
    }
    expect(set.classifiers[RESTATES_ID]?.instructions).toContain("same request");
    expect(set.classifiers[DROVE_DECISION_ID]?.instructions).toContain(
      "settle a decision",
    );
  });

  it("has exactly one classifier per destination plus the choice and two flags", () => {
    expect(Object.keys(set.classifiers)).toHaveLength(DESTINATIONS.length + 3);
  });
});
