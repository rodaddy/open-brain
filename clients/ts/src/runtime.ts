/**
 * First-class local runtime facade for Open Brain memory lifecycle calls —
 * the TypeScript peer of
 * `python/openbrain-memory/src/openbrain_memory/runtime.py` (plus the private
 * `_runtime_router.py` / `_runtime_spool.py` behavior it owns).
 *
 * Runtime-specific difference: there is no mcp2cli subprocess fallback route
 * in the TS client. `fallback_attempted` is always `false` on receipts and
 * scope-proof mismatches fail open exactly like the Python client with
 * fallback disabled.
 */

import { validateFirstClassContract } from "./contract.ts";
import type { Json } from "./client.ts";
import { OpenBrainClient } from "./client.ts";
import { idempotencyKey, redactText, ValidationError } from "./policy.ts";
import {
  JsonlSpool,
  SpoolUnitRetained,
  errorClassName,
  type SpoolAppendRecord,
  type SpoolReplayReport,
  type SpoolRecord,
  type SpoolUnitOutcome,
} from "./spool.ts";
import {
  boundedInt,
  distilledContent,
  persistedText,
  requireText,
  validateContextPackScope,
  validateStartedLane,
  wrapMetadata,
  type RuntimeScopeCoordinates,
} from "./validation.ts";

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
const REPLAYABLE_SET: ReadonlySet<string> = new Set(
  REPLAYABLE_SPOOL_OPERATIONS,
);

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
export type ReceiptStatusValue =
  (typeof ReceiptStatus)[keyof typeof ReceiptStatus];

export const RUNTIME_RECEIPT_SCHEMA = "openbrain.runtime_receipt.v1";

/** Raised internally when no direct call succeeded. */
export class RuntimeCallError extends Error {}

/** Raised when a server response fails the exact-scope proof. */
export class ScopeProofError extends RuntimeCallError {}

export function safeText(value: string): string {
  return redactText(value).slice(0, MAX_ERROR_CHARS);
}

