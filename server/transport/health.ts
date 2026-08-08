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

/**
 * The maintenance producer's liveness, as `/health` reports it.
 *
 * WHY THIS IS A HEALTH INPUT AT ALL (#625). Before this, `status` was computed
 * from the database probe and the NATS block alone, so a background producer
 * that had gone silent could not move the endpoint off "healthy" — observed as
 * ~18 minutes of no sweep lines against a green `/health`. A health endpoint
 * that reports only its inbound dependencies answers "can I serve a request?"
 * and silently declines to answer "is my background work still happening?".
 * Those are different questions and the second one is the one that goes wrong
 * quietly.
 */
export interface TransportProducerHealth {
  /** Milliseconds since the producer last completed a tick. */
  readonly quiet_ms: number;
  /** True once the producer has been quiet past its own threshold. */
  readonly stale: boolean;
  readonly quiet_threshold_ms: number;
  /** Ticks skipped because a previous one was still running. */
  readonly overlapped_ticks: number;
  readonly completed_ticks: number;
}

export interface SingleWorkerHealth {
  readonly status: "healthy" | "degraded";
  /** Machine hostname — the human half of "which brain did I reach?". */
  readonly hostname: string;
  readonly server_ip: string;
  readonly server_ips: readonly string[];
  /** Deploy stamp short sha; absent on a tree that was never deployed. */
  readonly revision?: string;
  readonly database: DatabaseHealth;
  readonly embedding: {
    readonly configured: boolean;
    readonly connected: boolean;
  };
  readonly nats: TransportNatsHealth;
  /**
   * Absent on a process that composes no maintenance producer — which is a
   * legitimate configuration (an opted-out worker), and is deliberately
   * distinct from a producer that is present and quiet. Absent means "not my
   * job"; `stale: true` means "my job and I am not doing it".
   */
  readonly maintenance_producer?: TransportProducerHealth;
  readonly timestamp: string;
}

export interface SingleWorkerHealthInput {
  readonly databaseHealth: () => Promise<DatabaseHealth>;
  readonly embeddingBaseUrl?: string;
  readonly embeddingApiKey?: string;
  readonly hostname: string;
  readonly serverIp: string;
  readonly serverIps: readonly string[];
  readonly revision?: string | undefined;
  readonly probeTimeoutMs: number;
  readonly logger: Logger;
  readonly fetch?: typeof fetch;
  readonly natsHealth?: () => TransportNatsHealth;
  /**
   * The maintenance producer's own liveness reading, injected the same way
   * `natsHealth` is: the live component knows its counters and this module
   * must not guess them. Omitted composes no producer block and cannot degrade
   * the status.
   */
  readonly producerHealth?: () => TransportProducerHealth | undefined;
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
  // #625: a quiet producer degrades this worker. A process that composes no
  // producer supplies nothing here and is unaffected — absence is not staleness.
  const producer = input.producerHealth?.();
  const producerDegraded = producer?.stale === true;
  const status =
    database.connected && !natsDegraded && !producerDegraded
      ? "healthy"
      : "degraded";
  input.logger.info(
    {
      status,
      database_connected: database.connected,
      embedding_connected: embeddingConnected,
      nats_availability: nats.availability,
      // Emitted whenever a producer exists, not only when it is stale: the
      // healthy reading is what makes a later stale one comparable, and a field
      // that appears only on failure cannot be graphed.
      ...(producer
        ? {
            maintenance_producer_stale: producer.stale ? 1 : 0,
            maintenance_producer_quiet_ms: producer.quiet_ms,
            maintenance_producer_overlapped_ticks: producer.overlapped_ticks,
          }
        : {}),
    },
    "worker_health_result",
  );
  if (producerDegraded) {
    input.logger.warn(
      {
        quiet_ms: producer.quiet_ms,
        quiet_threshold_ms: producer.quiet_threshold_ms,
        overlapped_ticks: producer.overlapped_ticks,
        completed_ticks: producer.completed_ticks,
      },
      "maintenance_producer_health_degraded",
    );
  }
  return {
    status,
    hostname: input.hostname,
    server_ip: input.serverIp,
    server_ips: input.serverIps,
    ...(input.revision ? { revision: input.revision } : {}),
    database,
    embedding: {
      configured: Boolean(input.embeddingBaseUrl),
      connected: embeddingConnected,
    },
    nats,
    ...(producer ? { maintenance_producer: producer } : {}),
    timestamp: new Date().toISOString(),
  };
}
