import { describe, expect, test } from "bun:test";
import {
  diffTraces,
  digestOutput,
  renderRepeatReport,
  renderSessionTraces,
  renderTimeline,
  renderTraceDiff,
  traceDiffExitCode,
  type LangfuseTrace,
} from "./langfuse-trace-lib.ts";

async function fixture(name: string): Promise<LangfuseTrace> {
  return Bun.file(new URL(`./fixtures/${name}`, import.meta.url)).json();
}

describe("Langfuse trace forensics", () => {
  test("digests nested count and row-id evidence without returning content", () => {
    const digest = digestOutput({
      count: 2,
      row_ids: ["row-1", "row-2"],
      nested: { selected_count: 1, selected_row_ids: ["row-1"] },
      candidates: [{ row_id: "row-1" }, { row_id: "row-2" }],
      content: "must not appear",
    });

    expect(digest).toBe(
      "count=2 row_ids=[row-1,row-2] nested.selected_count=1 nested.selected_row_ids=[row-1] candidate_row_ids=[row-1,row-2]",
    );
    expect(digest).not.toContain("must not appear");
  });

  test("renders trace identity and observations in start-time order", async () => {
    const output = renderTimeline(await fixture("langfuse-trace-a.json"));
    const vectorIndex = output.indexOf("retrieval.vector_query");
    const rankIndex = output.indexOf("retrieval.rank_rrf");

    expect(output).toContain("name=search_brain");
    expect(output).toContain("release=abc1234");
    expect(output).toContain("sessionId=session-569");
    expect(output).toContain("caller=user=rico client=rico token_client=rico agent=trace-fixture role=agent");
    expect(output).toContain("status=success");
    expect(vectorIndex).toBeGreaterThan(0);
    expect(rankIndex).toBeGreaterThan(vectorIndex);
    expect(output).toContain("stage=candidate_generation duration_ms=50");
    expect(output).toContain("row_ids=[row-1,row-2]");
  });

  test("treats duration, score, release, and namespace changes as informational when evidence is equivalent", async () => {
    const left = await fixture("langfuse-trace-a.json");
    const right = structuredClone(left);
    right.id = "trace-equivalent";
    right.release = "different-release";
    const root = right.observations?.find((observation) => !observation.parentObservationId);
    if (root?.metadata) {
      root.metadata.duration_ms = 999;
      root.metadata.resolved_namespace = ["rico"];
    }
    const rank = right.observations?.find((observation) => observation.name === "retrieval.rank_rrf");
    const candidate = (rank?.output as { candidates?: Array<Record<string, unknown>> })?.candidates?.[0];
    if (candidate) candidate.rrf_score = 0.5;

    const comparison = diffTraces(left, right);

    expect(comparison.equivalent).toBeTrue();
    expect(traceDiffExitCode(comparison)).toBe(0);
    expect(comparison.releaseB).toBe("different-release");
    expect(comparison.namespaceB).toBe("rico");
    expect(comparison.stages.find((stage) => stage.name === "retrieval.rank_rrf")?.scoreDeltas).toContain(
      "row-1.rrf_score: 0.03 -> 0.5 delta=0.47",
    );
  });

  test("non-equivalent fixture pair reports evidence changes and the diff exit path", async () => {
    const comparison = diffTraces(
      await fixture("langfuse-trace-a.json"),
      await fixture("langfuse-trace-b.json"),
    );
    const output = renderTraceDiff(comparison);

    expect(comparison.equivalent).toBeFalse();
    expect(traceDiffExitCode(comparison)).toBe(1);
    expect(output).toContain("equivalent=false");
    expect(output).toContain("release A=abc1234 B=def5678");
    expect(output).toContain("namespace A=rico,shared-kb B=rico");
    expect(output).toContain("candidate_row_ids added=row-3 removed=row-2");
    expect(output).toContain("chosen_row_ids added=row-3 removed=row-1");
    expect(output).toContain("row-1: — -> rrf_window");
    expect(output).toContain("row-1.rrf_score: 0.03 -> 0.025");
  });

  test("renders session summaries in chronological order with status and duration", async () => {
    const first = await fixture("langfuse-trace-a.json");
    const second = await fixture("langfuse-trace-b.json");
    const output = renderSessionTraces([second, first]);

    expect(output.split("\n")[0]).toStartWith("trace-a search_brain 2026-08-06T12:00:00.000Z");
    expect(output).toContain("release=abc1234 status=success duration_ms=120");
    expect(output.split("\n")[1]).toStartWith("trace-b search_brain 2026-08-06T12:01:00.000Z");
  });

  test("repeat report names the fields that vary by stage", async () => {
    const output = renderRepeatReport("session-569", [
      await fixture("langfuse-trace-a.json"),
      await fixture("langfuse-trace-b.json"),
    ]);

    expect(output).toContain("stage=retrieval.rank_rrf VARIES");
    expect(output).toContain("candidate_row_ids");
    expect(output).toContain("chosen_row_ids");
    expect(output).toContain("score_fields");
    expect(output).toContain("stage=search_brain VARIES fields=duration_ms");
  });
});
