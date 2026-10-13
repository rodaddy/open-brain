/**
 * Module-level support for the first-class runtime facade: receipt and drain
 * value objects, the exact `RuntimeScope`, adopted-lane scope reading, and the
 * direct-client shapes the runtime calls through.
 *
 * Split out of `runtime.ts` so each module stays reviewable; `runtime.ts`
 * re-exports every public name here, so no import path changes.
 */
import type { Json } from "./client.ts";
import { OpenBrainClient, OpenBrainError } from "./client.ts";
import { redactText, ValidationError } from "./policy.ts";
import type { SpoolAppendRecord } from "./spool.ts";
import { boundedInt, persistedText, requireText } from "./validation.ts";

export const MAX_ERROR_CHARS = 500;

export const EVENT_TYPES: ReadonlySet<string> = new Set([
  "fact",
  "decision",
  "blocker",
  "action",
  "artifact",
  "receipt",
  "question",
  "correction",
  "handoff",
]);

/**
 * The rejection reason for an event type outside {@link EVENT_TYPES}.
 *
 * Names the rejected value AND the accepted set, because a rejection that only
 * says what was wrong leaves the caller no way to be right (#431). The bare
 * `Unsupported event_type: finding` this replaces was true and useless to an
 * agent that reached for `finding` because it did not know the nine words it
 * was allowed to use.
 *
 * Sorted so the text is stable across runs -- `Set` iteration order follows
 * insertion, and an error string that reorders itself when the declaration is
 * reordered cannot be asserted on or diffed in a log.
 *
 * Kept byte-identical to `openbrain_memory.unsupported_event_type` so the two
 * clients answer the same caller error the same way; `test_ts_parity.py` is
 * what holds the two runtime surfaces together.
 */
export function unsupportedEventType(value: string): string {
  return (
    `Unsupported event_type: ${value}; ` +
    `accepted event types: ${[...EVENT_TYPES].sort().join(", ")}`
  );
}

export const CONTEXT_PACK_SECTIONS: ReadonlySet<string> = new Set([
  "candidate_memory",
  "durable_lane_context",
  "durable_memory",
  "pointers",
  "process_guidance",
  "profile_guidance",
  "recovery",
  "repo_facts",
  "working_set",
]);

export const REPLAYABLE_SPOOL_OPERATIONS = [
  "session_start",
  "lane_upsert",
  "upsert_repo_fact",
  "append_session_event",
  "log_thought",
  "log_decision",
  "session_wrap",
] as const;
export type ReplayableOperation = (typeof REPLAYABLE_SPOOL_OPERATIONS)[number];
export const REPLAYABLE_SET: ReadonlySet<string> = new Set(REPLAYABLE_SPOOL_OPERATIONS);

/**
 * Client-internal provenance key stamped on EVERY spooled record payload and
 * stripped before dispatch; it never reaches the server (#314, PR #317).
 */
export const PARKED_NAMESPACE_KEY = "_parked_namespace";

export const ReceiptStatus = {
  DIRECT: "direct",
  SAVED: "saved",
  SPOOLED: "spooled",
  FALLBACK: "fallback",
  FAILED: "failed",
  LOST: "lost",
  REPLAYED: "replayed",
  QUARANTINED: "quarantined",
} as const;
export type ReceiptStatusValue = (typeof ReceiptStatus)[keyof typeof ReceiptStatus];

export const RUNTIME_RECEIPT_SCHEMA = "openbrain.runtime_receipt.v1";

/** Raised internally when no direct call succeeded. */
export class RuntimeCallError extends Error {}

/** Raised when a server response fails the exact-scope proof. */
export class ScopeProofError extends RuntimeCallError {}

export function safeText(value: string): string {
  return redactText(value).slice(0, MAX_ERROR_CHARS);
}

export function safeError(error: unknown): string {
  if (error instanceof OpenBrainError) {
    const status = error.statusCode === undefined ? "none" : String(error.statusCode);
    const context = error.context ?? "none";
    return `remote_error=${error.constructor.name} status=${status} context=${context}`;
  }
  if (error instanceof Error) {
    // Local diagnostics may be useful, but never copy an arbitrary exception
    // body into a durable receipt: callers and remote SDKs can include payloads.
    return `local_error=${error.constructor.name || "Error"}`;
  }
  return `local_error=${typeof error}`;
}

