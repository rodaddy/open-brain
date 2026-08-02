import type { Express, RequestHandler } from "express";
import type { Logger } from "pino";
import type { ServerConfig } from "../config.ts";
import type { Database } from "../db/pool.ts";
import type { ServerModuleBoundary } from "../module.ts";
import {
  createSingleWorkerTransportApp,
  createSessionTransportHandlers,
  type McpServerFactory,
  type SessionTransportFactory,
  type SessionTransportHandlers,
  type TransportNatsHealth,
} from "../transport/index.ts";

export const APPLICATION_BOUNDARY: ServerModuleBoundary = {
  name: "application",
  owns: ["composition", "startup ordering", "shutdown ordering"],
  excludes: ["HTTP routing", "SQL", "authorization policy", "tool behavior"],
};

export interface ShadowApplicationInput {
  readonly config: ServerConfig;
  readonly logger: Logger;
  readonly database: Database;
  readonly authenticate: RequestHandler;
  readonly parseRequestBody: RequestHandler;
  readonly serverFactory: McpServerFactory;
  readonly transportFactory?: SessionTransportFactory;
  readonly fetch?: typeof fetch;
  readonly natsHealth?: () => TransportNatsHealth;
}

export interface ShadowApplication {
  readonly app: Express;
  readonly sessions: SessionTransportHandlers;
  close(): Promise<void>;
}

/** Compose the phase-4 shadow implementation without binding a network socket. */
export function createShadowApplication(
  input: ShadowApplicationInput,
): ShadowApplication {
  const transportLogger = input.logger.child({ component: "transport" });
  const sessions = createSessionTransportHandlers({
    config: input.config.transport,
    logger: transportLogger,
    serverFactory: input.serverFactory,
    ...(input.transportFactory ? { transportFactory: input.transportFactory } : {}),
  });
  const health = {
    databaseHealth: input.database.health,
    serverIp: input.config.transport.serverIp,
    probeTimeoutMs: input.config.transport.healthProbeTimeoutMs,
    logger: transportLogger,
    ...(input.config.transport.embeddingBaseUrl
      ? { embeddingBaseUrl: input.config.transport.embeddingBaseUrl }
      : {}),
    ...(input.config.transport.embeddingApiKey
      ? { embeddingApiKey: input.config.transport.embeddingApiKey }
      : {}),
    ...(input.fetch ? { fetch: input.fetch } : {}),
    ...(input.natsHealth ? { natsHealth: input.natsHealth } : {}),
  };
  const app = createSingleWorkerTransportApp({
    authenticate: input.authenticate,
    parseRequestBody: input.parseRequestBody,
    sessions,
    health,
    logger: transportLogger,
  });
  return {
    app,
    sessions,
    close: () => sessions.close(),
  };
}
