import {
  exportDisclosureBundle,
  type DisclosureBundle,
  type DisclosureBundleInput,
} from "./disclosure-bundle.ts";

export type JsonObject = Record<string, unknown>;

export type MemoryEventType =
  | "fact"
  | "decision"
  | "blocker"
  | "action"
  | "artifact"
  | "receipt"
  | "question"
  | "correction"
  | "handoff";

export type MemoryImportance = "hot" | "warm" | "cold";

export interface OpenBrainToolTransport {
  callTool(name: string, args: JsonObject): Promise<unknown> | unknown;
}

export interface AgentMemoryOptions {
  agent: string;
  project?: string;
  source?: string;
  defaultLimit?: number;
}

export interface StartOptions {
  sessionKey: string;
  topic?: string;
  channelId?: string;
  threadId?: string;
  metadata?: JsonObject;
}

export interface RefreshLaneOptions {
  currentContextMd?: string;
  status?: "active" | "wrapped" | "archived";
  topic?: string;
  channelId?: string;
  threadId?: string;
  metadata?: JsonObject;
}

export interface RecallOptions {
  query: string;
  limit?: number;
  includeSession?: boolean;
  includeAnswer?: boolean;
  searchMode?: "hybrid" | "vector" | "keyword";
  tier?: MemoryImportance;
}

export interface AppendEventOptions {
  content: string;
  eventType?: MemoryEventType;
  source?: string;
  artifactPath?: string;
  importance?: MemoryImportance;
  metadata?: JsonObject;
}

export interface CompactOptions {
  summary: string;
  keyDecisions?: string[];
  nextSteps?: string[];
  receiptRefs?: string[];
}

export interface WrapOptions extends CompactOptions {}

export interface ReceiptValidation {
  kind: string;
  status: string;
  command?: string;
  summary?: string;
}

export interface ReceiptOptions {
  action: string;
  sources: JsonObject[];
  outputs: JsonObject[];
  validations: ReceiptValidation[];
  timestamp?: string;
  residualRisk?: string;
  metadata?: JsonObject;
}

export type RepoFactType =
  | "api_contract"
  | "dependency"
  | "gotcha"
  | "migration"
  | "ownership"
  | "source_pointer"
  | "validation"
  | "workflow";

export interface ListRepoFactsOptions {
  namespace?: string;
  repo?: string;
  collection?: string;
  path?: string;
  factType?: RepoFactType;
  subject?: string;
  limit?: number;
  offset?: number;
}

export interface UpsertRepoFactOptions {
  namespace?: string;
  metadata: JsonObject;
  validation: JsonObject;
}

