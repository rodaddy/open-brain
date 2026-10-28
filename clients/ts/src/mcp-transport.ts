/**
 * Fetch-backed MCP transport and the wire-decoding helpers it shares with
 * `client.ts`. Split out of `client.ts` so each module holds one job; every
 * name here is re-exported from `client.ts`, so import paths are unchanged.
 */

import { redactText } from "./policy.ts";

export type Json = Record<string, unknown>;

export const DEFAULT_MAX_RESPONSE_BYTES = 1_000_000;

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
    const body = redactBody(options.body ?? "", options.token, options.sessionId);
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

/** True when `value` is a JSON-RPC message object carrying `id === expectedId`. */
function hasExpectedId(value: unknown, expectedId: number): boolean {
  return (
    typeof value === "object" && value !== null && (value as Json)["id"] === expectedId
  );
}

/** Parse an SSE `data:` block and return it when it carries the wanted id. */
function dataBlockForId(block: string, expectedId: number): string | null {
  try {
    const message: unknown = JSON.parse(block);
    return hasExpectedId(message, expectedId) ? block : null;
  } catch {
    // An unrelated malformed SSE event is handled by the protocol layer.
    return null;
  }
}

/** Split raw SSE text into its `data:` blocks, in arrival order. */
function sseDataBlocks(text: string): string[] {
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
  return dataBlocks;
}

export function lastSseData(text: string, expectedId?: number): string {
  const dataBlocks = sseDataBlocks(text);
  if (dataBlocks.length === 0) {
    throw new OpenBrainProtocolError("MCP SSE response did not contain data");
  }
  if (expectedId !== undefined) {
    for (const block of dataBlocks) {
      const matched = dataBlockForId(block, expectedId);
      if (matched !== null) {
        return matched;
      }
    }
  }
  return dataBlocks.at(-1) as string;
}

/** The single `{ type: "text" }` entry of a tool result, when there is one. */
function soleTextContent(result: Json): string | null {
  const content = result["content"];
  if (!Array.isArray(content) || content.length !== 1) {
    return null;
  }
  const item: unknown = content[0];
  if (typeof item !== "object" || item === null || (item as Json)["type"] !== "text") {
    return null;
  }
  const text = (item as Json)["text"];
  return typeof text === "string" ? text : null;
}

export function decodeToolPayload(result: Json): Json {
  const text = soleTextContent(result);
  if (text === null) {
    return { ...result };
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Json;
    }
  } catch {
    // fall through
  }
  return { ...result };
}

export function toolText(result: Json): string {
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
      const text = (item as Json)["text"];
      parts.push(
        typeof text === "string" ? text : text == null ? "" : JSON.stringify(text),
      );
    }
  }
  return parts.join("\n");
}

export function headerValue(
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

/** Just the reader surface `drain` uses, so Bun and DOM stream types both fit. */
interface ByteStreamReader {
  read(): Promise<{ done: boolean; value?: Uint8Array | undefined }>;
  cancel(): Promise<unknown>;
}

interface SendOptions {
  url: string;
  method: "POST" | "DELETE";
  headers: Record<string, string>;
  timeoutSeconds: number;
  json?: Json;
  expectedId?: number;
}

/** Incremental SSE line scanner that stops at the requested JSON-RPC id. */
class SseIdScanner {
  private pending = "";
  private dataLines: string[] = [];

  private readonly expectedId: number;

  constructor(expectedId: number) {
    this.expectedId = expectedId;
  }

  /** Feed a decoded chunk; returns the matching `data:` block, or null. */
  push(chunk: string): string | null {
    this.pending += chunk;
    for (;;) {
      const newline = this.pending.indexOf("\n");
      if (newline < 0) return null;
      const rawLine = this.pending.slice(0, newline);
      this.pending = this.pending.slice(newline + 1);
      const matched = this.consumeLine(
        rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine,
      );
      if (matched !== null) return matched;
    }
  }

  private consumeLine(line: string): string | null {
    if (line.startsWith("data:")) {
      this.dataLines.push(line.slice("data:".length).trim());
      return null;
    }
    if (line !== "") return null;
    const block = this.dataLines.join("\n");
    const empty = this.dataLines.length === 0;
    this.dataLines = [];
    return empty ? null : dataBlockForId(block, this.expectedId);
  }
}

export class FetchTransport implements Transport {
  readonly maxResponseBytes: number;

  constructor(options: { maxResponseBytes?: number } = {}) {
    this.maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
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
    return this.send({
      url,
      method: "POST",
      headers: options.headers,
      timeoutSeconds: options.timeout,
      json: options.json,
      ...(options.expectedId !== undefined ? { expectedId: options.expectedId } : {}),
    });
  }

  async delete(
    url: string,
    options: { headers: Record<string, string>; timeout: number },
  ): Promise<TransportResponse> {
    return this.send({
      url,
      method: "DELETE",
      headers: options.headers,
      timeoutSeconds: options.timeout,
    });
  }

  private async send(options: SendOptions): Promise<TransportResponse> {
    const response = await this.fetchOnce(options);
    const text = await this.readBody(response, options.expectedId);
    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      responseHeaders[key.toLowerCase()] = value;
    });
    return { status: response.status, headers: responseHeaders, text };
  }

  private async fetchOnce(options: SendOptions): Promise<Response> {
    try {
      return await fetch(options.url, {
        method: options.method,
        headers: options.headers,
        redirect: "manual",
        signal: AbortSignal.timeout(
          Math.max(1, Math.round(options.timeoutSeconds * 1000)),
        ),
        ...(options.json !== undefined ? { body: JSON.stringify(options.json) } : {}),
      });
    } catch (error) {
      throw new OpenBrainHTTPError(
        `Open Brain request failed: ${error instanceof Error ? error.name : "fetch error"}`,
        { context: "transport" },
      );
    }
  }

  /** Read a size-checked body and stop an SSE response at the requested id. */
  private async readBody(response: Response, expectedId?: number): Promise<string> {
    const reader = response.body?.getReader();
    if (reader === undefined) return "";
    const contentType = response.headers.get("content-type") ?? "";
    const scanner =
      expectedId !== undefined && contentType.includes("text/event-stream")
        ? new SseIdScanner(expectedId)
        : null;
    try {
      return await this.drain(reader, scanner);
    } catch (error) {
      if (error instanceof OpenBrainHTTPError) throw error;
      throw new OpenBrainHTTPError("Open Brain response stream failed", {
        context: "transport",
      });
    }
  }

  private async drain(
    reader: ByteStreamReader,
    scanner: SseIdScanner | null,
  ): Promise<string> {
    const decoder = new TextDecoder();
    let bytes = 0;
    let text = "";
    for (;;) {
      const next = await reader.read();
      if (next.done || next.value === undefined) break;
      bytes += next.value.byteLength;
      if (bytes > this.maxResponseBytes) {
        await reader.cancel();
        throw new OpenBrainHTTPError("Open Brain response exceeded maxResponseBytes", {
          context: "transport",
        });
      }
      const chunk = decoder.decode(next.value, { stream: true });
      text += chunk;
      const matched = scanner?.push(chunk) ?? null;
      if (matched !== null) {
        await reader.cancel();
        return `data: ${matched}\n\n`;
      }
    }
    return text + decoder.decode();
  }
}
