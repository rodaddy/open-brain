/** Shared typed fakes for the TS client tests (peer of `_runtime_fakes.py`). */

import { repoFactMetadata } from "../../../src/tools/repo-facts.ts";
import type { Json, Transport, TransportResponse } from "../src/client.ts";
import {
  CURRENT_CONTRACT_SCHEMA_HASH,
  CURRENT_CONTRACT_SCHEMA_VERSION,
  CURRENT_CONTRACT_VERSION,
  FIRST_CLASS_RUNTIME_TOOL_VERSIONS,
} from "../src/contract.ts";
import type { DirectClient, RuntimeConfig } from "../src/runtime.ts";
import { RuntimeScope } from "../src/runtime.ts";

// Assembled at runtime so no credential-shaped literal lands in source.
export const TEST_TOKEN = ["unit", "test", "token"].join("-");

export function runtimeContractManifest(): Json {
  return {
    contract_scope: "required_openbrain_memory_contract",
    contract_version: CURRENT_CONTRACT_VERSION,
    schema_version: CURRENT_CONTRACT_SCHEMA_VERSION,
    schema_hash: CURRENT_CONTRACT_SCHEMA_HASH,
    capabilities: Object.entries(FIRST_CLASS_RUNTIME_TOOL_VERSIONS).map(
      ([name, version]) => ({ kind: "tool", name, version }),
    ),
    tool_contracts: Object.fromEntries(
      Object.entries(FIRST_CLASS_RUNTIME_TOOL_VERSIONS).map(
        ([name, version]) => [
          name,
          { version, input_schema: {}, output_shape: "object" },
        ],
      ),
    ),
  };
}

export interface RecordedRequest {
  url: string;
  headers: Record<string, string>;
  json: Json;
  timeout: number;
}

/** Fake MCP boundary that rejects writes before session_start. */
export class LaneAwareTransport implements Transport {
  readonly failSessionStart: boolean;
  readonly requests: RecordedRequest[] = [];
  readonly startedSessions = new Map<string, Json>();
  deleteCalls = 0;

  constructor(options: { failSessionStart?: boolean } = {}) {
    this.failSessionStart = options.failSessionStart ?? false;
  }

  async delete(
    _url: string,
    _options: { headers: Record<string, string>; timeout: number },
  ): Promise<TransportResponse> {
    this.deleteCalls += 1;
    return { status: 200, headers: {}, text: "" };
  }

