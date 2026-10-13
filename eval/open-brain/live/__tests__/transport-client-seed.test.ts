import { describe, expect, it } from "vitest";
import { OpenBrainLiveClient, LiveTransportError } from "../transport.ts";
import {
  errored,
  fakeCaller,
  ok,
  expectTransportError,
} from "./transport-test-support.ts";

// The semantic client's seed / recall / isolation-probe surface. Every failure
// must be reduced to a content-free label, and the primary recall path must
// never swallow a denial (only the explicit isolation probe may). The redaction
// helpers themselves are covered in ./transport-redaction.test.ts, and the
// concrete MCP caller boundary in ./transport-mcp-caller.test.ts.

describe("OpenBrainLiveClient.logMemory", () => {
  it("returns the server id + namespace on a fresh create (merged:false)", async () => {
    const log = {
      calls: [] as Array<{ name: string; args: Record<string, unknown> }>,
    };
    const client = new OpenBrainLiveClient(
      fakeCaller(
        {
          log_thought: [
            ok(JSON.stringify({ id: "srv-1", namespace: "ns-a", merged: false })),
          ],
        },
        log,
      ),
    );
    const res = await client.logMemory({
      table: "thoughts",
      content: "c",
      tags: [],
      namespace: "ns-a",
    });
    expect(res).toEqual({ id: "srv-1", namespace: "ns-a", merged: false });
    expect(log.calls[0]?.args.namespace).toBe("ns-a");
  });

  it("throws a redacted LiveTransportError on failure (no raw body)", async () => {
    const client = new OpenBrainLiveClient(
      fakeCaller({ log_decision: [errored("log_decision:error")] }),
    );
    await expect(
      client.logMemory({
        table: "decisions",
        content: "c",
        tags: [],
        namespace: "n",
      }),
    ).rejects.toThrow(LiveTransportError);
  });
});

describe("OpenBrainLiveClient.logMemory fail-closed create contract", () => {
  it("FAILS CLOSED on a merged upsert (a stranded prior seed in a reused namespace)", async () => {
    // A create must be merged:false. merged:true means the server upserted onto
    // an EXISTING row -- a prior run's stranded seed in a reused namespace.
    // Treating it as a this-run creation and later archiving it would tombstone a
    // row this run did not create, so the seed must fail closed content-free.
    const client = new OpenBrainLiveClient(
      fakeCaller({
        log_thought: [
          ok(
            JSON.stringify({
              id: "srv-old",
              namespace: "ns-a",
              merged: true,
            }),
          ),
        ],
      }),
    );
    const err = expectTransportError(
      await client
        .logMemory({
          table: "thoughts",
          content: "c",
          tags: [],
          namespace: "ns-a",
        })
        .catch((e) => e as LiveTransportError),
    );
    expect(err).toBeInstanceOf(LiveTransportError);
    expect(err.label).toBe("log_thought:merged-upsert");
  });

  it("FAILS CLOSED when `merged` is missing or not a boolean", async () => {
    // No `merged` field at all: we cannot prove this was a fresh create.
    const missing = new OpenBrainLiveClient(
      fakeCaller({
        log_decision: [ok(JSON.stringify({ id: "srv-1", namespace: "ns-a" }))],
      }),
    );
    const missingErr = expectTransportError(
      await missing
        .logMemory({
          table: "decisions",
          content: "c",
          tags: [],
          namespace: "ns-a",
        })
        .catch((e) => e as LiveTransportError),
    );
    expect(missingErr).toBeInstanceOf(LiveTransportError);
    expect(missingErr.label).toBe("log_decision:missing-merged");

    // A non-boolean `merged` (string "false") is not a valid create signal.
    const nonBool = new OpenBrainLiveClient(
      fakeCaller({
        log_thought: [
          ok(JSON.stringify({ id: "srv-1", namespace: "ns-a", merged: "false" })),
        ],
      }),
    );
    const nonBoolErr = expectTransportError(
      await nonBool
        .logMemory({
          table: "thoughts",
          content: "c",
          tags: [],
          namespace: "ns-a",
        })
        .catch((e) => e as LiveTransportError),
    );
    expect(nonBoolErr.label).toBe("log_thought:missing-merged");
  });
});

describe("OpenBrainLiveClient.logMemory identity binding", () => {
  it("FAILS CLOSED when the returned namespace is not exactly the requested one", async () => {
    // A row that landed in a different namespace (or a response with no
    // namespace) is not where teardown/scoring were bound; do NOT default a
    // missing namespace to the requested one.
    const wrong = new OpenBrainLiveClient(
      fakeCaller({
        log_thought: [
          ok(
            JSON.stringify({
              id: "srv-1",
              namespace: "some-other-ns",
              merged: false,
            }),
          ),
        ],
      }),
    );
    const wrongErr = expectTransportError(
      await wrong
        .logMemory({
          table: "thoughts",
          content: "c",
          tags: [],
          namespace: "ns-a",
        })
        .catch((e) => e as LiveTransportError),
    );
    expect(wrongErr).toBeInstanceOf(LiveTransportError);
    expect(wrongErr.label).toBe("log_thought:namespace-mismatch");

    const absent = new OpenBrainLiveClient(
      fakeCaller({
        log_decision: [ok(JSON.stringify({ id: "srv-1", merged: false }))],
      }),
    );
    const absentErr = expectTransportError(
      await absent
        .logMemory({
          table: "decisions",
          content: "c",
          tags: [],
          namespace: "ns-a",
        })
        .catch((e) => e as LiveTransportError),
    );
    expect(absentErr.label).toBe("log_decision:namespace-mismatch");
  });

  it("still FAILS CLOSED on a missing id even when merged:false", async () => {
    const client = new OpenBrainLiveClient(
      fakeCaller({
        log_thought: [ok(JSON.stringify({ namespace: "ns-a", merged: false }))],
      }),
    );
    const err = expectTransportError(
      await client
        .logMemory({
          table: "thoughts",
          content: "c",
          tags: [],
          namespace: "ns-a",
        })
        .catch((e) => e as LiveTransportError),
    );
    expect(err.label).toBe("log_thought:missing-id");
  });
});