export interface RuntimeReceiptInit {
  operation: string;
  status: ReceiptStatusValue;
  durable: boolean;
  directAttempted: boolean;
  fallbackAttempted: boolean;
  spoolKey?: string | null;
  error?: string | null;
}

/** Truthful, JSON-ready evidence for a lifecycle operation. */
export class RuntimeReceipt {
  readonly operation: string;
  readonly status: ReceiptStatusValue;
  readonly durable: boolean;
  readonly directAttempted: boolean;
  readonly fallbackAttempted: boolean;
  readonly spoolKey: string | null;
  readonly error: string | null;

  constructor(init: RuntimeReceiptInit) {
    this.operation = init.operation;
    this.status = init.status;
    this.durable = init.durable;
    this.directAttempted = init.directAttempted;
    this.fallbackAttempted = init.fallbackAttempted;
    this.spoolKey = init.spoolKey ?? null;
    this.error = init.error ?? null;
  }

  asDict(): Json {
    const value: Json = {
      schema: RUNTIME_RECEIPT_SCHEMA,
      operation: this.operation,
      status: this.status,
      durable: this.durable,
      direct_attempted: this.directAttempted,
      fallback_attempted: this.fallbackAttempted,
    };
    if (this.spoolKey !== null) {
      value["spool_key"] = this.spoolKey;
    }
    if (this.error !== null) {
      value["error"] = this.error;
    }
    return value;
  }
}

/**
 * Content-free outcome of one automatic spool drain (#296): counts and linked
 * receipts only — spool keys, operations, statuses, error categories — never
 * payload content and never error message bodies. `retained_units` counts
 * units left parked without dispatch or failure accounting (#310/#314).
 */
export class DrainReport {
  readonly attemptedUnits: number;
  readonly replayedUnits: number;
  readonly replayedRecords: number;
  readonly failedUnits: number;
  readonly quarantinedUnits: number;
  readonly retainedUnits: number;
  readonly receipts: readonly RuntimeReceipt[];

  constructor(init: {
    attemptedUnits: number;
    replayedUnits: number;
    replayedRecords: number;
    failedUnits: number;
    quarantinedUnits: number;
    retainedUnits: number;
    receipts: readonly RuntimeReceipt[];
  }) {
    this.attemptedUnits = init.attemptedUnits;
    this.replayedUnits = init.replayedUnits;
    this.replayedRecords = init.replayedRecords;
    this.failedUnits = init.failedUnits;
    this.quarantinedUnits = init.quarantinedUnits;
    this.retainedUnits = init.retainedUnits;
    this.receipts = init.receipts;
  }

  asDict(): Json {
    return {
      attempted_units: this.attemptedUnits,
      replayed_units: this.replayedUnits,
      replayed_records: this.replayedRecords,
      failed_units: this.failedUnits,
      quarantined_units: this.quarantinedUnits,
      retained_units: this.retainedUnits,
      receipts: this.receipts.map((receipt) => receipt.asDict()),
    };
  }
}

/** One context or write result with its receipt. */
export interface RuntimeOutput {
  receipt: RuntimeReceipt;
  context?: Json;
  result?: Json;
  drain?: DrainReport | null;
}

export * from "./runtime-scope.ts";

import { RuntimeScope } from "./runtime-scope.ts";

/** Direct-client configuration for the first-class runtime. */
export interface RuntimeConfig {
  baseUrl: string;
  token: string;
  namespace: string;
  project?: string | null;
  role?: string | null;
  allowInsecureHttp?: boolean;
  /** Seconds, mirroring the Python client's `timeout`. */
  timeout?: number;
  spoolPath?: string | null;
}

export function validateConfig(config: RuntimeConfig): Required<
  Pick<RuntimeConfig, "baseUrl" | "token" | "namespace">
> & {
  project: string | null;
  role: string | null;
  allowInsecureHttp: boolean;
  timeout: number;
  spoolPath: string | null;
} {
  const baseUrl = requireText(config.baseUrl, "baseUrl");
  const token = requireText(config.token, "token");
  const namespace = requireText(config.namespace, "namespace");
  const timeout = validateTimeout(config.timeout);
  rejectKnownNonEndpoint(baseUrl);
  return {
    baseUrl,
    token,
    namespace,
    project: optionalPersisted(config.project, "project"),
    role: optionalRequired(config.role, "role"),
    allowInsecureHttp: config.allowInsecureHttp ?? false,
    timeout,
    spoolPath: config.spoolPath ?? null,
  };
}

