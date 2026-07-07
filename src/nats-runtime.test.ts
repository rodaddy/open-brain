import { describe, expect, it } from "bun:test";
import {
  planNatsContextPackBridge,
  readNatsRuntimeBoundary,
  summarizeNatsUrlForLog,
} from "./nats-runtime.ts";

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
    user_id: "user-1",
    repo: "rodaddy/open-brain",
    task: "issue-223",
    client_context_refs: [
      { kind: "repo_path", path: "docs/nats-jetstream-foundation.md" },
    ],
    metadata: { route_name: "discord_reply" },
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
          user_id: "user-1",
          repo: "rodaddy/open-brain",
          task: "issue-223",
          client_context_refs: [
            { kind: "repo_path", path: "docs/nats-jetstream-foundation.md" },
          ],
          metadata: { route_name: "discord_reply" },
          budget: { max_tokens: 3500, max_latency_ms: 750 },
        },
      },
    });
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

  it("rejects unbounded metadata and context references before fallback planning", () => {
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
            metadata: { large: "x".repeat(3000) },
          },
        },
        bearerToken: "token",
      }),
    ).toThrow();
  });
});
