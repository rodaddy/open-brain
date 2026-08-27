/**
 * The content-ful trace body for one MCP tool call.
 *
 * CONTENT-FUL, per issue #530, which supersedes #372's content-free spec for
 * the local dogfood deployment: the operator receives every field and its
 * surrounding content, with credential-shaped spans replaced by
 * `trace-masking.ts` before any payload leaves this boundary. Masking is
 * replacement, never field removal.
 *
 * Split out of `langfuse-tracing.ts` because building the body is pure: given
 * arguments, a result, and an identity it returns a plain object, with no SDK,
 * server, socket, or async-local state involved.
 */
import type { AuthInfo } from "../types.ts";
import { maskTraceValue } from "./trace-masking.ts";
import type {
  McpTraceStatus,
  TraceBody,
  TraceSpanBody,
} from "./trace-types.ts";

/** Tags on every trace this lane writes, so server traffic is filterable. */
const TRACE_TAGS = ["open-brain-server", "mcp-tool"] as const;

export interface ToolTraceBodyInput {
  toolName: string;
  status: McpTraceStatus;
  durationMs: number;
  args: unknown;
  output: unknown;
  auth?: AuthInfo;
  sessionId?: string;
  maskingEnabled?: boolean;
  metadata?: Record<string, unknown>;
  spans?: TraceSpanBody[];
}

/** Apply masking, or pass the value through untouched when it is off. */
function maskWhenEnabled(value: unknown, maskingEnabled: boolean): unknown {
  return maskingEnabled ? maskTraceValue(value) : value;
}

/** Non-finite durations record as 0 rather than travelling as NaN/Infinity. */
function traceDurationMs(durationMs: number): number {
  return Number.isFinite(durationMs) ? Math.max(0, Math.round(durationMs)) : 0;
}

/**
 * Trace-level metadata: the caller's own fields, then the identity and timing
 * this lane always adds.
 *
 * The audit lane records BOTH client ids (`src/audit-log.ts:299-301`), and the
 * pair is the whole answer to "who actually did this" when a delegated call's
 * `clientId` differs from its token-derived identity.
 */
function toolTraceMetadata(
  input: ToolTraceBodyInput,
  maskingEnabled: boolean,
): Record<string, unknown> {
  const traceMetadata = maskWhenEnabled(
    input.metadata ?? {},
    maskingEnabled,
  ) as Record<string, unknown>;
  return {
    ...traceMetadata,
    ...callerIdentityMetadata(input.auth),
    duration_ms: traceDurationMs(input.durationMs),
    status: input.status,
  };
}

/**
 * Who made this call, with every field present and explicitly null when absent.
 *
 * Null rather than omitted so a trace missing an identity is distinguishable
 * from one where the field was never recorded.
 */
function callerIdentityMetadata(
  auth: AuthInfo | undefined,
): Record<string, unknown> {
  const metadata: Record<string, unknown> = {};
  for (const [field, key] of CALLER_IDENTITY_FIELDS) {
    metadata[key] = auth?.[field] ?? null;
  }
  return metadata;
}

/**
 * `AuthInfo` field to trace-metadata key, in emission order.
 *
 * A table rather than five inline reads: the mapping is the whole content of
 * `callerIdentityMetadata`, and stating it once keeps the key names in one
 * place where a reader can check them against the audit lane's.
 */
const CALLER_IDENTITY_FIELDS = [
  ["role", "caller_role"],
  ["clientId", "caller_client_id"],
  ["tokenClientId", "caller_token_client_id"],
  ["agentId", "caller_agent_id"],
  ["namespaceSource", "namespace_source"],
] as const satisfies readonly (readonly [keyof AuthInfo, string])[];

/** Mask each collected child span in place, preserving name and order. */
function maskedTraceSpans(
  spans: TraceSpanBody[] | undefined,
  maskingEnabled: boolean,
): TraceSpanBody[] | undefined {
  return spans?.map((span) => ({
    name: span.name,
    input: maskWhenEnabled(span.input, maskingEnabled),
    output: maskWhenEnabled(span.output, maskingEnabled),
    metadata: maskWhenEnabled(span.metadata, maskingEnabled) as Record<
      string,
      unknown
    >,
  }));
}

/**
 * The trace body for one tool call, content-ful and masked by default.
 *
 * Exported so the shape is assertable without an SDK, a server, or a socket.
 */
export function buildToolTraceBody(input: ToolTraceBodyInput): TraceBody {
  const maskingEnabled = input.maskingEnabled !== false;
  const spans = maskedTraceSpans(input.spans, maskingEnabled);
  return {
    name: input.toolName,
    input: maskWhenEnabled(input.args, maskingEnabled),
    output: maskWhenEnabled(input.output, maskingEnabled),
    tags: [...TRACE_TAGS],
    metadata: toolTraceMetadata(input, maskingEnabled),
    ...(spans === undefined ? {} : { spans }),
    ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
    ...(input.auth?.clientId === undefined
      ? {}
      : { userId: input.auth.clientId }),
  };
}

/**
 * The output field for a call that threw: class and message, nothing else.
 *
 * Content-FUL like the rest of this lane — the operator's stated requirement is
 * to see WHY a call failed — so the message travels in full. That is the whole
 * difference from `tracingErrorLabel`, which labels tracing's OWN failures for
 * the local log and is deliberately content-free.
 */
export function errorOutput(err: unknown): Record<string, string> {
  if (err instanceof Error) {
    return { error_class: err.name, error_message: err.message };
  }
  return { error_class: errorClassOf(err), error_message: String(err) };
}

/** The best available class name for a non-`Error` throw. */
function errorClassOf(err: unknown): string {
  if (typeof err !== "object" || err === null) return typeof err;
  return err.constructor?.name ?? "Object";
}
