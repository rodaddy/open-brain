import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { LiveMemoryTable } from "./types.ts";

// Live transport for the recall gate.
//
// This talks to the real Open Brain server over its MCP streamable-HTTP
// endpoint (`POST /mcp`) using the official MCP client. Every gate operation --
// seeding a memory, running a recall search, and archiving a record -- is a
// standard `tools/call`, so the gate exercises the exact contract, auth, and
// namespace boundary that live agents hit. The MCP endpoint is used (not the
// REST surface) because it uniformly exposes archive_entry, which the REST API
// does not, and archive_entry is namespace-scoped -- the property that makes
// teardown mutation-safe.

/** Minimal tool interface so the gate can run against a fake in tests. */
export interface OpenBrainToolCaller {
  callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<ToolCallResult>;
  close(): Promise<void>;
}

export interface ToolCallResult {
  /** True when the server reported the call as an error. */
  isError: boolean;
  /**
   * True when the server denied the call for permission/namespace reasons.
   * Modeled distinctly from a generic error so the gate can require an explicit
   * denial (isolation proof) without ever inspecting the raw error body.
   */
  denied: boolean;
  /**
   * On success: the raw response body text, from which the client parses only
   * structured fields (ids, namespace) -- it is never logged or embedded in a
   * receipt. Empty string on error, where the body is discarded at the
   * redaction boundary so no memory body or secret can escape.
   */
  data: string;
  /**
   * A redacted, content-free label for a failed call: tool name plus, when the
   * server surfaced them, an error class / status / reason keyword. NEVER the
   * raw response text -- that could carry a memory body or secret. Empty string
   * on success.
   */
  errorLabel: string;
}

export interface LogMemoryResult {
  id: string;
  /** The namespace the server reported the row was written to. */
  namespace: string;
  /**
   * The server's `merged` flag: false when this call CREATED a new row, true
   * when it upserted onto an existing row (ON CONFLICT). The seeder requires
   * `merged === false` so it can only ever count a fresh, this-run creation --
   * a merged upsert means the record predates this run (a stranded prior seed in
   * a reused namespace) and must never be treated as newly created and later
   * archived as though this run owned it.
   */
  merged: boolean;
}

export interface SearchHit {
  id: string;
  source_type: string;
  namespace?: string;
}

/**
 * The exact seven-coordinate active scope the complete-pack gate binds. The
 * namespace is the isolation predicate (the per-run throwaway namespace); the
 * remaining coordinates address the exact working-set / durable-lane scope. A
 * missing `thread_id` means the unthreaded lane, exactly as the pack tool treats
 * an omitted thread id.
 */
export interface ContextPackScope {
  namespace: string;
  agent: string;
  platform: string;
  server_id: string;
  channel_id: string;
  thread_id?: string | null;
  session_key: string;
}

/**
 * The structural fields the complete-pack gate reads out of the pack payload.
 * Deliberately narrow: only the shape needed to verify presence/emptiness,
 * citations, budget, and warnings. Section bodies are kept as opaque records so
 * the gate reads item counts / citation ids / empty markers WITHOUT the eval
 * code ever needing to log a memory body. The raw payload text is never carried.
 */
export interface ContextPackPayload {
  status: string;
  sections: Record<string, unknown>;
  citations: Array<Record<string, unknown>>;
  budget: Record<string, unknown>;
  warnings: {
    scope_denials: Array<Record<string, unknown>>;
    degraded_sources: Array<Record<string, unknown>>;
    truncation: Array<Record<string, unknown>>;
  };
}

/**
 * Result of an explicit isolation probe: an attempt by one caller to read a
 * namespace it must not be able to read. `denied` is the only signal the gate
 * trusts as proof of isolation; an empty-but-successful search is NOT denial.
 * `hitCount` is retained so a "denied but non-empty" contradiction can be
 * surfaced content-free. No hit ids or bodies are carried.
 */
export interface DenialProbeResult {
  denied: boolean;
  hitCount: number;
}

/**
 * The public error surface for a live transport failure. Callers may log or
 * embed `label` in a receipt; it is redacted to tool/class/status/reason
 * keywords only and never contains raw response text.
 */