const EVENT_TYPES = new Set<MemoryEventType>([
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

const IMPORTANCE_LEVELS = new Set<MemoryImportance>(["hot", "warm", "cold"]);
const SEARCH_MODES = new Set(["hybrid", "vector", "keyword"]);
const PROTECTED_KEYS = new Set([
  "agent",
  "authorization",
  "content",
  "event_type",
  "namespace",
  "project",
  "role",
  "session_key",
  "source",
  "token",
  "x-namespace",
  "x_namespace",
]);
const NESTED_AUTHORITY_KEYS = new Set([
  "authorization",
  "headers",
  "namespace",
  "role",
  "token",
  "x-namespace",
]);
const LANE_STATUSES = new Set(["active", "wrapped", "archived"]);
const REPO_FACT_TYPES = new Set<RepoFactType>([
  "api_contract",
  "dependency",
  "gotcha",
  "migration",
  "ownership",
  "source_pointer",
  "validation",
  "workflow",
]);
const MAX_METADATA_KEYS = 50;
const MAX_METADATA_KEY_LENGTH = 100;
const MAX_METADATA_JSON_BYTES = 100000;
const MAX_METADATA_DEPTH = 16;

export class AgentMemory {
  readonly transport: OpenBrainToolTransport;
  readonly agent: string;
  readonly project?: string;
  readonly source: string;
  readonly defaultLimit: number;
  sessionKey?: string;

  constructor(transport: OpenBrainToolTransport, options: AgentMemoryOptions) {
    if (!options.agent) throw new Error("AgentMemory requires agent");
    this.transport = transport;
    this.agent = options.agent;
    this.project = options.project;
    this.source = options.source ?? options.agent;
    this.defaultLimit = boundedInt(options.defaultLimit ?? 8, "defaultLimit", 1, 50);
  }

  async start(options: StartOptions): Promise<unknown> {
    const metadata = safeMetadata(options.metadata ?? {});
    const payload: JsonObject = {
      session_key: requiredString(options.sessionKey, "sessionKey"),
      agent: this.agent,
    };
    setOptional(payload, "project", this.project);
    setOptional(payload, "source", this.source);
    setOptional(payload, "topic", options.topic);
    setOptional(payload, "channel_id", options.channelId);
    setOptional(payload, "thread_id", options.threadId);
    if (Object.keys(metadata).length > 0) payload.metadata = metadata;

    const result = await this.transport.callTool("session_start", payload);
    this.sessionKey = options.sessionKey;
    return result;
  }

  async refreshLane(options: RefreshLaneOptions): Promise<unknown> {
    this.requireSession("refreshLane");
    const metadata = safeMetadata(options.metadata ?? {});
    const payload: JsonObject = {
      session_key: this.sessionKey,
      agent: this.agent,
      source: this.source,
    };
    setOptional(payload, "project", this.project);
    setOptional(payload, "topic", options.topic);
    setOptional(payload, "channel_id", options.channelId);
    setOptional(payload, "thread_id", options.threadId);
    setOptional(payload, "current_context_md", options.currentContextMd);
    if (options.status !== undefined) {
      payload.status = enumValue(options.status, "status", LANE_STATUSES);
    }
    if (Object.keys(metadata).length > 0) payload.metadata = metadata;
    return this.transport.callTool("lane_upsert", payload);
  }

  async recall(options: RecallOptions): Promise<{
    session?: unknown;
    search: unknown;
    answer?: unknown;
  }> {
    const query = requiredString(options.query, "query");
    const limit = boundedInt(options.limit ?? this.defaultLimit, "limit", 1, 50);
    const searchPayload: JsonObject = { query, limit };
    if (options.searchMode !== undefined) {
      searchPayload.search_mode = enumValue(options.searchMode, "searchMode", SEARCH_MODES);
    }
    if (options.tier !== undefined) {
      searchPayload.tier = enumValue(options.tier, "tier", IMPORTANCE_LEVELS);
    }

    const session =
      options.includeSession !== false && this.sessionKey
        ? await this.transport.callTool("session_context", {
            session_key: this.sessionKey,
            include_events: true,
            event_limit: limit,
          })
        : undefined;
    const search = await this.transport.callTool("search_all", searchPayload);
    const answer =
      options.includeAnswer === true
        ? await this.transport.callTool("brain_answer", { query, limit })
        : undefined;
    return { session, search, answer };
  }

  async appendEvent(options: AppendEventOptions): Promise<unknown> {
    this.requireSession("appendEvent");
    const eventType = options.eventType ?? "fact";
    const metadata = safeMetadata(options.metadata ?? {});
    const payload: JsonObject = {
      session_key: this.sessionKey,
      event_type: enumValue(eventType, "eventType", EVENT_TYPES),
      content: requiredString(options.content, "content"),
      source: options.source ?? this.source,
    };
    if (Object.keys(metadata).length > 0) payload.metadata = metadata;
    setOptional(payload, "artifact_path", options.artifactPath);
    if (options.importance !== undefined) {
      payload.importance = enumValue(options.importance, "importance", IMPORTANCE_LEVELS);
    }
    return this.transport.callTool("append_session_event", payload);
  }

  async compact(options: CompactOptions): Promise<unknown> {
    this.requireSession("compact");
    await this.transport.callTool("session_context", {
      session_key: this.sessionKey,
      include_events: true,
      event_limit: this.defaultLimit,
    });
    return this.wrap(options);
  }

  async wrap(options: WrapOptions): Promise<unknown> {
    this.requireSession("wrap");
    const payload: JsonObject = {
      session_key: this.sessionKey,
      summary: requiredString(options.summary, "summary"),
    };
    setOptional(payload, "project", this.project);
    if (options.keyDecisions !== undefined) {
      payload.key_decisions = stringList(options.keyDecisions, "keyDecisions");
    }
    if (options.nextSteps !== undefined) {
      payload.next_steps = stringList(options.nextSteps, "nextSteps");
    }
    if (options.receiptRefs !== undefined) {
      payload.metadata = { receipt_refs: stringList(options.receiptRefs, "receiptRefs") };
    }
    return this.transport.callTool("session_wrap", payload);
  }

  async recordReceipt(options: ReceiptOptions): Promise<unknown> {
    const metadata = safeMetadata(options.metadata ?? {});
    const receipt: JsonObject = {
      schema: "openbrain.receipt.v1",
      action: requiredString(options.action, "action"),
      agent: this.agent,
      session_key: this.sessionKey,
      timestamp: options.timestamp ?? new Date().toISOString(),
      sources: mappingList(options.sources, "sources"),
      outputs: mappingList(options.outputs, "outputs"),
      validations: validationList(options.validations),
    };
    setOptional(receipt, "project", this.project);
    setOptional(receipt, "residual_risk", options.residualRisk);
    return this.appendEvent({
      eventType: "receipt",
      content: `Receipt: ${options.action}`,
      source: this.source,
      metadata: {
        ...metadata,
        receipt,
      },
    });
  }

  async nominateShared(options: AppendEventOptions): Promise<unknown> {
    return this.appendEvent({
      ...options,
      metadata: {
        ...(options.metadata ?? {}),
        share_candidate: true,
      },
    });
  }

  exportDisclosureBundle(input: Omit<DisclosureBundleInput, "lane"> & {
    lane?: Partial<DisclosureBundleInput["lane"]>;
  }): DisclosureBundle {
    this.requireSession("exportDisclosureBundle");
    return exportDisclosureBundle({
      ...input,
      lane: {
        ...input.lane,
        sessionKey: this.sessionKey,
        agent: this.agent,
        project: this.project,
      },
    });
  }

  async listRepoFacts(options: ListRepoFactsOptions = {}): Promise<unknown> {
    const payload: JsonObject = {};
    setOptional(payload, "namespace", options.namespace);
    setOptional(payload, "repo", options.repo);
    setOptional(payload, "collection", options.collection);
    setOptional(payload, "path", options.path);
    setOptional(payload, "subject", options.subject);
    if (options.factType !== undefined) {
      payload.fact_type = enumValue(options.factType, "factType", REPO_FACT_TYPES);
    }
    if (options.limit !== undefined) {
      payload.limit = boundedInt(options.limit, "limit", 1, 250);
    }
    if (options.offset !== undefined) {
      payload.offset = boundedInt(options.offset, "offset", 0, Number.MAX_SAFE_INTEGER);
    }
    return this.transport.callTool("list_repo_facts", payload);
  }

  async upsertRepoFact(options: UpsertRepoFactOptions): Promise<unknown> {
    const payload: JsonObject = {
      metadata: safeMetadata(options.metadata),
      validation: safeMetadata(options.validation),
    };
    setOptional(payload, "namespace", options.namespace);
    return this.transport.callTool("upsert_repo_fact", payload);
  }

  private requireSession(method: string): asserts this is this & { sessionKey: string } {
    if (!this.sessionKey) throw new Error(`${method} requires start() first`);
  }
}

function setOptional(payload: JsonObject, key: string, value: string | undefined): void {
  if (value !== undefined) payload[key] = requiredString(value, key);
}

function requiredString(value: string | undefined, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value;
}

function boundedInt(
  value: number,
  name: string,
  min: number,
  max: number,
): number {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}`);
  }
  return value;
}

function enumValue<T extends string>(value: string, name: string, allowed: Set<T>): T {
  if (!allowed.has(value as T)) throw new Error(`Unsupported ${name}: ${value}`);
  return value as T;
}

function stringList(values: string[], name: string): string[] {
  if (!Array.isArray(values) || values.some((value) => typeof value !== "string")) {
    throw new Error(`${name} must be a string array`);
  }
  return values;
}

function mappingList(values: JsonObject[], name: string): JsonObject[] {
  if (!Array.isArray(values)) throw new Error(`${name} must be an object array`);
  return values.map((value, index) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`${name}[${index}] must be an object`);
    }
    rejectNestedAuthority(value, `${name}[${index}]`, 0);
    const jsonBytes = new TextEncoder().encode(JSON.stringify(value)).byteLength;
    if (jsonBytes > MAX_METADATA_JSON_BYTES) {
      throw new Error(`${name}[${index}] JSON exceeds ${MAX_METADATA_JSON_BYTES} bytes`);
    }
    return { ...(value as JsonObject) };
  });
}

function validationList(values: ReceiptValidation[]): JsonObject[] {
  const validations = mappingList(values as unknown as JsonObject[], "validations");
  validations.forEach((validation, index) => {
    requiredString(validation.kind as string | undefined, `validations[${index}].kind`);
    requiredString(validation.status as string | undefined, `validations[${index}].status`);
  });
  return validations;
}

function safeMetadata(value: JsonObject): JsonObject {
  rejectReservedMetadata(value);
  const keys = Object.keys(value);
  if (keys.length > MAX_METADATA_KEYS) {
    throw new Error(`metadata must have at most ${MAX_METADATA_KEYS} keys`);
  }
  const longKey = keys.find((key) => key.length > MAX_METADATA_KEY_LENGTH);
  if (longKey) {
    throw new Error(`metadata key exceeds ${MAX_METADATA_KEY_LENGTH} characters: ${longKey}`);
  }
  const jsonBytes = new TextEncoder().encode(JSON.stringify(value)).byteLength;
  if (jsonBytes > MAX_METADATA_JSON_BYTES) {
    throw new Error(`metadata JSON exceeds ${MAX_METADATA_JSON_BYTES} bytes`);
  }
  return { ...value };
}

function rejectReservedMetadata(value: JsonObject): void {
  const collisions = Object.keys(value).filter((key) => PROTECTED_KEYS.has(key));
  if (collisions.length > 0) {
    throw new Error(`metadata contains reserved keys: ${collisions.sort().join(", ")}`);
  }
  rejectNestedAuthority(value, "metadata", 0);
}

function rejectNestedAuthority(value: unknown, path: string, depth: number): void {
  if (depth > MAX_METADATA_DEPTH) {
    throw new Error(`${path} exceeds maximum nesting depth (${MAX_METADATA_DEPTH})`);
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => rejectNestedAuthority(item, `${path}[${index}]`, depth + 1));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value as JsonObject)) {
    if (NESTED_AUTHORITY_KEYS.has(authorityKey(key))) {
      throw new Error(`metadata contains reserved authority key at ${path}.${key}`);
    }
    rejectNestedAuthority(item, `${path}.${key}`, depth + 1);
  }
}

function authorityKey(key: string): string {
  return key.toLowerCase().replaceAll("_", "-");
}
