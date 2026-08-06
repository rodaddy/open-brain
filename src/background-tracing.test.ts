import { describe, expect, test } from "bun:test";
import {
  BackgroundTraceRecorder,
  backgroundSessionId,
  type BackgroundTraceBody,
  type BackgroundTraceEmitter,
} from "./background-tracing.ts";

function recordingEmitter(): BackgroundTraceEmitter & {
  bodies: BackgroundTraceBody[];
} {
  const bodies: BackgroundTraceBody[] = [];
  return {
    bodies,
    emitBackground(body) {
      bodies.push(body);
    },
  };
}

describe("BackgroundTraceRecorder", () => {
  test("disabled tracing is a no-op around the original work", async () => {
    let calls = 0;
    const trace = new BackgroundTraceRecorder(undefined, {
      name: "disabled",
      tags: ["background-job"],
    });

    const result = await trace.span("work", async () => {
      calls++;
      return { value: 42 };
    });
    trace.finish(result);

    expect(result).toEqual({ value: 42 });
    expect(calls).toBe(1);
    expect(trace.active).toBe(false);
  });

  test("emits one job trace with stage and generation usage", async () => {
    const emitter = recordingEmitter();
    let now = 100;
    const trace = new BackgroundTraceRecorder(
      emitter,
      {
        name: "memory.distill",
        input: { job_id: "job-1" },
        tags: ["background-job", "dream"],
        sessionId: "session-569",
      },
      () => ++now,
    );

    await trace.span("distill.claim", async () => ["turn-1", "turn-2"], {
      output: (rowIds) => ({ row_ids: rowIds }),
    });
    await trace.generation(
      "distill.extract",
      async () => ({ candidates: ["candidate-1"], usage: { input: 8, output: 3 } }),
      {
        model: "test-llm",
        input: { row_ids: ["turn-1"] },
        output: (result) => ({ candidate_ids: result.candidates }),
        usageDetails: (result) => result.usage,
      },
    );
    trace.finish({ outcome: "succeeded" });

    expect(emitter.bodies).toHaveLength(1);
    expect(emitter.bodies[0]).toMatchObject({
      name: "memory.distill",
      sessionId: "session-569",
      output: { outcome: "succeeded" },
      metadata: { status: "success" },
      observations: [
        {
          name: "distill.claim",
          type: "span",
          output: { row_ids: ["turn-1", "turn-2"] },
        },
        {
          name: "distill.extract",
          type: "generation",
          model: "test-llm",
          usageDetails: { input: 8, output: 3 },
        },
      ],
    });
  });

  test("a broken trace summarizer cannot change a successful job result", async () => {
    const emitter = recordingEmitter();
    const trace = new BackgroundTraceRecorder(emitter, {
      name: "best-effort",
      tags: ["background-job"],
    });

    const result = await trace.span("work", async () => "job-result", {
      output: () => {
        throw new Error("summarizer failed");
      },
    });
    trace.finish(result);

    expect(result).toBe("job-result");
    expect(emitter.bodies).toHaveLength(1);
    expect(emitter.bodies[0]!.observations).toEqual([]);
  });

  test("records a failed stage and rethrows the original error", async () => {
    const emitter = recordingEmitter();
    const trace = new BackgroundTraceRecorder(emitter, {
      name: "nats.message",
      tags: ["background-job", "nats"],
    });
    const failure = new TypeError("provider failed");

    await expect(
      trace.span("nats.reply", async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    trace.fail(failure);

    expect(emitter.bodies[0]).toMatchObject({
      metadata: { status: "exception" },
      output: { error_class: "TypeError", error_message: "provider failed" },
      observations: [
        {
          name: "nats.reply",
          level: "ERROR",
          statusMessage: "TypeError",
        },
      ],
    });
  });
});

describe("backgroundSessionId", () => {
  test("prefers a payload session key and falls back to provenance", () => {
    expect(
      backgroundSessionId({
        payload: { session_key: "payload-session" },
        provenance: { session_key: "provenance-session" },
      }),
    ).toBe("payload-session");
    expect(
      backgroundSessionId({ provenance: { session_key: "provenance-session" } }),
    ).toBe("provenance-session");
  });
});