/** Default the request timeout and refuse a non-positive one. */
function validateTimeout(timeout: number | undefined): number {
  const seconds = timeout ?? 30.0;
  if (!(seconds > 0)) {
    throw new ValidationError("timeout must be > 0");
  }
  return seconds;
}

/**
 * Refuse a base URL that names a service known not to be Open Brain.
 *
 * An unparseable URL is left alone: `OpenBrainClient` rejects it later with a
 * better message than this check could give.
 */
function rejectKnownNonEndpoint(baseUrl: string): void {
  let hostname = "";
  let port = "";
  try {
    const parsed = new URL(baseUrl);
    hostname = parsed.hostname;
    port = parsed.port;
  } catch {
    return;
  }
  if ((hostname === "127.0.0.1" || hostname === "localhost") && port === "8317") {
    throw new ValidationError("127.0.0.1:8317 is not an Open Brain endpoint");
  }
}

/** Validate an optional persisted-text field, keeping unset as null. */
function optionalPersisted(
  value: string | null | undefined,
  field: string,
): string | null {
  return value === undefined || value === null ? null : persistedText(value, field);
}

/** Validate an optional non-empty field, keeping unset as null. */
function optionalRequired(
  value: string | null | undefined,
  field: string,
): string | null {
  return value === undefined || value === null ? null : requireText(value, field);
}

/** Direct Open Brain methods used by the first-class runtime. */
export interface DirectClient {
  timeout: number;
  get_contract(args?: Json): Json | Promise<Json>;
  session_start(args: Json): Json | Promise<Json>;
  append_session_event(args: Json): Json | Promise<Json>;
  lane_upsert(args: Json): Json | Promise<Json>;
  upsert_repo_fact(args: Json): Json | Promise<Json>;
  log_thought(args: Json): Json | Promise<Json>;
  log_decision(args: Json): Json | Promise<Json>;
  session_wrap(args: Json): Json | Promise<Json>;
  agent_context_pack(args: Json): Json | Promise<Json>;
  close(): void | Promise<void>;
}

/** Minimal spool surface a runtime accepts (JsonlSpool implements it). */
export interface MemorySpoolLike {
  append(operation: string, payload: Json, key?: string | null): string;
  appendBatch?(records: readonly SpoolAppendRecord[]): string[];
}

export interface CallState {
  path: "direct" | null;
  directAttempted: boolean;
  fallbackAttempted: boolean;
}

