/**
 * Structured-question and V2-record coverage for `dream-route-run-core.ts`
 * (`_plans/1469-jev-matrix.md` section 4). Free: no network, no Postgres.
 */
import { describe, expect, it } from "vitest";
import {
  buildJevBatchPlan,
  executeJevBatchPlan,
  type JevConfig,
} from "../server/integrations/jev.ts";
import type { RouteCandidate } from "../server/domain/dream-route/types.ts";
import { fakeJevFetch, recordOfV2 } from "../server/domain/dream-route/run-core.ts";

const CONFIG: JevConfig = {
  enabled: true,
  apiKey: "x",
  baseUrl: "https://example.invalid",
  model: "jev-test",
  timeoutMs: 5_000,
  maxRequestBytes: 64_000,
  maxStateQuestionBytes: 64_000,
};

const FIELDS = {
  operator_said: "never do timeout waits",
  distilled_item: "item",
  said_by: "the operator",
  unit_kind: "exchange",
  anchor_kind: null,
};

describe("dream-route-run-core structured fake", () => {
  it("fakeJevFetch answers a structured Choice and Noul over a record with fields", async () => {
    const plan = buildJevBatchPlan({
      sharedState: {},
      records: [{ key: "r1", content: "item", fields: FIELDS }],
      classifierSet: {
        name: "test",
        version: "1",
        classifiers: {
          pick: {
            type: "choice",
            instructions: { question: "Which?" },
            criteria: { a: { what: "timeout waits" }, none: { what: "nothing" } },
          },
          lasting: { type: "noul", instructions: { question: "lasting?" } },
        },
      },
      limits: CONFIG,
    });
    const { answers } = await executeJevBatchPlan(CONFIG, plan, fakeJevFetch());
    const record = answers.get("r1");
    const choice = record?.pick;
    expect(record?.lasting?.type).toBe("noul");
    expect(choice?.type).toBe("choice");
    if (choice?.type !== "choice") throw new Error("no choice answer");
    expect(choice.choice).toBe("a");
    expect(Object.keys(choice.probabilities).sort()).toEqual(["a", "none"]);
  });

  it("recordOfV2 carries the named fields", () => {
    const base: RouteCandidate = {
      id: "r1",
      namespace: "ns",
      candidateType: "correction",
      content: "item",
      operatorText: "never do timeout waits",
      unitKind: "exchange",
      anchorKind: null,
    };
    expect(recordOfV2(base)).toEqual({ key: "r1", content: "item", fields: FIELDS });
    expect(recordOfV2({ ...base, operatorText: null })).toEqual({
      key: "r1",
      content: "item",
      fields: { ...FIELDS, operator_said: null, said_by: "not recorded" },
    });
  });
});
