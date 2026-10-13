/**
 * Bearer-auth MCP HTTP client over fetch — the TypeScript peer of
 * `python/openbrain-memory/src/openbrain_memory/client.py` for the lifecycle
 * surface. Every MCP request declares the reviewed contract id + schema hash
 * in the `X-OB-Contract` header.
 *
 * The fetch transport, the error classes, and the wire-decoding helpers live in
 * `./mcp-transport.ts` and are re-exported here, so this module's import path
 * remains the one every caller uses.
 */

import { CURRENT_CONTRACT_HEADER } from "./contract.ts";
import {
  FetchTransport,
  OpenBrainError,
  OpenBrainHTTPError,
  OpenBrainProtocolError,
  OpenBrainToolError,
  decodeToolPayload,
  headerValue,
  lastSseData,
  toolText,
  type Json,
  type Transport,
  type TransportResponse,
} from "./mcp-transport.ts";

export {
  DEFAULT_MAX_RESPONSE_BYTES,
  FetchTransport,
  OpenBrainError,
  OpenBrainHTTPError,
  OpenBrainProtocolError,
  OpenBrainToolError,
  type Json,
  type OpenBrainErrorOptions,
  type Transport,
  type TransportResponse,
} from "./mcp-transport.ts";

export const MCP_PROTOCOL_VERSION = "2025-03-26";
export const CLIENT_NAME = "openbrain-memory-ts";
export const CLIENT_VERSION = "0.1.0";

function validateBaseUrl(baseUrl: string, allowInsecureHttp: boolean): void {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error(
      "OpenBrainClient baseUrl must use https, localhost http, " +
        "or allowInsecureHttp=true",
    );
  }
  if (parsed.protocol === "https:") {
    return;
  }
  if (parsed.protocol === "http:") {
    const host = parsed.hostname.toLowerCase();
    if (
      allowInsecureHttp ||
      host === "localhost" ||
      host === "127.0.0.1" ||
      host === "::1" ||
      host === "[::1]"
    ) {
      return;
    }
  }
  throw new Error(
    "OpenBrainClient baseUrl must use https, localhost http, " +
      "or allowInsecureHttp=true",
  );
}

const EXPIRED_SESSION_MESSAGES = new Set([
  "bad request: missing session or not an initialize request",
  "invalid or missing session",
]);

/** The `error` member of a 400 body, when it names an expired session. */
function namesExpiredSession(error: unknown): boolean {
  if (typeof error === "string") {
    return EXPIRED_SESSION_MESSAGES.has(error.trim().toLowerCase());
  }
  if (typeof error === "object" && error !== null) {
    const message = (error as Json)["message"];
    return (
      typeof message === "string" &&
      EXPIRED_SESSION_MESSAGES.has(message.trim().toLowerCase())
    );
  }
  return false;
}

/** A JSON object, or null when `value` is any other JSON shape. */
function asJsonObject(value: unknown): Json | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Json;
}

export interface OpenBrainClientOptions {
  token: string;
  namespace: string;
  agentId?: string;
  role?: string;
  /** Seconds, matching the Python client's `timeout`. */
  timeout?: number;
  transport?: Transport;
  allowInsecureHttp?: boolean;
  delegateNamespace?: boolean;
}

/**
 * Minimal MCP streamable-http client for the memory lifecycle surface.
 * Method names are the wire tool names (snake_case) so spooled operations can
 * dispatch by name exactly like the Python runtime router.
 */
export class OpenBrainClient {
  readonly baseUrl: string;
  readonly token: string;
  readonly namespace: string;
  readonly agentId: string | undefined;
  readonly role: string | undefined;
  timeout: number;
  readonly transport: Transport;
  readonly delegateNamespace: boolean;

  private sessionId: string | null = null;
  private protocolVersion: string = MCP_PROTOCOL_VERSION;
  private nextId = 1;
  private initializationPromise: Promise<void> | null = null;
  private lifecycleEpoch = 0;