export function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function nonEmptyText(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

export function verifyAppendResult(result: Json): void {
  if (result["duplicate"] === true) {
    return;
  }
  if (!nonEmptyText(result["event_id"]) || !nonEmptyText(result["lane_id"])) {
    throw new RuntimeCallError(
      "append_session_event result did not prove a created or duplicate event",
    );
  }
  if (typeof result["lane_created"] !== "boolean") {
    throw new RuntimeCallError(
      "append_session_event result missing lane_created boolean",
    );
  }
}

export function verifyWrapResult(result: Json): void {
  if (!nonEmptyText(result["lane_id"]) || result["context_updated"] !== true) {
    throw new RuntimeCallError(
      "session_wrap result did not prove durable lane context update",
    );
  }
  if (result["duplicate"] === true) {
    return;
  }
  if (!nonEmptyText(result["session_id"])) {
    throw new RuntimeCallError(
      "session_wrap result did not prove a created or duplicate checkpoint",
    );
  }
}

export interface FirstClassMemoryRuntimeOptions {
  client?: DirectClient;
  transport?: ConstructorParameters<typeof OpenBrainClient>[1]["transport"];
  spool?: MemorySpoolLike;
}

/** Dispatch one runtime tool call to its named direct-client method. */
export async function invokeDirect(
  client: DirectClient,
  tool: ReplayableOperation | "agent_context_pack",
  args: Json,
): Promise<Json> {
  switch (tool) {
    case "session_start":
      return client.session_start(args);
    case "append_session_event":
      return client.append_session_event(args);
    case "lane_upsert":
      return client.lane_upsert(args);
    case "upsert_repo_fact":
      return client.upsert_repo_fact(args);
    case "log_thought":
      return client.log_thought(args);
    case "log_decision":
      return client.log_decision(args);
    case "session_wrap":
      return client.session_wrap(args);
    case "agent_context_pack":
      return client.agent_context_pack(args);
  }
}

/**
 * Run one call under a tightened client timeout, restoring the original.
 *
 * The client's own timeout is the ceiling: a per-call value only ever narrows
 * it, never widens it.
 */
export async function withCallTimeout<T>(
  client: DirectClient,
  timeout: number | undefined,
  call: () => Promise<T>,
): Promise<T> {
  const originalTimeout = client.timeout;
  if (timeout !== undefined) {
    client.timeout = Math.min(originalTimeout, timeout);
  }
  try {
    return await call();
  } finally {
    client.timeout = originalTimeout;
  }
}

/** Prove the server advertises the first-class runtime contract. */
export async function ensureDirectContract(
  client: DirectClient,
  timeout: number | undefined,
  validate: (manifest: Json) => { ok: boolean; reasons: readonly string[] },
): Promise<void> {
  await withCallTimeout(client, timeout, async () => {
    const manifest = await client.get_contract({});
    const validation = validate(manifest);
    if (!validation.ok) {
      throw new RuntimeCallError(
        "direct get_contract did not prove the first-class runtime contract: " +
          validation.reasons.join("; "),
      );
    }
  });
}

/** Caller-supplied shaping for one context-pack recall. */
export interface RecallOptions {
  maxTokens?: number;
  maxLatencyMs?: number;
  requestedSections?: readonly string[];
}

/**
 * Build the `agent_context_pack` arguments for one recall.
 *
 * Rejects an unknown section name here rather than sending it, so the caller
 * learns which of its names the server does not accept.
 */
export function contextPackRequest(
  scope: RuntimeScope,
  query: string,
  options: RecallOptions,
): Json {
  const args = scope.contextPackArguments(query);
  const budget = recallBudget(options);
  if (Object.keys(budget).length > 0) {
    args["budget"] = budget;
  }
  if (options.requestedSections !== undefined) {
    args["requested_sections"] = checkedSections(options.requestedSections);
  }
  return args;
}

/** Validate and collect the optional per-call shaping values. */
function recallBudget(options: RecallOptions): Json {
  const budget: Json = {};
  if (options.maxTokens !== undefined) {
    budget["max_tokens"] = boundedInt(options.maxTokens, "max_tokens", 100, 20_000);
  }
  if (options.maxLatencyMs !== undefined) {
    budget["max_latency_ms"] = boundedInt(
      options.maxLatencyMs,
      "max_latency_ms",
      1,
      10_000,
    );
  }
  return budget;
}

/** Accept only section names the server contract defines. */
function checkedSections(requested: readonly string[]): string[] {
  const sections = requested.map((section) =>
    requireText(section, "requested_sections"),
  );
  const unsupported = sections.filter((s) => !CONTEXT_PACK_SECTIONS.has(s)).sort();
  if (unsupported.length > 0) {
    throw new ValidationError(
      `requested_sections contains unsupported values: ${unsupported.join(", ")}`,
    );
  }
  return sections;
}

/**
 * Fold `receipt_refs` into `next_steps`, which is where the server reads them.
 *
 * `receipt_refs` is a caller-facing convenience and never a wire field, so it
 * is removed from the payload whether or not it held an array.
 */
export function mergeReceiptRefs(payload: Json): Json {
  const receiptRefs = payload["receipt_refs"];
  delete payload["receipt_refs"];
  if (!Array.isArray(receiptRefs)) {
    return payload;
  }
  const nextSteps = Array.isArray(payload["next_steps"])
    ? [...(payload["next_steps"] as string[])]
    : [];
  for (const ref of receiptRefs as string[]) {
    nextSteps.push(`Receipt ref: ${ref}`);
  }
  if (nextSteps.length > 20) {
    throw new ValidationError(
      "next_steps plus receipt_refs must contain at most 20 items",
    );
  }
  payload["next_steps"] = nextSteps;
  return payload;
}
