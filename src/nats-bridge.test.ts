import { describe, expect, it } from "bun:test";
import {
  handleNatsContextPackMessage,
  processNatsSubscriptionMessage,
  startNatsContextPackBridge,
  type NatsBridgeDriver,
  type NatsRequestMessage,
} from "./nats-bridge.ts";
import { readNatsRuntimeBoundary } from "./nats-runtime.ts";
import { WorkingSetStore } from "./realtime/working-set.ts";
import { RecoveryWalStore } from "./realtime/recovery-wal.ts";
import type { ToolDeps } from "./tools/index.ts";
import type { AuthInfo } from "./types.ts";

const encoder = new TextEncoder();

const scope = {
  namespace: "rico",
  agent: "nagatha",
  platform: "discord",
  server_id: "rodaddy-live",
  channel_id: "open-brain",
  session_key: "discord:rodaddy-live:open-brain:nagatha",
};

const baseEnvelope = {
  schema: "openbrain.nats.request.v1",
  operation: "agent_context_pack",
  request_id: "req-123",
  identity: {
    namespace_source: "authorization",
    agent: scope.agent,
    platform: scope.platform,
    server_id: scope.server_id,
    channel_id: scope.channel_id,
    thread_id: null,
    session_key: scope.session_key,
  },
  body: {
    query: "what is the current task state?",
    requested_sections: ["working_set"],
  },
  metadata: {
    client: "openbrain-memory",
    client_version: "0.1.0",
    transport: "nats",
  },
} as const;

function depsWithWorkingSet(): ToolDeps {
  const workingSetStore = new WorkingSetStore();
  workingSetStore.append(scope, {
    kind: "current_intent",
    content: "Finish #223 over NATS without changing HTTP default.",
  });

  return {
    pool: { query: async () => ({ rows: [] }) } as any,
    embedFn: async () => Array(768).fill(0.1),
    workingSetStore,
    recoveryWalStore: new RecoveryWalStore(),
  };
}

function data(payload: unknown): Uint8Array {
  return encoder.encode(JSON.stringify(payload));
}

describe("handleNatsContextPackMessage", () => {
  it("returns the same agent_context_pack payload over an authorized NATS request", () => {
    const tokenMap = new Map<string, AuthInfo>([
      ["secret-token", { role: "admin", clientId: "rico" }],
    ]);
    const boundary = readNatsRuntimeBoundary({
      OPENBRAIN_TRANSPORT: "nats",
      OPENBRAIN_NATS_ENABLE_BRIDGE: "true",
      OPENBRAIN_NATS_URL: "nats://127.0.0.1:4222",
    });

    const response = handleNatsContextPackMessage({
      message: {
        subject: "ob.memory.context_pack",
        data: data(baseEnvelope),
        headers: { Authorization: "Bearer secret-token" },
      },
      boundary,
      tokenMap,
      deps: depsWithWorkingSet(),
    }) as any;

    expect(response).toMatchObject({
      schema: "openbrain.nats.response.v1",
      request_id: "req-123",
      status: "ok",
      operation: "agent_context_pack",
    });
    expect(response.body.sections.working_set.items[0]).toMatchObject({
      content: "Finish #223 over NATS without changing HTTP default.",
      label: "working_context",
    });
    expect(response.body.warnings.scope_denials).toEqual([]);
  });

  it("rejects NATS requests that do not carry a bearer token", () => {
    const boundary = readNatsRuntimeBoundary({
      OPENBRAIN_TRANSPORT: "nats",
      OPENBRAIN_NATS_ENABLE_BRIDGE: "true",
      OPENBRAIN_NATS_URL: "nats://127.0.0.1:4222",
    });

    const response = handleNatsContextPackMessage({
      message: {
        subject: "ob.memory.context_pack",
        data: data({ not: "valid-json-envelope" }),
        headers: {},
      },
      boundary,
      tokenMap: new Map(),
      deps: depsWithWorkingSet(),
    }) as any;

    expect(response).toMatchObject({
      request_id: null,
      status: "error",
      error: { code: "permission_denied" },
    });
  });

  it("rejects oversized bodies before parsing", () => {
    const boundary = readNatsRuntimeBoundary({
      OPENBRAIN_TRANSPORT: "nats",
      OPENBRAIN_NATS_ENABLE_BRIDGE: "true",
      OPENBRAIN_NATS_URL: "nats://127.0.0.1:4222",
    });

    const response = handleNatsContextPackMessage({
      message: {
        subject: "ob.memory.context_pack",
        data: encoder.encode("x".repeat(65 * 1024)),
        headers: { Authorization: "Bearer secret-token" },
      },
      boundary,
      tokenMap: new Map([["secret-token", { role: "admin", clientId: "rico" }]]),
      deps: depsWithWorkingSet(),
    }) as any;

    expect(response).toMatchObject({
      request_id: null,
      status: "error",
      error: { code: "payload_too_large" },
    });
  });

  it("does not expose raw parser or schema errors to NATS callers", () => {
    const boundary = readNatsRuntimeBoundary({
      OPENBRAIN_TRANSPORT: "nats",
      OPENBRAIN_NATS_ENABLE_BRIDGE: "true",
      OPENBRAIN_NATS_URL: "nats://127.0.0.1:4222",
    });

    const response = handleNatsContextPackMessage({
      message: {
        subject: "ob.memory.context_pack",
        data: encoder.encode("{bad json"),
        headers: { Authorization: "Bearer secret-token" },
      },
      boundary,
      tokenMap: new Map([["secret-token", { role: "admin", clientId: "rico" }]]),
      deps: depsWithWorkingSet(),
    }) as any;

    expect(response).toMatchObject({
      request_id: null,
      status: "error",
      error: {
        code: "bad_request",
        message: "Invalid NATS context pack request",
      },
    });
  });
});

