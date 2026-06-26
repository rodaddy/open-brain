import { describe, expect, it } from "bun:test";
import { AgentMemory, type JsonObject } from "../agent-memory.ts";
import { scoreProbe } from "../../eval/open-brain/runner.ts";
import type { EvalCorpusEntry, EvalProbe } from "../../eval/open-brain/types.ts";

class FakeTransport {
  calls: Array<{ name: string; args: JsonObject }> = [];

  callTool(name: string, args: JsonObject): JsonObject {
    this.calls.push({ name, args });
    return { tool: name, args };
  }
}

describe("AgentMemory TypeScript wrapper", () => {
  it("starts a lane with contract-shaped session_start arguments", async () => {
    const transport = new FakeTransport();
    const memory = new AgentMemory(transport, {
      agent: "codex",
      project: "open-brain",
      source: "codex-local",
    });

    await memory.start({
      sessionKey: "open-brain/run",
      topic: "memory substrate",
      channelId: "chan-1",
      threadId: "thread-1",
      metadata: { color: "blue" },
    });

    expect(transport.calls).toEqual([
      {
        name: "session_start",
        args: {
          session_key: "open-brain/run",
          agent: "codex",
          project: "open-brain",
          source: "codex-local",
          topic: "memory substrate",
          channel_id: "chan-1",
          thread_id: "thread-1",
          metadata: { color: "blue" },
        },
      },
    ]);
  });

  it("recalls session context, search results, and optional cited answer", async () => {
    const transport = new FakeTransport();
    const memory = new AgentMemory(transport, { agent: "codex" });
    await memory.start({ sessionKey: "open-brain/run" });

    await memory.recall({
      query: "adapter contract",
      limit: 5,
      includeAnswer: true,
      searchMode: "hybrid",
      tier: "warm",
    });

    expect(transport.calls.map((call) => call.name)).toEqual([
      "session_start",
      "session_context",
      "search_all",
      "brain_answer",
    ]);
    expect(transport.calls[1]!.args).toEqual({
      session_key: "open-brain/run",
      include_events: true,
      event_limit: 5,
    });
    expect(transport.calls[2]!.args).toEqual({
      query: "adapter contract",
      limit: 5,
      search_mode: "hybrid",
      tier: "warm",
    });
  });

  it("refreshes lane context through lane_upsert", async () => {
    const transport = new FakeTransport();
    const memory = new AgentMemory(transport, {
      agent: "codex",
      project: "open-brain",
      source: "codex-local",
    });
    await memory.start({ sessionKey: "open-brain/run" });

    await memory.refreshLane({
      status: "active",
      topic: "memory substrate",
      currentContextMd: "Phase B wrapper in progress.",
      metadata: { color: "blue" },
    });

    expect(transport.calls[1]).toEqual({
      name: "lane_upsert",
      args: {
        session_key: "open-brain/run",
        agent: "codex",
        source: "codex-local",
        project: "open-brain",
        topic: "memory substrate",
        current_context_md: "Phase B wrapper in progress.",
        status: "active",
        metadata: { color: "blue" },
      },
    });
  });

  it("appends events and nominations without caller-controlled authority keys", async () => {
    const transport = new FakeTransport();
    const memory = new AgentMemory(transport, { agent: "codex", source: "codex" });
    await memory.start({ sessionKey: "open-brain/run" });

    await memory.appendEvent({
      eventType: "action",
      content: "Implemented wrapper.",
      artifactPath: "src/agent-memory.ts",
      importance: "hot",
      metadata: { issue: 209 },
    });
    await memory.nominateShared({
      eventType: "decision",
      content: "Use a caller-provided transport for the TS memory wrapper.",
      metadata: { reason: "keeps server auth boundary owned by Open Brain" },
    });

    expect(transport.calls[1]!.args).toEqual({
      session_key: "open-brain/run",
      event_type: "action",
      content: "Implemented wrapper.",
      source: "codex",
      metadata: { issue: 209 },
      artifact_path: "src/agent-memory.ts",
      importance: "hot",
    });
    expect(transport.calls[2]!.args).toMatchObject({
      session_key: "open-brain/run",
      event_type: "decision",
      metadata: {
        reason: "keeps server auth boundary owned by Open Brain",
        share_candidate: true,
      },
    });
  });

  it("records openbrain.receipt.v1 metadata through receipt events", async () => {
    const transport = new FakeTransport();
    const memory = new AgentMemory(transport, {
      agent: "codex",
      project: "open-brain",
    });
    await memory.start({ sessionKey: "open-brain/run" });

    await memory.recordReceipt({
      action: "contract_update",
      timestamp: "2026-06-26T16:00:00.000Z",
      sources: [{ kind: "repo_path", path: "docs/agent-memory-adapter-contract.md" }],
      outputs: [{ kind: "repo_path", path: "src/agent-memory.ts" }],
      validations: [{ kind: "test", status: "passed", command: "bun test" }],
      residualRisk: "Review still pending.",
    });

    expect(transport.calls[1]!.name).toBe("append_session_event");
    expect(transport.calls[1]!.args).toMatchObject({
      session_key: "open-brain/run",
      event_type: "receipt",
      content: "Receipt: contract_update",
      metadata: {
        receipt: {
          schema: "openbrain.receipt.v1",
          action: "contract_update",
          agent: "codex",
          session_key: "open-brain/run",
          timestamp: "2026-06-26T16:00:00.000Z",
          project: "open-brain",
          residual_risk: "Review still pending.",
        },
      },
    });
  });

  it("rejects malformed receipt evidence before writing events", async () => {
    const transport = new FakeTransport();
    const memory = new AgentMemory(transport, { agent: "codex" });
    await memory.start({ sessionKey: "session-receipt-validation" });

    await expect(
      memory.recordReceipt({
        action: "bad_receipt",
        sources: ["not-an-object"] as any,
        outputs: [],
        validations: [],
      }),
    ).rejects.toThrow("sources[0] must be an object");
    await expect(
      memory.recordReceipt({
        action: "bad_receipt",
        sources: [{ headers: { authorization: "Bearer secret" } }],
        outputs: [],
        validations: [],
      }),
    ).rejects.toThrow("reserved authority key");
    await expect(
      memory.recordReceipt({
        action: "bad_receipt",
        sources: [],
        outputs: [],
        validations: [{ kind: "", status: "passed" }],
      }),
    ).rejects.toThrow("validations[0].kind must be a non-empty string");

    expect(transport.calls.filter((call) => call.name === "append_session_event")).toHaveLength(0);
  });

  it("wraps repo fact tools with contract-shaped filters and payloads", async () => {
    const transport = new FakeTransport();
    const memory = new AgentMemory(transport, {
      agent: "codex",
      project: "open-brain",
    });

    await memory.listRepoFacts({
      repo: "rodaddy/open-brain",
      collection: "source",
      path: "src/agent-memory.ts",
      factType: "api_contract",
      subject: "AgentMemory",
      limit: 10,
      offset: 5,
    });
    await memory.upsertRepoFact({
      metadata: {
        repo: "rodaddy/open-brain",
        collection: "source",
        path: "src/agent-memory.ts",
        fact_type: "api_contract",
        subject: "AgentMemory",
        fact: "AgentMemory wraps Open Brain tool calls.",
      },
      validation: {
        source_url:
          "https://github.com/rodaddy/open-brain/blob/abc/src/agent-memory.ts",
      },
    });

    expect(transport.calls[0]).toEqual({
      name: "list_repo_facts",
      args: {
        repo: "rodaddy/open-brain",
        collection: "source",
        path: "src/agent-memory.ts",
        fact_type: "api_contract",
        subject: "AgentMemory",
        limit: 10,
        offset: 5,
      },
    });
    expect(transport.calls[1]).toEqual({
      name: "upsert_repo_fact",
      args: {
        metadata: {
          repo: "rodaddy/open-brain",
          collection: "source",
          path: "src/agent-memory.ts",
          fact_type: "api_contract",
          subject: "AgentMemory",
          fact: "AgentMemory wraps Open Brain tool calls.",
        },
        validation: {
          source_url:
            "https://github.com/rodaddy/open-brain/blob/abc/src/agent-memory.ts",
        },
      },
    });
  });

  it("preserves Hermes channel, thread, platform, and profile metadata", async () => {
    const transport = new FakeTransport();
    const memory = new AgentMemory(transport, {
      agent: "bilby",
      project: "open-brain",
      source: "hermes-discord",
    });

    await memory.start({
      sessionKey: "hermes/discord/chan-1/thread-1",
      topic: "Discord memory handoff",
      channelId: "chan-1",
      threadId: "thread-1",
      metadata: {
        platform: "discord",
        agent_profile: "bilby-default",
        transport: "openbrain-memory",
      },
    });
    await memory.refreshLane({
      currentContextMd: "Hermes adapter fixture keeps channel identity.",
      metadata: {
        platform: "discord",
        agent_profile: "bilby-default",
      },
    });
    await memory.recordReceipt({
      action: "hermes_lifecycle_fixture",
      timestamp: "2026-06-26T17:00:00.000Z",
      sources: [
        {
          kind: "external_channel",
          platform: "discord",
          channel_id: "chan-1",
          thread_id: "thread-1",
        },
      ],
      outputs: [{ kind: "session_event", event_type: "receipt" }],
      validations: [{ kind: "fake_transport", status: "passed" }],
    });

    expect(transport.calls[0]).toMatchObject({
      name: "session_start",
      args: {
        session_key: "hermes/discord/chan-1/thread-1",
        agent: "bilby",
        project: "open-brain",
        source: "hermes-discord",
        channel_id: "chan-1",
        thread_id: "thread-1",
        metadata: {
          platform: "discord",
          agent_profile: "bilby-default",
          transport: "openbrain-memory",
        },
      },
    });
    expect(transport.calls[1]).toMatchObject({
      name: "lane_upsert",
      args: {
        session_key: "hermes/discord/chan-1/thread-1",
        agent: "bilby",
        source: "hermes-discord",
        metadata: {
          platform: "discord",
          agent_profile: "bilby-default",
        },
      },
    });
    expect(transport.calls[2]).toMatchObject({
      name: "append_session_event",
      args: {
        event_type: "receipt",
        source: "hermes-discord",
        metadata: {
          receipt: {
            schema: "openbrain.receipt.v1",
            action: "hermes_lifecycle_fixture",
            agent: "bilby",
            sources: [
              {
                kind: "external_channel",
                platform: "discord",
                channel_id: "chan-1",
                thread_id: "thread-1",
              },
            ],
          },
        },
      },
    });
  });

  it("compacts by reading context before writing a session wrap", async () => {
    const transport = new FakeTransport();
    const memory = new AgentMemory(transport, {
      agent: "codex",
      project: "open-brain",
    });
    await memory.start({ sessionKey: "open-brain/run" });

    await memory.compact({
      summary: "Phase A contract complete.",
      keyDecisions: ["Keep auth authority server-side."],
      nextSteps: ["Implement TS wrapper tests."],
      receiptRefs: ["https://github.com/rodaddy/open-brain/issues/207#receipt"],
    });

    expect(transport.calls.map((call) => call.name)).toEqual([
      "session_start",
      "session_context",
      "session_wrap",
    ]);
    expect(transport.calls[2]!.args).toEqual({
      session_key: "open-brain/run",
      summary: "Phase A contract complete.",
      project: "open-brain",
      key_decisions: ["Keep auth authority server-side."],
      next_steps: ["Implement TS wrapper tests."],
      metadata: {
        receipt_refs: ["https://github.com/rodaddy/open-brain/issues/207#receipt"],
      },
    });
  });

  it("rejects reserved top-level and nested authority metadata", async () => {
    const transport = new FakeTransport();
    const memory = new AgentMemory(transport, { agent: "codex" });

    expect(() =>
      memory.start({
        sessionKey: "open-brain/run",
        metadata: { namespace: "shared-kb" },
      }),
    ).toThrow("reserved keys: namespace");

    await memory.start({ sessionKey: "open-brain/run" });
    expect(() =>
      memory.appendEvent({
        content: "unsafe",
        metadata: { nested: { token: "secret" } },
      }),
    ).toThrow("reserved authority key");
  });

  it("bounds metadata key count, key length, and JSON size", () => {
    const memory = new AgentMemory(new FakeTransport(), { agent: "codex" });
    const tooManyKeys = Object.fromEntries(
      Array.from({ length: 51 }, (_, index) => [`key_${index}`, index]),
    );

    expect(() =>
      memory.start({
        sessionKey: "open-brain/run",
        metadata: tooManyKeys,
      }),
    ).toThrow("at most 50 keys");
    expect(() =>
      memory.start({
        sessionKey: "open-brain/run",
        metadata: { ["x".repeat(101)]: true },
      }),
    ).toThrow("metadata key exceeds 100 characters");
    expect(() =>
      memory.start({
        sessionKey: "open-brain/run",
        metadata: { value: "x".repeat(100001) },
      }),
    ).toThrow("metadata JSON exceeds 100000 bytes");
  });

  it("exports a deterministic OKF-like disclosure bundle", async () => {
    const memory = new AgentMemory(new FakeTransport(), { agent: "codex" });

    await memory.start({
      sessionKey: "session-disclosure",
      topic: "Memory substrate fixture",
      metadata: {
        okf: {
          type: "collection",
          x_unknown_okf_key: "preserved",
        },
      },
    });

    const bundle = memory.exportDisclosureBundle({
      lane: {
        topic: "Memory substrate fixture",
        metadata: {
          okf: {
            type: "collection",
            x_unknown_okf_key: "preserved",
          },
        },
      },
      events: [
        {
          id: "event-2",
          type: "artifact",
          content: "Generated report artifact.",
          timestamp: "2026-06-26T12:05:00.000Z",
          artifactPath: "reports/memory-substrate.md",
        },
        {
          id: "event-1",
          type: "decision",
          content: "OKF is an edge disclosure profile, not storage.",
          timestamp: "2026-06-26T12:00:00.000Z",
          sourceRef: "docs/memory-contract.md:207",
        },
      ],
      repoFacts: [
        {
          id: "fact-okf-edge",
          subject: "OKF edge profile",
          fact: "Open Brain exports OKF-like bundles without changing storage.",
          sourceUrl: "https://github.com/rodaddy/open-brain/issues/215",
          path: "docs/memory-contract.md",
          metadata: {
            okf: {
              type: "concept",
              extra_vendor_key: "kept",
            },
          },
        },
      ],
      receipts: [
        {
          id: "receipt-1",
          action: "build_disclosure_fixture",
          timestamp: "2026-06-26T12:10:00.000Z",
          sources: [{ kind: "file", path: "docs/memory-contract.md" }],
          outputs: [{ kind: "bundle", path: "index.md" }],
          validations: [{ kind: "bun", status: "passed", command: "bun test" }],
        },
      ],
    });

    expect(bundle.profile).toBe("okf-like");
    expect(bundle.files.map((file) => file.path)).toEqual([
      "index.md",
      "log.md",
      "concepts/okf-edge-profile.md",
      "citations.md",
      "receipts.md",
    ]);
    expect(bundle.files[0]!.content).toContain('"x_unknown_okf_key":"preserved"');
    expect(bundle.files[1]!.content.indexOf("OKF is an edge")).toBeLessThan(
      bundle.files[1]!.content.indexOf("Generated report artifact"),
    );
    expect(bundle.files.find((file) => file.path === "citations.md")!.content).toContain(
      "fact:fact-okf-edge:source_url",
    );
    expect(bundle.files.find((file) => file.path === "receipts.md")!.content).toContain(
      "build_disclosure_fixture",
    );
    for (const file of bundle.files) {
      expect(file.content).toContain("type:");
      expect(file.content).not.toContain("kind:");
    }
  });

  it("keeps disclosure bundle identity bound to the active lane", async () => {
    const memory = new AgentMemory(new FakeTransport(), {
      agent: "codex",
      project: "open-brain",
    });
    await memory.start({ sessionKey: "real-session" });

    const bundle = memory.exportDisclosureBundle({
      lane: {
        sessionKey: "spoofed-session",
        agent: "spoofed-agent",
        project: "spoofed-project",
        topic: "Caller label is allowed",
      },
    });
    const index = bundle.files.find((file) => file.path === "index.md")!.content;
    expect(index).toContain('session_key: "real-session"');
    expect(index).toContain('agent: "codex"');
    expect(index).toContain('project: "open-brain"');
    expect(index).not.toContain("spoofed-session");
    expect(index).not.toContain("spoofed-agent");
    expect(index).not.toContain("spoofed-project");
  });

  it("feeds wrapper receipt/export evidence into the memory substrate eval shape", async () => {
    const transport = new FakeTransport();
    const memory = new AgentMemory(transport, {
      agent: "codex",
      project: "open-brain",
    });
    await memory.start({ sessionKey: "eval-session" });
    await memory.recordReceipt({
      action: "report_generation",
      timestamp: "2026-06-26T12:10:00.000Z",
      sources: [
        { kind: "repo_path", path: "docs/source-a.md" },
        { kind: "base_document", path: "reports/base-template.pdf" },
      ],
      outputs: [{ kind: "artifact", path: "reports/generated-report.md" }],
      validations: [{ kind: "manual", status: "passed", summary: "manual PDF comparison" }],
    });
    const receipt = (transport.calls.find((call) => call.name === "append_session_event")!.args
      .metadata as any).receipt;
    const bundle = memory.exportDisclosureBundle({
      receipts: [
        {
          id: "receipt-complete-report",
          action: receipt.action,
          timestamp: receipt.timestamp,
          sources: receipt.sources,
          outputs: receipt.outputs,
          validations: receipt.validations,
        },
      ],
    });
    const receiptPreview = bundle.files.find((file) => file.path === "receipts.md")!.content;
    const corpus: EvalCorpusEntry[] = [
      {
        id: "receipt-complete-report",
        namespace: "skippy",
        type: "session",
        title: "Complete report generation receipt",
        content: receiptPreview,
        tags: ["receipt", "report"],
        created_at: "2026-06-26T12:10:00.000Z",
        source_ref: {
          source: "brain",
          type: "session",
          id: "receipt-complete-report",
          namespace: "skippy",
          label: "Complete report generation receipt",
          preview: receiptPreview,
          created_at: "2026-06-26T12:10:00.000Z",
        },
      },
    ];
    const probe: EvalProbe = {
      id: "wrapper-export-receipt",
      category: "citation",
      query: "report receipt source-a base template output artifact manual PDF comparison",
      readable_namespaces: ["skippy"],
      top_k: 1,
      relevant_ids: ["receipt-complete-report"],
      expected_citation_ids: ["receipt-complete-report"],
      expected_answer_terms: [
        "docs/source-a.md",
        "reports/base-template.pdf",
        "reports/generated-report.md",
        "manual PDF comparison",
      ],
    };

    expect(scoreProbe(corpus, probe).passed).toBe(true);
  });
});
