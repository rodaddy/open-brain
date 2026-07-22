/**
 * Persisted-content and exact-scope validation — the TypeScript peer of
 * `python/openbrain-memory/src/openbrain_memory/_runtime_validation.py`.
 */

import type { Json } from "./client.ts";
import { rejectSecretPayload, ValidationError } from "./policy.ts";

export const MAX_DISTILLED_CONTENT_BYTES = 16 * 1024;

export interface RuntimeScopeCoordinates {
  readonly agent: string;
  readonly platform: string;
  readonly server_id: string;
  readonly channel_id: string;
  readonly session_key: string;
  readonly thread_id: string | null;
}

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function requireText(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new ValidationError(`${name} must be a non-empty string`);
  }
  return value.trim();
}

export function optionalText(value: unknown, name: string): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  return requireText(value, name);
}

export function boundedInt(
  value: unknown,
  name: string,
  minimum: number,
  maximum: number,
): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new ValidationError(`${name} must be an integer`);
  }
  if (value < minimum || value > maximum) {
    throw new ValidationError(
      `${name} must be between ${minimum} and ${maximum}`,
    );
  }
  return value;
}

/** Validate content that will be persisted as distilled memory. */
export function distilledContent(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new ValidationError(`${name} must be a non-empty string`);
  }
  if (Buffer.byteLength(value, "utf-8") > MAX_DISTILLED_CONTENT_BYTES) {
    throw new ValidationError(
      `${name} exceeds ${MAX_DISTILLED_CONTENT_BYTES} UTF-8 bytes`,
    );
  }
  rejectSecretPayload(value, name);
  return value;
}

/** Validate text that will be persisted as scope or project metadata. */
export function persistedText(value: unknown, name: string): string {
  const text = requireText(value, name);
  if (Buffer.byteLength(text, "utf-8") > MAX_DISTILLED_CONTENT_BYTES) {
    throw new ValidationError(
      `${name} exceeds ${MAX_DISTILLED_CONTENT_BYTES} UTF-8 bytes`,
    );
  }
  rejectSecretPayload(text, name);
  return text;
}

/** Return the exact scope fields a server response must prove. */
export function exactScopeFields(
  namespace: string,
  scope: RuntimeScopeCoordinates,
): Json {
  return {
    namespace,
    session_key: scope.session_key,
    agent: scope.agent,
    platform: scope.platform,
    server_id: scope.server_id,
    channel_id: scope.channel_id,
    thread_id: scope.thread_id,
  };
}

/** Require every expected field to be present with its exact value. */
export function validateExactFields(
  candidate: Json,
  expected: Json,
  label: string,
): void {
  const mismatches = Object.entries(expected)
    .filter(
      ([name, value]) => !(name in candidate) || candidate[name] !== value,
    )
    .map(([name]) => name)
    .sort();
  if (mismatches.length > 0) {
    throw new ValidationError(
      `${label} did not prove exact Open Brain scope: ${mismatches.join(", ")}`,
    );
  }
}

/** Require a session-start result to prove the requested exact scope. */
export function validateStartedLane(
  result: unknown,
  namespace: string,
  scope: RuntimeScopeCoordinates,
): void {
  if (!isRecord(result)) {
    throw new ValidationError("session_start result missing lane object");
  }
  const lane = result["lane"];
  if (!isRecord(lane)) {
    throw new ValidationError("session_start result missing lane object");
  }
  const metadata = lane["metadata"];
  const candidate: Json = {};
  for (const name of [
    "namespace",
    "session_key",
    "agent",
    "source",
    "channel_id",
    "thread_id",
  ]) {
    if (name in lane) {
      candidate[name] = lane[name];
    }
  }
  if (isRecord(metadata) && "server_id" in metadata) {
    candidate["server_id"] = metadata["server_id"];
  }
  const expected = exactScopeFields(namespace, scope);
  expected["source"] = expected["platform"];
  delete expected["platform"];
  validateExactFields(candidate, expected, "session_start result");
}

/** Require a context-pack result to prove the requested exact scope. */
export function validateContextPackScope(
  result: unknown,
  namespace: string,
  scope: RuntimeScopeCoordinates,
): void {
  if (!isRecord(result)) {
    throw new ValidationError("agent_context_pack result missing scope");
  }
  let candidate: unknown = result["scope"];
  if (!isRecord(candidate)) {
    const payload = result["payload"];
    candidate = isRecord(payload) ? payload["scope"] : null;
  }
  if (!isRecord(candidate)) {
    throw new ValidationError("agent_context_pack result missing scope");
  }
  validateExactFields(
    candidate,
    exactScopeFields(namespace, scope),
    "agent_context_pack result",
  );
}

/** Validate optional persisted metadata for checkpoint and wrap calls. */
export function wrapMetadata(
  keyDecisions: readonly string[] | null | undefined,
  nextSteps: readonly string[] | null | undefined,
  receiptRefs: readonly string[] | null | undefined,
): Json {
  const metadata: Json = {};
  const entries: Array<[string, readonly string[] | null | undefined]> = [
    ["key_decisions", keyDecisions],
    ["next_steps", nextSteps],
    ["receipt_refs", receiptRefs],
  ];
  for (const [name, values] of entries) {
    if (values === null || values === undefined) {
      continue;
    }
    if (typeof values === "string" || !Array.isArray(values)) {
      throw new ValidationError(`${name} must be a sequence of strings`);
    }
    const distilled = values.map((value) => distilledContent(value, name));
    if (distilled.length > 20) {
      throw new ValidationError(`${name} must contain at most 20 items`);
    }
    const encoded = Buffer.byteLength(JSON.stringify(distilled), "utf-8");
    if (encoded > MAX_DISTILLED_CONTENT_BYTES) {
      throw new ValidationError(
        `${name} exceeds ${MAX_DISTILLED_CONTENT_BYTES} UTF-8 bytes`,
      );
    }
    metadata[name] = distilled;
  }
  return metadata;
}