  async post(
    url: string,
    options: { headers: Record<string, string>; json: Json; timeout: number },
  ): Promise<TransportResponse> {
    this.requests.push({
      url,
      headers: { ...options.headers },
      json: structuredClone(options.json),
      timeout: options.timeout,
    });
    const body = options.json;
    const method = body["method"];
    if (method === "initialize") {
      return {
        status: 200,
        headers: {
          "content-type": "application/json",
          "mcp-session-id": "runtime-session",
        },
        text: JSON.stringify({
          jsonrpc: "2.0",
          id: body["id"],
          result: { protocolVersion: "2025-03-26" },
        }),
      };
    }
    if (method === "notifications/initialized") {
      return { status: 202, headers: {}, text: "" };
    }
    if (method !== "tools/call") {
      throw new Error(`unexpected method: ${String(method)}`);
    }
    const params = body["params"] as Json;
    const tool = params["name"] as string;
    const args = params["arguments"] as Json;
    const requestId = body["id"] as number;
    if (tool === "get_contract") {
      return toolResult(requestId, runtimeContractManifest());
    }
    if (tool === "session_start") {
      if (this.failSessionStart) {
        return toolError(requestId, "lane creation failed");
      }
      const requestedLane: Json = {
        namespace: "bilby",
        session_key: args["session_key"],
        agent: args["agent"] ?? null,
        source: args["platform"] ?? null,
        channel_id: args["channel_id"] ?? null,
        thread_id: args["thread_id"] ?? null,
        project: args["project"] ?? null,
        current_context_md: null,
        metadata: { server_id: args["server_id"] ?? null },
      };
      const sessionKey = args["session_key"] as string;
      let lane = this.startedSessions.get(sessionKey);
      const isNew = lane === undefined;
      if (lane === undefined) {
        lane = requestedLane;
        this.startedSessions.set(sessionKey, lane);
      }
      const laneMetadata = lane["metadata"] as Json;
      const requestedMetadata = requestedLane["metadata"] as Json;
      const mismatch =
        ["agent", "source", "channel_id", "thread_id"].some(
          (key) => lane?.[key] !== requestedLane[key],
        ) || laneMetadata["server_id"] !== requestedMetadata["server_id"];
      if (mismatch) {
        return toolError(
          requestId,
          "existing lane exact scope does not match session_start request",
        );
      }
      return toolResult(requestId, { lane, events: [], is_new: isNew });
    }
    if (tool === "append_session_event" || tool === "session_wrap") {
      const sessionKey = args["session_key"] as string | undefined;
      const lane =
        sessionKey !== undefined
          ? this.startedSessions.get(sessionKey)
          : undefined;
      if (lane === undefined) {
        return toolError(requestId, "session lane does not exist");
      }
      const laneMetadata = lane["metadata"] as Json;
      const expectedScope: Json = {
        agent: lane["agent"],
        platform: lane["source"],
        server_id: laneMetadata["server_id"],
        channel_id: lane["channel_id"],
        thread_id: lane["thread_id"],
      };
      const mismatch = Object.entries(expectedScope).some(
        ([key, value]) => (args[key] ?? null) !== value,
      );
      if (mismatch) {
        return toolError(
          requestId,
          `existing lane scope does not match requested ${tool} scope`,
        );
      }
      if (tool === "session_wrap") {
        lane["current_context_md"] = args["summary"];
        return toolResult(requestId, {
          session_id: "session-1",
          lane_id: "lane-1",
          context_updated: true,
        });
      }
      return toolResult(requestId, {
        event_id: "event-1",
        lane_id: "lane-1",
        lane_created: false,
      });
    }
    if (tool === "agent_context_pack") {
      const sessionKey = args["session_key"] as string;
      const lane = this.startedSessions.get(sessionKey);
      const laneMetadata =
        lane !== undefined ? (lane["metadata"] as Json) : undefined;
      const exact =
        lane !== undefined &&
        lane["agent"] === args["agent"] &&
        lane["source"] === args["platform"] &&
        laneMetadata?.["server_id"] === args["server_id"] &&
        lane["channel_id"] === args["channel_id"] &&
        (lane["thread_id"] ?? null) === (args["thread_id"] ?? null);
      const requestedSections = Array.isArray(args["requested_sections"])
        ? (args["requested_sections"] as string[])
        : [];
      let durable: Json | null = null;
      if (
        exact &&
        lane !== undefined &&
        requestedSections.includes("durable_lane_context")
      ) {
        durable = {
          label: "durable_lane_context",
          lane: { current_context_md: lane["current_context_md"] ?? null },
          events: [],
        };
      }
      return toolResult(requestId, {
        tool,
        arguments: args,
        scope: {
          namespace: "bilby",
          session_key: args["session_key"],
          agent: args["agent"],
          platform: args["platform"],
          server_id: args["server_id"],
          channel_id: args["channel_id"],
          thread_id: args["thread_id"] ?? null,
        },
        sections: durable !== null ? { durable_lane_context: durable } : {},
      });
    }
    // Fixture replay must exercise schema-compatible tool arguments. Keeping
    // this fake permissive would let malformed parked records drain green.
    if (tool === "lane_upsert") {
      if (!nonEmpty(args["session_key"])) {
        return toolError(requestId, "lane_upsert requires session_key");
      }
    } else if (tool === "upsert_repo_fact") {
      if (!validRepoFactMetadata(args["metadata"])) {
        return toolError(requestId, "upsert_repo_fact metadata is invalid");
      }
    } else if (tool === "log_thought") {
      if (!nonEmpty(args["content"])) {
        return toolError(requestId, "log_thought requires content");
      }
    } else if (tool === "log_decision") {
      if (!nonEmpty(args["title"]) || !nonEmpty(args["rationale"])) {
        return toolError(
          requestId,
          "log_decision requires title and rationale",
        );
      }
    }
    return toolResult(requestId, {
      tool,
      arguments: args,
      sections: { working_set: { items: [] } },
    });
  }
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function validRepoFactMetadata(value: unknown): boolean {
  return repoFactMetadata.safeParse(value).success;
}

export function toolResult(requestId: number, body: Json): TransportResponse {
  return {
    status: 200,
    headers: { "content-type": "application/json" },
    text: JSON.stringify({
      jsonrpc: "2.0",
      id: requestId,
      result: { content: [{ type: "text", text: JSON.stringify(body) }] },
    }),
  };
}

export function toolError(
  requestId: number,
  message: string,
): TransportResponse {
  return {
    status: 200,
    headers: { "content-type": "application/json" },
    text: JSON.stringify({
      jsonrpc: "2.0",
      id: requestId,
      result: { isError: true, content: [{ type: "text", text: message }] },
    }),
  };
}

/** Direct-client fake: session start succeeds, later writes fail. */
export class StartThenFailClient implements DirectClient {
  timeout = 30.0;
  started = false;
  closed = false;
  readonly failStart: boolean;

