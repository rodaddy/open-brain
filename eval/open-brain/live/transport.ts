import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { LiveMemoryTable } from "./types.ts";
import {
  isAlreadyAbsentMarker,
  parseContextPackPayload,
  parseHits,
  parseReflexPointersPayload,
  redactToolFailure,
  safeJson,
  sanitizeThrownTransportError,
} from "./transport-parse.ts";
import {
  LiveTransportError,
  type ArchiveTable,
  type ContextPackPayload,
  type ContextPackScope,
  type DenialProbeResult,
  type LogMemoryResult,
  type McpClientLike,
  type OpenBrainToolCaller,
  type ReflexPointersPayload,
  type ReflexPriorContextRef,
  type SearchHit,
} from "./transport-types.ts";

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
//
// The type surface lives in ./transport-types.ts and the redaction/parsing
// boundary in ./transport-parse.ts (issue 752, file-length bound). The
// functions MOVED; there is still exactly ONE parse/redaction implementation,
// which is the point -- a second copy of a redaction predicate is how one of
// them silently stops redacting. Everything is re-exported here, so this module
// remains the single import specifier every caller in the repo already uses.

export {
  isDenialLabel,
  parseContextPackPayload,
  parseHits,
  parseReflexPointersPayload,
  redactToolFailure,
  sanitizeThrownTransportError,
} from "./transport-parse.ts";
export { LiveTransportError } from "./transport-types.ts";
export type {
  ArchiveTable,
  ContextPackPayload,
  ContextPackScope,
  DenialProbeResult,
  LogMemoryResult,
  McpClientLike,
  OpenBrainToolCaller,
  ReflexPointersPayload,
  ReflexPriorContextRef,
  SearchHit,
  ToolCallResult,
} from "./transport-types.ts";

/**
 * Semantic wrapper over an OpenBrainToolCaller. Keeps the gate orchestrator
 * free of tool-name/argument details and response parsing, and is the seam the
 * unit tests target with a fake caller.
 */
export class OpenBrainLiveClient {
  private readonly caller: OpenBrainToolCaller;

  constructor(caller: OpenBrainToolCaller) {
    this.caller = caller;
  }

  /**
   * Call a tool whose success contract is one JSON object and return that parsed
   * object without ever logging or surfacing the raw body. Scenario fixtures use
   * this narrow seam for lifecycle reads while retaining the same real/fake
   * OpenBrainToolCaller boundary as the ranking and context-pack gates.
   */
  async structuredTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const result = await this.caller.callTool(name, args);
    if (result.isError) {
      throw new LiveTransportError(result.errorLabel, result.denied);
    }
    const parsed = safeJson(result.data);
    if (!parsed) {
      throw new LiveTransportError(`${name}:malformed-payload`, false);
    }
    return parsed;
  }

  /**
   * Seed one memory into a namespace, returning the server-assigned id.
   *
   * The seed is a CREATE: this run owns every record it later archives, so the
   * response must prove a fresh row was created under the exact namespace we
   * asked for. `log_thought`/`log_decision` return `{id, namespace, merged}`
   * (src/tools/log-thought.ts, log-decision.ts). `assertFreshSeed` fails closed
   * content-free on any response that does not exactly match a create.
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
    const id = assertFreshSeed(tool, safeJson(result.data), opts.namespace);
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
      ...scopeArgs(opts.scope),
      query: opts.query,
      requested_sections: [...opts.requestedSections],
    };
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
   * Call the per-turn reflex `agent_reflex_pointers` for the exact active scope,
   * returning the parsed body-free pointer payload. This is the single tool the
   * REFLEX-4 A/B gate exercises: it reuses `agent_context_pack`'s scope, query,
   * prior-context, and whole-pack budget contract but returns only cited
   * resolvable pointers (no memory bodies). Passing `priorContext` (the
   * suppression-ON arm) makes the shared recall drop records already represented
   * by those references before any pointer is emitted; omitting it (the
   * suppression-OFF arm) emits every net-new authorized pointer.
   *
   * Fails closed content-free exactly like `contextPack`: a permission denial is
   * a redacted LiveTransportError, and the raw payload text (which could carry a
   * body if the tool ever regressed) is never logged -- only structural fields
   * the gate reads (pointer ids, citation ids, counts, budget numbers).
   */
  async reflexPointers(opts: {
    scope: ContextPackScope;
    query: string;
    priorContext?: readonly ReflexPriorContextRef[];
    budgetMaxTokens?: number;
  }): Promise<ReflexPointersPayload> {
    const args: Record<string, unknown> = {
      ...scopeArgs(opts.scope),
      query: opts.query,
    };
    // Only attach prior_context on the suppression-ON arm. An empty array is the
    // suppression-OFF arm and is deliberately OMITTED rather than sent as [], so
    // the two arms differ exactly by the presence of the references -- never by
    // an incidental empty-array vs absent distinction.
    if (opts.priorContext !== undefined && opts.priorContext.length > 0) {
      args.prior_context = opts.priorContext.map((ref) => {
        const out: Record<string, unknown> = {};
        if (ref.citation_id !== undefined) out.citation_id = ref.citation_id;
        if (ref.source_ref !== undefined) out.source_ref = ref.source_ref;
        return out;
      });
    }
    if (opts.budgetMaxTokens !== undefined) {
      args.budget = { max_tokens: opts.budgetMaxTokens };
    }
    const result = await this.caller.callTool("agent_reflex_pointers", args);
    if (result.isError) {
      throw new LiveTransportError(result.errorLabel, result.denied);
    }
    return parseReflexPointersPayload(result.data);
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
    table: ArchiveTable;
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
 * The six scope coordinates every scoped tool call carries, plus `thread_id`
 * only when the caller bound one. An explicitly-absent thread id means the
 * unthreaded lane and is OMITTED rather than sent as null, exactly as the pack
 * tool treats an omitted thread id.
 */
function scopeArgs(scope: ContextPackScope): Record<string, unknown> {
  const args: Record<string, unknown> = {
    namespace: scope.namespace,
    agent: scope.agent,
    platform: scope.platform,
    server_id: scope.server_id,
    channel_id: scope.channel_id,
    session_key: scope.session_key,
  };
  if (scope.thread_id !== undefined && scope.thread_id !== null) {
    args.thread_id = scope.thread_id;
  }
  return args;
}

/**
 * Assert a seed response is a fresh create bound to the exact namespace asked
 * for, returning the server-assigned id. Fails closed content-free on every
 * shape that is not exactly a create:
 *
 *  - missing/non-string `id` -> we never learned the server id, so teardown
 *    could not archive this row (`:missing-id`).
 *  - missing/non-boolean or `merged: true` -> the server upserted onto an
 *    EXISTING row (a stranded prior seed in a reused namespace), so this is not
 *    a this-run creation; archiving it later would tombstone a row this run did
 *    not create (`:merged-upsert` / `:missing-merged`).
 *  - a returned namespace that is not EXACTLY `namespace` -> the row did not
 *    land where we bound our teardown/scoring, so we must not treat it as ours
 *    (`:namespace-mismatch`). We do NOT default a missing namespace to the
 *    requested one: that would mask a server that wrote elsewhere.
 */
function assertFreshSeed(
  tool: string,
  parsed: Record<string, unknown> | undefined,
  namespace: string,
): string {
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
  if (parsed.namespace !== namespace) {
    throw new LiveTransportError(`${tool}:namespace-mismatch`, false);
  }
  return id;
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
 *
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
  clientFactory?: (o: { baseUrl: string; token: string; namespace: string }) => {
    client: McpClientLike;
    transport: unknown;
  };
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
