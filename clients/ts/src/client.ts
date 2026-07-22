/**
 * Bearer-auth MCP HTTP client over fetch — the TypeScript peer of
 * `python/openbrain-memory/src/openbrain_memory/client.py` for the lifecycle
 * surface. Every MCP request declares the reviewed contract id + schema hash
 * in the `X-OB-Contract` header.
 */

import { CURRENT_CONTRACT_HEADER } from "./contract.ts";
import { redactText } from "./policy.ts";

export type Json = Record<string, unknown>;

export const MCP_PROTOCOL_VERSION = "2025-03-26";
export const DEFAULT_MAX_RESPONSE_BYTES = 1_000_000;
export const CLIENT_NAME = "openbrain-memory-ts";
export const CLIENT_VERSION = "0.1.0";

export interface TransportResponse {
  status: number;
  headers: Record<string, string>;
  text: string;
}

export interface Transport {
  post(
    url: string,
    options: {
      headers: Record<string, string>;
      json: Json;
      timeout: number;
      /** Lets stream-capable transports stop after the matching SSE response. */
      expectedId?: number;
    },
  ): Promise<TransportResponse>;
  delete(
    url: string,
    options: { headers: Record<string, string>; timeout: number },
  ): Promise<TransportResponse>;
}

export interface OpenBrainErrorOptions {
  statusCode?: number;
  context?: string;
  body?: string;
  token?: string;
  sessionId?: string;
}

function redactBody(
  body: string,
  token: string | undefined,
  sessionId: string | undefined,
  maxLength = 1000,
): string {
  let redacted = body;
  for (const secret of [token, sessionId]) {
    if (secret) {
      redacted = redacted.split(secret).join("[REDACTED]");
    }
  }
  redacted = redactText(redacted);
  if (redacted.length > maxLength) {
    redacted = redacted.slice(0, maxLength) + "...[truncated]";
  }
  return redacted;
}

export class OpenBrainError extends Error {
  readonly statusCode: number | undefined;
  readonly context: string | undefined;
  readonly body: string;

  constructor(message: string, options: OpenBrainErrorOptions = {}) {
    const body = redactBody(
      options.body ?? "",
      options.token,
      options.sessionId,
    );
    const parts = [message];
    if (options.statusCode !== undefined) {
      parts.push(`status=${options.statusCode}`);
    }
    if (options.context) {
      parts.push(`context=${options.context}`);
    }
    if (body) {
      parts.push(`body=${body}`);
    }
    super(parts.join(" "));
    this.name = new.target.name;
    this.statusCode = options.statusCode;
    this.context = options.context;
    this.body = body;
  }
}

export class OpenBrainHTTPError extends OpenBrainError {}
export class OpenBrainProtocolError extends OpenBrainError {}
export class OpenBrainToolError extends OpenBrainError {}

export class FetchTransport implements Transport {
  readonly maxResponseBytes: number;

  constructor(options: { maxResponseBytes?: number } = {}) {
    this.maxResponseBytes =
      options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    if (this.maxResponseBytes < 1) {
      throw new Error("maxResponseBytes must be >= 1");
    }
  }

  async post(
    url: string,
    options: {
      headers: Record<string, string>;
      json: Json;
      timeout: number;
      expectedId?: number;
    },
  ): Promise<TransportResponse> {
    return this.send(
      url,
      "POST",
      options.headers,
      options.timeout,
      options.json,
      options.expectedId,
    );
  }

  async delete(
    url: string,
    options: { headers: Record<string, string>; timeout: number },
  ): Promise<TransportResponse> {
    return this.send(url, "DELETE", options.headers, options.timeout);
  }