export class LiveTransportError extends Error {
  readonly label: string;
  readonly denied: boolean;
  constructor(label: string, denied: boolean) {
    super(label);
    this.name = "LiveTransportError";
    this.label = label;
    this.denied = denied;
  }
}

/**
 * Semantic wrapper over an OpenBrainToolCaller. Keeps the gate orchestrator
 * free of tool-name/argument details and response parsing, and is the seam the
 * unit tests target with a fake caller.
 */
export class OpenBrainLiveClient {
  constructor(private readonly caller: OpenBrainToolCaller) {}

  /**
   * Seed one memory into a namespace, returning the server-assigned id.
   *
   * The seed is a CREATE: this run owns every record it later archives, so the
   * response must prove a fresh row was created under the exact namespace we
   * asked for. `log_thought`/`log_decision` return `{id, namespace, merged}`
   * (src/tools/log-thought.ts, log-decision.ts). We fail closed content-free on
   * any response that does not exactly match a create:
   *
   *  - missing/non-string `id` -> we never learned the server id, so teardown
   *    could not archive this row (`:missing-id`).
   *  - missing/non-boolean or `merged: true` -> the server upserted onto an
   *    EXISTING row (a stranded prior seed in a reused namespace), so this is
   *    not a this-run creation; archiving it later would tombstone a row this
   *    run did not create (`:merged-upsert` / `:missing-merged`).
   *  - a returned namespace that is not EXACTLY `opts.namespace` -> the row did
   *    not land where we bound our teardown/scoring, so we must not treat it as
   *    ours (`:namespace-mismatch`). We do NOT default a missing namespace to
   *    the requested one: that would mask a server that wrote elsewhere.
   */
  async logMemory(opts: {
    table: LiveMemoryTable;
    content: string;
    tags: string[];
    namespace: string;
  }): Promise<LogMemoryResult> {
    const tool = opts.table === "decisions" ? "log_decision" : "log_thought";
    const args: Record<string, unknown> =
      opts.table === "decisions"
        ? {
            title: opts.content,
            rationale: opts.content,
            tags: opts.tags,
            namespace: opts.namespace,
          }
        : {
            content: opts.content,
            tags: opts.tags,
            namespace: opts.namespace,
          };
    const result = await this.caller.callTool(tool, args);
    if (result.isError) {
      throw new LiveTransportError(result.errorLabel, result.denied);
    }
    const parsed = safeJson(result.data);
    const id = typeof parsed?.id === "string" ? parsed.id : undefined;
    if (!id) {
      // Content-free: name the tool, not the response body.
      throw new LiveTransportError(`${tool}:missing-id`, false);
    }
    // `merged` must be present and a boolean; a create is `merged === false`.
    if (typeof parsed?.merged !== "boolean") {
      throw new LiveTransportError(`${tool}:missing-merged`, false);
    }
    if (parsed.merged) {
      // The server upserted onto a pre-existing row -- not a this-run creation.
      throw new LiveTransportError(`${tool}:merged-upsert`, false);
    }
    // The returned namespace must EXACTLY equal the one we bound teardown/scoring
    // to; no defaulting a missing/other namespace to the requested one.
    if (parsed.namespace !== opts.namespace) {
      throw new LiveTransportError(`${tool}:namespace-mismatch`, false);
    }
    return { id, namespace: opts.namespace, merged: false };
  }

  /**
   * Run a recall search scoped to a namespace the caller is expected to be able
   * to read. Returns ranked hits (best first). A permission-denied response is
   * NOT swallowed here: this method is used for the primary recall scoring path,
   * where a denial means the gate is misconfigured (primary token cannot read
   * its own namespace) and must fail loudly, content-free. Use `attemptRead`
   * for the isolation probe, where denial is the desired outcome.
   */
  async search(opts: {
    query: string;
    namespace: string;
    limit: number;
    searchMode: "hybrid" | "vector" | "keyword";
  }): Promise<SearchHit[]> {
    const result = await this.caller.callTool("search_brain", {
      query: opts.query,
      namespace: opts.namespace,
      limit: opts.limit,
      search_mode: opts.searchMode,
    });
    if (result.isError) {
      throw new LiveTransportError(result.errorLabel, result.denied);
    }
    return parseHits(result.data);
  }

