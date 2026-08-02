import type { Logger } from "pino";
import type { DatabaseHealth } from "../db/pool.ts";

export interface TransportNatsHealth {
  readonly requested_transport: "http" | "nats";
  readonly availability: "available" | "not_runtime_available";
  readonly context_pack_subject: string;
  readonly fallback_http: boolean;
  readonly consecutive_failures: number;
  readonly last_error: "redacted" | null;
}

export interface SingleWorkerHealth {
  readonly status: "healthy" | "degraded";
  readonly server_ip: string;
  readonly server_ips: readonly string[];
  readonly database: DatabaseHealth;
  readonly embedding: {
    readonly configured: boolean;
    readonly connected: boolean;
  };
  readonly nats: TransportNatsHealth;
  readonly timestamp: string;
}

export interface SingleWorkerHealthInput {
  readonly databaseHealth: () => Promise<DatabaseHealth>;
  readonly embeddingBaseUrl?: string;
  readonly embeddingApiKey?: string;
  readonly serverIp: string;
  readonly probeTimeoutMs: number;
  readonly logger: Logger;
  readonly fetch?: typeof fetch;
  readonly natsHealth?: () => TransportNatsHealth;
}

const HTTP_NATS_HEALTH: TransportNatsHealth = {
  requested_transport: "http",
  availability: "available",
  context_pack_subject: "openbrain.context-pack.v1",
  fallback_http: true,
  consecutive_failures: 0,
  last_error: null,
};

async function probeEmbedding(input: SingleWorkerHealthInput): Promise<boolean> {
  if (!input.embeddingBaseUrl) return false;
  const headers = new Headers();
  if (input.embeddingApiKey) {
    headers.set("Authorization", `Bearer ${input.embeddingApiKey}`);
  }
  try {
    const response = await (input.fetch ?? fetch)(
      `${input.embeddingBaseUrl.replace(/\/$/, "")}/models`,
      { headers, signal: AbortSignal.timeout(input.probeTimeoutMs) },
    );
    const connected = response.ok;
    await response.body?.cancel();
    if (!connected) {
      input.logger.warn({ status: response.status }, "embedding_health_degraded");
    }
    return connected;
  } catch (error: unknown) {
    input.logger.warn(
      { error_category: error instanceof Error ? error.name : typeof error },
      "embedding_health_failed",
    );
    return false;
  }
}

/** Probe one worker's owned dependencies without opening a listener. */
export async function getSingleWorkerHealth(
  input: SingleWorkerHealthInput,
): Promise<SingleWorkerHealth> {
  const [database, embeddingConnected] = await Promise.all([
    input.databaseHealth(),
    probeEmbedding(input),
  ]);
  const nats = input.natsHealth?.() ?? HTTP_NATS_HEALTH;
  const natsDegraded =
    nats.requested_transport === "nats" && nats.availability !== "available";
  const status = database.connected && !natsDegraded ? "healthy" : "degraded";
  input.logger.info(
    {
      status,
      database_connected: database.connected,
      embedding_connected: embeddingConnected,
      nats_availability: nats.availability,
    },
    "worker_health_result",
  );
  return {
    status,
    server_ip: input.serverIp,
    server_ips: [input.serverIp],
    database,
    embedding: {
      configured: Boolean(input.embeddingBaseUrl),
      connected: embeddingConnected,
    },
    nats,
    timestamp: new Date().toISOString(),
  };
}
