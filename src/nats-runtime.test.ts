import { describe, expect, it } from "bun:test";
import {
  buildEnvelope,
  envelopeFromBytes,
  envelopeToBytes,
  EnvelopeError,
  ENVELOPE_VERSION,
  planNatsContextPackBridge,
  readNatsRuntimeBoundary,
  REQUEST_KIND,
  resolveContextPackSubject,
  summarizeNatsUrlForLog,
} from "./nats-runtime.ts";
import { agentContextPackInputSchema } from "./tools/agent-context-pack.ts";

const requestPayload = {
  operation: "agent_context_pack",
  identity: {
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
} as const;

const baseEnvelope = {
  id: "req-123",
  ts: "2026-07-08T00:00:00.000Z",
  from: "nagatha",
  kind: REQUEST_KIND,
  payload: requestPayload,
  version: 1,
} as const;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

describe("fleet envelope codec", () => {
  it("round-trips through wire bytes with the 'from' key (not 'sender')", () => {
    const envelope = buildEnvelope({
      id: "m-1",
      ts: "2026-07-08T00:00:00.000Z",
      from: "nagatha",
      kind: REQUEST_KIND,
      payload: { operation: "agent_context_pack" },
    });

    const bytes = envelope ? envelopeToBytes(envelope) : new Uint8Array();
    const wire = JSON.parse(decoder.decode(bytes));
    expect(wire).toMatchObject({
      id: "m-1",
      from: "nagatha",
      kind: REQUEST_KIND,
      version: ENVELOPE_VERSION,
    });
    expect(wire).not.toHaveProperty("sender");

    const parsed = envelopeFromBytes(bytes);
    expect(parsed).toMatchObject({
      id: "m-1",
      from: "nagatha",
      kind: REQUEST_KIND,
      payload: { operation: "agent_context_pack" },
      correlation_id: null,
      version: ENVELOPE_VERSION,
    });
  });

  it("emits compact JSON with no whitespace", () => {
    const bytes = envelopeToBytes(buildEnvelope(baseEnvelope));
    const text = decoder.decode(bytes);
    expect(text).not.toContain(", ");
    expect(text).not.toContain(": ");
  });

  it("warns but accepts a forward-compatible newer version", () => {
    const wire = { ...baseEnvelope, version: 2 };
    const warnings: number[] = [];
    const parsed = envelopeFromBytes(
      encoder.encode(JSON.stringify(wire)),
      (v) => warnings.push(v),
    );
    expect(parsed.version).toBe(2);
    expect(warnings).toEqual([2]);
  });

  it("rejects an empty id", () => {
    expect(() =>
      envelopeFromBytes(encoder.encode(JSON.stringify({ ...baseEnvelope, id: "" }))),
    ).toThrow(EnvelopeError);
  });

  it("rejects a missing/null from", () => {
    expect(() =>
      envelopeFromBytes(
        encoder.encode(JSON.stringify({ ...baseEnvelope, from: null })),
      ),
    ).toThrow(EnvelopeError);
  });

  it("rejects an empty kind", () => {
    expect(() =>
      envelopeFromBytes(
        encoder.encode(JSON.stringify({ ...baseEnvelope, kind: "" })),
      ),
    ).toThrow(EnvelopeError);
  });

  it("rejects a non-object payload", () => {
    expect(() =>
      envelopeFromBytes(
        encoder.encode(JSON.stringify({ ...baseEnvelope, payload: [1, 2, 3] })),
      ),
    ).toThrow(/payload must be a JSON object/);
  });

  it("rejects a non-integer version rather than coercing it", () => {
    expect(() =>
      envelopeFromBytes(
        encoder.encode(JSON.stringify({ ...baseEnvelope, version: "2" })),
      ),
    ).toThrow(/invalid version/);
  });

  it("rejects undecodable bytes", () => {
    expect(() => envelopeFromBytes(encoder.encode("{bad json"))).toThrow(
      EnvelopeError,
    );
  });

  it("coerces non-string optional fields via _opt_str semantics", () => {
    const parsed = envelopeFromBytes(
      encoder.encode(JSON.stringify({ ...baseEnvelope, to: 123 })),
    );
    expect(parsed.to).toBe("123");
  });

  it("buildEnvelope rejects an empty from before it can be serialised", () => {
    expect(() =>
      buildEnvelope({ ...baseEnvelope, from: "" }),
    ).toThrow(EnvelopeError);
  });
});

describe("resolveContextPackSubject", () => {
  it("defaults to the dev env-prefixed builder subject", () => {
    expect(resolveContextPackSubject({})).toBe("dev.ob.memory.context_pack");
  });

  it("uses OPENBRAIN_NATS_ENV as the env prefix", () => {
    expect(resolveContextPackSubject({ OPENBRAIN_NATS_ENV: "prod" })).toBe(
      "prod.ob.memory.context_pack",
    );
  });

  it("slugs the env token (lowercase, spaces/dots -> hyphens)", () => {
    expect(
      resolveContextPackSubject({ OPENBRAIN_NATS_ENV: "Staging Lab.1" }),
    ).toBe("staging-lab-1.ob.memory.context_pack");
  });

  it("honours the explicit subject override escape hatch", () => {
    expect(
      resolveContextPackSubject({
        OPENBRAIN_NATS_ENV: "prod",
        OPENBRAIN_NATS_CONTEXT_PACK_SUBJECT: "custom.subject",
      }),
    ).toBe("custom.subject");
  });
});

describe("readNatsRuntimeBoundary", () => {
  it("defaults to HTTP/MCP, auth off, override allowed, env-prefixed subject", () => {
    const boundary = readNatsRuntimeBoundary({});

    expect(boundary).toEqual({
      requested_transport: "http",
      fallback_transport: "http_mcp",
      nats: {
        availability: "not_runtime_available",
        url: null,
        context_pack_subject: "dev.ob.memory.context_pack",
        fallback_http: true,
        require_auth: false,
        allow_namespace_override: true,
      },
    });
  });

  it("records explicit NATS env without claiming runtime availability", () => {
    const boundary = readNatsRuntimeBoundary({
      OPENBRAIN_TRANSPORT: "nats",
      OPENBRAIN_NATS_URL: "nats://127.0.0.1:4222",
      OPENBRAIN_NATS_FALLBACK_HTTP: "true",
    });

    expect(boundary.requested_transport).toBe("nats");
    expect(boundary.nats).toMatchObject({
      availability: "not_runtime_available",
      url: "nats://127.0.0.1:4222",
      context_pack_subject: "dev.ob.memory.context_pack",
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
      context_pack_subject: "dev.ob.memory.context_pack",
    });
  });

  it("REQUIRE_AUTH=true force-disables the namespace override (mutually exclusive)", () => {
    const boundary = readNatsRuntimeBoundary({
      OPENBRAIN_NATS_REQUIRE_AUTH: "true",
      // even if a caller tries to also enable override, auth wins
      OPENBRAIN_NATS_ALLOW_NAMESPACE_OVERRIDE: "true",
    });

    expect(boundary.nats.require_auth).toBe(true);
    expect(boundary.nats.allow_namespace_override).toBe(false);
  });

  it("allows explicitly disabling the namespace override while auth stays off", () => {
    const boundary = readNatsRuntimeBoundary({
      OPENBRAIN_NATS_ALLOW_NAMESPACE_OVERRIDE: "false",
    });

    expect(boundary.nats.require_auth).toBe(false);
    expect(boundary.nats.allow_namespace_override).toBe(false);
  });

  it("treats loopback NATS hostnames case-insensitively", () => {
    const boundary = readNatsRuntimeBoundary({
      OPENBRAIN_TRANSPORT: "nats",
      OPENBRAIN_NATS_ENABLE_BRIDGE: "true",
      OPENBRAIN_NATS_URL: "nats://LocalHost:4222",
    });

    expect(boundary.nats.availability).toBe("available");
    expect(summarizeNatsUrlForLog(boundary.nats.url)).toMatchObject({
      configured: true,
      protocol: "nats",
      local: true,
    });
  });

  it("does not mark NATS available when bridge env is set but HTTP remains requested", () => {
    const boundary = readNatsRuntimeBoundary({
      OPENBRAIN_NATS_ENABLE_BRIDGE: "true",
      OPENBRAIN_NATS_URL: "nats://127.0.0.1:4222",
    });

    expect(boundary).toMatchObject({
      requested_transport: "http",
      nats: { availability: "not_runtime_available" },
    });
  });

  it("does not mark remote plaintext NATS available without an explicit lab override", () => {
    const boundary = readNatsRuntimeBoundary({
      OPENBRAIN_TRANSPORT: "nats",
      OPENBRAIN_NATS_ENABLE_BRIDGE: "true",
      OPENBRAIN_NATS_URL: "nats://10.71.1.21:4222",
    });

    expect(boundary.nats.availability).toBe("not_runtime_available");
  });

  it("allows remote plaintext NATS only with an explicit lab override", () => {
    const boundary = readNatsRuntimeBoundary({
      OPENBRAIN_TRANSPORT: "nats",
      OPENBRAIN_NATS_ENABLE_BRIDGE: "true",
      OPENBRAIN_NATS_URL: "nats://10.71.1.21:4222",
      OPENBRAIN_NATS_ALLOW_INSECURE_REMOTE: "true",
    });

    expect(boundary.nats.availability).toBe("available");
  });
});

describe("summarizeNatsUrlForLog", () => {
  it("omits host and credentials while preserving safe configuration facts", () => {
    const credentials = ["user", ":", "pass"].join("");
    const remoteHost = ["10", "71", "1", "21"].join(".");
    const natsUrl = ["nats://", credentials, "@", remoteHost, ":4222"].join("");

    expect(summarizeNatsUrlForLog(natsUrl)).toEqual({
      configured: true,
      protocol: "nats",
      contains_credentials: true,
      local: false,
    });
  });
});

describe("planNatsContextPackBridge", () => {
  const subject = "dev.ob.memory.context_pack";

  it("maps the fleet envelope payload to the existing MCP tool call with HTTP fallback", () => {
    const boundary = readNatsRuntimeBoundary({
      OPENBRAIN_TRANSPORT: "nats",
      OPENBRAIN_NATS_URL: "nats://127.0.0.1:4222",
    });

    const plan = planNatsContextPackBridge(boundary, {
      subject,
      envelope: baseEnvelope,
      bearerToken: " bearer-token ",
    });

    expect(plan).toEqual({
      status: "http_mcp_fallback",
      request_id: "req-123",
      subject,
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
        subject,
        envelope: baseEnvelope,
        bearerToken: "token",
      }),
    ).toThrow("NATS runtime is available; HTTP/MCP fallback plan is not used");
  });

  it("keeps fallback tool arguments within the implemented agent_context_pack schema", () => {
    const boundary = readNatsRuntimeBoundary({ OPENBRAIN_TRANSPORT: "nats" });

    const plan = planNatsContextPackBridge(boundary, {
      subject,
      envelope: baseEnvelope,
      bearerToken: "token",
    });

    expect(
      Object.keys(plan.mcpToolCall.arguments).filter(
        (key) => !(key in agentContextPackInputSchema),
      ),
    ).toEqual([]);
  });

  it("allows query to be omitted like the MCP agent_context_pack tool", () => {
    const boundary = readNatsRuntimeBoundary({ OPENBRAIN_TRANSPORT: "nats" });

    const plan = planNatsContextPackBridge(boundary, {
      subject,
      envelope: {
        ...baseEnvelope,
        payload: {
          ...requestPayload,
          body: { requested_sections: ["working_set"] },
        },
      },
      bearerToken: "token",
    });

    expect(plan.mcpToolCall.arguments).not.toHaveProperty("query");
  });

  it("preserves optional thread_id when the caller scoped the request to a thread", () => {
    const boundary = readNatsRuntimeBoundary({ OPENBRAIN_TRANSPORT: "nats" });

    const plan = planNatsContextPackBridge(boundary, {
      subject,
      envelope: {
        ...baseEnvelope,
        payload: {
          ...requestPayload,
          identity: { ...requestPayload.identity, thread_id: "thread-7" },
        },
      },
      bearerToken: "token",
    });

    expect(plan.mcpToolCall.arguments.thread_id).toBe("thread-7");
  });

  it("rejects fallback planning when no bearer token is available", () => {
    const boundary = readNatsRuntimeBoundary({ OPENBRAIN_TRANSPORT: "nats" });

    expect(() =>
      planNatsContextPackBridge(boundary, {
        subject,
        envelope: baseEnvelope,
        bearerToken: " ",
      }),
    ).toThrow("Bearer token is required for NATS bridge fallback");
  });

  it("rejects unsupported subjects before touching envelope contents", () => {
    const boundary = readNatsRuntimeBoundary({ OPENBRAIN_TRANSPORT: "nats" });

    expect(() =>
      planNatsContextPackBridge(boundary, {
        subject: "dev.ob.memory.wrap",
        envelope: baseEnvelope,
        bearerToken: "token",
      }),
    ).toThrow(
      "Unsupported NATS subject 'dev.ob.memory.wrap'; expected 'dev.ob.memory.context_pack'",
    );
  });

  it("rejects runtime fallback when explicitly disabled", () => {
    const boundary = readNatsRuntimeBoundary({
      OPENBRAIN_TRANSPORT: "nats",
      OPENBRAIN_NATS_FALLBACK_HTTP: "false",
    });

    expect(() =>
      planNatsContextPackBridge(boundary, {
        subject,
        envelope: baseEnvelope,
        bearerToken: "token",
      }),
    ).toThrow("NATS runtime is unavailable and HTTP/MCP fallback is disabled");
  });

  it("rejects non-context-pack operations so the bridge cannot widen scope silently", () => {
    const boundary = readNatsRuntimeBoundary({ OPENBRAIN_TRANSPORT: "nats" });

    expect(() =>
      planNatsContextPackBridge(boundary, {
        subject,
        envelope: {
          ...baseEnvelope,
          payload: { ...requestPayload, operation: "session_wrap" },
        },
        bearerToken: "token",
      }),
    ).toThrow();
  });

  it("rejects requested sections outside the current agent_context_pack contract", () => {
    const boundary = readNatsRuntimeBoundary({ OPENBRAIN_TRANSPORT: "nats" });

    expect(() =>
      planNatsContextPackBridge(boundary, {
        subject,
        envelope: {
          ...baseEnvelope,
          payload: {
            ...requestPayload,
            body: {
              ...requestPayload.body,
              requested_sections: ["working_set", "unknown_section"],
            },
          },
        },
        bearerToken: "token",
      }),
    ).toThrow();
  });

  it("rejects unsupported body fields before fallback planning", () => {
    const boundary = readNatsRuntimeBoundary({ OPENBRAIN_TRANSPORT: "nats" });

    expect(() =>
      planNatsContextPackBridge(boundary, {
        subject,
        envelope: {
          ...baseEnvelope,
          payload: {
            ...requestPayload,
            body: { ...requestPayload.body, metadata: { route_name: "x" } },
          },
        },
        bearerToken: "token",
      }),
    ).toThrow();
  });
});
