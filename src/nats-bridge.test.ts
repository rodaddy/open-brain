import { describe, expect, it, mock } from "bun:test";
import {
  createNatsBridgeHealth,
  handleNatsContextPackMessage,
  startNatsContextPackBridge,
  type NatsBridgeDriver,
  type NatsRequestMessage,
} from "./nats-bridge.ts";
import { logger } from "./logger.ts";
import type {
  BackgroundTraceBody,
  BackgroundTraceEmitter,
} from "./background-tracing.ts";
import {
  envelopeFromBytes,
  readNatsRuntimeBoundary,
  REQUEST_KIND,
  RESPONSE_FROM,
  RESPONSE_KIND,
} from "./nats-runtime.ts";
import { WorkingSetStore } from "./realtime/working-set.ts";
import { RecoveryWalStore } from "./realtime/recovery-wal.ts";
import type { ToolDeps } from "./tools/index.ts";
import type { AuthInfo } from "./types.ts";

const encoder = new TextEncoder();

const SUBJECT = "dev.ob.memory.context_pack";

const scope = {
  namespace: "rico",
  agent: "nagatha",
  platform: "discord",
  server_id: "rodaddy-live",
  channel_id: "open-brain",
  session_key: "discord:rodaddy-live:open-brain:nagatha",
};