  constructor(options: { failStart?: boolean } = {}) {
    this.failStart = options.failStart ?? false;
  }

  get_contract(): Json {
    return runtimeContractManifest();
  }

  session_start(args: Json): Json {
    if (this.failStart) {
      throw new Error(
        "session start failed with " + ["token", "secret-value"].join("="),
      );
    }
    this.started = true;
    return {
      lane: {
        namespace: "bilby",
        session_key: args["session_key"],
        agent: args["agent"],
        source: args["platform"],
        channel_id: args["channel_id"],
        thread_id: args["thread_id"] ?? null,
        metadata: { server_id: args["server_id"] },
      },
    };
  }

  append_session_event(_args: Json): Json {
    if (!this.started) {
      throw new Error("lane missing");
    }
    throw new Error(
      "append failed with " + ["token", "secret-value"].join("="),
    );
  }

  lane_upsert(_args: Json): Json {
    throw new Error("lane_upsert failed");
  }

  upsert_repo_fact(_args: Json): Json {
    throw new Error("upsert_repo_fact failed");
  }

  log_thought(_args: Json): Json {
    throw new Error("log_thought failed");
  }

  log_decision(_args: Json): Json {
    throw new Error("log_decision failed");
  }

  session_wrap(_args: Json): Json {
    if (!this.started) {
      throw new Error("lane missing");
    }
    throw new Error("wrap failed with " + ["token", "secret-value"].join("="));
  }

  agent_context_pack(_args: Json): Json {
    throw new Error(
      "recall failed with " + ["token", "secret-value"].join("="),
    );
  }

  close(): void {
    this.closed = true;
  }
}

/** Echo a caller-chosen scope object from agent_context_pack. */
export class ScopeProofClient extends StartThenFailClient {
  readonly scopeResult: Json;

  constructor(scopeResult: Json) {
    super();
    this.scopeResult = { ...scopeResult };
  }

  override agent_context_pack(_args: Json): Json {
    return { scope: { ...this.scopeResult } };
  }
}

export function runtimeConfig(
  overrides: Partial<RuntimeConfig> = {},
): RuntimeConfig {
  return {
    baseUrl: "https://brain.example",
    token: TEST_TOKEN,
    namespace: "bilby",
    ...overrides,
  };
}

export function runtimeScope(): RuntimeScope {
  return new RuntimeScope({
    agent: "bilby",
    platform: "discord",
    serverId: "guild-1",
    channelId: "channel-2",
    threadId: "thread-3",
    sessionKey: "repo/session-4",
  });
}

export function toolCalls(transport: LaneAwareTransport): Json[] {
  return transport.requests
    .filter((request) => request.json["method"] === "tools/call")
    .map((request) => request.json);
}