  /**
   * Explicit isolation probe: attempt to read `namespace` and report whether the
   * server denied the read. This is the ONLY method that treats a permission
   * denial as a success signal, and it does so distinctly -- an empty but
   * successful search is reported as `denied: false`, because "no results" is
   * not proof of denial (the namespace could simply be empty for this caller).
   *
   * Never surfaces hit ids or bodies; only the boolean denial and a count.
   */
  async attemptRead(opts: {
    query: string;
    namespace: string;
    limit: number;
    searchMode: "hybrid" | "vector" | "keyword";
  }): Promise<DenialProbeResult> {
    const result = await this.caller.callTool("search_brain", {
      query: opts.query,
      namespace: opts.namespace,
      limit: opts.limit,
      search_mode: opts.searchMode,
    });
    if (result.isError) {
      if (result.denied) {
        return { denied: true, hitCount: 0 };
      }
      // A non-denial error (timeout, malformed request) is a real failure and
      // must not be mistaken for isolation proof.
      throw new LiveTransportError(result.errorLabel, false);
    }
    // Successful read of a namespace the caller should not reach: NOT denial.
    return { denied: false, hitCount: parseHits(result.data).length };
  }

  /**
   * Build the complete agent context pack for the exact active scope, requesting
   * all of `requestedSections` under one whole-pack budget. Returns the parsed
   * structured payload object (sections/citations/budget/warnings) for the
   * complete-pack gate to verify functional outcomes against.
   *
   * The pack tool returns a JSON OBJECT (never an array). We fail closed
   * content-free on a body that is not a JSON object or that the server flagged
   * as an error: the pack payload can carry memory bodies inside its section
   * items, so the raw text is NEVER logged or surfaced -- only structural fields
   * the gate reads (ids, counts, citation ids, budget numbers). A permission
   * denial is thrown as a redacted LiveTransportError, exactly like `search`.
   */
  async contextPack(opts: {
    scope: ContextPackScope;
    query: string;
    requestedSections: readonly string[];
    budgetMaxTokens?: number;
    includeUnreviewedRecovery?: boolean;
  }): Promise<ContextPackPayload> {
    const args: Record<string, unknown> = {
      namespace: opts.scope.namespace,
      agent: opts.scope.agent,
      platform: opts.scope.platform,
      server_id: opts.scope.server_id,
      channel_id: opts.scope.channel_id,
      session_key: opts.scope.session_key,
      query: opts.query,
      requested_sections: [...opts.requestedSections],
    };
    if (opts.scope.thread_id !== undefined && opts.scope.thread_id !== null) {
      args.thread_id = opts.scope.thread_id;
    }
    if (opts.includeUnreviewedRecovery) {
      args.include_unreviewed_recovery = true;
    }
    if (opts.budgetMaxTokens !== undefined) {
      args.budget = { max_tokens: opts.budgetMaxTokens };
    }
    const result = await this.caller.callTool("agent_context_pack", args);
    if (result.isError) {
      throw new LiveTransportError(result.errorLabel, result.denied);
    }
    return parseContextPackPayload(result.data);
  }

