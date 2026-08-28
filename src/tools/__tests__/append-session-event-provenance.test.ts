/**
 * Writer- and token-provenance coverage for `append_session_event`, split out
 * of append-session-event.test.ts so each half stays a readable size.
 */
import { describe, it, expect } from "bun:test";
import type { AuthInfo } from "../../types.ts";
import { parseToolResult } from "./test-helpers.ts";
import {
  setupToolClient,
  createCapturingPool,
  expectDefined,
} from "./append-session-event-test-helpers.ts";

async function provenanceCase1() {
  const mockPool = createCapturingPool();
  const auth: AuthInfo = {
    role: "admin",
    clientId: "rico",
    tokenClientId: "rico",
    namespaceSource: "token",
  };
  const { client, cleanup } = await setupToolClient(mockPool, auth);

  try {
    const result = await client.callTool({
      name: "append_session_event",
      arguments: {
        session_key: "test",
        namespace: "nagatha",
        event_type: "fact",
        content: "Nagatha delegated write provenance canary",
        source: "nagatha",
      },
    });

    expect(result.isError).toBeFalsy();
    const parsed = parseToolResult(result);
    expect(parsed.writer_identity).toBe("rico");
    expect(parsed.token_identity).toBe("rico");
    expect(parsed.delegated_agent_id).toBeNull();
    expect(parsed.namespace_source).toBe("token");

    expect(mockPool.captured.createdBy).toBe("rico");
    expect(mockPool.captured.metadata).not.toBeNull();
    expect(
      expectDefined(mockPool.captured.metadata, "mockPool.captured.metadata")
        ._openbrain,
    ).toEqual({
      writer: {
        client_id: "rico",
        token_client_id: "rico",
        agent_id: null,
        namespace_source: "token",
      },
    });
  } finally {
    await cleanup();
  }
}

async function provenanceCase2() {
  const mockPool = createCapturingPool();
  const auth: AuthInfo = {
    role: "agent",
    clientId: "skippy",
    tokenClientId: "skippy",
    agentId: "spoofed-agent",
    namespaceSource: "token",
  };
  const { client, cleanup } = await setupToolClient(mockPool, auth);

  try {
    const result = await client.callTool({
      name: "append_session_event",
      arguments: {
        session_key: "test",
        event_type: "fact",
        content: "Non-delegated agent id should not become provenance",
      },
    });

    expect(result.isError).toBeFalsy();
    const parsed = parseToolResult(result);
    expect(parsed.writer_identity).toBe("skippy");
    expect(parsed.token_identity).toBe("skippy");
    expect(parsed.delegated_agent_id).toBeNull();
    expect(parsed.namespace_source).toBe("token");

    expect(mockPool.captured.metadata).not.toBeNull();
    expect(
      expectDefined(mockPool.captured.metadata, "mockPool.captured.metadata")
        ._openbrain,
    ).toEqual({
      writer: {
        client_id: "skippy",
        token_client_id: "skippy",
        agent_id: null,
        namespace_source: "token",
      },
    });
  } finally {
    await cleanup();
  }
}

async function provenanceCase3() {
  const mockPool = createCapturingPool();
  const auth: AuthInfo = {
    role: "admin",
    clientId: "nagatha",
    tokenClientId: "rico",
    agentId: "nagatha",
    namespaceSource: "header",
  };
  const { client, cleanup } = await setupToolClient(mockPool, auth);

  try {
    const result = await client.callTool({
      name: "append_session_event",
      arguments: {
        session_key: "test",
        namespace: "nagatha",
        event_type: "fact",
        content: "Nagatha header delegated write provenance canary",
        source: "nagatha",
      },
    });

    expect(result.isError).toBeFalsy();
    const parsed = parseToolResult(result);
    expect(parsed.writer_identity).toBe("nagatha");
    expect(parsed.token_identity).toBe("rico");
    expect(parsed.delegated_agent_id).toBe("nagatha");
    expect(parsed.namespace_source).toBe("header");

    expect(mockPool.captured.createdBy).toBe("nagatha");
    expect(mockPool.captured.metadata).not.toBeNull();
    expect(
      expectDefined(mockPool.captured.metadata, "mockPool.captured.metadata")
        ._openbrain,
    ).toEqual({
      writer: {
        client_id: "nagatha",
        token_client_id: "rico",
        agent_id: "nagatha",
        namespace_source: "header",
      },
    });
  } finally {
    await cleanup();
  }
}

async function provenanceCase4() {
  const mockPool = createCapturingPool();
  const auth: AuthInfo = { role: "admin", clientId: "skippy" };
  const { client, cleanup } = await setupToolClient(mockPool, auth);

  try {
    const result = await client.callTool({
      name: "append_session_event",
      arguments: {
        session_key: "test",
        event_type: "fact",
        content: "Caller metadata should not clobber OpenBrain provenance",
        metadata: {
          _openbrain: { writer: { client_id: "spoofed" } },
          user_value: "kept",
        },
      },
    });

    expect(result.isError).toBeFalsy();
    expect(mockPool.captured.metadata).not.toBeNull();
    expect(
      expectDefined(mockPool.captured.metadata, "mockPool.captured.metadata")
        .user_value,
    ).toBe("kept");
    expect(
      expectDefined(mockPool.captured.metadata, "mockPool.captured.metadata")
        ._caller_openbrain_metadata,
    ).toEqual({
      writer: { client_id: "spoofed" },
    });
    expect(
      expectDefined(mockPool.captured.metadata, "mockPool.captured.metadata")
        ._openbrain,
    ).toEqual({
      writer: {
        client_id: "skippy",
        token_client_id: "skippy",
        agent_id: null,
        namespace_source: "token",
      },
    });
  } finally {
    await cleanup();
  }
}

describe("append_session_event writer provenance", () => {
  it(
    "records distinct writer and token provenance for cross-namespace writes",
    provenanceCase1,
  );
  it(
    "does not treat X-Agent-Id as delegated provenance without X-Namespace",
    provenanceCase2,
  );
  it(
    "records delegated namespace writer separately from token provenance",
    provenanceCase3,
  );
  it(
    "preserves caller _openbrain metadata while stamping trusted writer provenance",
    provenanceCase4,
  );
});
