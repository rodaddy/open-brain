/**
 * Transport boundary surface.
 *
 * Design authority: `_plans/463-server-rewrite-charter.md` phase 4 owns the
 * shadow HTTP/MCP implementation. This barrel is the only import path the
 * application layer may use; the modules behind it stay private so composition
 * cannot reach past the boundary into session internals.
 */
import type { ServerModuleBoundary } from "../module.ts";

export const TRANSPORT_BOUNDARY: ServerModuleBoundary = {
  name: "transport",
  owns: ["HTTP routes", "MCP sessions", "health responses", "worker proxying"],
  excludes: ["tool behavior", "authorization policy", "SQL"],
};

export { createSessionTransportHandlers } from "./session-manager.ts";
export type {
  McpServerFactory,
  SessionIdentity,
  SessionTransportConfig,
  SessionTransportFactory,
  SessionTransportFactoryInput,
  SessionTransportHandlers,
} from "./session-manager.ts";

export { getSingleWorkerHealth } from "./health.ts";
export type {
  SingleWorkerHealth,
  SingleWorkerHealthInput,
  TransportNatsHealth,
} from "./health.ts";

export { createSingleWorkerTransportApp } from "./http-app.ts";
export type { SingleWorkerTransportAppInput } from "./http-app.ts";

export {
  createRequestLogger,
  createRestSurface,
  installHttpMiddleware,
  parseAllowedOrigins,
} from "./rest.ts";
export type { RestSurfaceInput } from "./rest.ts";

export { createWorkerProxyHandler } from "./worker-proxy.ts";
export type {
  AggregateHealth,
  WorkerHealthResult,
  WorkerProxyHandler,
  WorkerProxyInput,
  WorkerTarget,
} from "./worker-proxy.ts";
