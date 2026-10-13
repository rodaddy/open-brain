import type { LiveMemoryTable } from "./types.ts";

// The shared type surface and error class of the live transport.
//
// Split out of transport.ts (issue 752) so the client module stays under the
// file-length bound, and so transport-parse.ts can construct a
// LiveTransportError without importing transport.ts back (which would make the
// pair circular). transport.ts re-exports every name here, so no import
// specifier anywhere in the repo moves.

/** Minimal tool interface so the gate can run against a fake in tests. */
export interface OpenBrainToolCaller {
  callTool(name: string, args: Record<string, unknown>): Promise<ToolCallResult>;
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

export type ArchiveTable = LiveMemoryTable | "sessions";

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
 * One explicit prior-context reference for a reflex-pointers call: an identifier
 * or structural source pointer for a record already supplied to the model this
 * turn. Only resolvable identity is ever carried -- never a raw prior-context
 * body -- mirroring `agent_reflex_pointers.prior_context`. The suppression-ON
 * arm of the A/B gate echoes back the citation ids the already-known seeds were
 * emitted under; the suppression-OFF arm sends none.
 */
export interface ReflexPriorContextRef {
  citation_id?: string;
  source_ref?:
    string | { source: string; type: string; id: string; namespace?: string };
}

/**
 * The structural fields the reflex-A/B gate reads out of an
 * `agent_reflex_pointers` payload. Deliberately narrow: the body-free pointer
 * section (items carry identity + structural source_ref only), the top-level
 * citations, the whole-pack budget, and the warnings channel. Section item
 * bodies stay opaque records so the gate reads pointer ids / citation ids /
 * counts WITHOUT ever inspecting a memory body. The raw payload text is never
 * carried past this boundary.
 */
export interface ReflexPointersPayload {
  status: string;
  placement: string;
  pointers: Record<string, unknown>;
  citations: Array<Record<string, unknown>>;
  budget: Record<string, unknown>;
  warnings: {
    scope_denials: Array<Record<string, unknown>>;
    degraded_sources: Array<Record<string, unknown>>;
    truncation: Array<Record<string, unknown>>;
  };
}

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
 * The public error surface for a live transport failure. Callers may log or
 * embed `label` in a receipt; it is redacted to tool/class/status/reason
 * keywords only and never contains raw response text.
 */
export class LiveTransportError extends Error {
  readonly label: string;
  readonly denied: boolean;
  /**
   * Content-free diagnostics carried from a failing child process: the error
   * class and one redacted stderr line. Without these a provider failure
   * presents as a bare exit code and has to be recovered by replaying the
   * command by hand (issue #583).
   */
  readonly errorClass?: string;
  readonly stderrFirstLine?: string;
  constructor(
    label: string,
    denied: boolean,
    diagnostics: { errorClass?: string; stderrFirstLine?: string } = {},
  ) {
    super(label);
    this.name = "LiveTransportError";
    this.label = label;
    this.denied = denied;
    this.errorClass = diagnostics.errorClass;
    this.stderrFirstLine = diagnostics.stderrFirstLine;
  }
}
