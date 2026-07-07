import { describe, expect, it } from "bun:test";
import {
  planNatsContextPackBridge,
  readNatsRuntimeBoundary,
  summarizeNatsUrlForLog,
} from "./nats-runtime.ts";
import { agentContextPackInputSchema } from "./tools/agent-context-pack.ts";

const baseEnvelope = {
  schema: "openbrain.nats.request.v1",
  operation: "agent_context_pack",
  request_id: "req-123",
  identity: {
    namespace_source: "authorization",
    agent: "nagatha",
    platform: "discord",
    server_id: "rodaddy-live",
    channel_id: "open-brain",
    thread_id: null,
    session_key: "discord:rodaddy-live:open-brain:nagatha",
  },
  body: {
    query: "what is the current task state?",
    requested_sections: ["working_set", "durable_memory"],
    include_unreviewed_recovery: true,
    budget: { max_tokens: 3500, max_latency_ms: 750 },
  },
  metadata: {
    client: "openbrain-memory",
    client_version: "0.1.0",
    transport: "nats",
  },
} as const;

describe("readNatsRuntimeBoundary", () => {
  it("defaults to HTTP/MCP and the planned context-pack subject", () => {
    const boundary = readNatsRuntimeBoundary({});

    expect(boundary).toEqual({
      requested_transport: "http",
      fallback_transport: "http_mcp",
      nats: {
        availability: "not_runtime_available",
        url: null,
        context_pack_subject: "ob.memory.context_pack",
        fallback_http: true,
      },
    });
  });

  it("records explicit NATS env without claiming runtime availability", () => {
    const boundary = readNatsRuntimeBoundary({
      OPENBRAIN_TRANSPORT: "nats",
      OPENBRAIN_NATS_URL: "nats://127.0.0.1:4222",
      OPENBRAIN_NATS_CONTEXT_PACK_SUBJECT: "ob.memory.context_pack",
      OPENBRAIN_NATS_FALLBACK_HTTP: "true",
    });

    expect(boundary.requested_transport).toBe("nats");
    expect(boundary.nats).toMatchObject({
      availability: "not_runtime_available",
      url: "nats://127.0.0.1:4222",
      context_pack_subject: "ob.memory.context_pack",
      fallback_http: true,
    });
  });

  it("marks NATS available only when the bridge is explicitly enabled with a URL", () => {
    const boundary = readNatsRuntimeBoundary({
      OPENBRAIN_TRANSPORT: "nats",
      OPENBRAIN_NATS_ENABLE_BRIDGE: "true",
      OPENBRAIN_NATS_URL: "nats://127.0.0.1:4222",
    });

    expect(boundary.requested_transport).toBe("nats");
    expect(boundary.nats).toMatchObject({
      availability: "available",
      url: "nats://127.0.0.1:4222",
      context_pack_subject: "ob.memory.context_pack",
    });
  });
});

describe("summarizeNatsUrlForLog", () => {
  it("omits host and credentials while preserving safe configuration facts", () => {
    expect(summarizeNatsUrlForLog("nats://user:pass@10.71.1.21:4222")).toEqual({
      configured: true,
      protocol: "nats",
      contains_credentials: true,
    });
  });
});

