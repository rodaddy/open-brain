/**
 * Legacy-to-server dependency mapping for the context-pack L5 adapters (issue 864).
 *
 * The three `src/tools/agent-context-pack*.ts` adapters keep a legacy call form
 * the server twins cannot offer, and each needs the same two translations. That
 * shared translation lives HERE, under `server/`, so that an adapter names only
 * `../../server/...` relative specifiers and clause A of
 * `scripts/done-means/864-moved-out-of-src.sh` passes.
 *
 * The shapes it translates FROM are legacy types, so `ToolDeps` and `AuthInfo`
 * are imported type-only from `src/` (rule M3) and re-exported for the adapters,
 * which then need no `src/` specifier of their own. Nothing here reads the
 * environment: every server module is handed its configuration, so the caller
 * passes the resolved shared-namespace name set in.
 */
import { logger } from "../../../src/logger.ts";
import type { Logger } from "pino";
import type { MemoryToolDependencies } from "../types.ts";
import type { AuthIdentity } from "../../auth/types.ts";
import type { SharedNamespaceConfig } from "../../security/shared-namespace.ts";
import type { ToolDeps } from "../../../src/tools/index.ts";
import type { AuthInfo } from "../../../src/types.ts";

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
 * dependency filled from config. `recoveryWalStore` is the legacy wrapper class,
 * which COMPOSES the server store rather than extending it, so the server
 * instance is unwrapped through `serverStore`; the two halves of the realtime
 * surface keep sharing the one object they always did. Every other field
 * carries across by name.
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
    recoveryWalStore: deps.recoveryWalStore?.serverStore,
    natsRuntimeBoundary: deps.natsRuntimeBoundary,
    sharedNamespaceNames,
    recoveryWalPath,
  };
}

/**
 * Map the legacy `AuthInfo` onto the server `AuthIdentity`.
 *
 * `tokenClientId` is optional on the legacy side and required on the server
 * side, so it falls back to `clientId`, which is what every legacy read of an
 * absent `tokenClientId` already resolved to. `namespaceSource` spells the
 * non-token case `"header"` on the legacy side and `"delegated"` on the server
 * side; the two name the same condition.
 */
export function authIdentityFor(auth: AuthInfo): AuthIdentity {
  return {
    role: auth.role,
    clientId: auth.clientId,
    tokenClientId: auth.tokenClientId ?? auth.clientId,
    namespaceSource: auth.namespaceSource === "token" ? "token" : "delegated",
  };
}