export function safeError(error: unknown): string {
  if (error instanceof Error) {
    return safeText(error.message || error.constructor.name);
  }
  return safeText(String(error));
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

/** Exact runtime identity used for context-pack recall and lane writes. */
export class RuntimeScope implements RuntimeScopeCoordinates {
  readonly agent: string;
  readonly platform: string;
  readonly server_id: string;
  readonly channel_id: string;
  readonly session_key: string;
  readonly thread_id: string | null;

  constructor(init: {
    agent: string;
    platform: string;
    serverId: string;
    channelId: string;
    sessionKey: string;
    threadId?: string | null;
  }) {
    this.agent = persistedText(init.agent, "agent");
    this.platform = persistedText(init.platform, "platform");
    this.server_id = persistedText(init.serverId, "server_id");
    this.channel_id = persistedText(init.channelId, "channel_id");
    this.session_key = persistedText(init.sessionKey, "session_key");
    this.thread_id =
      init.threadId === undefined || init.threadId === null
        ? null
        : persistedText(init.threadId, "thread_id");
  }

  /** Return the server contract's exact-scope context-pack fields. */
  contextPackArguments(query: string): Json {
    const args: Json = {
      agent: this.agent,
      platform: this.platform,
      server_id: this.server_id,
      channel_id: this.channel_id,
      session_key: this.session_key,
      query: requireText(query, "query"),
    };
    if (this.thread_id !== null) {
      args["thread_id"] = this.thread_id;
    }
    return args;
  }

  /** Return scope-owned lane coordinates supported by `session_start`. */
  startMetadata(): Json {
    const metadata: Json = {
      platform: this.platform,
      server_id: this.server_id,
      channel_id: this.channel_id,
    };
    if (this.thread_id !== null) {
      metadata["thread_id"] = this.thread_id;
    }
    return metadata;
  }

  /** Return exact scope coordinates supported by `session_wrap`. */
  wrapMetadata(): Json {
    return this.startMetadata();
  }
}

/** Rebuild the exact scope a spooled session_start unit was parked under. */
function spooledStartScope(payload: Json): RuntimeScope {
  try {
    return new RuntimeScope({
      agent: payload["agent"] as string,
      platform: payload["platform"] as string,
      serverId: payload["server_id"] as string,
      channelId: payload["channel_id"] as string,
      sessionKey: payload["session_key"] as string,
      threadId: (payload["thread_id"] as string | undefined) ?? null,
    });
  } catch {
    throw new ValidationError(
      "spooled session_start record does not carry a complete exact scope",
    );
  }
}

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

function validateConfig(config: RuntimeConfig): Required<
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
  const timeout = config.timeout ?? 30.0;
  if (!(timeout > 0)) {
    throw new ValidationError("timeout must be > 0");
  }
  let hostname = "";
  let port = "";
  try {
    const parsed = new URL(baseUrl);
    hostname = parsed.hostname;
    port = parsed.port;
  } catch {
    // OpenBrainClient rejects unparseable base URLs later.
  }
  if (
    (hostname === "127.0.0.1" || hostname === "localhost") &&
    port === "8317"
  ) {
    throw new ValidationError("127.0.0.1:8317 is not an Open Brain endpoint");
  }
  return {
    baseUrl,
    token,
    namespace,
    project:
      config.project === undefined || config.project === null
        ? null
        : persistedText(config.project, "project"),
    role:
      config.role === undefined || config.role === null
        ? null
        : requireText(config.role, "role"),
    allowInsecureHttp: config.allowInsecureHttp ?? false,
    timeout,
    spoolPath: config.spoolPath ?? null,
  };
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

interface CallState {
  path: "direct" | null;
  directAttempted: boolean;
  fallbackAttempted: boolean;
}

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyText(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function verifyAppendResult(result: Json): void {
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

function verifyWrapResult(result: Json): void {
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

/** Primary local memory path for thin runtime adapters. */
export class FirstClassMemoryRuntime {
  readonly config: ReturnType<typeof validateConfig>;
  readonly scope: RuntimeScope;
  /** Content-free report from the most recent automatic drain, if any. */
  lastDrainReport: DrainReport | null = null;

  private readonly client: DirectClient;
  private readonly ownsClient: boolean;
  private readonly setupError: unknown;
  private readonly spool: MemorySpoolLike | null;
  private readonly jsonlSpool: JsonlSpool | null;
  private state: CallState = {
    path: null,
    directAttempted: false,
    fallbackAttempted: false,
  };
  private conversationKey: string | null = null;
  // Set only while draining a spooled unit parked under another scope;
  // session_start replay results validate against this instead of `scope`.
  private replayScope: RuntimeScope | null = null;
  // Serialize public operations so a drain never interleaves with a write.
  private operationChain: Promise<unknown> = Promise.resolve();

  constructor(
    config: RuntimeConfig,
    scope: RuntimeScope,
    options: FirstClassMemoryRuntimeOptions = {},
  ) {
    this.config = validateConfig(config);
    this.scope = scope;
    this.ownsClient = options.client === undefined;
    let client = options.client ?? null;
    let setupError: unknown = null;
    if (client === null) {
      try {
        client = new OpenBrainClient(this.config.baseUrl, {
          token: this.config.token,
          namespace: this.config.namespace,
          agentId: scope.agent,
          role: this.config.role ?? undefined,
          timeout: this.config.timeout,
          transport: options.transport,
          allowInsecureHttp: this.config.allowInsecureHttp,
          delegateNamespace: false,
        });
      } catch (error) {
        setupError = error;
      }
    }
    this.client = client ?? (new UnavailableClient() as DirectClient);
    this.setupError = setupError;
    let spool: MemorySpoolLike | null = options.spool ?? null;
    if (spool === null && this.config.spoolPath !== null) {
      spool = new JsonlSpool(this.config.spoolPath);
    }
    this.spool = spool;
    this.jsonlSpool = spool instanceof JsonlSpool ? spool : null;
  }

  /** Close only a direct MCP client constructed by this runtime. */
  async close(): Promise<void> {
    if (!this.ownsClient) {
      return;
    }
    await this.client.close();
  }

  /** Fail open while recalling the exact-scope server context pack. */
  async recallContext(
    query: string,
    options: {
      maxTokens?: number;
      maxLatencyMs?: number;
      requestedSections?: readonly string[];
    } = {},
  ): Promise<RuntimeOutput> {
    return this.serialized(() => this.recallContextLocked(query, options));
  }

  private async recallContextLocked(
    query: string,
    options: {
      maxTokens?: number;
      maxLatencyMs?: number;
      requestedSections?: readonly string[];
    },
  ): Promise<RuntimeOutput> {
    this.resetState();
    try {
      const args = this.scope.contextPackArguments(query);
      const budget: Json = {};
      if (options.maxTokens !== undefined) {
        budget["max_tokens"] = boundedInt(
          options.maxTokens,
          "max_tokens",
          100,
          20_000,
        );
      }
      if (options.maxLatencyMs !== undefined) {
        budget["max_latency_ms"] = boundedInt(
          options.maxLatencyMs,
          "max_latency_ms",
          1,
          10_000,
        );
      }
      if (Object.keys(budget).length > 0) {
        args["budget"] = budget;
      }
      if (options.requestedSections !== undefined) {
        const sections = options.requestedSections.map((section) =>
          requireText(section, "requested_sections"),
        );
        const unsupported = sections
          .filter((section) => !CONTEXT_PACK_SECTIONS.has(section))
          .sort();
        if (unsupported.length > 0) {
          throw new ValidationError(
            `requested_sections contains unsupported values: ${unsupported.join(", ")}`,
          );
        }
        args["requested_sections"] = sections;
      }
      const localTimeout =
        options.maxLatencyMs !== undefined
          ? options.maxLatencyMs / 1000
          : undefined;
      const result = await this.directCall(
        "agent_context_pack",
        args,
        localTimeout,
      );
      const receipt = this.receipt("recall", ReceiptStatus.DIRECT, false);
      const drain = await this.drainSpool();
      return { receipt, context: result, drain };
    } catch (error) {
      return {
        receipt: this.receipt("recall", ReceiptStatus.FAILED, false, {
          error: safeError(error),
        }),
        context: {},
      };
    }
  }

  /** Explicitly start (or lazily re-prove) the exact durable lane. */
  async sessionStart(): Promise<RuntimeOutput> {
    return this.serialized(async () => {
      this.resetState();
      try {
        const result = await this.ensureLane();
        return {
          receipt: this.receipt("session_start", ReceiptStatus.DIRECT, false),
          result: result ?? {},
        };
      } catch (error) {
        return {
          receipt: this.receipt("session_start", ReceiptStatus.FAILED, false, {
            error: safeError(error),
          }),
        };
      }
    });
  }

  /** Capture one already-distilled event; raw transcript APIs are absent. */
  async captureDistilled(
    content: string,
    options: { eventType?: string } = {},
  ): Promise<RuntimeOutput> {
    let safeContent: string;
    let safeEventType: string;
    try {
      safeContent = distilledContent(content, "content");
      safeEventType = requireText(options.eventType ?? "fact", "event_type");
      if (!EVENT_TYPES.has(safeEventType)) {
        throw new ValidationError(`Unsupported event_type: ${safeEventType}`);
      }
    } catch (error) {
      return failedWrite("capture", error);
    }
    return this.serialized(() =>
      this.writeLocked("capture", "append_session_event", () => {
        const key = idempotencyKey();
        const payload: Json = {
          session_key: this.scope.session_key,
          agent: this.scope.agent,
          platform: this.scope.platform,
          server_id: this.scope.server_id,
          channel_id: this.scope.channel_id,
          event_type: safeEventType,
          content: safeContent,
          source: this.scope.agent,
          metadata: { idempotency_key: key },
        };
        if (this.scope.thread_id !== null) {
          payload["thread_id"] = this.scope.thread_id;
        }
        if (this.config.project !== null) {
          payload["project"] = this.config.project;
        }
        return { payload, key };
      }),
    );
  }

  /** Persist a distilled checkpoint through `session_wrap`. */
  async checkpoint(
    summary: string,
    options: {
      keyDecisions?: readonly string[];
      nextSteps?: readonly string[];
      receiptRefs?: readonly string[];
    } = {},
  ): Promise<RuntimeOutput> {
    return this.wrapLike("checkpoint", summary, options);
  }

  /** Persist a distilled session wrap through `session_wrap`. */
  async wrap(
    summary: string,
    options: {
      keyDecisions?: readonly string[];
      nextSteps?: readonly string[];
      receiptRefs?: readonly string[];
    } = {},
  ): Promise<RuntimeOutput> {
    return this.wrapLike("wrap", summary, options);
  }

  private async wrapLike(
    operation: "checkpoint" | "wrap",
    summary: string,
    options: {
      keyDecisions?: readonly string[];
      nextSteps?: readonly string[];
      receiptRefs?: readonly string[];
    },
  ): Promise<RuntimeOutput> {
    let payloadBase: Json;
    try {
      const safeSummary = distilledContent(summary, "summary");
      const metadata = wrapMetadata(
        options.keyDecisions ?? null,
        options.nextSteps ?? null,
        options.receiptRefs ?? null,
      );
      payloadBase = this.sessionWrapPayload(safeSummary, metadata);
    } catch (error) {
      return failedWrite(operation, error);
    }
    return this.serialized(() =>
      this.writeLocked(operation, "session_wrap", () => ({
        payload: payloadBase,
        key: idempotencyKey(),
      })),
    );
  }

  private sessionWrapPayload(summary: string, metadata: Json): Json {
    const payload: Json = { summary, ...metadata };
    // receipt_refs merge into next_steps (never a separate wire field).
    const receiptRefs = payload["receipt_refs"];
    delete payload["receipt_refs"];
    if (Array.isArray(receiptRefs)) {
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
    }
    Object.assign(payload, this.scope.wrapMetadata());
    payload["agent"] = this.scope.agent;
    payload["session_key"] = this.scope.session_key;
    if (this.config.project !== null) {
      payload["project"] = this.config.project;
    }
    return payload;
  }

  private async writeLocked(
    operation: string,
    tool: ReplayableOperation,
    build: () => { payload: Json; key: string },
  ): Promise<RuntimeOutput> {
    this.resetState();
    let built: { payload: Json; key: string };
    try {
      built = build();
    } catch (error) {
      return failedWrite(operation, error);
    }
    try {
      await this.ensureLane();
      const result = await this.directCall(tool, built.payload);
      const receipt = this.receipt(operation, ReceiptStatus.SAVED, true);
      const drain = await this.drainSpool();
      return { receipt, result, drain };
    } catch (error) {
      if (error instanceof ValidationError) {
        return {
          receipt: this.receipt(operation, ReceiptStatus.FAILED, false, {
            error: safeError(error),
          }),
        };
      }
      return this.spoolAfterFailedWrite(operation, tool, built, error);
    }
  }

  private spoolAfterFailedWrite(
    operation: string,
    tool: ReplayableOperation,
    built: { payload: Json; key: string },
    error: unknown,
  ): RuntimeOutput {
    if (this.spool === null) {
      return {
        receipt: this.receipt(operation, ReceiptStatus.LOST, false, {
          error: safeError(error),
        }),
      };
    }
    try {
      let spoolKey: string;
      if (this.conversationKey === null) {
        // Lane setup failed: atomically pair the exact-scope prerequisite
        // with the requested write so replay order is preserved.
        const appendBatch = this.spool.appendBatch?.bind(this.spool);
        if (appendBatch === undefined) {
          throw new Error(
            "configured spool cannot atomically queue lane prerequisite",
          );
        }
        const keys = appendBatch([
          {
            operation: "session_start",
            payload: this.parked(this.startPayload()),
            key: null,
          },
          {
            operation: tool,
            payload: this.parked(built.payload),
            key: built.key,
          },
        ]);
        spoolKey = keys.at(-1) as string;
      } else {
        spoolKey = this.spool.append(
          tool,
          this.parked(built.payload),
          built.key,
        );
      }
      return {
        receipt: this.receipt(operation, ReceiptStatus.SPOOLED, true, {
          spoolKey,
          error: safeError(error),
        }),
      };
    } catch (spoolError) {
      return {
        receipt: this.receipt(operation, ReceiptStatus.LOST, false, {
          error: safeText(
            `${safeError(error)}; spool failed: ${safeError(spoolError)}`,
          ),
        }),
      };
    }
  }

  /**
   * Stamp namespace provenance on every spooled record payload (#314,
   * PR #317). The marker is client-internal and stripped before dispatch.
   */
  private parked(payload: Json): Json {
    return { ...payload, [PARKED_NAMESPACE_KEY]: this.config.namespace };
  }

  private startPayload(): Json {
    const payload: Json = {
      ...this.scope.startMetadata(),
      session_key: this.scope.session_key,
      agent: this.scope.agent,
    };
    if (this.config.project !== null) {
      payload["project"] = this.config.project;
    }
    return payload;
  }

  private async ensureLane(): Promise<Json | null> {
    if (this.conversationKey !== null) {
      return null;
    }
    const result = await this.directCall("session_start", this.startPayload());
    this.conversationKey = this.scope.session_key;
    return result;
  }

  /**
   * Replay pending durable records after direct connectivity recovers.
   * Returns a content-free DrainReport when a drain ran, or null when there
   * was nothing to drain or the drain machinery itself failed.
   */
  private async drainSpool(): Promise<DrainReport | null> {
    try {
      const spool = this.jsonlSpool;
      if (spool === null) {
        return null;
      }
      if (spool.status().pending_count <= 0) {
        return null;
      }
      const dispatch = async (record: SpoolRecord): Promise<Json> => {
        // Reset per record so no later record or unit can inherit a stale
        // scope.
        this.replayScope = null;
        if (!REPLAYABLE_SET.has(record.operation)) {
          throw new ValidationError(
            `Unsupported spooled operation: ${record.operation}`,
          );
        }
        const payload = { ...record.payload };
        // A record parked by a runtime configured for another namespace must
        // stay parked: draining it here would silently transplant content
        // into this runtime's namespace (#314). Records without the marker
        // (legacy carve-out) drain under the replaying runtime's namespace.
        const parkedNamespace = payload[PARKED_NAMESPACE_KEY];
        delete payload[PARKED_NAMESPACE_KEY];
        if (
          parkedNamespace !== undefined &&
          parkedNamespace !== null &&
          parkedNamespace !== this.config.namespace
        ) {
          throw new SpoolUnitRetained(
            "spooled unit parked under a different namespace",
          );
        }
        if (record.operation === "session_start") {
          // Validate the replayed lane against the scope the unit was parked
          // under, not the runtime's current scope (#310). The namespace
          // stays bound to this runtime's auth config.
          try {
            this.replayScope = spooledStartScope(payload);
          } catch (error) {
            throw new SpoolUnitRetained(safeError(error));
          }
        }
        return this.directCall(
          record.operation as ReplayableOperation,
          payload,
        );
      };
      let report: SpoolReplayReport;
      try {
        report = await spool.replayWithReport(dispatch);
      } finally {
        this.replayScope = null;
      }
      const drain = buildDrainReport(report);
      this.lastDrainReport = drain;
      return drain;
    } catch {
      // Auto-drain is best-effort; failures never break the triggering call.
      return null;
    }
  }

  private async directCall(
    tool: ReplayableOperation | "agent_context_pack",
    args: Json,
    timeout?: number,
  ): Promise<Json> {
    this.state.directAttempted = true;
    if (this.setupError !== null) {
      throw new RuntimeCallError(safeError(this.setupError));
    }
    await this.ensureDirectContract(timeout);
    const originalTimeout = this.client.timeout;
    if (timeout !== undefined) {
      this.client.timeout = Math.min(originalTimeout, timeout);
    }
    let result: Json;
    try {
      result = await this.invoke(tool, args);
    } finally {
      this.client.timeout = originalTimeout;
    }
    if (!isRecord(result)) {
      throw new RuntimeCallError(`direct ${tool} returned a non-object result`);
    }
    if (tool === "append_session_event") {
      verifyAppendResult(result);
    } else if (tool === "session_wrap") {
      verifyWrapResult(result);
    }
    try {
      if (tool === "session_start") {
        validateStartedLane(
          result,
          this.config.namespace,
          this.replayScope ?? this.scope,
        );
      } else if (tool === "agent_context_pack") {
        validateContextPackScope(result, this.config.namespace, this.scope);
      }
    } catch (error) {
      if (error instanceof ValidationError) {
        throw new ScopeProofError(error.message);
      }
      throw error;
    }
    if (this.state.path === null) {
      this.state.path = "direct";
    }
    return result;
  }

  private async invoke(
    tool: ReplayableOperation | "agent_context_pack",
    args: Json,
  ): Promise<Json> {
    switch (tool) {
      case "session_start":
        return this.client.session_start(args);
      case "append_session_event":
        return this.client.append_session_event(args);
      case "lane_upsert":
        return this.client.lane_upsert(args);
      case "upsert_repo_fact":
        return this.client.upsert_repo_fact(args);
      case "log_thought":
        return this.client.log_thought(args);
      case "log_decision":
        return this.client.log_decision(args);
      case "session_wrap":
        return this.client.session_wrap(args);
      case "agent_context_pack":
        return this.client.agent_context_pack(args);
    }
  }

  private async ensureDirectContract(timeout?: number): Promise<void> {
    const originalTimeout = this.client.timeout;
    if (timeout !== undefined) {
      this.client.timeout = Math.min(originalTimeout, timeout);
    }
    try {
      const manifest = await this.client.get_contract({});
      const validation = validateFirstClassContract(manifest);
      if (!validation.ok) {
        throw new RuntimeCallError(
          "direct get_contract did not prove the first-class runtime contract: " +
            validation.reasons.join("; "),
        );
      }
    } finally {
      this.client.timeout = originalTimeout;
    }
  }

  private resetState(): void {
    this.state = {
      path: null,
      directAttempted: false,
      fallbackAttempted: false,
    };
  }

  private receipt(
    operation: string,
    status: ReceiptStatusValue,
    durable: boolean,
    extra: { spoolKey?: string | null; error?: string | null } = {},
  ): RuntimeReceipt {
    return new RuntimeReceipt({
      operation,
      status,
      durable,
      directAttempted: this.state.directAttempted,
      fallbackAttempted: this.state.fallbackAttempted,
      spoolKey: extra.spoolKey ?? null,
      error: extra.error ?? null,
    });
  }

  private async serialized<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.operationChain.then(operation, operation);
    this.operationChain = next.catch(() => undefined);
    return next;
  }
}

class UnavailableClient {
  timeout = 0;
  private fail(): never {
    throw new RuntimeCallError("direct client unavailable");
  }
  get_contract(): Json {
    this.fail();
  }
  session_start(): Json {
    this.fail();
  }
  append_session_event(): Json {
    this.fail();
  }
  lane_upsert(): Json {
    this.fail();
  }
  upsert_repo_fact(): Json {
    this.fail();
  }
  log_thought(): Json {
    this.fail();
  }
  log_decision(): Json {
    this.fail();
  }
  session_wrap(): Json {
    this.fail();
  }
  agent_context_pack(): Json {
    this.fail();
  }
  close(): void {}
}

function failedWrite(operation: string, error: unknown): RuntimeOutput {
  return {
    receipt: new RuntimeReceipt({
      operation,
      status: ReceiptStatus.FAILED,
      durable: false,
      directAttempted: false,
      fallbackAttempted: false,
      error: safeError(error),
    }),
  };
}

function buildDrainReport(report: SpoolReplayReport): DrainReport {
  const counts: Record<string, number> = {
    replayed: 0,
    failed: 0,
    quarantined: 0,
    retained: 0,
  };
  let replayedRecords = 0;
  const receipts: RuntimeReceipt[] = [];
  for (const outcome of report.outcomes) {
    counts[outcome.status] = (counts[outcome.status] ?? 0) + 1;
    if (outcome.status === "replayed") {
      replayedRecords += outcome.record_keys.length;
      receipts.push(...replayedReceipts(outcome));
    } else if (outcome.status === "quarantined") {
      receipts.push(quarantinedReceipt(outcome));
    }
  }
  return new DrainReport({
    attemptedUnits: report.outcomes.length,
    replayedUnits: counts["replayed"] ?? 0,
    replayedRecords,
    failedUnits: counts["failed"] ?? 0,
    quarantinedUnits: counts["quarantined"] ?? 0,
    retainedUnits: counts["retained"] ?? 0,
    receipts,
  });
}

function replayedReceipts(outcome: SpoolUnitOutcome): RuntimeReceipt[] {
  return outcome.operations.map(
    (operation, index) =>
      new RuntimeReceipt({
        operation,
        status: ReceiptStatus.REPLAYED,
        durable: true,
        directAttempted: true,
        fallbackAttempted: false,
        spoolKey: outcome.record_keys[index] as string,
      }),
  );
}

function quarantinedReceipt(outcome: SpoolUnitOutcome): RuntimeReceipt {
  return new RuntimeReceipt({
    operation: outcome.operations[0] as string,
    status: ReceiptStatus.QUARANTINED,
    durable: true,
    directAttempted: true,
    fallbackAttempted: false,
    spoolKey: outcome.record_keys[0] as string,
    // Error CLASS/category only, never message bodies.
    error: outcome.error_category ?? errorClassName(null),
  });
}