describe("planNatsContextPackBridge", () => {
  it("maps the planned NATS envelope to the existing MCP tool call with HTTP fallback", () => {
    const boundary = readNatsRuntimeBoundary({
      OPENBRAIN_TRANSPORT: "nats",
      OPENBRAIN_NATS_URL: "nats://127.0.0.1:4222",
    });

    const plan = planNatsContextPackBridge(boundary, {
      subject: "ob.memory.context_pack",
      envelope: baseEnvelope,
      bearerToken: " bearer-token ",
    });

    expect(plan).toEqual({
      status: "http_mcp_fallback",
      request_id: "req-123",
      subject: "ob.memory.context_pack",
      operation: "agent_context_pack",
      bearerToken: "bearer-token",
      mcpToolCall: {
        name: "agent_context_pack",
        arguments: {
          agent: "nagatha",
          platform: "discord",
          server_id: "rodaddy-live",
          channel_id: "open-brain",
          session_key: "discord:rodaddy-live:open-brain:nagatha",
          query: "what is the current task state?",
          requested_sections: ["working_set", "durable_memory"],
          include_unreviewed_recovery: true,
          budget: { max_tokens: 3500, max_latency_ms: 750 },
        },
      },
    });
  });

  it("does not build a fallback plan after the NATS bridge is available", () => {
    const boundary = readNatsRuntimeBoundary({
      OPENBRAIN_TRANSPORT: "nats",
      OPENBRAIN_NATS_ENABLE_BRIDGE: "true",
      OPENBRAIN_NATS_URL: "nats://127.0.0.1:4222",
    });

    expect(() =>
      planNatsContextPackBridge(boundary, {
        subject: "ob.memory.context_pack",
        envelope: baseEnvelope,
        bearerToken: "token",
      }),
    ).toThrow("NATS runtime is available; HTTP/MCP fallback plan is not used");
  });

  it("keeps fallback tool arguments within the implemented agent_context_pack schema", () => {
    const boundary = readNatsRuntimeBoundary({
      OPENBRAIN_TRANSPORT: "nats",
    });

    const plan = planNatsContextPackBridge(boundary, {
      subject: "ob.memory.context_pack",
      envelope: baseEnvelope,
      bearerToken: "token",
    });

    expect(
      Object.keys(plan.mcpToolCall.arguments).filter(
        (key) => !(key in agentContextPackInputSchema),
      ),
    ).toEqual([]);
  });

  it("preserves optional thread_id when the caller scoped the request to a thread", () => {
    const boundary = readNatsRuntimeBoundary({
      OPENBRAIN_TRANSPORT: "nats",
    });

    const plan = planNatsContextPackBridge(boundary, {
      subject: "ob.memory.context_pack",
      envelope: {
        ...baseEnvelope,
        identity: {
          ...baseEnvelope.identity,
          thread_id: "thread-7",
        },
      },
      bearerToken: "token",
    });

    expect(plan.mcpToolCall.arguments.thread_id).toBe("thread-7");
  });

  it("rejects fallback planning when no bearer token is available", () => {
    const boundary = readNatsRuntimeBoundary({
      OPENBRAIN_TRANSPORT: "nats",
    });

    expect(() =>
      planNatsContextPackBridge(boundary, {
        subject: "ob.memory.context_pack",
        envelope: baseEnvelope,
        bearerToken: " ",
      }),
    ).toThrow("Bearer token is required for NATS bridge fallback");
  });

  it("rejects unsupported subjects before touching envelope contents", () => {
    const boundary = readNatsRuntimeBoundary({
      OPENBRAIN_TRANSPORT: "nats",
    });

    expect(() =>
      planNatsContextPackBridge(boundary, {
        subject: "ob.memory.wrap",
        envelope: baseEnvelope,
        bearerToken: "token",
      }),
    ).toThrow(
      "Unsupported NATS subject 'ob.memory.wrap'; expected 'ob.memory.context_pack'",
    );
  });

  it("rejects runtime fallback when explicitly disabled", () => {
    const boundary = readNatsRuntimeBoundary({
      OPENBRAIN_TRANSPORT: "nats",
      OPENBRAIN_NATS_FALLBACK_HTTP: "false",
    });

    expect(() =>
      planNatsContextPackBridge(boundary, {
        subject: "ob.memory.context_pack",
        envelope: baseEnvelope,
        bearerToken: "token",
      }),
    ).toThrow("NATS runtime is unavailable and HTTP/MCP fallback is disabled");
  });

  it("rejects non-context-pack operations so the bridge cannot widen scope silently", () => {
    const boundary = readNatsRuntimeBoundary({
      OPENBRAIN_TRANSPORT: "nats",
    });

    expect(() =>
      planNatsContextPackBridge(boundary, {
        subject: "ob.memory.context_pack",
        envelope: {
          ...baseEnvelope,
          operation: "session_wrap",
        },
        bearerToken: "token",
      }),
    ).toThrow();
  });

  it("rejects requested sections outside the current agent_context_pack contract", () => {
    const boundary = readNatsRuntimeBoundary({
      OPENBRAIN_TRANSPORT: "nats",
    });

    expect(() =>
      planNatsContextPackBridge(boundary, {
        subject: "ob.memory.context_pack",
        envelope: {
          ...baseEnvelope,
          body: {
            ...baseEnvelope.body,
            requested_sections: ["working_set", "unknown_section"],
          },
        },
        bearerToken: "token",
      }),
    ).toThrow();
  });

  it("rejects unsupported body fields before fallback planning", () => {
    const boundary = readNatsRuntimeBoundary({
      OPENBRAIN_TRANSPORT: "nats",
    });

    expect(() =>
      planNatsContextPackBridge(boundary, {
        subject: "ob.memory.context_pack",
        envelope: {
          ...baseEnvelope,
          body: {
            ...baseEnvelope.body,
            metadata: { route_name: "discord_reply" },
          },
        },
        bearerToken: "token",
      }),
    ).toThrow();
  });
});
