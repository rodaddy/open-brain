import { describe, expect, it } from "bun:test";
import {
  LiveTransportError,
  OpenBrainLiveClient,
  parseContextPackPayload,
  type OpenBrainToolCaller,
  type ToolCallResult,
} from "../transport.ts";
import { setUpCompletePackClients } from "../complete-pack-setup.ts";
import type { LiveEvalConfig } from "../config.ts";

// Transport-boundary tests for the complete-pack additions: parseContextPackPayload
// normalization / fail-closed behavior, the OpenBrainLiveClient.contextPack call
// shape, and the client-setup lifecycle (primary closed if negative connect
// fails). These exercise the REAL parse path, not a fake at the client seam.

describe("parseContextPackPayload", () => {
  it("normalizes a well-formed pack object into structural containers", () => {
    const payload = parseContextPackPayload(
      JSON.stringify({
        status: "ok",
        sections: { durable_memory: { items: [], item_count: 0 } },
        citations: [{ id: "brain_record:thought:x" }, "not-an-object"],
        budget: { whole_pack: { content_char_limit: 100 } },
        warnings: {
          scope_denials: [{ source: "durable_lane_context" }],
          degraded_sources: [],
          truncation: [{ source: "durable_memory", starved: true }],
        },
      }),
    );
    expect(payload.status).toBe("ok");
    expect(payload.sections.durable_memory).toBeDefined();
    // Non-object citation entries are filtered out.
    expect(payload.citations.length).toBe(1);
    expect(payload.warnings.scope_denials.length).toBe(1);
    expect(payload.warnings.truncation[0]!.starved).toBe(true);
  });

  it("defaults missing containers to their empty forms", () => {
    const payload = parseContextPackPayload(JSON.stringify({ status: "ok" }));
    expect(payload.sections).toEqual({});
    expect(payload.citations).toEqual([]);
    expect(payload.budget).toEqual({});
    expect(payload.warnings.scope_denials).toEqual([]);
    expect(payload.warnings.degraded_sources).toEqual([]);
    expect(payload.warnings.truncation).toEqual([]);
  });

  it("fails closed content-free on a non-object body (never an empty pack)", () => {
    expect(() => parseContextPackPayload("[1,2,3]")).toThrow(
      LiveTransportError,
    );
    expect(() => parseContextPackPayload("not json")).toThrow(
      LiveTransportError,
    );
    try {
      parseContextPackPayload("[1,2,3]");
    } catch (error) {
      const err = error as LiveTransportError;
      expect(err.label).toBe("agent_context_pack:malformed-payload");
    }
  });
});

describe("OpenBrainLiveClient.contextPack", () => {
  function scriptedCaller(result: ToolCallResult): {
    caller: OpenBrainToolCaller;
    calls: Array<{ name: string; args: Record<string, unknown> }>;
  } {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    return {
      caller: {
        async callTool(name, args) {
          calls.push({ name, args });
          return result;
        },
        async close() {},
      },
      calls,
    };
  }

  const ok = (data: string): ToolCallResult => ({
    isError: false,
    denied: false,
    data,
    errorLabel: "",
  });

  it("sends the requested sections + budget + scope and parses the payload", async () => {
    const { caller, calls } = scriptedCaller(
      ok(JSON.stringify({ status: "ok", sections: {}, citations: [] })),
    );
    const client = new OpenBrainLiveClient(caller);
    const payload = await client.contextPack({
      scope: {
        namespace: "eval-ns",
        agent: "a",
        platform: "p",
        server_id: "s",
        channel_id: "c",
        session_key: "k",
      },
      query: "q",
      requestedSections: ["working_set", "durable_memory"],
      budgetMaxTokens: 6000,
    });
    expect(payload.status).toBe("ok");
    expect(calls.length).toBe(1);
    expect(calls[0]!.name).toBe("agent_context_pack");
    expect(calls[0]!.args.namespace).toBe("eval-ns");
    expect(calls[0]!.args.requested_sections).toEqual([
      "working_set",
      "durable_memory",
    ]);
    expect(calls[0]!.args.budget).toEqual({ max_tokens: 6000 });
    // No thread_id in scope -> not sent.
    expect("thread_id" in (calls[0]!.args as object)).toBe(false);
  });

  it("throws a redacted error on a denied pack call", async () => {
    const { caller } = scriptedCaller({
      isError: true,
      denied: true,
      data: "",
      errorLabel: "agent_context_pack:permission-denied",
    });
    const client = new OpenBrainLiveClient(caller);
    await expect(
      client.contextPack({
        scope: {
          namespace: "eval-ns",
          agent: "a",
          platform: "p",
          server_id: "s",
          channel_id: "c",
          session_key: "k",
        },
        query: "q",
        requestedSections: ["working_set"],
      }),
    ).rejects.toThrow(LiveTransportError);
  });
});

describe("setUpCompletePackClients lifecycle", () => {
  const CONFIG: LiveEvalConfig = {
    baseUrl: "http://127.0.0.1:3100",
    primaryToken: "t",
    negativeToken: "t",
    negativeTokenIsDistinct: false,
    primaryNamespace: "ns-primary",
    negativeNamespace: "ns-negative",
    searchMode: "hybrid",
    timeoutMs: 1000,
  };

  it("closes the primary caller when the negative connect fails", async () => {
    let primaryClosed = 0;
    const factory = async (opts: { namespace: string }) => {
      if (opts.namespace === CONFIG.negativeNamespace) {
        throw new LiveTransportError("connect:transport-error", false);
      }
      return {
        async callTool() {
          return { isError: false, denied: false, data: "", errorLabel: "" };
        },
        async close() {
          primaryClosed += 1;
        },
      } as OpenBrainToolCaller;
    };
    await expect(setUpCompletePackClients(CONFIG, factory)).rejects.toThrow(
      LiveTransportError,
    );
    // The successfully-connected primary was closed so no session leaks.
    expect(primaryClosed).toBe(1);
  });
});
