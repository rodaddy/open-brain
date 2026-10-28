import { describe, expect, it } from "vitest";
import { buildJevBatchPlan } from "../../integrations/jev.ts";
import { DEST_V2_ID, LASTING_ID, NONE_OPTION } from "./decide-v2.ts";
import { DEFAULT_MATRIX_PATH, loadMatrix } from "./matrix.ts";
import { DROVE_DECISION_ID, buildRouteClassifierSet } from "./questions.ts";
import { buildRouteClassifierSetV2 } from "./questions-v2.ts";

const matrix = loadMatrix(DEFAULT_MATRIX_PATH);
const set = buildRouteClassifierSetV2(matrix);

describe("buildRouteClassifierSetV2", () => {
  it("names and versions the set by the matrix fingerprint", () => {
    expect(set.name).toBe("dream-route");
    expect(set.version).toBe(`dream-route-v2-${matrix.fingerprint}`);
  });

  it("asks exactly three classifiers in order", () => {
    expect(Object.keys(set.classifiers)).toEqual([
      LASTING_ID,
      DEST_V2_ID,
      DROVE_DECISION_ID,
    ]);
  });

  it("offers every matrix row plus none as a structured Choice option", () => {
    const question = set.classifiers[DEST_V2_ID];
    if (question?.type !== "choice") throw new Error("expected a choice question");
    const keys = Object.keys(question.criteria);
    expect(keys).toEqual([...matrix.rows.map((row) => row.name), NONE_OPTION]);
    for (const key of keys) {
      const option = question.criteria[key];
      if (option === null || typeof option !== "object") {
        throw new Error(`expected structured criteria for ${key}`);
      }
      expect(Object.keys(option)).toEqual(["what", "not_for", "examples"]);
    }
    for (const row of matrix.rows) {
      const option = question.criteria[row.name];
      if (option === null || typeof option !== "object") throw new Error("structured");
      expect(option.what).toBe(row.line);
    }
  });

  it("routes settling agreement away from none to decision", () => {
    const question = set.classifiers[DEST_V2_ID];
    if (question?.type !== "choice") throw new Error("expected a choice question");
    const none = question.criteria[NONE_OPTION];
    if (none === null || typeof none !== "object") throw new Error("structured");
    expect(none.not_for).toContain("`decision`");
  });

  it("gives both Nouls true/false criteria and structured record-path instructions", () => {
    for (const id of [LASTING_ID, DROVE_DECISION_ID]) {
      const question = set.classifiers[id];
      if (question?.type !== "noul") throw new Error("expected a noul question");
      expect(Object.keys(question.criteria ?? {})).toEqual(["true", "false"]);
      if (typeof question.instructions === "string") throw new Error("structured");
      expect(question.instructions.question).toContain(
        "records[0].fields.operator_said",
      );
    }
  });

  it("passes the Jev planner's validation", () => {
    const plan = buildJevBatchPlan({
      sharedState: {},
      records: [{ key: "r", content: "c", fields: { operator_said: "go" } }],
      classifierSet: set,
      limits: {
        model: "jev-1.13.0",
        maxRequestBytes: 192000,
        maxStateQuestionBytes: 96000,
      },
    });
    expect(plan.batches).toHaveLength(1);
    const questions = plan.batches[0]?.questions ?? {};
    expect(Object.keys(questions)).toHaveLength(3);
    const instructions = questions.r0_c1?.instructions;
    if (typeof instructions !== "object") throw new Error("structured");
    expect(instructions.judge_only).toBe("record key r at records[0]");
  });

  it("leaves the V1 set untouched", () => {
    const v1 = buildRouteClassifierSet(matrix);
    expect(v1.version.startsWith("dream-route-v1-")).toBe(true);
    expect(Object.keys(v1.classifiers)).toHaveLength(8);
  });
});