describe("startNatsContextPackBridge", () => {
  it("subscribes only when NATS is explicitly requested and available", async () => {
    let subscribedSubject: string | undefined;
    const driver: NatsBridgeDriver = {
      subscribe: async (subject, handler) => {
        subscribedSubject = subject;
        await handler({
          subject,
          data: data(baseEnvelope),
          headers: { authorization: "Bearer secret-token" },
          respond: () => undefined,
        } satisfies NatsRequestMessage);
        return { close: () => undefined };
      },
      close: () => undefined,
    };

    const runtime = await startNatsContextPackBridge({
      boundary: readNatsRuntimeBoundary({
        OPENBRAIN_TRANSPORT: "nats",
        OPENBRAIN_NATS_ENABLE_BRIDGE: "true",
        OPENBRAIN_NATS_URL: "nats://127.0.0.1:4222",
      }),
      tokenMap: new Map([["secret-token", { role: "admin", clientId: "rico" }]]),
      deps: depsWithWorkingSet(),
      driver,
    });

    expect(runtime).toMatchObject({
      subject: "ob.memory.context_pack",
      availability: "available",
    });
    expect(subscribedSubject).toBe("ob.memory.context_pack");
    await runtime?.close();
  });

  it("does not subscribe for the default HTTP/MCP runtime", async () => {
    const runtime = await startNatsContextPackBridge({
      boundary: readNatsRuntimeBoundary({}),
      tokenMap: new Map(),
      deps: depsWithWorkingSet(),
      driver: {
        subscribe: async () => {
          throw new Error("should not subscribe");
        },
        close: () => undefined,
      },
    });

    expect(runtime).toBeNull();
  });

  it("surfaces reply failures from request messages", async () => {
    const driver: NatsBridgeDriver = {
      subscribe: async (subject, handler) => {
        await expect(
          handler({
            subject,
            data: data(baseEnvelope),
            headers: { authorization: "Bearer secret-token" },
            respond: () => false,
          } satisfies NatsRequestMessage),
        ).rejects.toThrow("NATS request did not include a reply inbox");
        return { close: () => undefined };
      },
      close: () => undefined,
    };

    const runtime = await startNatsContextPackBridge({
      boundary: readNatsRuntimeBoundary({
        OPENBRAIN_TRANSPORT: "nats",
        OPENBRAIN_NATS_ENABLE_BRIDGE: "true",
        OPENBRAIN_NATS_URL: "nats://127.0.0.1:4222",
      }),
      tokenMap: new Map([["secret-token", { role: "admin", clientId: "rico" }]]),
      deps: depsWithWorkingSet(),
      driver,
    });

    await runtime?.close();
  });

  it("isolates per-message reply failures in the subscription driver boundary", async () => {
    const handled: string[] = [];
    const errors: string[] = [];
    const handler = async (message: NatsRequestMessage) => {
      handled.push(message.subject);
      const responded = await message.respond(data({ ok: true }));
      if (responded === false) {
        throw new Error("NATS request did not include a reply inbox");
      }
    };
    const onError = (err: unknown, subject: string) => {
      errors.push(`${subject}:${err instanceof Error ? err.message : String(err)}`);
    };

    await processNatsSubscriptionMessage(
      {
        subject: "ob.memory.context_pack",
        data: data(baseEnvelope),
        respond: () => false,
      },
      handler,
      onError,
    );
    await processNatsSubscriptionMessage(
      {
        subject: "ob.memory.context_pack",
        data: data(baseEnvelope),
        respond: () => true,
      },
      handler,
      onError,
    );

    expect(handled).toEqual(["ob.memory.context_pack", "ob.memory.context_pack"]);
    expect(errors).toEqual([
      "ob.memory.context_pack:NATS request did not include a reply inbox",
    ]);
  });
});