const requestPayload = {
  operation: "agent_context_pack",
  identity: {
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
} as const;

function envelope(
  overrides: {
    id?: string;
    from?: string;
    kind?: string;
    payload?: Record<string, unknown>;
    version?: number;
  } = {},
): Record<string, unknown> {
  return {
    id: overrides.id ?? "req-123",
    ts: "2026-07-08T00:00:00.000Z",
    from: overrides.from ?? scope.namespace,
    kind: overrides.kind ?? REQUEST_KIND,
    payload: overrides.payload ?? requestPayload,
    version: overrides.version ?? 1,
  };
}

function depsWithWorkingSet(namespace = scope.namespace): ToolDeps {
  const workingSetStore = new WorkingSetStore();
  workingSetStore.append(
    { ...scope, namespace },
    {
      kind: "current_intent",
      content: "Finish #223 over NATS without changing HTTP default.",
    },
  );

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

function recordingTracing(): BackgroundTraceEmitter & {
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

function localBoundary(extra: Record<string, string> = {}) {
  return readNatsRuntimeBoundary({
    OPENBRAIN_TRANSPORT: "nats",
    OPENBRAIN_NATS_ENABLE_BRIDGE: "true",
    OPENBRAIN_NATS_URL: "nats://127.0.0.1:4222",
    ...extra,
  });
}

async function waitFor(
  condition: () => boolean,
  description: string,
  timeoutMs = 500,
): Promise<void> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error(`Timed out waiting for ${description}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("handleNatsContextPackMessage — response envelope", () => {
  it("wraps the reply in a fleet context_pack_response envelope echoing the request id", async () => {
    const response = await handleNatsContextPackMessage({
      message: { subject: SUBJECT, data: data(envelope()), headers: {} },
      boundary: localBoundary(),
      tokenMap: new Map(),
      deps: depsWithWorkingSet(),
    });

    expect(response.kind).toBe(RESPONSE_KIND);
    expect(response.from).toBe(RESPONSE_FROM);
    expect(response.id).toBe("req-123");
    expect(response.correlation_id).toBe("req-123");

    const payload = response.payload as Record<string, any>;
    expect(payload.status).toBe("ok");
    expect(payload.operation).toBe("agent_context_pack");
    expect(payload.namespace_source).toBe("declared");
    expect(payload.body.sections.working_set.items[0]).toMatchObject({
      content: "Finish #223 over NATS without changing HTTP default.",
      label: "working_context",
    });
  });
});

describe("handleNatsContextPackMessage — inbound kind validation (codex-C5)", () => {
  async function expectBadRequestForKind(kind: string) {
    const response = await handleNatsContextPackMessage({
      // A valid agent_context_pack payload on the subject, but the WRONG kind:
      // must be rejected as bad_request before payload handling, so a reply or
      // unrelated fleet message is never processed as a real request.
      message: { subject: SUBJECT, data: data(envelope({ kind, from: "rico" })), headers: {} },
      boundary: localBoundary(),
      tokenMap: new Map(),
      deps: depsWithWorkingSet("rico"),
    });
    const payload = response.payload as Record<string, any>;
    expect(payload.status).toBe("error");
    expect(payload.error.code).toBe("bad_request");
    // requestId is still echoed even though the kind was wrong.
    expect(response.id).toBe("req-123");
    expect(response.correlation_id).toBe("req-123");
    return payload;
  }

  it("rejects a response-kind envelope replayed onto the request subject", async () => {
    await expectBadRequestForKind(RESPONSE_KIND);
  });

  it("rejects an empty kind", async () => {
    // Empty kind is rejected by the envelope required-field guard (also bad_request).
    const response = await handleNatsContextPackMessage({
      message: { subject: SUBJECT, data: data(envelope({ kind: "", from: "rico" })), headers: {} },
      boundary: localBoundary(),
      tokenMap: new Map(),
      deps: depsWithWorkingSet("rico"),
    });
    const payload = response.payload as Record<string, any>;
    expect(payload.status).toBe("error");
    expect(payload.error.code).toBe("bad_request");
  });

  it("rejects an unrelated kind", async () => {
    await expectBadRequestForKind("dispatch");
  });
});

describe("handleNatsContextPackMessage — lane binding (auth off, local bus)", () => {
  it("binds via explicit payload.namespace override when override is allowed", async () => {
    const response = await handleNatsContextPackMessage({
      message: {
        subject: SUBJECT,
        data: data(
          envelope({
            from: "someone-else",
            payload: { ...requestPayload, namespace: "rico" },
          }),
        ),
        headers: {},
      },
      boundary: localBoundary(),
      tokenMap: new Map(),
      deps: depsWithWorkingSet("rico"),
    });

    const payload = response.payload as Record<string, any>;
    expect(payload.status).toBe("ok");
    expect(payload.namespace_source).toBe("override");
    // The override namespace ("rico") — not the envelope from ("someone-else") —
    // selected the working set.
    expect(payload.body.sections.working_set.items[0].content).toContain(
      "Finish #223",
    );
  });

  it("binds via the declared identity (envelope from) when no override is given", async () => {
    const response = await handleNatsContextPackMessage({
      message: {
        subject: SUBJECT,
        data: data(envelope({ from: "rico" })),
        headers: {},
      },
      boundary: localBoundary(),
      tokenMap: new Map(),
      deps: depsWithWorkingSet("rico"),
    });

    const payload = response.payload as Record<string, any>;
    expect(payload.status).toBe("ok");
    expect(payload.namespace_source).toBe("declared");
  });

  it("rejects as unroutable when no namespace can be derived", async () => {
    // Both the envelope from AND the identity agent must fail to normalise to a
    // valid namespace token so nothing is routable. "@@@@" starts with a
    // disallowed char, so it fails NAMESPACE_TOKEN_RE.
    const response = await handleNatsContextPackMessage({
      message: {
        subject: SUBJECT,
        data: data(
          envelope({
            from: "@@@@",
            payload: {
              ...requestPayload,
              identity: { ...requestPayload.identity, agent: "@@@@" },
            },
          }),
        ),
        headers: {},
      },
      boundary: localBoundary(),
      tokenMap: new Map(),
      deps: depsWithWorkingSet(),
    });

    const payload = response.payload as Record<string, any>;
    expect(payload.status).toBe("error");
    expect(payload.error.code).toBe("unroutable");
    expect(payload.namespace_source).toBe("rejected");
  });

  it("ignores payload.namespace override when the override is disabled", async () => {
    // override disabled but auth still off -> falls to declared identity binding.
    const response = await handleNatsContextPackMessage({
      message: {
        subject: SUBJECT,
        data: data(
          envelope({
            from: "rico",
            payload: { ...requestPayload, namespace: "someone-else" },
          }),
        ),
        headers: {},
      },
      boundary: localBoundary({ OPENBRAIN_NATS_ALLOW_NAMESPACE_OVERRIDE: "false" }),
      tokenMap: new Map(),
      deps: depsWithWorkingSet("rico"),
    });

    const payload = response.payload as Record<string, any>;
    expect(payload.status).toBe("ok");
    expect(payload.namespace_source).toBe("declared");
  });
});

describe("handleNatsContextPackMessage — REQUIRE_AUTH interlock", () => {
  const authBoundary = () => localBoundary({ OPENBRAIN_NATS_REQUIRE_AUTH: "true" });

  it("requires a bearer token when REQUIRE_AUTH=true", async () => {
    const response = await handleNatsContextPackMessage({
      message: { subject: SUBJECT, data: data(envelope()), headers: {} },
      boundary: authBoundary(),
      tokenMap: new Map([["secret-token", { role: "admin", clientId: "rico" }]]),
      deps: depsWithWorkingSet(),
    });

    const payload = response.payload as Record<string, any>;
    expect(payload.status).toBe("error");
    expect(payload.error.code).toBe("permission_denied");
    expect(payload.namespace_source).toBe("rejected");
  });

  it("uses the token-derived namespace and ignores a wire override when REQUIRE_AUTH=true", async () => {
    const response = await handleNatsContextPackMessage({
      message: {
        subject: SUBJECT,
        data: data(
          // hostile client tries to override to a namespace it doesn't own
          envelope({ from: "rico", payload: { ...requestPayload, namespace: "victim" } }),
        ),
        headers: { Authorization: "Bearer agent-token" },
      },
      boundary: authBoundary(),
      // agent role -> clientId "rico" is the ONLY namespace it can read
      tokenMap: new Map([["agent-token", { role: "agent", clientId: "rico" }]]),
      deps: depsWithWorkingSet("rico"),
    });

    const payload = response.payload as Record<string, any>;
    expect(payload.status).toBe("ok");
    // Token-derived binding is stamped "token" — distinct from wire-derived
    // "declared" (S2). A caller can tell auth was enforced.
    expect(payload.namespace_source).toBe("token");
    // Token namespace "rico" selected the working set, not "victim".
    expect(payload.body.sections.working_set.items[0].content).toContain(
      "Finish #223",
    );
  });

  it("uses constant-time token matching instead of direct map lookup", async () => {
    class NoDirectLookupTokenMap extends Map<string, AuthInfo> {
      override get(_key: string): AuthInfo | undefined {
        throw new Error("direct token lookup should not be used");
      }
    }

    const response = await handleNatsContextPackMessage({
      message: {
        subject: SUBJECT,
        data: data(envelope({ from: "rico" })),
        headers: { Authorization: "Bearer secret-token" },
      },
      boundary: authBoundary(),
      tokenMap: new NoDirectLookupTokenMap([
        ["secret-token", { role: "agent", clientId: "rico" }],
      ]),
      deps: depsWithWorkingSet("rico"),
    });

    expect((response.payload as Record<string, any>).status).toBe("ok");
  });
});

describe("handleNatsContextPackMessage — guards and redaction", () => {
  it("rejects oversized bodies before parsing", async () => {
    const response = await handleNatsContextPackMessage({
      message: {
        subject: SUBJECT,
        data: encoder.encode("x".repeat(65 * 1024)),
        headers: {},
      },
      boundary: localBoundary(),
      tokenMap: new Map(),
      deps: depsWithWorkingSet(),
    });

    const payload = response.payload as Record<string, any>;
    expect(response.id).toBe("unknown");
    expect(payload.error.code).toBe("payload_too_large");
  });

  it("does not expose raw parser or schema errors to NATS callers", async () => {
    const response = await handleNatsContextPackMessage({
      message: { subject: SUBJECT, data: encoder.encode("{bad json"), headers: {} },
      boundary: localBoundary(),
      tokenMap: new Map(),
      deps: depsWithWorkingSet(),
    });

    const payload = response.payload as Record<string, any>;
    expect(payload.error).toMatchObject({
      code: "bad_request",
      message: "Invalid NATS context pack request",
    });
  });

  it("returns unavailable when live bridge health is degraded", async () => {
    const health = createNatsBridgeHealth("not_runtime_available");
    health.lastError = "connection closed";

    const response = await handleNatsContextPackMessage({
      message: { subject: SUBJECT, data: data(envelope()), headers: {} },
      boundary: localBoundary(),
      tokenMap: new Map(),
      deps: depsWithWorkingSet(),
      health,
    });

    const payload = response.payload as Record<string, any>;
    expect(payload.error).toMatchObject({
      code: "temporarily_unavailable",
      message: "NATS bridge is not available",
    });
  });

  it("logs internal handler failures without leaking token/PII", async () => {
    const loggedErrors: string[] = [];
    const originalError = logger.error;
    logger.error = (message, extra) => {
      loggedErrors.push(JSON.stringify({ message, ...extra }));
    };

    try {
      const sensitiveToken = ["user", ":", "pass"].join("");
      const sensitiveHost = ["broker", "internal"].join(".");
      const brokenWorkingSetStore = {
        buildContextPackFragment: () => {
          const err = new Error(
            ["working set exploded for nats://", sensitiveToken, "@", sensitiveHost].join(""),
          );
          // Mutable err.name is deliberately set to a leaking value; the
          // allowlist must NOT surface it.
          err.name = ["NatsError nats://", sensitiveToken, "@", sensitiveHost].join("");
          throw err;
        },
      } as unknown as WorkingSetStore;

      const response = await handleNatsContextPackMessage({
        message: { subject: SUBJECT, data: data(envelope({ from: "rico" })), headers: {} },
        boundary: localBoundary(),
        tokenMap: new Map(),
        deps: { ...depsWithWorkingSet("rico"), workingSetStore: brokenWorkingSetStore },
      });

      const payload = response.payload as Record<string, any>;
      expect(payload.error).toMatchObject({
        code: "internal_error",
        message: "NATS context pack request failed",
      });
      const joinedLogs = loggedErrors.join("\n");
      expect(joinedLogs).toContain('"error_type":"Error"');
      expect(joinedLogs).not.toContain(sensitiveToken);
      expect(joinedLogs).not.toContain(sensitiveHost);
    } finally {
      logger.error = originalError;
    }
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
          data: data(envelope({ from: "rico" })),
          headers: {},
          respond: () => undefined,
        } satisfies NatsRequestMessage);
        return { close: () => undefined };
      },
      close: () => undefined,
    };

    const runtime = await startNatsContextPackBridge({
      boundary: localBoundary(),
      tokenMap: new Map(),
      deps: depsWithWorkingSet("rico"),
      driver,
    });

    expect(runtime).toMatchObject({
      subject: SUBJECT,
      availability: "available",
    });
    expect(subscribedSubject).toBe(SUBJECT);
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

  // #549 regression lane. Before this fix the bridge threw "NATS request did
  // not include a reply inbox" and published NOTHING, so a caller whose reply
  // the broker refused waited out its own timeout with no reason. Each test
  // below fails on that old behavior: the throw escapes, and no reply exists to
  // assert against.
  it("answers with an error envelope when the broker refuses the reply publish", async () => {
    const published: Array<ReturnType<typeof envelopeFromBytes>> = [];
    const driver: NatsBridgeDriver = {
      subscribe: async (subject, handler) => {
        let firstPublish = true;
        await handler({
          subject,
          data: data(envelope({ id: "req-refused", from: "rico" })),
          headers: {},
          respond: (payload: Uint8Array) => {
            // The broker refuses the real reply, then carries the small error
            // envelope — exactly the live shape from the runbook.
            if (firstPublish) {
              firstPublish = false;
              return false;
            }
            published.push(envelopeFromBytes(payload));
            return true;
          },
        } satisfies NatsRequestMessage);
        return { close: () => undefined };
      },
      close: () => undefined,
    };

    const runtime = await startNatsContextPackBridge({
      boundary: localBoundary(),
      tokenMap: new Map(),
      deps: depsWithWorkingSet("rico"),
      driver,
    });

    expect(published).toHaveLength(1);
    const reply = published[0]!;
    expect(reply.kind).toBe(RESPONSE_KIND);
    expect(reply.from).toBe(RESPONSE_FROM);
    // The correlation id is what lets the waiting caller match this reply to
    // its request instead of timing out.
    expect(reply.correlation_id).toBe("req-refused");
    const payload = reply.payload as Record<string, any>;
    expect(payload.status).toBe("error");
    expect(payload.operation).toBe("agent_context_pack");
    expect(payload.error.code).toBe("payload_too_large");
    expect(payload.error.message).toContain("broker refused");
    expect(payload.error.message).toContain("working_set");

    await runtime?.close();
  });

  it("does not trust a forged wire session key when auth rejects the request", async () => {
    const tracing = recordingTracing();
    const forgedSessionKey = "victim/session";
    const driver: NatsBridgeDriver = {
      subscribe: async (subject, handler) => {
        await handler({
          subject,
          data: data(
            envelope({
              payload: {
                ...requestPayload,
                identity: {
                  ...requestPayload.identity,
                  session_key: forgedSessionKey,
                },
              },
            }),
          ),
          headers: {},
          respond: () => true,
        } satisfies NatsRequestMessage);
        return { close: () => undefined };
      },
      close: () => undefined,
    };

    const runtime = await startNatsContextPackBridge({
      boundary: localBoundary({ OPENBRAIN_NATS_REQUIRE_AUTH: "true" }),
      tokenMap: new Map([
        ["valid-token", { role: "agent", clientId: "rico" }],
      ]),
      deps: depsWithWorkingSet("rico"),
      driver,
      tracing,
    });

    expect(tracing.bodies).toHaveLength(1);
    expect(tracing.bodies[0]?.sessionId).toBeUndefined();
    expect(tracing.bodies[0]?.metadata).toMatchObject({
      declared_session_key_unverified: "[MASKED:unverified]",
      status: "success",
    });
    expect(JSON.stringify(tracing.bodies)).not.toContain(forgedSessionKey);
    await runtime?.close();
  });

  it("traces an undeliverable reply as a handled error-envelope outcome", async () => {
    const tracing = recordingTracing();
    const driver: NatsBridgeDriver = {
      subscribe: async (subject, handler) => {
        let firstPublish = true;
        await handler({
          subject,
          data: data(envelope({ id: "req-traced", from: "rico" })),
          headers: {},
          respond: () => {
            if (firstPublish) {
              firstPublish = false;
              return false;
            }
            return true;
          },
        } satisfies NatsRequestMessage);
        return { close: () => undefined };
      },
      close: () => undefined,
    };

    const runtime = await startNatsContextPackBridge({
      boundary: localBoundary(),
      tokenMap: new Map(),
      deps: depsWithWorkingSet("rico"),
      driver,
      tracing,
    });

    expect(tracing.bodies).toHaveLength(1);
    expect(tracing.bodies[0]).toMatchObject({
      name: "nats.message",
      sessionId: scope.session_key,
      output: {
        subject: SUBJECT,
        outcome: "ok",
        reply_outcome: "undeliverable_error_published",
        error: { code: "payload_too_large" },
      },
      observations: [
        { name: "nats.handle", type: "span" },
        {
          name: "nats.reply",
          type: "span",
          output: {
            outcome: "undeliverable_error_published",
            error: { code: "payload_too_large" },
          },
        },
      ],
    });

    await runtime?.close();
  });

  it("answers with an error envelope without attempting a publish the broker's advertised figure rules out", async () => {
    const published: Array<ReturnType<typeof envelopeFromBytes>> = [];
    const attempts: number[] = [];
    const driver: NatsBridgeDriver = {
      subscribe: async (subject, handler) => {
        await handler({
          subject,
          data: data(envelope({ id: "req-oversized", from: "rico" })),
          headers: {},
          // A figure small enough that the real reply cannot fit, while the
          // content-free error envelope still can.
          maxPayloadBytes: 400,
          respond: (payload: Uint8Array) => {
            attempts.push(payload.byteLength);
            published.push(envelopeFromBytes(payload));
            return true;
          },
        } satisfies NatsRequestMessage);
        return { close: () => undefined };
      },
      close: () => undefined,
    };

    const runtime = await startNatsContextPackBridge({
      boundary: localBoundary(),
      tokenMap: new Map(),
      deps: depsWithWorkingSet("rico"),
      driver,
    });

    // Only the error envelope was ever put on the wire: the doomed publish was
    // never spent, because the reply already exceeded what the broker advertises.
    expect(attempts).toHaveLength(1);
    const payload = published[0]!.payload as Record<string, any>;
    expect(payload.status).toBe("error");
    expect(payload.error.code).toBe("payload_too_large");
    // The envelope names the measured reply size and the broker's own figure.
    expect(payload.error.message).toContain("400 bytes");
    expect(payload.error.message).toMatch(/Reply was \d+ bytes/);
    expect(published[0]!.correlation_id).toBe("req-oversized");

    await runtime?.close();
  });

  it("answers with an error envelope when the client THROWS MaxPayloadExceeded on the reply publish", async () => {
    // This mirrors the REAL nats.js client, which is what makes this the
    // regression test for #549 rather than a restatement of the false-return
    // case. `Msg.respond()` publishes through `protocol.publish()`, and that
    // raises NatsError(MAX_PAYLOAD_EXCEEDED) — it does not return false. The
    // false return is reserved for a genuinely absent reply inbox.
    //
    // The message text is deliberately NOT what the bridge matches on, so this
    // fixture carries the machine code and prose the client is free to reword.
    const published: Array<ReturnType<typeof envelopeFromBytes>> = [];
    const driver: NatsBridgeDriver = {
      subscribe: async (subject, handler) => {
        let firstPublish = true;
        await handler({
          subject,
          data: data(envelope({ id: "req-thrown", from: "rico" })),
          headers: {},
          // The figure is UNREADABLE, so the bridge cannot pre-judge the reply
          // and must attempt the publish — the exact path that had no guard.
          maxPayloadBytes: undefined,
          respond: (payload: Uint8Array) => {
            if (firstPublish) {
              firstPublish = false;
              const err = new Error("Maximum payload exceeded") as Error & {
                code: string;
                name: string;
              };
              err.name = "NatsError";
              err.code = "MAX_PAYLOAD_EXCEEDED";
              throw err;
            }
            published.push(envelopeFromBytes(payload));
            return true;
          },
        } satisfies NatsRequestMessage);
        return { close: () => undefined };
      },
      close: () => undefined,
    };

    const runtime = await startNatsContextPackBridge({
      boundary: localBoundary(),
      tokenMap: new Map(),
      deps: depsWithWorkingSet("rico"),
      driver,
    });

    // The caller is answered. Before the guard the throw escaped to the
    // handler-error catch and NOTHING was published, so this array was empty.
    expect(published).toHaveLength(1);
    const reply = published[0]!;
    expect(reply.kind).toBe(RESPONSE_KIND);
    expect(reply.from).toBe(RESPONSE_FROM);
    // The correlation id is what releases the waiting caller.
    expect(reply.correlation_id).toBe("req-thrown");
    const payload = reply.payload as Record<string, any>;
    expect(payload.status).toBe("error");
    expect(payload.operation).toBe("agent_context_pack");
    expect(payload.error.code).toBe("payload_too_large");
    expect(payload.error.message).toContain("working_set");

    await runtime?.close();
  });

  it("rethrows a generic respond failure and emits one exception trace", async () => {
    // A connection-closed throw is not ours to reinterpret as an undeliverable
    // reply. It must reject the subscription callback unchanged, not be answered
    // with a payload_too_large envelope that would misdescribe what happened.
    const published: Array<ReturnType<typeof envelopeFromBytes>> = [];
    const tracing = recordingTracing();
    const failure = new Error("connection closed") as Error & { code: string };
    failure.code = "CONNECTION_CLOSED";
    const driver: NatsBridgeDriver = {
      subscribe: async (subject, handler) => {
        await handler({
          subject,
          data: data(envelope({ id: "req-closed", from: "rico" })),
          headers: {},
          respond: (payload: Uint8Array) => {
            published.push(envelopeFromBytes(payload));
            throw failure;
          },
        } satisfies NatsRequestMessage);
        return { close: () => undefined };
      },
      close: () => undefined,
    };

    await expect(
      startNatsContextPackBridge({
        boundary: localBoundary(),
        tokenMap: new Map(),
        deps: depsWithWorkingSet("rico"),
        driver,
        tracing,
      }),
    ).rejects.toBe(failure);

    // Exactly one publish was attempted; no error envelope followed it.
    expect(published).toHaveLength(1);
    expect((published[0]!.payload as Record<string, any>).status).toBe("ok");
    expect(tracing.bodies).toHaveLength(1);
    expect(tracing.bodies[0]).toMatchObject({
      name: "nats.message",
      metadata: { status: "exception" },
      observations: [
        { name: "nats.handle", level: "DEFAULT" },
        {
          name: "nats.reply",
          level: "ERROR",
          statusMessage: "Error",
        },
      ],
    });
  });

  it("carries the reply normally when it fits the broker's advertised figure", async () => {
    const published: Array<ReturnType<typeof envelopeFromBytes>> = [];
    const driver: NatsBridgeDriver = {
      subscribe: async (subject, handler) => {
        await handler({
          subject,
          data: data(envelope({ id: "req-ok", from: "rico" })),
          headers: {},
          maxPayloadBytes: 8 * 1024 * 1024,
          respond: (payload: Uint8Array) => {
            published.push(envelopeFromBytes(payload));
            return true;
          },
        } satisfies NatsRequestMessage);
        return { close: () => undefined };
      },
      close: () => undefined,
    };

    const runtime = await startNatsContextPackBridge({
      boundary: localBoundary(),
      tokenMap: new Map(),
      deps: depsWithWorkingSet("rico"),
      driver,
    });

    expect(published).toHaveLength(1);
    expect((published[0]!.payload as Record<string, any>).status).toBe("ok");

    await runtime?.close();
  });

  it("logs an accurate reason when even the error envelope cannot be published", async () => {
    const loggedErrors: string[] = [];
    const originalError = logger.error;
    logger.error = (message, extra) => {
      loggedErrors.push(`${message}:${JSON.stringify(extra ?? {})}`);
    };

    try {
      const driver: NatsBridgeDriver = {
        subscribe: async (subject, handler) => {
          await handler({
            subject,
            data: data(envelope({ id: "req-no-inbox", from: "rico" })),
            headers: {},
            // Every publish is refused, including the small error envelope —
            // the only case where a missing reply inbox is the accurate reading.
            respond: () => false,
          } satisfies NatsRequestMessage);
          return { close: () => undefined };
        },
        close: () => undefined,
      };

      const runtime = await startNatsContextPackBridge({
        boundary: localBoundary(),
        tokenMap: new Map(),
        deps: depsWithWorkingSet("rico"),
        driver,
      });

      const joined = loggedErrors.join("\n");
      expect(joined).toContain(
        "NATS reply could not be published to a reply inbox",
      );
      // The old misattribution claimed this about EVERY refused publish.
      expect(joined).not.toContain("NATS request did not include a reply inbox");

      await runtime?.close();
    } finally {
      logger.error = originalError;
    }
  });

  it("attempts driver close when subscription close fails", async () => {
    const subscriptionClose = mock(async () => {
      throw new Error("subscription close failed");
    });
    const driverClose = mock(async () => {});
    const driver: NatsBridgeDriver = {
      subscribe: async () => ({ close: subscriptionClose }),
      close: driverClose,
    };

    const runtime = await startNatsContextPackBridge({
      boundary: localBoundary(),
      tokenMap: new Map(),
      deps: depsWithWorkingSet("rico"),
      driver,
    });

    await expect(runtime?.close()).rejects.toThrow("subscription close failed");
    expect(subscriptionClose).toHaveBeenCalled();
    expect(driverClose).toHaveBeenCalled();
  });

  it("resubscribes the real NATS subscription loop after handler and iterator failures", async () => {
    const responses: Array<{ correlation_id?: string | null; status?: string }> = [];
    const loggedErrors: string[] = [];
    const originalError = logger.error;
    logger.error = (message, extra) => {
      loggedErrors.push(`${message}:${String(extra?.error_type ?? "")}`);
    };

    try {
      const headers = {
        keys: () => [] as string[],
        get: () => "",
      };
      const record = (payload: Uint8Array) => {
        const parsed = envelopeFromBytes(payload);
        responses.push({
          correlation_id: parsed.correlation_id,
          status: (parsed.payload as Record<string, any>).status,
        });
        return true;
      };
      const firstSubscription = {
        unsubscribe: mock(() => {}),
        async *[Symbol.asyncIterator]() {
          yield {
            subject: SUBJECT,
            data: data(envelope({ id: "req-no-reply", from: "rico" })),
            headers,
            respond: () => false,
          };
          yield {
            subject: SUBJECT,
            data: data(envelope({ id: "req-before-resubscribe", from: "rico" })),
            headers,
            respond: record,
          };
          throw new Error("subscription iterator failed");
        },
      };
      const secondSubscription = {
        unsubscribe: mock(() => {}),
        async *[Symbol.asyncIterator]() {
          yield {
            subject: SUBJECT,
            data: data(envelope({ id: "req-after-resubscribe", from: "rico" })),
            headers,
            respond: record,
          };
        },
      };
      const fallbackSubscription = {
        unsubscribe: mock(() => {}),
        async *[Symbol.asyncIterator]() {},
      };
      let subscribeCalls = 0;
      const connection = {
        subscribe: mock(() => {
          subscribeCalls += 1;
          if (subscribeCalls === 1) return firstSubscription;
          if (subscribeCalls === 2) return secondSubscription;
          return fallbackSubscription;
        }),
        drain: mock(async () => {}),
      };
      mock.module("nats", () => ({ connect: mock(async () => connection) }));

      const runtime = await startNatsContextPackBridge({
        boundary: localBoundary(),
        tokenMap: new Map(),
        deps: depsWithWorkingSet("rico"),
      });

      await waitFor(
        () =>
          responses.some((r) => r.correlation_id === "req-after-resubscribe"),
        "NATS bridge to process a message after resubscribe",
      );

      expect(connection.subscribe).toHaveBeenCalledWith(SUBJECT);
      expect(connection.subscribe.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(responses).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            correlation_id: "req-before-resubscribe",
            status: "ok",
          }),
          expect.objectContaining({
            correlation_id: "req-after-resubscribe",
            status: "ok",
          }),
        ]),
      );
      // The `req-no-reply` message refuses EVERY publish, including the error
      // envelope, so the bridge logs the one accurate reading of that case and
      // moves on. It no longer throws (#549): the old throw was misattributed,
      // and turning a refused publish into a handler error is what let the
      // caller receive nothing at all.
      expect(loggedErrors).toContain(
        "NATS reply could not be published to a reply inbox:",
      );
      expect(loggedErrors).not.toContain(
        "NATS context-pack bridge request failed:Error",
      );
      expect(loggedErrors).toContain(
        "NATS context-pack bridge subscription failed:Error",
      );

      await runtime?.close();
      expect(secondSubscription.unsubscribe).toHaveBeenCalled();
      expect(connection.drain).toHaveBeenCalled();
    } finally {
      logger.error = originalError;
      mock.restore();
    }
  });

  it("resubscribes after clean iterator completion without degrading health", async () => {
    const responses: Array<{ correlation_id?: string | null; status?: string }> = [];
    const headers = { keys: () => [] as string[], get: () => "" };
    const firstSubscription = {
      unsubscribe: mock(() => {}),
      async *[Symbol.asyncIterator]() {},
    };
    const secondSubscription = {
      unsubscribe: mock(() => {}),
      async *[Symbol.asyncIterator]() {
        yield {
          subject: SUBJECT,
          data: data(envelope({ id: "req-after-clean-end", from: "rico" })),
          headers,
          respond: (payload: Uint8Array) => {
            const parsed = envelopeFromBytes(payload);
            responses.push({
              correlation_id: parsed.correlation_id,
              status: (parsed.payload as Record<string, any>).status,
            });
            return true;
          },
        };
      },
    };
    const fallbackSubscription = {
      unsubscribe: mock(() => {}),
      async *[Symbol.asyncIterator]() {},
    };
    let subscribeCalls = 0;
    const connection = {
      subscribe: mock(() => {
        subscribeCalls += 1;
        if (subscribeCalls === 1) return firstSubscription;
        if (subscribeCalls === 2) return secondSubscription;
        return fallbackSubscription;
      }),
      drain: mock(async () => {}),
    };
    mock.module("nats", () => ({ connect: mock(async () => connection) }));
    const health = createNatsBridgeHealth("available");

    try {
      const runtime = await startNatsContextPackBridge({
        boundary: localBoundary(),
        tokenMap: new Map(),
        deps: depsWithWorkingSet("rico"),
        health,
      });

      await waitFor(
        () => responses.some((r) => r.correlation_id === "req-after-clean-end"),
        "NATS bridge to resubscribe after clean iterator completion",
      );
      expect(health).toMatchObject({
        availability: "available",
        consecutiveFailures: 0,
        lastError: null,
      });
      expect(connection.subscribe.mock.calls.length).toBeGreaterThanOrEqual(2);

      await runtime?.close();
    } finally {
      mock.restore();
    }
  });

  it("marks health unavailable after repeated clean empty subscription completions", async () => {
    const emptySubscription = () => ({
      unsubscribe: mock(() => {}),
      async *[Symbol.asyncIterator]() {},
    });
    const subscriptions: Array<ReturnType<typeof emptySubscription>> = [];
    const connection = {
      subscribe: mock(() => {
        const subscription = emptySubscription();
        subscriptions.push(subscription);
        return subscription;
      }),
      drain: mock(async () => {}),
    };
    mock.module("nats", () => ({ connect: mock(async () => connection) }));
    const health = createNatsBridgeHealth("available");

    try {
      const runtime = await startNatsContextPackBridge({
        boundary: localBoundary(),
        tokenMap: new Map(),
        deps: depsWithWorkingSet("rico"),
        health,
      });

      await waitFor(
        () =>
          health.availability === "not_runtime_available" &&
          health.lastError === "NATS subscription ended without messages",
        "NATS bridge health to degrade after repeated clean empty subscriptions",
      );
      expect(connection.subscribe.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(health.consecutiveFailures).toBe(1);

      await runtime?.close();
      expect(subscriptions.at(-1)?.unsubscribe).toHaveBeenCalled();
      expect(connection.drain).toHaveBeenCalled();
    } finally {
      mock.restore();
    }
  });

  it("backs off when resubscribe succeeds but replacement iterators keep failing", async () => {
    const loggedErrors: string[] = [];
    const originalError = logger.error;
    logger.error = (message, extra) => {
      loggedErrors.push(`${message}:${String(extra?.error_type ?? "")}`);
    };

    try {
      const subscriptions: Array<{ unsubscribe: ReturnType<typeof mock> }> = [];
      let subscribeCalls = 0;
      const connection = {
        subscribe: mock(() => {
          subscribeCalls += 1;
          const error = new Error(`iterator failed ${subscribeCalls}`);
          const subscription = {
            unsubscribe: mock(() => {}),
            async *[Symbol.asyncIterator]() {
              throw error;
            },
          };
          subscriptions.push(subscription);
          return subscription;
        }),
        drain: mock(async () => {}),
      };
      mock.module("nats", () => ({ connect: mock(async () => connection) }));
      const health = createNatsBridgeHealth("available");

      const runtime = await startNatsContextPackBridge({
        boundary: localBoundary(),
        tokenMap: new Map(),
        deps: depsWithWorkingSet("rico"),
        health,
      });

      await waitFor(
        () => subscribeCalls >= 2,
        "NATS bridge to resubscribe after an iterator failure",
      );
      const callsAfterSecondFailure = subscribeCalls;
      await new Promise((resolve) => setTimeout(resolve, 80));

      expect(health.availability).toBe("not_runtime_available");
      expect(health.lastError).toMatch(/^iterator failed /);
      expect(subscribeCalls - callsAfterSecondFailure).toBeLessThanOrEqual(1);
      expect(loggedErrors).toContain(
        "NATS context-pack bridge subscription failed:Error",
      );

      await runtime?.close();
      expect(subscriptions.at(-1)?.unsubscribe).toHaveBeenCalled();
      expect(connection.drain).toHaveBeenCalled();
    } finally {
      logger.error = originalError;
      mock.restore();
    }
  });

  it("marks live NATS health unavailable and backs off when resubscribe repeatedly fails", async () => {
    const loggedErrors: string[] = [];
    const originalError = logger.error;
    logger.error = (message, extra) => {
      loggedErrors.push(`${message}:${String(extra?.error_type ?? "")}`);
    };

    try {
      const firstSubscription = {
        unsubscribe: mock(() => {}),
        async *[Symbol.asyncIterator]() {
          throw new Error("subscription iterator failed");
        },
      };
      let subscribeCalls = 0;
      const connection = {
        subscribe: mock(() => {
          subscribeCalls += 1;
          if (subscribeCalls === 1) return firstSubscription;
          throw new Error("connection closed");
        }),
        drain: mock(async () => {}),
      };
      mock.module("nats", () => ({ connect: mock(async () => connection) }));
      const health = createNatsBridgeHealth("available");

      const runtime = await startNatsContextPackBridge({
        boundary: localBoundary(),
        tokenMap: new Map(),
        deps: depsWithWorkingSet("rico"),
        health,
      });

      await waitFor(
        () =>
          health.availability === "not_runtime_available" &&
          health.lastError === "connection closed",
        "NATS bridge health to degrade after repeated resubscribe failure",
      );
      const callsAfterFailure = subscribeCalls;
      await new Promise((resolve) => setTimeout(resolve, 80));

      expect(health).toMatchObject({
        availability: "not_runtime_available",
        lastError: "connection closed",
      });
      expect(callsAfterFailure).toBeGreaterThanOrEqual(2);
      expect(subscribeCalls - callsAfterFailure).toBeLessThanOrEqual(2);
      expect(loggedErrors).toContain(
        "NATS context-pack bridge subscription failed:Error",
      );

      await runtime?.close();
      expect(firstSubscription.unsubscribe).toHaveBeenCalled();
      expect(connection.drain).toHaveBeenCalled();
    } finally {
      logger.error = originalError;
      mock.restore();
    }
  });
});