  /**
   * Archive exactly one record by table + id. archive_entry is namespace-scoped
   * server-side (it appends the caller's write-namespace predicate), so a token
   * can only ever archive records it owns -- this is what makes per-record
   * teardown mutation-safe. Returns "archived", "already_absent", or throws a
   * redacted LiveTransportError.
   *
   * A destructive teardown operation MUST fail closed on an ambiguous success.
   * archive_entry has exactly two real successful response shapes on the server
   * (src/tools/archive-entry.ts): a JSON object `{id, table, archived: true}`
   * for a row it tombstoned, and the EXACT plain-text body
   * "Already archived or not found" for the zero-row no-op. We recognize only
   * those two -- `archived: true` WITH the returned `id`/`table` exactly equal
   * to the requested record, or that exact marker (trimmed, case-insensitive) --
   * and throw a content-free LiveTransportError for EVERY other success response.
   *
   * The id/table binding matters because `archived: true` alone does not say
   * WHICH row was tombstoned: an echo for a different id/table, or a response
   * missing them, would otherwise be credited as this record's cleanup while the
   * real record stays live. Binding returned identity closes that gap.
   *
   * We deliberately do NOT accept a structured `archived: false` (the server
   * never emits it), nor broad substrings like "not found" / "no rows", nor a
   * marker embedded in mixed text: any of those could false-pass on unrelated
   * output. Treating an unrecognized success as "already_absent" would let
   * teardown false-pass -- a shape drift, a differently-worded body, or a
   * success that did not actually tombstone the row would be silently counted
   * as clean cleanup, stranding a live record while the gate reports PASS.
   */
  async archive(opts: {
    table: LiveMemoryTable;
    id: string;
  }): Promise<"archived" | "already_absent"> {
    const result = await this.caller.callTool("archive_entry", {
      table: opts.table,
      id: opts.id,
    });
    if (result.isError) {
      throw new LiveTransportError(result.errorLabel, result.denied);
    }
    const parsed = safeJson(result.data);
    // Explicit archived success: the JSON object the server returns for a row it
    // tombstoned is `{id, table, archived: true}` (src/tools/archive-entry.ts).
    // A destructive success is only trustworthy when it is bound to the record
    // we asked to archive: `archived: true` alone is not enough -- the returned
    // `id` and `table` must EXACTLY match this request, or the server tombstoned
    // some other row (a shape drift, a mismatched echo, or a response for a
    // different record) and we must NOT count it as this record's cleanup.
    if (parsed?.archived === true) {
      if (parsed.id === opts.id && parsed.table === opts.table) {
        return "archived";
      }
      // archived:true but for a different id/table (or missing them) -> fail
      // closed content-free rather than credit this record as archived.
      throw new LiveTransportError("archive_entry:identity-mismatch", false);
    }
    // Exact already-absent no-op marker: the server returns the plain-text body
    // "Already archived or not found" (and nothing else) for the zero-row case.
    if (isAlreadyAbsentMarker(result.data)) return "already_absent";
    // Any other success shape -- a structured `archived: false`, a partial or
    // mixed-text marker, "no rows", or an unknown body -- is ambiguous for a
    // destructive operation: fail closed content-free rather than assume the
    // row is gone.
    throw new LiveTransportError("archive_entry:unrecognized-success", false);
  }

  close(): Promise<void> {
    return this.caller.close();
  }
}

/**
 * Parse ranked search hits from a JSON array body. Never logs the body.
 *
 * This is the transport boundary for every hit the gate scores or probes. It
 * FAILS CLOSED content-free rather than silently dropping any entry, because a
 * discarded raw result never reaches the gate-level validator (gate.ts
 * `toFixtureRetrieval`) and so could compress rankings or hide a foreign /
 * malformed result before PASS logic runs:
 *
 *  - a successful search body MUST be a JSON array. A non-array (object, scalar)
 *    or invalid JSON is a malformed result set (`search_brain:malformed-results`)
 *    -- NOT an empty result, which the old `return []` conflated with real
 *    "no hits" and let a malformed body pass as a clean empty read.
 *  - every array entry MUST be an object carrying a non-empty string `id`
 *    (`search_brain:malformed-hit`). A non-object row, a missing id, or an empty
 *    id is unaccountable at this boundary and must not be silently skipped.
 *
 * `namespace` stays OPTIONAL on purpose: a hit that is a valid object with a
 * string id but no namespace passes THIS boundary and reaches gate.ts, which
 * fails it specifically as `foreign-namespace`. Requiring namespace here would
 * mask that distinct (and security-relevant) gate-level classification.
 *
 * Content-free: labels name only the tool + failure class, never a raw body,
 * row, or id value.
 */