  constructor(baseUrl: string, options: OpenBrainClientOptions) {
    validateBaseUrl(baseUrl, options.allowInsecureHttp ?? false);
    this.baseUrl = baseUrl.replace(/\/+$/, "") + "/";
    this.token = options.token;
    this.namespace = options.namespace;
    this.agentId = options.agentId;
    this.role = options.role;
    this.timeout = options.timeout ?? 30.0;
    this.transport = options.transport ?? new FetchTransport();
    this.delegateNamespace = options.delegateNamespace ?? false;
  }

  get mcpSessionId(): string | null {
    return this.sessionId;
  }

  async close(): Promise<void> {
    // Invalidate operations that started before close, then wait for any
    // coalesced initialize attempt to clean up its pending server session.
    this.lifecycleEpoch += 1;
    const initialization = this.initializationPromise;
    if (initialization !== null) {
      try {
        await initialization;
      } catch {
        // Initialization owns cleanup for any pending session id.
      }
    }
    const sessionId = this.sessionId;
    this.sessionId = null;
    if (sessionId !== null) {
      await this.discardSession(sessionId);
    }
  }

  async callTool(name: string, args: Json = {}): Promise<Json> {
    const operationEpoch = this.lifecycleEpoch;
    await this.ensureSession(operationEpoch);
    const requestId = this.nextId++;
    const payload: Json = {
      jsonrpc: "2.0",
      id: requestId,
      method: "tools/call",
      params: { name, arguments: { ...args } },
    };
    const context = `call_tool:${name}`;
    const response = await this.postToolCallWithRetry(payload, operationEpoch);
    this.raiseForStatus(response, context);
    const message = this.decodeJsonRpcResponse(response, requestId, context);
    return this.toolResult(message, context);
  }

  /** Post the call, re-initializing once if the server rejects the session. */
  private async postToolCallWithRetry(
    payload: Json,
    operationEpoch: number,
  ): Promise<TransportResponse> {
    const requestSessionId = this.sessionId as string;
    const response = await this.postToolCall(payload, requestSessionId);
    if (!this.isExpiredSessionResponse(response)) {
      return response;
    }
    this.assertOperationEpoch(operationEpoch);
    // A delayed response from an older session must not clear a newer session
    // established by another concurrent caller.
    if (this.sessionId === requestSessionId) {
      this.sessionId = null;
    }
    await this.ensureSession(operationEpoch);
    return this.postToolCall(payload, this.sessionId as string);
  }

  /** Unwrap a JSON-RPC `result` into the tool payload, raising on tool errors. */
  private toolResult(message: Json, context: string): Json {
    const resultObject = asJsonObject(message["result"]);
    if (resultObject === null) {
      throw new OpenBrainProtocolError("MCP tool result was not a JSON object", {
        context,
      });
    }
    if (resultObject["isError"]) {
      throw new OpenBrainToolError("Open Brain tool returned an error", {
        context,
        body: toolText(resultObject),
        token: this.token,
        sessionId: this.sessionId ?? undefined,
      });
    }
    return decodeToolPayload(resultObject);
  }

  async get_contract(args: Json = {}): Promise<Json> {
    return this.callTool("get_contract", args);
  }

  async session_start(args: Json = {}): Promise<Json> {
    return this.callTool("session_start", args);
  }

  async append_session_event(args: Json = {}): Promise<Json> {
    return this.callTool("append_session_event", args);
  }

  async session_wrap(args: Json = {}): Promise<Json> {
    return this.callTool("session_wrap", args);
  }

  async agent_context_pack(args: Json = {}): Promise<Json> {
    return this.callTool("agent_context_pack", args);
  }

  async lane_upsert(args: Json = {}): Promise<Json> {
    return this.callTool("lane_upsert", args);
  }

  async upsert_repo_fact(args: Json = {}): Promise<Json> {
    return this.callTool("upsert_repo_fact", args);
  }

  async log_thought(args: Json = {}): Promise<Json> {
    return this.callTool("log_thought", args);
  }

  async log_decision(args: Json = {}): Promise<Json> {
    return this.callTool("log_decision", args);
  }

