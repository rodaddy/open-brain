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
import { idempotencyKey, ValidationError } from "./policy.ts";
import { JsonlSpool } from "./spool.ts";
import {
  distilledContent,
  requireText,
  validateAdoptedLane,
  validateContextPackScope,
  validateStartedLane,
  wrapMetadata,
} from "./validation.ts";
import {
  DrainReport,
  EVENT_TYPES,
  PARKED_NAMESPACE_KEY,
  ReceiptStatus,
  RuntimeCallError,
  RuntimeReceipt,
  RuntimeScope,
  ScopeProofError,
  adoptedScopeFromResult,
  adoptedWrapFields,
  isLaneScopeRefusal,
  contextPackRequest,
  ensureDirectContract,
  invokeDirect,
  isRecord,
  mergeReceiptRefs,
  withCallTimeout,
  safeError,
  unsupportedEventType,
  validateConfig,
  verifyAppendResult,
  verifyWrapResult,
  type AdoptedLaneScope,
  type CallState,
  type DirectClient,
  type FirstClassMemoryRuntimeOptions,
  type MemorySpoolLike,
  type RecallOptions,
  type ReceiptStatusValue,
  type ReplayableOperation,
  type RuntimeConfig,
  type RuntimeOutput,
} from "./runtime-support.ts";

export * from "./runtime-support.ts";
export { UnavailableClient } from "./runtime-drain.ts";

