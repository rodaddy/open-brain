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
  namespace: string;
}

export interface SearchHit {
  id: string;
  source_type: string;
  namespace?: string;
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

  /** Seed one memory into a namespace, returning the server-assigned id. */
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
    const namespace =
      typeof parsed?.namespace === "string" ? parsed.namespace : opts.namespace;
    if (!id) {
      // Content-free: name the tool, not the response body.
      throw new LiveTransportError(`${tool}:missing-id`, false);
    }
    return { id, namespace };
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
   * those two -- `archived: true`, or that exact marker (trimmed,
   * case-insensitive) -- and throw a content-free LiveTransportError for EVERY
   * other success response.
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
    // Explicit archived success: the JSON object the server returns for a row
    // it tombstoned. Only `archived: true` counts.
    if (parsed?.archived === true) return "archived";
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

/** Parse ranked search hits from a JSON array body. Never logs the body. */
export function parseHits(text: string): SearchHit[] {
  const parsed = safeJsonArray(text);
  if (!parsed) return [];
  const hits: SearchHit[] = [];
  for (const row of parsed) {
    if (row && typeof row === "object") {
      const id = (row as Record<string, unknown>).id;
      const sourceType = (row as Record<string, unknown>).source_type;
      const namespace = (row as Record<string, unknown>).namespace;
      if (typeof id === "string") {
        hits.push({
          id,
          source_type: typeof sourceType === "string" ? sourceType : "",
          namespace: typeof namespace === "string" ? namespace : undefined,
        });
      }
    }
  }
  return hits;
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
