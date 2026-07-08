import type pg from "pg";
import { generateEmbedding } from "./embedding.ts";
import { createNatsBridgeHealth, startNatsContextPackBridge, type NatsBridgeDriver, type NatsBridgeHealth, type NatsBridgeRuntime } from "./nats-bridge.ts";
import { readNatsRuntimeBoundary, summarizeNatsUrlForLog, type NatsRuntimeBoundary } from "./nats-runtime.ts";
import type { ToolDeps } from "./tools/index.ts";
import type { AuthInfo } from "./types.ts";

export interface StartNatsWorkerOptions {
  env: NodeJS.ProcessEnv;
  pool: pg.Pool;
  tokenMap: Map<string, AuthInfo>;
  driver?: NatsBridgeDriver;
  deps?: Partial<ToolDeps>;
}

export interface NatsWorkerRuntime {
  boundary: NatsRuntimeBoundary;
  health: NatsBridgeHealth;
  subject: string;
  close(): Promise<void>;
}

export function readNatsWorkerBoundary(env: NodeJS.ProcessEnv): NatsRuntimeBoundary {
  return readNatsRuntimeBoundary({
    ...env,
    OPENBRAIN_TRANSPORT: "nats",
    OPENBRAIN_NATS_ENABLE_BRIDGE: "true",
  });
}

export async function startNatsWorker(
  options: StartNatsWorkerOptions,
): Promise<NatsWorkerRuntime> {
  const boundary = readNatsWorkerBoundary(options.env);
  if (boundary.nats.availability !== "available") {
    throw new Error(
      "Dedicated NATS worker requires an allowed OPENBRAIN_NATS_URL",
    );
  }

  const health = createNatsBridgeHealth("available");
  const deps: ToolDeps = {
    pool: options.pool,
    embedFn: generateEmbedding,
    ...options.deps,
    natsRuntimeBoundary: boundary,
    natsBridgeHealth: health,
  };
  const bridge = await startNatsContextPackBridge({
    boundary,
    tokenMap: options.tokenMap,
    deps,
    driver: options.driver,
    health,
  });
  if (!bridge) {
    throw new Error("Dedicated NATS worker did not start a bridge runtime");
  }

  return {
    boundary,
    health,
    subject: bridge.subject,
    close: async () => {
      await bridge.close();
    },
  };
}

export function natsWorkerLogSummary(boundary: NatsRuntimeBoundary): object {
  return {
    subject: boundary.nats.context_pack_subject,
    nats_url: summarizeNatsUrlForLog(boundary.nats.url),
  };
}
