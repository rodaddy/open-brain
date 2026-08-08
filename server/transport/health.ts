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

/**
 * The raw-capture lane's liveness, as `/health` reports it.
 *
 * WHY THIS IS A HEALTH INPUT AT ALL (#647, ledger item 25). Raw capture is
 * AUTOMATIC — a `Stop` hook reads since the watermark and delivers — and
 * automatic is what makes it dangerous: nothing was ever asked to notice it
 * stopping. `ob_raw_turns` records ARRIVALS; nothing anywhere read ABSENCE, so
 * a silently-dead capture lane was server-side indistinguishable from an idle
 * one. This is the #625 producer argument applied to the second background
 * lane, and it replaces an enforcement tier rather than adding a test: ledger
 * item 25 retired the capture merge-gate on the reasoning that gating a
 * human's PR is the wrong instrument for a background pipeline.
 *
 * Every field is derived from EVENT COUNTS by
 * `openbrain.apps.capture.liveness`. `silence_seconds` is reported, never
 * compared — a wall-clock verdict cannot tell a wedged pipeline from a quiet
 * afternoon (`docs/lane-contract.md`, Tightenings round 5).
 */
export interface TransportCaptureHealth {
  /** True once any capture fault below fired. */
  readonly stale: boolean;
  /** Sessions ran and the watermark advanced zero bytes. */
  readonly watermark_wedged: boolean;
  /** The spool holds records and the outage latch announced nothing. */
  readonly spool_unannounced: boolean;
  /**
   * Speakers that delivered nothing while the lane was active.
   *
   * PER ROLE, not per lane, and this field is the reason the block exists in
   * this shape: `docs/decisions/capture-never-drops-a-turn.md:188-200` records
   * that the operator's numbers stayed healthy for six days while the
   * assistant side sat at zero (#447). A lane total reads as busy traffic;
   * only the per-role view sees a dead speaker.
   */
  readonly silent_roles: readonly string[];
  readonly sessions_observed: number;
  readonly turns_delivered: number;
  readonly spool_pending: number;
  /** Reported for an operator; no verdict is derived from it. */
  readonly silence_seconds: number;
  /** Content-free sentence naming which fault fired. */
  readonly reason: string;
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
  /**
   * Absent on a process that composes no capture lane — a server no hook
   * reports to, or a worker that opted out. Distinct from a lane that is
   * present and silent, exactly as `maintenance_producer` is: absent means
   * "not my job"; `stale: true` means "my job and I am not doing it"
   * (`docs/lane-contract.md`, Tightenings round 8).
   */
  readonly capture?: TransportCaptureHealth;
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
  /**
   * The capture lane's liveness reading, injected the same way `natsHealth`
   * and `producerHealth` are: the live component knows its counters and this
   * module must not guess them. Omitted composes no capture block and cannot
   * degrade the status — which is the ordinary case for most workers, not an
   * edge (core01 runs several; `AGENTS.md`).
   */
  readonly captureHealth?: () => TransportCaptureHealth | undefined;
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
  // #647: a silent capture lane degrades this worker, on the same argument as
  // the producer above. A process that composes no capture lane supplies
  // nothing here and is unaffected — absence is not staleness.
  const capture = input.captureHealth?.();
  const captureDegraded = capture?.stale === true;
  const status =
    database.connected && !natsDegraded && !producerDegraded && !captureDegraded
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
      // Emitted whenever a capture lane exists, not only when it is stale, for
      // the same reason as the producer block above: a field that appears only
      // on failure cannot be graphed, and the healthy reading is what makes a
      // later stale one comparable.
      ...(capture
        ? {
            capture_stale: capture.stale ? 1 : 0,
            capture_sessions_observed: capture.sessions_observed,
            capture_turns_delivered: capture.turns_delivered,
            capture_spool_pending: capture.spool_pending,
            capture_silent_roles: capture.silent_roles.length,
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
  if (captureDegraded) {
    input.logger.warn(
      {
        reason: capture.reason,
        sessions_observed: capture.sessions_observed,
        turns_delivered: capture.turns_delivered,
        spool_pending: capture.spool_pending,
        watermark_wedged: capture.watermark_wedged,
        spool_unannounced: capture.spool_unannounced,
        silent_roles: capture.silent_roles.join(","),
      },
      "capture_lane_health_degraded",
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
    ...(capture ? { capture } : {}),
    timestamp: new Date().toISOString(),
  };
}