export function parseHits(text: string): SearchHit[] {
  const parsed = safeJsonArray(text);
  if (!parsed) {
    // Non-array success body or invalid JSON: a malformed result set, not empty.
    throw new LiveTransportError("search_brain:malformed-results", false);
  }
  const hits: SearchHit[] = [];
  for (const row of parsed) {
    if (!row || typeof row !== "object") {
      // A non-object array entry is unaccountable; never silently skip it.
      throw new LiveTransportError("search_brain:malformed-hit", false);
    }
    const id = (row as Record<string, unknown>).id;
    if (typeof id !== "string" || id.length === 0) {
      // Missing / non-string / empty id: cannot account for this hit.
      throw new LiveTransportError("search_brain:malformed-hit", false);
    }
    const sourceType = (row as Record<string, unknown>).source_type;
    const namespace = (row as Record<string, unknown>).namespace;
    hits.push({
      id,
      source_type: typeof sourceType === "string" ? sourceType : "",
      // Optional by design: a missing namespace reaches gate.ts, which fails it
      // as foreign-namespace. Do NOT reject it here.
      namespace: typeof namespace === "string" ? namespace : undefined,
    });
  }
  return hits;
}

/**
 * Parse the complete context-pack payload from a JSON object body. Never logs
 * the body, which can carry memory bodies inside its section items.
 *
 * Fails closed content-free rather than defaulting a malformed body to an empty
 * pack: a non-object body, or invalid JSON, is a malformed pack
 * (`agent_context_pack:malformed-payload`), NOT an empty pack -- conflating the
 * two would let a broken pack pass as a clean empty. `sections`, `citations`,
 * `budget`, and `warnings.*` are normalized to their expected container shapes
 * (object / array), defaulting a MISSING container to its empty form so the gate
 * can classify a genuinely-empty pack without inspecting any body. The section
 * bodies themselves stay opaque records; the gate reads only their structural
 * fields.
 */
export function parseContextPackPayload(text: string): ContextPackPayload {
  const parsed = safeJson(text);
  if (!parsed) {
    throw new LiveTransportError("agent_context_pack:malformed-payload", false);
  }
  const asRecordArray = (value: unknown): Array<Record<string, unknown>> => {
    if (!Array.isArray(value)) return [];
    return value.filter(
      (row): row is Record<string, unknown> =>
        !!row && typeof row === "object" && !Array.isArray(row),
    );
  };
  const asRecord = (value: unknown): Record<string, unknown> =>
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};

  const warnings = asRecord(parsed.warnings);
  return {
    status: typeof parsed.status === "string" ? parsed.status : "",
    sections: asRecord(parsed.sections),
    citations: asRecordArray(parsed.citations),
    budget: asRecord(parsed.budget),
    warnings: {
      scope_denials: asRecordArray(warnings.scope_denials),
      degraded_sources: asRecordArray(warnings.degraded_sources),
      truncation: asRecordArray(warnings.truncation),
    },
  };
}

/**
 * The exact plain-text no-op marker archive_entry returns for the zero-row case
 * (src/tools/archive-entry.ts): "Already archived or not found", and nothing
 * else. This is the ONLY non-structured success shape teardown treats as "the
 * row is gone".
 *
 * Matching is EXACT (trimmed, case-insensitive) -- not substring -- on purpose:
 * a destructive teardown must fail closed, so a partial phrase ("not found"),
 * "no rows", or the marker embedded in incidental/mixed text must NOT classify,
 * because any of those could false-pass on unrelated server output. Anything
 * that is not exactly this marker fails closed at the caller. The raw text is
 * never logged or returned -- only the boolean.
 */
const ARCHIVE_ABSENT_MARKER = "already archived or not found";

function isAlreadyAbsentMarker(text: string): boolean {
  return text.trim().toLowerCase() === ARCHIVE_ABSENT_MARKER;
}

