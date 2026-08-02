/**
 * NATS context-pack bridge as a composed background runtime.
 *
 * Design authority: `_plans/463-server-rewrite-charter.md` section 3 puts
 * startup/shutdown ORDERING in `server/application/`. The bridge is a second
 * ingress — it accepts context-pack requests off a message bus instead of an
 * HTTP socket — so it must start after the pool and stop before it, exactly
 * like the maintenance runner. Wrapping it as a `BackgroundRuntime` is what
 * puts it in `closeInOrder`'s list rather than in a bespoke `if (bridge)` arm
 * of a shutdown function, which is how `src/index.ts:405-424` carries it today
 * and why that shutdown path has to re-implement the every-runtime-still-stops
 * rule per dependency.
 *
 * WHY THE BOUNDARY IS PROJECTED RATHER THAN RE-READ. `server/config/nats.ts`
 * already parsed the environment into `NatsConfig`, including the local-broker
 * security rule. The bridge implementation in `src/nats-bridge.ts` wants the
 * older `NatsRuntimeBoundary` shape. Projecting one onto the other keeps the
 * charter's single-env-read rule intact: if this file called
 * `readNatsRuntimeBoundary(process.env)` instead, the process would have two
 * independent answers to "is NATS available", and they would disagree the first
 * time one of the two parsers changed.
 */
import type { Logger } from "pino";
import type { NatsConfig } from "../config.ts";
import {
  createNatsBridgeHealth,
  startNatsContextPackBridge,
  type NatsBridgeHealth,
  type NatsBridgeRuntime,
} from "../../src/nats-bridge.ts";
import type { NatsRuntimeBoundary } from "../../src/nats-runtime.ts";
import type { ToolDeps } from "../../src/tools/index.ts";
import type { AuthInfo } from "../../src/types.ts";
import type { BackgroundRuntime } from "./index.ts";

/** Project the parsed config onto the bridge's runtime-boundary shape. */
export function natsRuntimeBoundaryFromConfig(
  config: NatsConfig,
): NatsRuntimeBoundary {
  return {
    requested_transport: config.requestedTransport,
    fallback_transport: config.fallbackTransport,
    nats: {
      availability: config.availability,
      url: config.url,
      context_pack_subject: config.contextPackSubject,
      fallback_http: config.fallbackHttp,
      require_auth: config.requireAuth,
      allow_namespace_override: config.allowNamespaceOverride,
    },
  };
}

export interface NatsBridgeInput {
  readonly config: NatsConfig;
  readonly logger: Logger;
  readonly tokenMap: Map<string, AuthInfo>;
  readonly deps: ToolDeps;
  readonly health: NatsBridgeHealth;
  readonly start?: typeof startNatsContextPackBridge;
}

export interface StartedNatsBridge {
  readonly runtime?: BackgroundRuntime;
  readonly health: NatsBridgeHealth;
}

/** How long a bridge close may take before shutdown stops waiting for it. */
const CLOSE_TIMEOUT_MS = 5_000;

/**
 * Start the bridge when the operator asked for it, and wrap it for shutdown.
 *
 * Returns no runtime in two DIFFERENT situations that must not be conflated:
 * the operator did not request NATS (normal, silent), and the operator
 * requested it but config found it unavailable (a warning, because the caller
 * asked for a transport it is not getting and would otherwise discover that
 * only from a latency change). `config.unavailableReason` is what separates
 * them, which is the entire reason that field exists.
 *
 * A bridge that FAILS TO START throws. That is the difference from the two
 * cases above: the operator asked for NATS, config said the broker was usable,
 * and the connection still failed — so the process's declared ingress is
 * missing and starting anyway would serve a deployment that silently answers on
 * only one of its two doors. `src/index.ts:328` reaches the same conclusion by
 * calling `process.exit(1)`; throwing keeps the decision with the entrypoint,
 * which is the only layer allowed to end a process.
 */
export async function startNatsBridgeRuntime(
  input: NatsBridgeInput,
): Promise<StartedNatsBridge> {
  const { config, logger, health } = input;
  if (config.requestedTransport !== "nats") return { health };
  if (config.availability !== "available") {
    logger.warn(
      {
        availability: config.availability,
        unavailable_reason: config.unavailableReason,
        fallback_transport: config.fallbackTransport,
        fallback_http: config.fallbackHttp,
        context_pack_subject: config.contextPackSubject,
      },
      "nats_bridge_requested_but_unavailable",
    );
    return { health };
  }
  const start = input.start ?? startNatsContextPackBridge;
  let bridge: NatsBridgeRuntime | null;
  try {
    bridge = await start({
      boundary: natsRuntimeBoundaryFromConfig(config),
      tokenMap: input.tokenMap,
      deps: input.deps,
      health,
    });
  } catch (error: unknown) {
    health.availability = "not_runtime_available";
    health.consecutiveFailures += 1;
    // The message may embed the broker URL, which may embed credentials. The
    // health block already reports `last_error` as the literal "redacted" for
    // this reason; the log must not be the leak the response body avoids.
    health.lastError = "redacted";
    logger.error(
      { error_category: error instanceof Error ? error.name : typeof error },
      "nats_bridge_start_failed",
    );
    throw error;
  }
  if (!bridge) return { health };
  logger.info(
    { subject: bridge.subject, availability: bridge.availability },
    "nats_bridge_started",
  );
  const runtime = bridge;
  return {
    health,
    runtime: {
      name: "nats-bridge",
      stop: async () => {
        // Bounded, because a broker that has stopped answering can leave
        // `close()` pending indefinitely, and a shutdown that never returns is
        // worse than one that gives up on a socket: launchd escalates to
        // SIGKILL and the maintenance drain behind this runtime never runs.
        await Promise.race([
          runtime.close(),
          new Promise((_, reject) =>
            setTimeout(
              () => reject(new Error("nats_bridge_close_timeout")),
              CLOSE_TIMEOUT_MS,
            ),
          ),
        ]);
      },
    },
  };
}

export { createNatsBridgeHealth };
export type { NatsBridgeHealth };