  private async send(
    url: string,
    method: "POST" | "DELETE",
    headers: Record<string, string>,
    timeoutSeconds: number,
    json?: Json,
    expectedId?: number,
  ): Promise<TransportResponse> {
    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers,
        redirect: "manual",
        signal: AbortSignal.timeout(
          Math.max(1, Math.round(timeoutSeconds * 1000)),
        ),
        ...(json !== undefined ? { body: JSON.stringify(json) } : {}),
      });
    } catch (error) {
      throw new OpenBrainHTTPError(
        `Open Brain request failed: ${error instanceof Error ? error.name : "fetch error"}`,
        { context: "transport" },
      );
    }
    const text = await this.readBody(response, expectedId);
    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      responseHeaders[key.toLowerCase()] = value;
    });
    return { status: response.status, headers: responseHeaders, text };
  }

  /** Read a bounded body and stop an SSE response at the requested JSON-RPC id. */
  private async readBody(
    response: Response,
    expectedId?: number,
  ): Promise<string> {
    const reader = response.body?.getReader();
    if (reader === undefined) return "";
    const decoder = new TextDecoder();
    const contentType = response.headers.get("content-type") ?? "";
    const isSse = contentType.includes("text/event-stream");
    let bytes = 0;
    let text = "";
    let pending = "";
    let dataLines: string[] = [];
    const matched = (): string | null => {
      if (expectedId === undefined || dataLines.length === 0) return null;
      const data = dataLines.join("\n");
      try {
        const message: unknown = JSON.parse(data);
        if (
          typeof message === "object" &&
          message !== null &&
          (message as Json)["id"] === expectedId
        ) {
          return data;
        }
      } catch {
        // An unrelated malformed SSE event is handled by the protocol layer.
      }
      return null;
    };
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        bytes += next.value.byteLength;
        if (bytes > this.maxResponseBytes) {
          await reader.cancel();
          throw new OpenBrainHTTPError(
            "Open Brain response exceeded maxResponseBytes",
            { context: "transport" },
          );
        }
        const chunk = decoder.decode(next.value, { stream: true });
        text += chunk;
        if (!isSse || expectedId === undefined) continue;
        pending += chunk;
        while (true) {
          const newline = pending.indexOf("\n");
          if (newline < 0) break;
          const rawLine = pending.slice(0, newline);
          pending = pending.slice(newline + 1);
          const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
          if (line === "") {
            const data = matched();
            dataLines = [];
            if (data !== null) {
              await reader.cancel();
              return `data: ${data}\n\n`;
            }
          } else if (line.startsWith("data:")) {
            dataLines.push(line.slice("data:".length).trim());
          }
        }
      }
      text += decoder.decode();
      return text;
    } catch (error) {
      if (error instanceof OpenBrainHTTPError) throw error;
      throw new OpenBrainHTTPError("Open Brain response stream failed", {
        context: "transport",
      });
    }
  }
}

function headerValue(
  headers: Record<string, string>,
  name: string,
): string | undefined {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) {
      return value;
    }
  }
  return undefined;
}

function lastSseData(text: string, expectedId?: number): string {
  const dataBlocks: string[] = [];
  let current: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line) {
      if (current.length > 0) {
        dataBlocks.push(current.join("\n"));
        current = [];
      }
      continue;
    }
    if (line.startsWith("data:")) {
      current.push(line.slice("data:".length).trim());
    }
  }
  if (current.length > 0) {
    dataBlocks.push(current.join("\n"));
  }
  if (dataBlocks.length === 0) {
    throw new OpenBrainProtocolError("MCP SSE response did not contain data");
  }
  if (expectedId !== undefined) {
    for (const block of dataBlocks) {
      try {
        const message: unknown = JSON.parse(block);
        if (
          typeof message === "object" &&
          message !== null &&
          (message as Json)["id"] === expectedId
        ) {
          return block;
        }
      } catch {
        continue;
      }
    }
  }
  return dataBlocks.at(-1) as string;
}

function decodeToolPayload(result: Json): Json {
  const content = result["content"];
  if (!Array.isArray(content) || content.length !== 1) {
    return { ...result };
  }
  const item: unknown = content[0];
  if (
    typeof item !== "object" ||
    item === null ||
    (item as Json)["type"] !== "text"
  ) {
    return { ...result };
  }
  const text = (item as Json)["text"];
  if (typeof text !== "string") {
    return { ...result };
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed)
    ) {
      return parsed as Json;
    }
  } catch {
    // fall through
  }
  return { ...result };
}