function safeJson(text: string): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function safeJsonArray(text: string): unknown[] | undefined {
  try {
    const value = JSON.parse(text);
    return Array.isArray(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Denial keywords: a permission/namespace/auth refusal. These are the security-
 * relevant signals the isolation proof depends on, so they are classified FIRST,
 * ahead of any generic error keyword. A server body can legitimately mix a
 * denial phrase with a generic one (e.g. "invalid request: permission denied for
 * namespace"); if a generic keyword like "invalid" were matched first, a real
 * denial would be mislabeled as a non-denial error and the isolation proof (or a
 * teardown auth failure) would be silently misread. Denial precedence closes
 * that classification hole.
 */
const DENIAL_ERROR_KEYWORDS: readonly string[] = [
  "permission denied",
  "not authenticated",
  "unauthorized",
  "forbidden",
];

/**
 * Generic (non-denial) error bodies the gate is willing to name in a content-
 * free label. Matched only AFTER the denial keywords above, so a mixed body that
 * contains a denial phrase always classifies as a denial regardless of array
 * order.
 */
const GENERIC_ERROR_KEYWORDS: readonly string[] = [
  "invalid",
  "not found",
  "already archived",
  "rate limit",
  "timeout",
];

/**
 * The full allowlist of non-sensitive tokens the gate may copy out of a
 * response is exactly DENIAL_ERROR_KEYWORDS followed by GENERIC_ERROR_KEYWORDS.
 * Only these tokens are ever emitted; anything else collapses to a bare marker,
 * so a memory body or secret in the error text can never leak into a log or
 * receipt.
 *
 * Select the single keyword to name in a content-free label, prioritizing any
 * denial keyword over every generic one so a mixed body classifies as a denial.
 * Returns undefined when no known keyword is present.
 */
function matchRedactedKeyword(lower: string): string | undefined {
  return (
    DENIAL_ERROR_KEYWORDS.find((kw) => lower.includes(kw)) ??
    GENERIC_ERROR_KEYWORDS.find((kw) => lower.includes(kw))
  );
}

/** True when the redacted error signal indicates a permission/namespace denial. */
export function isDenialLabel(label: string): boolean {
  return (
    label.includes("permission-denied") ||
    label.includes("unauthorized") ||
    label.includes("forbidden") ||
    label.includes("not-authenticated")
  );
}

/**
 * Reduce a failed tool call to a content-free label. Emits the tool name plus
 * at most one matched known keyword (as a slug); the raw response text is never
 * included. Returns { errorLabel, denied }.
 */
export function redactToolFailure(
  toolName: string,
  rawText: string,
): { errorLabel: string; denied: boolean } {
  const lower = rawText.toLowerCase();
  const matched = matchRedactedKeyword(lower);
  const slug = matched ? matched.replace(/\s+/g, "-") : "error";
  const errorLabel = `${toolName}:${slug}`;
  return { errorLabel, denied: isDenialLabel(errorLabel) };
}

/**
 * Sanitize a THROWN transport-layer error (connect / callTool / close) into a
 * content-free LiveTransportError. The MCP SDK can throw errors whose `.message`
 * carries the raw remote HTTP body or response text -- which could include a
 * memory body or secret -- so we NEVER surface `error.message` verbatim. We copy
 * out only the operation name plus, if the message happens to contain one of the
 * known non-sensitive keywords, that single keyword as a slug. Anything else
 * collapses to `<op>:transport-error`. An HTTP status code (a bare number) is
 * safe to name and helps triage, so we extract at most one 3-digit status.
 *
 * `op` is the transport operation (e.g. "connect", "close", or a tool name), not
 * the raw error, so the label shape matches redactToolFailure's `<name>:<slug>`.
 */
export function sanitizeThrownTransportError(
  op: string,
  error: unknown,
): LiveTransportError {
  // Already redacted upstream: pass it through unchanged so we never re-wrap or
  // accidentally widen a content-free label.
  if (error instanceof LiveTransportError) {
    return error;
  }
  const raw = error instanceof Error ? error.message : String(error);
  const lower = raw.toLowerCase();
  const matchedKeyword = matchRedactedKeyword(lower);
  const statusMatch = /\b([1-5]\d{2})\b/.exec(raw);
  let slug: string;
  if (matchedKeyword) {
    slug = matchedKeyword.replace(/\s+/g, "-");
  } else if (statusMatch) {
    slug = `http-${statusMatch[1]}`;
  } else {
    slug = "transport-error";
  }
  const errorLabel = `${op}:${slug}`;
  return new LiveTransportError(errorLabel, isDenialLabel(errorLabel));
}

/**
 * Concrete MCP-over-HTTP caller. One caller == one bearer token + one bound
 * X-Namespace == one client session. The gate creates one caller per role
 * (primary, negative), each pinned to the exact per-run namespace it owns.
 *
 * X-Namespace is sent on EVERY request (including the session-initializing
 * `initialize`), which is what binds the token-sourced global role to this
 * run's generated namespace. The server treats the delegated namespace as the
 * effective clientId for both the write predicate and the read predicate, so
 * two callers sharing one admin/ob-admin token but carrying different
 * X-Namespace headers are genuinely isolated from each other -- token identity
 * is NOT what proves isolation, the header-bound namespace is.
 */
/**
 * Minimal surface of the MCP SDK client the caller depends on. Injected so unit
 * tests can drive the redaction boundary (a thrown connect/callTool/close) with
 * a fake that emits raw, secret-bearing errors -- proving nothing raw escapes --
 * without standing up a hosted server.
 */
export interface McpClientLike {
  connect(transport: unknown): Promise<void>;
  callTool(
    request: { name: string; arguments: Record<string, unknown> },
    schema: undefined,
    options: { timeout: number },
  ): Promise<{ content?: unknown; isError?: boolean }>;
  close(): Promise<void>;
}

/**
 * Build the real SDK client + streamable-HTTP transport bound to a token and a
 * per-request X-Namespace header. Factored out so createMcpCaller can accept an
 * injected client in tests.
 */
export function defaultMcpClientFactory(opts: {
  baseUrl: string;
  token: string;
  namespace: string;
}): { client: McpClientLike; transport: unknown } {
  const url = new URL("/mcp", opts.baseUrl);
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: {
      headers: {
        Authorization: `Bearer ${opts.token}`,
        "X-Namespace": opts.namespace,
      },
    },
  });
  const client = new Client({
    name: "open-brain-live-recall-gate",
    version: "1.0.0",
  }) as unknown as McpClientLike;
  return { client, transport };
}

export async function createMcpCaller(opts: {
  baseUrl: string;
  token: string;
  /** Effective namespace to bind via the X-Namespace header on every request. */
  namespace: string;
  timeoutMs: number;
  /** Injectable client factory; defaults to the real SDK client. Tests override. */
  clientFactory?: (o: {
    baseUrl: string;
    token: string;
    namespace: string;
  }) => { client: McpClientLike; transport: unknown };
}): Promise<OpenBrainToolCaller> {
  const factory = opts.clientFactory ?? defaultMcpClientFactory;
  const { client, transport } = factory({
    baseUrl: opts.baseUrl,
    token: opts.token,
    namespace: opts.namespace,
  });

  // connect() can throw an SDK error whose message carries the raw remote HTTP
  // body. Sanitize at the boundary so no raw response text or secret escapes.
  try {
    await client.connect(transport);
  } catch (error) {
    throw sanitizeThrownTransportError("connect", error);
  }

  return {
    async callTool(name, args) {
      let raw: { content?: unknown; isError?: boolean };
      try {
        raw = await client.callTool({ name, arguments: args }, undefined, {
          timeout: opts.timeoutMs,
        });
      } catch (error) {
        // A thrown callTool (network drop, HTTP error with a body, malformed
        // response) is sanitized to a content-free label -- the raw error
        // message is never surfaced to a script or log.
        throw sanitizeThrownTransportError(name, error);
      }
      const content = Array.isArray(raw.content) ? raw.content : [];
      const firstText = content.find(
        (block): block is { type: "text"; text: string } =>
          !!block &&
          typeof block === "object" &&
          (block as { type?: unknown }).type === "text" &&
          typeof (block as { text?: unknown }).text === "string",
      );
      const text = firstText?.text ?? "";
      if (raw.isError === true) {
        // Redaction boundary: drop the raw body entirely, keep only a label.
        const { errorLabel, denied } = redactToolFailure(name, text);
        return { isError: true, denied, data: "", errorLabel };
      }
      // Success: carry the body forward for structured parsing only. Callers
      // extract ids/namespace and never log it.
      return { isError: false, denied: false, data: text, errorLabel: "" };
    },
    async close() {
      // close() can also throw an SDK error carrying raw remote text. Sanitize
      // it so a cleanup failure never leaks a body -- the gate's finally block
      // already swallows this, but the message must be content-free if surfaced.
      try {
        await client.close();
      } catch (error) {
        throw sanitizeThrownTransportError("close", error);
      }
    },
  };
}