  private async ensureSession(expectedEpoch: number): Promise<void> {
    this.assertOperationEpoch(expectedEpoch);
    if (this.sessionId !== null) {
      return;
    }
    let initialization = this.initializationPromise;
    if (initialization === null) {
      initialization = this.initializeSessionWithRetry(expectedEpoch);
      this.initializationPromise = initialization;
      try {
        await initialization;
      } finally {
        if (this.initializationPromise === initialization) {
          this.initializationPromise = null;
        }
      }
    } else {
      await initialization;
    }
    this.assertOperationEpoch(expectedEpoch);
  }

  private async initializeSessionWithRetry(expectedEpoch: number): Promise<void> {
    // One rate-limit retry, mirroring the Python initialize retry.
    try {
      await this.initializeSession(expectedEpoch);
    } catch (error) {
      if (
        error instanceof OpenBrainError &&
        error.statusCode === 429 &&
        this.sessionId === null
      ) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        this.assertOperationEpoch(expectedEpoch);
        await this.initializeSession(expectedEpoch);
        return;
      }
      throw error;
    }
  }

  private async initializeSession(expectedEpoch: number): Promise<void> {
    this.assertOperationEpoch(expectedEpoch);
    const requestId = this.nextId++;
    const payload: Json = {
      jsonrpc: "2.0",
      id: requestId,
      method: "initialize",
      params: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: CLIENT_NAME, version: CLIENT_VERSION },
      },
    };
    const response = await this.transport.post(this.url("mcp"), {
      headers: this.mcpHeaders(false),
      json: payload,
      timeout: this.timeout,
      expectedId: payload["id"] as number | undefined,
    });
    this.raiseForStatus(response, "initialize");
    const pendingSessionId = headerValue(response.headers, "mcp-session-id");
    if (!pendingSessionId) {
      throw new OpenBrainProtocolError("Initialize response missing mcp-session-id", {
        context: "initialize",
      });
    }
    try {
      this.protocolVersion = this.negotiatedProtocolVersion(response, requestId);
      await this.sendInitializedNotification(pendingSessionId);
      this.assertOperationEpoch(expectedEpoch);
      this.sessionId = pendingSessionId;
    } catch (error) {
      await this.discardSession(pendingSessionId);
      throw error;
    }
  }

  /** Read `result.protocolVersion` out of an initialize response. */
  private negotiatedProtocolVersion(
    response: TransportResponse,
    requestId: number,
  ): string {
    const message = this.decodeJsonRpcResponse(response, requestId, "initialize");
    const result = asJsonObject(message["result"]);
    if (result === null) {
      throw new OpenBrainProtocolError("Initialize response missing result object", {
        context: "initialize",
        token: this.token,
      });
    }
    const protocolVersion = result["protocolVersion"];
    if (typeof protocolVersion !== "string") {
      throw new OpenBrainProtocolError("Initialize response missing protocolVersion", {
        context: "initialize",
        token: this.token,
      });
    }
    return protocolVersion;
  }

  private assertOperationEpoch(expectedEpoch: number): void {
    if (expectedEpoch !== this.lifecycleEpoch) {
      throw new OpenBrainProtocolError("MCP operation was invalidated by close", {
        context: "session_lifecycle",
      });
    }
  }

  private async discardSession(sessionId: string): Promise<void> {
    try {
      await this.transport.delete(this.url("mcp"), {
        headers: this.mcpHeaders(true, sessionId),
        timeout: this.timeout,
      });
    } catch {
      // Best-effort session teardown, mirroring the Python client.
    }
  }

  private async sendInitializedNotification(sessionId: string): Promise<void> {
    const payload: Json = {
      jsonrpc: "2.0",
      method: "notifications/initialized",
    };
    const response = await this.transport.post(this.url("mcp"), {
      headers: this.mcpHeaders(true, sessionId),
      json: payload,
      timeout: this.timeout,
    });
    this.raiseForStatus(response, "initialized");
  }

  private async postToolCall(
    payload: Json,
    sessionId: string,
  ): Promise<TransportResponse> {
    return this.transport.post(this.url("mcp"), {
      headers: this.mcpHeaders(true, sessionId),
      json: payload,
      timeout: this.timeout,
      expectedId: payload["id"] as number | undefined,
    });
  }

  private isExpiredSessionResponse(response: TransportResponse): boolean {
    if (response.status === 404) {
      return true;
    }
    if (response.status !== 400) {
      return false;
    }
    let body: unknown;
    try {
      body = JSON.parse(response.text);
    } catch {
      return EXPIRED_SESSION_MESSAGES.has(response.text.trim().toLowerCase());
    }
    if (typeof body !== "object" || body === null) {
      return false;
    }
    return namesExpiredSession((body as Json)["error"]);
  }

  private url(path: string): string {
    return new URL(path, this.baseUrl).toString();
  }

  private mcpHeaders(
    includeSession: boolean,
    sessionId?: string,
  ): Record<string, string> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
      "X-OB-Contract": CURRENT_CONTRACT_HEADER,
    };
    if (this.delegateNamespace) {
      headers["X-Namespace"] = this.namespace;
    }
    if (this.agentId) {
      headers["X-Agent-Id"] = this.agentId;
    }
    if (this.role) {
      headers["X-Role"] = this.role;
    }
    if (includeSession) {
      const activeSessionId = sessionId ?? this.sessionId;
      if (!activeSessionId) {
        throw new OpenBrainProtocolError("MCP session has not been initialized", {
          context: "headers",
        });
      }
      headers["Mcp-Session-Id"] = activeSessionId;
      headers["MCP-Protocol-Version"] = this.protocolVersion;
    }
    return headers;
  }

  private raiseForStatus(response: TransportResponse, context: string): void {
    if (response.status >= 200 && response.status < 300) {
      return;
    }
    throw new OpenBrainHTTPError("Open Brain HTTP error", {
      statusCode: response.status,
      context,
      body: response.text,
      token: this.token,
      sessionId: this.sessionId ?? undefined,
    });
  }

  private decodeJsonRpcResponse(
    response: TransportResponse,
    expectedId: number,
    context: string,
  ): Json {
    const messageObject = this.parseJsonRpcBody(response, expectedId, context);
    if (messageObject["jsonrpc"] !== "2.0") {
      throw new OpenBrainProtocolError("MCP response missing jsonrpc=2.0", {
        context,
        token: this.token,
        sessionId: this.sessionId ?? undefined,
      });
    }
    if (messageObject["id"] !== expectedId) {
      throw new OpenBrainProtocolError("MCP response id did not match request", {
        context,
        token: this.token,
        sessionId: this.sessionId ?? undefined,
      });
    }
    if ("error" in messageObject) {
      throw new OpenBrainProtocolError("MCP JSON-RPC error", {
        context,
        body: JSON.stringify(messageObject["error"]),
        token: this.token,
        sessionId: this.sessionId ?? undefined,
      });
    }
    return messageObject;
  }

  /** Unwrap any SSE framing and parse the response body into a JSON object. */
  private parseJsonRpcBody(
    response: TransportResponse,
    expectedId: number,
    context: string,
  ): Json {
    let text = response.text.trim();
    if (!text) {
      throw new OpenBrainProtocolError("MCP response was empty", { context });
    }
    const contentType = headerValue(response.headers, "content-type") ?? "";
    if (
      contentType.includes("text/event-stream") ||
      text.startsWith("event:") ||
      text.startsWith("data:")
    ) {
      text = lastSseData(text, expectedId);
    }
    let message: unknown;
    try {
      message = JSON.parse(text);
    } catch {
      throw new OpenBrainProtocolError("MCP response was not valid JSON", {
        statusCode: response.status,
        context,
        body: text,
        token: this.token,
        sessionId: this.sessionId ?? undefined,
      });
    }
    const messageObject = asJsonObject(message);
    if (messageObject === null) {
      throw new OpenBrainProtocolError("MCP response was not a JSON object", {
        context,
      });
    }
    return messageObject;
  }
}