function toolText(result: Json): string {
  const content = result["content"];
  if (!Array.isArray(content)) {
    return JSON.stringify(result);
  }
  const parts: string[] = [];
  for (const item of content) {
    if (
      typeof item === "object" &&
      item !== null &&
      (item as Json)["type"] === "text"
    ) {
      parts.push(String((item as Json)["text"] ?? ""));
    }
  }
  return parts.join("\n");
}

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
    const requestSessionId = this.sessionId as string;
    let response = await this.postToolCall(payload, requestSessionId);
    if (this.isExpiredSessionResponse(response)) {
      this.assertOperationEpoch(operationEpoch);
      // A delayed response from an older session must not clear a newer session
      // established by another concurrent caller.
      if (this.sessionId === requestSessionId) {
        this.sessionId = null;
      }
      await this.ensureSession(operationEpoch);
      response = await this.postToolCall(payload, this.sessionId as string);
    }
    this.raiseForStatus(response, `call_tool:${name}`);
    const message = this.decodeJsonRpcResponse(
      response,
      requestId,
      `call_tool:${name}`,
    );
    const result = message["result"];
    if (
      typeof result !== "object" ||
      result === null ||
      Array.isArray(result)
    ) {
      throw new OpenBrainProtocolError(
        "MCP tool result was not a JSON object",
        {
          context: `call_tool:${name}`,
        },
      );
    }
    const resultObject = result as Json;
    if (resultObject["isError"]) {
      throw new OpenBrainToolError("Open Brain tool returned an error", {
        context: `call_tool:${name}`,
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

  private async initializeSessionWithRetry(
    expectedEpoch: number,
  ): Promise<void> {
    // One bounded rate-limit retry, mirroring the Python initialize retry.
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
      throw new OpenBrainProtocolError(
        "Initialize response missing mcp-session-id",
        { context: "initialize" },
      );
    }
    try {
      const message = this.decodeJsonRpcResponse(
        response,
        requestId,
        "initialize",
      );
      const result = message["result"];
      if (
        typeof result !== "object" ||
        result === null ||
        Array.isArray(result)
      ) {
        throw new OpenBrainProtocolError(
          "Initialize response missing result object",
          { context: "initialize", token: this.token },
        );
      }
      const protocolVersion = (result as Json)["protocolVersion"];
      if (typeof protocolVersion !== "string") {
        throw new OpenBrainProtocolError(
          "Initialize response missing protocolVersion",
          { context: "initialize", token: this.token },
        );
      }
      this.protocolVersion = protocolVersion;
      await this.sendInitializedNotification(pendingSessionId);
      this.assertOperationEpoch(expectedEpoch);
      this.sessionId = pendingSessionId;
    } catch (error) {
      await this.discardSession(pendingSessionId);
      throw error;
    }
  }

  private assertOperationEpoch(expectedEpoch: number): void {
    if (expectedEpoch !== this.lifecycleEpoch) {
      throw new OpenBrainProtocolError(
        "MCP operation was invalidated by close",
        { context: "session_lifecycle" },
      );
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
    const error = (body as Json)["error"];
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
        throw new OpenBrainProtocolError(
          "MCP session has not been initialized",
          {
            context: "headers",
          },
        );
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
    if (
      typeof message !== "object" ||
      message === null ||
      Array.isArray(message)
    ) {
      throw new OpenBrainProtocolError("MCP response was not a JSON object", {
        context,
      });
    }
    const messageObject = message as Json;
    if (messageObject["jsonrpc"] !== "2.0") {
      throw new OpenBrainProtocolError("MCP response missing jsonrpc=2.0", {
        context,
        token: this.token,
        sessionId: this.sessionId ?? undefined,
      });
    }
    if (messageObject["id"] !== expectedId) {
      throw new OpenBrainProtocolError(
        "MCP response id did not match request",
        {
          context,
          token: this.token,
          sessionId: this.sessionId ?? undefined,
        },
      );
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
}
