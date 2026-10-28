/**
 * Translation between the legacy `ToolDeps`/`AuthInfo` shapes and the server
 * `MemoryToolDependencies`/`AuthIdentity` shapes the memory tools take.
 *
 * Two live callers reach it: `server/application/nats-bridge-handler.ts`, which
 * builds server tool dependencies for the NATS bridge, and
 * `scripts/done-means/563-bounded-recall.driver.ts`. Both hold a `ToolDeps` and
 * need a `MemoryToolDependencies`; this module is the one place that mapping is
 * written. `ToolDeps` and `AuthInfo` are re-exported so a caller names this
 * module alone. Nothing here reads the environment: every server module is
 * handed its configuration, so the caller passes the resolved shared-namespace
 * name set in.
 */
import { logger } from "../logging/legacy-logger.ts";
import type { Logger } from "pino";
import type { MemoryToolDependencies } from "./types.ts";
import type { SharedNamespaceConfig } from "../security/shared-namespace.ts";
import type { ToolDeps } from "./tool-deps.ts";
import type { AuthInfo } from "../types.ts";

export type { ToolDeps, AuthInfo };

/**
 * The legacy logger presented in the pino shape the server twins call.
 *
 * The two differ in ARGUMENT ORDER, not in destination: the legacy logger is
 * `(message, fields)` and pino is `(fields, message)`. A cast would compile and
 * silently swap every field bag with its event name, so the four methods the
 * server twins actually reach are forwarded explicitly. Everything else on the
 * pino surface is unreached by these call sites; the object is presented as a
 * `Logger` for the dependency slot's benefit.
 */
function pinoShapedLegacyLogger(): Logger {
  const forward =
    (level: "info" | "warn" | "error" | "debug") =>
    (fields: unknown, message?: string): void => {
      if (typeof fields === "string") {
        logger[level](fields);
        return;
      }
      logger[level](message ?? "", fields as Record<string, unknown>);
    };
  return {
    info: forward("info"),
    warn: forward("warn"),
    error: forward("error"),
    debug: forward("debug"),
  } as unknown as Logger;
}

/**
 * Map the legacy `ToolDeps` shape onto the server `MemoryToolDependencies`.
 *
 * Four fields differ. `logger` is required on the server side and absent from
 * `ToolDeps`, so the src logger — the one every legacy caller was already
 * writing through — supplies it. `sharedNamespaceNames` and `recoveryWalPath`
 * are read from the environment by the CALLING adapter and passed in, because
 * the legacy path derived both per call while the server twin takes each as a
 * dependency filled from config. `recoveryWalStore` is already the server store:
 * `ToolDeps` types both realtime members against the server declarations, and
 * the one src construction site unwraps its legacy wrapper through
 * `.serverStore` before the value ever reaches here, so the two halves of the
 * realtime surface keep sharing the one object they always did. Every other
 * field carries across by name.
 */
export function memoryToolDependenciesFor(
  deps: ToolDeps,
  sharedNamespaceNames: SharedNamespaceConfig,
  recoveryWalPath: string | null,
): MemoryToolDependencies {
  return {
    pool: deps.pool,
    embedFn: deps.embedFn,
    logger: pinoShapedLegacyLogger(),
    workingSetStore: deps.workingSetStore,
    recoveryWalStore: deps.recoveryWalStore,
    natsRuntimeBoundary: deps.natsRuntimeBoundary,
    sharedNamespaceNames,
    recoveryWalPath,
  };
}

/**
 * The `AuthInfo` -> `AuthIdentity` map now lives in `../auth/identity.ts`, next
 * to both of its types. It is re-exported here so callers that name this
 * barrel keep working unchanged.
 */
export { authIdentityFor } from "../auth/identity.ts";