import {
  UnavailableClient,
  drainSpool,
  failedWrite,
  spoolAfterFailedWrite,
  type SpoolContext,
} from "./runtime-drain.ts";

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
  // The stored scope of a lane this runtime adopted rather than claimed;
  // reset per write so no later operation inherits a stale adopted scope.
  private adoptedScope: AdoptedLaneScope | null = null;
  // True only while the claim-nothing session_start of an adopting write is
  // in flight, so its result validates on session_key plus namespace.
  private adoptingLane = false;
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
    const built = this.buildClient(scope, options);
    this.client = built.client;
    this.setupError = built.setupError;
    const spool = this.buildSpool(options);
    this.spool = spool;
    this.jsonlSpool = spool instanceof JsonlSpool ? spool : null;
  }

  /**
   * Resolve the direct client, keeping a construction failure as state.
   *
   * A failed construction yields a client that refuses every call rather than
   * throwing here, so the caller still gets a receipt instead of an exception
   * from the constructor.
   */
  private buildClient(
    scope: RuntimeScope,
    options: FirstClassMemoryRuntimeOptions,
  ): { client: DirectClient; setupError: unknown } {
    if (options.client !== undefined) {
      return { client: options.client, setupError: null };
    }
    try {
      const client = new OpenBrainClient(this.config.baseUrl, {
        token: this.config.token,
        namespace: this.config.namespace,
        agentId: scope.agent,
        role: this.config.role ?? undefined,
        timeout: this.config.timeout,
        transport: options.transport,
        allowInsecureHttp: this.config.allowInsecureHttp,
        delegateNamespace: false,
      });
      return { client: client as DirectClient, setupError: null };
    } catch (error) {
      return { client: new UnavailableClient() as DirectClient, setupError: error };
    }
  }

  /** Resolve the spool: an injected one, a configured path, or none. */
  private buildSpool(options: FirstClassMemoryRuntimeOptions): MemorySpoolLike | null {
    if (options.spool !== undefined) {
      return options.spool;
    }
    return this.config.spoolPath === null
      ? null
      : new JsonlSpool(this.config.spoolPath);
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
    options: RecallOptions = {},
  ): Promise<RuntimeOutput> {
    return this.serialized(() => this.recallContextLocked(query, options));
  }

  private async recallContextLocked(
    query: string,
    options: RecallOptions,
  ): Promise<RuntimeOutput> {
    this.resetState();
    try {
      const args = contextPackRequest(this.scope, query, options);
      const localTimeout =
        options.maxLatencyMs !== undefined ? options.maxLatencyMs / 1000 : undefined;
      const result = await this.directCall("agent_context_pack", args, localTimeout);
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
        throw new ValidationError(unsupportedEventType(safeEventType));
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
    let safeSummary: string;
    let metadata: Json;
    try {
      safeSummary = distilledContent(summary, "summary");
      metadata = wrapMetadata(
        options.keyDecisions ?? null,
        options.nextSteps ?? null,
        options.receiptRefs ?? null,
      );
    } catch (error) {
      return failedWrite(operation, error);
    }
    return this.serialized(() =>
      this.writeLocked(
        operation,
        "session_wrap",
        () => ({
          // Built after the lane is resolved so the scope written is the
          // adopted lane's, not the caller's (issue 736).
          payload: this.sessionWrapPayload(safeSummary, metadata),
          key: idempotencyKey(),
        }),
        { adoptLaneScope: true },
      ),
    );
  }

  private sessionWrapPayload(summary: string, metadata: Json): Json {
    const payload = mergeReceiptRefs({ summary, ...metadata });
    Object.assign(payload, this.adoptedWrapMetadata());
    payload["agent"] = this.adoptedWrapAgent();
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
    options: { adoptLaneScope?: boolean } = {},
  ): Promise<RuntimeOutput> {
    this.resetState();
    // Reset per write so no later operation inherits a stale adopted scope;
    // every adopting write re-derives it.
    this.adoptedScope = null;
    const adopt = options.adoptLaneScope ?? false;
    let built: { payload: Json; key: string } | null = null;
    if (!adopt) {
      try {
        built = build();
      } catch (error) {
        return failedWrite(operation, error);
      }
    }
    try {
      await this.ensureLane({ adoptLaneScope: adopt });
      // An adopting write builds AFTER the lane is resolved, so the payload
      // carries the scope adoption produced rather than the caller's own.
      built ??= build();
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
      // An adopting write can fail before its payload was built; spooling
      // still needs one, under the caller's own scope.
      let record: { payload: Json; key: string };
      try {
        record = built ?? build();
      } catch (buildError) {
        return failedWrite(operation, buildError);
      }
      return spoolAfterFailedWrite(
        this.spoolContext(),
        { operation, tool, built: record },
        error,
      );
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

  /**
   * Open or adopt a lane WITHOUT claiming any exact-scope coordinate. Sending
   * only `session_key` puts the server on its incomplete-exact-scope path,
   * where an existing lane is returned verbatim. `project` is still sent
   * because it is not an exact-scope coordinate.
   */
  private unscopedStartPayload(): Json {
    const payload: Json = { session_key: this.scope.session_key };
    if (this.config.project !== null) {
      payload["project"] = this.config.project;
    }
    return payload;
  }

  private async ensureLane(
    options: { adoptLaneScope?: boolean } = {},
  ): Promise<Json | null> {
    const adopt = options.adoptLaneScope ?? false;
    if (this.conversationKey !== null) {
      if (adopt && this.adoptedScope === null) {
        // The lane was opened earlier in this process and this wrap never saw
        // its session_start result. Its stored scope is unknown, so fall back
        // to the scope this runtime opened it with rather than sending nulls
        // at a lane that has real coordinates.
        this.adoptedScope = {
          agent: this.scope.agent,
          platform: this.scope.platform,
          server_id: this.scope.server_id,
          channel_id: this.scope.channel_id,
          thread_id: this.scope.thread_id,
        };
      }
      return null;
    }
    if (adopt) {
      // CLAIM FIRST, adopt only on the specific scope refusal, so the ordinary
      // path stays one call with the same arguments and adoption costs nothing
      // until it is actually needed.
      try {
        const claimed = await this.directCall("session_start", this.startPayload());
        this.conversationKey = this.scope.session_key;
        return claimed;
      } catch (error) {
        if (!isLaneScopeRefusal(error)) {
          throw error;
        }
      }
      // The lane exists and already holds a coordinate this session does not
      // own. Re-issue claiming NOTHING but the session_key, which puts the
      // server on its incomplete-exact-scope branch and returns the existing
      // lane verbatim, then write under the scope that comes back.
      this.adoptingLane = true;
      let result: Json;
      try {
        result = await this.directCall("session_start", this.unscopedStartPayload());
      } finally {
        this.adoptingLane = false;
      }
      this.adoptedScope = adoptedScopeFromResult(result);
      this.conversationKey = this.scope.session_key;
      return result;
    }
    const result = await this.directCall("session_start", this.startPayload());
    this.conversationKey = this.scope.session_key;
    return result;
  }

  /**
   * Return the scope a wrap or checkpoint write must carry: the adopted lane
   * scope when there is one, and the requester's own scope otherwise.
   */
  private adoptedWrapMetadata(): Json {
    if (this.adoptedScope !== null) {
      return adoptedWrapFields(this.adoptedScope);
    }
    return this.scope.wrapMetadata();
  }

  /**
   * Prove a `session_start` result against the binding that applies.
   *
   * A spooled replay is parked under its own exact scope and still proves it,
   * so that branch is checked first: a drain running inside an adopting wrap
   * must not borrow the weaker binding.
   */
  private validateStartResult(result: Json): void {
    if (this.replayScope !== null) {
      validateStartedLane(result, this.config.namespace, this.replayScope);
      return;
    }
    if (this.adoptingLane) {
      validateAdoptedLane(result, this.config.namespace, this.scope.session_key);
      return;
    }
    validateStartedLane(result, this.config.namespace, this.scope);
  }

  /** The agent a wrap or checkpoint write must carry. */
  private adoptedWrapAgent(): string {
    return this.adoptedScope?.agent ?? this.scope.agent;
  }

  /**
   * Replay pending durable records after direct connectivity recovers.
   * Returns a content-free DrainReport when a drain ran, or null when there
   * was nothing to drain or the drain machinery itself failed.
   */
  private async drainSpool(): Promise<DrainReport | null> {
    const drain = await drainSpool(this.spoolContext());
    if (drain !== null) {
      this.lastDrainReport = drain;
    }
    return drain;
  }

  /** The state the spool half of the runtime reads and writes. */
  private spoolContext(): SpoolContext {
    return {
      spool: this.spool,
      jsonlSpool: this.jsonlSpool,
      namespace: this.config.namespace,
      conversationKey: this.conversationKey,
      startPayload: () => this.startPayload(),
      parked: (payload) => this.parked(payload),
      receipt: (operation, status, durable, extra) =>
        this.receipt(operation, status as ReceiptStatusValue, durable, extra),
      setReplayScope: (scope) => {
        this.replayScope = scope;
      },
      directCall: (operation, payload) => this.directCall(operation, payload),
    };
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
    await ensureDirectContract(this.client, timeout, validateFirstClassContract);
    const result = await withCallTimeout(this.client, timeout, () =>
      invokeDirect(this.client, tool, args),
    );
    if (!isRecord(result)) {
      throw new RuntimeCallError(`direct ${tool} returned a non-object result`);
    }
    this.verifyResult(tool, result);
    if (this.state.path === null) {
      this.state.path = "direct";
    }
    return result;
  }

  /**
   * Prove the result did what it claims, and that its scope is ours.
   *
   * A scope mismatch is re-raised as `ScopeProofError` so a caller can tell it
   * apart from an argument the client itself rejected.
   */
  private verifyResult(
    tool: ReplayableOperation | "agent_context_pack",
    result: Json,
  ): void {
    if (tool === "append_session_event") {
      verifyAppendResult(result);
    } else if (tool === "session_wrap") {
      verifyWrapResult(result);
    }
    try {
      if (tool === "session_start") {
        this.validateStartResult(result);
      } else if (tool === "agent_context_pack") {
        validateContextPackScope(result, this.config.namespace, this.scope);
      }
    } catch (error) {
      if (error instanceof ValidationError) {
        throw new ScopeProofError(error.message);
      }
      throw error;
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
