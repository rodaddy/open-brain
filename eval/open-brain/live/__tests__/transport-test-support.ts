import { expect } from "vitest";
import {
  LiveTransportError,
  type McpClientLike,
  type OpenBrainToolCaller,
  type ToolCallResult,
} from "../transport.ts";

// Shared harness for the live transport wrapper suites. These target the
// redaction boundary and the semantic client without touching a hosted server:
// every failure must be reduced to a content-free label, denial must be modeled
// distinctly from a generic error, and the primary recall path must never
// swallow a denial (only the explicit isolation probe may).

/** A scripted fake caller: each tool name maps to a queue of results. */
export function fakeCaller(
  script: Record<string, ToolCallResult[]>,
  log?: { calls: Array<{ name: string; args: Record<string, unknown> }> },
): OpenBrainToolCaller {
  const queues: Record<string, ToolCallResult[]> = {};
  for (const [k, v] of Object.entries(script)) queues[k] = [...v];
  return {
    async callTool(name, args) {
      log?.calls.push({ name, args });
      const q = queues[name];
      if (!q || q.length === 0) {
        throw new Error(`fake caller has no scripted result for ${name}`);
      }
      const next = q.shift();
      if (next === undefined) {
        throw new Error(`fake caller queue for ${name} drained`);
      }
      return next;
    },
    async close() {},
  };
}

/** A successful tool result carrying `data`. */
export function ok(data: string): ToolCallResult {
  return { isError: false, denied: false, data, errorLabel: "" };
}

/** A denial: the server refused the call (isolation proof). */
export function denied(label: string): ToolCallResult {
  return { isError: true, denied: true, data: "", errorLabel: label };
}

/** A generic (non-denial) tool error. */
export function errored(label: string): ToolCallResult {
  return { isError: true, denied: false, data: "", errorLabel: label };
}

/** Build a fake McpClientLike whose methods throw or return scripted results. */
export function fakeMcpClient(behavior: {
  connect?: () => Promise<void>;
  callTool?: () => Promise<{ content?: unknown; isError?: boolean }>;
  close?: () => Promise<void>;
}): McpClientLike {
  return {
    async connect() {
      if (behavior.connect) return behavior.connect();
    },
    async callTool() {
      if (behavior.callTool) return behavior.callTool();
      return { content: [{ type: "text", text: "{}" }], isError: false };
    },
    async close() {
      if (behavior.close) return behavior.close();
    },
  };
}

/**
 * Assert a caught value is a LiveTransportError and return it narrowed, so a
 * suite can read `label`/`message` off a `Promise<Outcome>` rejection
 * without a cast.
 */
export function expectTransportError(value: unknown): LiveTransportError {
  expect(value).toBeInstanceOf(LiveTransportError);
  if (!(value instanceof LiveTransportError)) throw new Error("unreachable");
  return value;
}
