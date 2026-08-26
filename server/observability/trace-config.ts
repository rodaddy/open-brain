/**
 * Reading the tracing lane's inputs: its configuration and a call's session.
 *
 * Split out of `langfuse-tracing.ts` because both are pure reads over data
 * handed in — an env record and a tool call's arguments — with no SDK, server,
 * or async-local state involved, which is what makes them assertable directly.
 */
import { logger } from "../../src/logger.ts";
import type { McpTracingConfig } from "./trace-types.ts";

/** One tracing coordinate, trimmed, with absent and blank both reading as "". */
function trimmedEnv(
  env: Record<string, string | undefined>,
  key: string,
): string {
  return env[key]?.trim() ?? "";
}

/**
 * Resolve tracing configuration from the environment.
 *
 * Mirrors `readMcpAuditConfig` (`src/audit-log.ts:134-158`), with the opposite
 * default: audit is on unless disabled, tracing is OFF unless every coordinate
 * is present. A payload-carrying export to an external server is opt-in per
 * deployment, never something a missing variable turns on by accident.
 *
 * The incomplete-flag case warns exactly once at install, content-free: the
 * operator who set the flag and mistyped one variable would otherwise get a
 * silent zero, which is the failure mode this whole file exists to remove.
 * Key VALUES are never logged — only whether each one was present.
 */
export function readMcpTracingConfig(
  env: Record<string, string | undefined> = process.env,
): McpTracingConfig {
  const endpoint = trimmedEnv(env, "OPENBRAIN_TRACING_ENDPOINT");
  const publicKey = trimmedEnv(env, "OPENBRAIN_TRACING_PUBLIC_KEY");
  const secretKey = trimmedEnv(env, "OPENBRAIN_TRACING_SECRET_KEY");
  const flagged = env.OPENBRAIN_TRACING_ENABLED === "1";
  const maskingEnabled = env.OPENBRAIN_TRACING_MASKING_ENABLED !== "0";
  const complete =
    endpoint.length > 0 && publicKey.length > 0 && secretKey.length > 0;
  if (flagged && !complete) {
    // Field names deliberately avoid every substring in
    // `SENSITIVE_KEY_PARTS` (`src/secret-patterns.ts:160-173` — `secret`,
    // `apikey`, `credential`, `privatekey`, ...). A field named `hasSecretKey`
    // is rewritten to "[REDACTED]" by the shared logger, which turns the one
    // line telling an operator WHICH variable they mistyped into noise. The
    // values are booleans by construction, so no key material can travel here
    // regardless of the name.
    logger.warn("mcp_tool_tracing_config_incomplete", {
      endpointSet: endpoint.length > 0,
      publicIdSet: publicKey.length > 0,
      privateIdSet: secretKey.length > 0,
    });
  }
  return {
    enabled: flagged && complete,
    maskingEnabled,
    endpoint,
    publicKey,
    secretKey,
  };
}

/**
 * The Langfuse session this call belongs to, or undefined.
 *
 * Preference order is deliberate: a `session_key` in the arguments is the
 * BRAIN's own session identity, which is what makes an agent's whole
 * conversation with the brain read as one Langfuse timeline next to the
 * client-side traces the #523 sink already ships. The MCP transport's
 * `sessionId` is a per-connection fallback — real, but a different grain.
 */
export function resolveSessionId(
  args: unknown,
  extra: unknown,
): string | undefined {
  const fromArgs =
    readStringField(args, "session_key") ??
    readStringField(readField(args, "scope"), "session_key");
  if (fromArgs !== undefined) return fromArgs;
  return readStringField(extra, "sessionId");
}

function readField(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object") return undefined;
  return (value as Record<string, unknown>)[key];
}

function readStringField(value: unknown, key: string): string | undefined {
  const field = readField(value, key);
  if (typeof field !== "string" || field.length === 0) return undefined;
  return field;
}

/**
 * The trace body for one tool call, content-ful and masked by default.
 *
 * Exported so the shape is assertable without an SDK, a server, or a socket.
 */
