/**
 * NATS runtime boundary, owned by the config layer.
 *
 * Design authority: `_plans/463-server-rewrite-charter.md` section 3 —
 * `server/config/` owns ALL env parsing and startup validation, replacing the
 * 18 scattered `process.env` readers the charter counts in `src/`. The behavior
 * being preserved is `src/nats-runtime.ts`'s `readNatsRuntimeBoundary`, and the
 * `/health` `nats` block it feeds (`src/index.ts` health payload), both frozen
 * by the charter's `/health` row.
 *
 * WHY THIS IS CONFIG AND NOT TRANSPORT. Everything here is a decision about the
 * ENVIRONMENT: which transport was requested, whether a bridge was enabled,
 * whether the broker URL is one this process may talk to. None of it needs a
 * socket, and `server/transport/health.ts` already takes the answer through its
 * `natsHealth` port rather than deriving it. Putting the derivation here is what
 * lets health stay a pure reporter — the charter's stated reason for the config
 * boundary existing at all.
 *
 * THE URL RULE IS A SECURITY RULE, NOT A CONVENIENCE. NATS here is a
 * plaintext, possibly auth-bearing transport, so the runtime is available only
 * for a LOCAL broker unless an explicit remote override is set, and an
 * UNPARSEABLE url fails closed rather than being treated as local
 * (`docs/sme/security.md` records this). An unparseable URL and a deliberately
 * remote one produce the same `not_runtime_available`, so the reason is reported
 * separately rather than being inferred from the availability alone — a typo in
 * the broker URL used to be indistinguishable from a configuration choice.
 */
import { obContextPackSubject } from "../../src/nats-subjects.ts";

/** Hosts treated as a local broker for the plaintext-transport rule. */
const LOCAL_NATS_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

const DEFAULT_NATS_ENV = "dev";

export type NatsAvailability = "available" | "not_runtime_available";

/**
 * Why the runtime is not available, when it is not.
 *
 * `null` when it IS available. This is the field that separates "the operator
 * did not ask for NATS" from "the operator asked and the broker URL is a typo",
 * which the availability flag alone collapses into one silent answer.
 */
export type NatsUnavailableReason =
  | "transport_not_requested"
  | "bridge_disabled"
  | "url_missing"
  | "url_unparseable"
  | "url_remote_not_allowed"
  | null;

export interface NatsConfig {
  readonly requestedTransport: "http" | "nats";
  readonly fallbackTransport: "http_mcp";
  readonly availability: NatsAvailability;
  readonly unavailableReason: NatsUnavailableReason;
  /** Never logged and never emitted in `/health`; it may carry credentials. */
  readonly url: string | null;
  readonly contextPackSubject: string;
  readonly fallbackHttp: boolean;
  readonly requireAuth: boolean;
  readonly allowNamespaceOverride: boolean;
}

type Environment = Record<string, string | undefined>;

function readEnv(value: string | undefined): string | null {
  const cleaned = value?.trim();
  return cleaned ? cleaned : null;
}

function isTrue(value: string | undefined): boolean {
  return value?.trim().toLowerCase() === "true";
}

/**
 * Decide whether the configured broker URL may be used by this runtime.
 *
 * Returns the failure REASON rather than a boolean so the caller can report
 * which of the three distinct situations occurred. Fails closed on a parse
 * error: the URL may carry credentials, so it is never included in the answer.
 */
function urlAvailability(
  url: string | null,
  environment: Environment,
): Exclude<NatsUnavailableReason, "transport_not_requested" | "bridge_disabled"> {
  if (!url) return "url_missing";
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "url_unparseable";
  }
  if (LOCAL_NATS_HOSTS.has(parsed.hostname.toLowerCase())) return null;
  return isTrue(environment.OPENBRAIN_NATS_ALLOW_INSECURE_REMOTE)
    ? null
    : "url_remote_not_allowed";
}

/**
 * Resolve the env-prefixed context-pack subject, or the explicit override.
 *
 * The subject is reported in `/health` even when the runtime is unavailable,
 * because it tells an operator which lane the bridge WOULD use — which is the
 * question being asked when the bridge is not working.
 */
export function resolveContextPackSubject(environment: Environment): string {
  const override = readEnv(environment.OPENBRAIN_NATS_CONTEXT_PACK_SUBJECT);
  if (override) return override;
  return obContextPackSubject(
    readEnv(environment.OPENBRAIN_NATS_ENV) ?? DEFAULT_NATS_ENV,
  );
}

/** Derive the whole NATS boundary from an explicit environment-shaped input. */
export function parseNatsConfig(environment: Environment): NatsConfig {
  const requestedTransport =
    environment.OPENBRAIN_TRANSPORT?.trim().toLowerCase() === "nats"
      ? "nats"
      : "http";
  const url = readEnv(environment.OPENBRAIN_NATS_URL);
  const bridgeEnabled = isTrue(environment.OPENBRAIN_NATS_ENABLE_BRIDGE);

  // Auth is OFF by default (trusted local bus). When REQUIRE_AUTH is set the
  // bearer gate is re-enabled AND the namespace override is force-disabled:
  // they are mutually exclusive, because the override is a local-trust
  // affordance and an authenticated caller must not also be able to name any
  // namespace it likes.
  const requireAuth = isTrue(environment.OPENBRAIN_NATS_REQUIRE_AUTH);
  const allowNamespaceOverride =
    !requireAuth &&
    environment.OPENBRAIN_NATS_ALLOW_NAMESPACE_OVERRIDE?.trim().toLowerCase() !==
      "false";

  // Order matters and is the reported reason: not requested beats disabled
  // beats a URL problem, so an operator is told the FIRST thing to fix rather
  // than a downstream symptom of a switch that was never turned on.
  const unavailableReason: NatsUnavailableReason =
    requestedTransport !== "nats"
      ? "transport_not_requested"
      : !bridgeEnabled
        ? "bridge_disabled"
        : urlAvailability(url, environment);

  return {
    requestedTransport,
    fallbackTransport: "http_mcp",
    availability: unavailableReason === null ? "available" : "not_runtime_available",
    unavailableReason,
    url,
    contextPackSubject: resolveContextPackSubject(environment),
    fallbackHttp:
      environment.OPENBRAIN_NATS_FALLBACK_HTTP?.trim().toLowerCase() !== "false",
    requireAuth,
    allowNamespaceOverride,
  };
}

/**
 * Project the config onto the frozen `/health` `nats` block.
 *
 * The URL is deliberately absent and `last_error` is the literal `"redacted"`
 * or `null`: `/health` is unauthenticated, and the broker URL may carry
 * credentials. `consecutive_failures` comes from a live bridge, so it is a
 * parameter rather than something config could know.
 */
export function natsHealthFromConfig(
  config: NatsConfig,
  live: { consecutiveFailures?: number; lastError?: boolean } = {},
): {
  requested_transport: "http" | "nats";
  availability: NatsAvailability;
  context_pack_subject: string;
  fallback_http: boolean;
  consecutive_failures: number;
  last_error: "redacted" | null;
} {
  return {
    requested_transport: config.requestedTransport,
    availability: config.availability,
    context_pack_subject: config.contextPackSubject,
    fallback_http: config.fallbackHttp,
    consecutive_failures: live.consecutiveFailures ?? 0,
    last_error: live.lastError ? "redacted" : null,
  };
}
