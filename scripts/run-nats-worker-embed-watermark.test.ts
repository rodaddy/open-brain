/**
 * RED-FIRST done-means check for issue #724 item 3 — the embed watermark is
 * invisible to health.
 *
 * WHAT WENT WRONG. The maintenance producer ticked for three days with no
 * consumer draining the embed queue. Raw rows kept arriving; embedded rows
 * stopped. Nothing anywhere compared the two, so every liveness surface stayed
 * green while the corpus silently stopped being searchable. A watermark check —
 * newest embedded-row age against newest raw-row age — would have caught it in
 * about an hour instead of three days.
 *
 * WHY THIS SURFACE, ON THIS PORT. `docs/core01-nats-worker-runbook.md`
 * ("What `/health` on 3100 does and does NOT show") is explicit that the HTTP
 * service derives its blocks from its OWN process environment and deliberately
 * never observes the separate worker process. The runbook forbids "fixing"
 * 3100 by putting the worker back in the HTTP service's business. The worker's
 * own health is on `OPEN_BRAIN_NATS_WORKER_HEALTH_PORT` (3110), composed by
 * `startHealthServer` in `scripts/run-nats-worker.ts:83-113` and reachable only
 * through `startNatsWorkerProcess` (`scripts/run-nats-worker.ts:174`), which is
 * why this test drives it through an injected `serve` rather than binding a
 * port.
 *
 * NAMING MATCHED, NOT INVENTED. `server/transport/health.ts:14-33` and
 * `:35-79` already establish the convention for a background-lane liveness
 * block on this repo's health payloads: a snake_case named block, a boolean
 * `stale` that is the verdict, the raw counters beside it, an explicit
 * `*_threshold_*` naming the bound the verdict used, and a content-free
 * `reason`. `src/operator-doctor.ts:111` establishes `*_age_seconds` as the
 * spelling for an age. This block therefore reads:
 *
 *   embed_watermark: {
 *     stale, newest_raw_age_seconds, newest_embedded_age_seconds,
 *     lag_seconds, lag_threshold_seconds, raw_rows_recent, reason
 *   }
 *
 * ABSENCE IS NOT STALENESS (`docs/lane-contract.md`, Tightenings rounds 8/13,
 * restated at `server/transport/health.ts:93-105`): a worker that composes no
 * watermark observer publishes no block and cannot be degraded by one. That is
 * asserted here too, so the fix cannot degrade every worker that opts out.
 *
 * INJECTED CLOCK, NO WALL-CLOCK SLEEPS (`docs/lane-contract.md`, Tightenings
 * round 5 — wall-clock assertions are flake generators). Every age in this file
 * comes from fixture data, and the lag verdict is a comparison of two supplied
 * ages, never of `Date.now()` against anything.
 *
 * STATUS: RED as written. `startHealthServer` composes only `status`, `nats`,
 * and `timestamp` (`scripts/run-nats-worker.ts:100-111`); there is no
 * `embedWatermarkHealth` option on `StartNatsWorkerProcessOptions`
 * (`scripts/run-nats-worker.ts:28-36`) and no `embed_watermark` key on the
 * payload. This file asserts the DESIRED behavior and is expected to fail until
 * that surface exists. It does not implement it.
 */
import { describe, expect, it } from "bun:test";
import { createNatsBridgeHealth } from "../src/nats-bridge.ts";
import {
  readNatsWorkerBoundary,
  type NatsWorkerRuntime,
} from "../src/nats-worker.ts";
import { startNatsWorkerProcess } from "./run-nats-worker.ts";

/**
 * The block this lane's fix must add to the worker health payload.
 *
 * Deliberately declared in the TEST, not imported: the type does not exist on
 * the branch yet, and importing it would make this file fail to typecheck
 * rather than fail as a red assertion. The fix replaces this with an import.
 */
interface EmbedWatermarkHealthShape {
  readonly stale: boolean;
  readonly newest_raw_age_seconds: number;
  readonly newest_embedded_age_seconds: number;
  readonly lag_seconds: number;
  readonly lag_threshold_seconds: number;
  readonly raw_rows_recent: number;
  readonly reason: string;
}

const NATS_URL = "nats://127.0.0.1:4222";

function workerRuntime(env: NodeJS.ProcessEnv): NatsWorkerRuntime {
  return {
    boundary: readNatsWorkerBoundary(env),
    // The bridge itself is AVAILABLE in every case below. That is the whole
    // point: a healthy bridge must not be able to mask a stalled embed lane,
    // which is exactly the shape of the three-day outage.
    health: createNatsBridgeHealth("available"),
    subject: "dev.ob.memory.context_pack",
    close: async () => undefined,
  };
}

/**
 * Start the worker with `serve` captured rather than bound, hit `/health`, and
 * return the parsed body with its HTTP status.
 *
 * No port is opened and no clock is read; `serve` is a fake that hands back the
 * `fetch` handler `startHealthServer` registered.
 */
async function readWorkerHealth(
  embedWatermark: EmbedWatermarkHealthShape | undefined,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const env: NodeJS.ProcessEnv = {
    OPENBRAIN_NATS_URL: NATS_URL,
    OPEN_BRAIN_NATS_WORKER_HEALTH_PORT: "3110",
  };
  let handler: ((request: Request) => Response | Promise<Response>) | null =
    null;

  const processRuntime = await startNatsWorkerProcess({
    env,
    log: { info: () => undefined, error: () => undefined },
    buildTokens: () =>
      new Map([["secret-token", { role: "admin", clientId: "rico" }]]),
    createDbPool: () => ({ end: async () => undefined }) as any,
    startWorker: async () => workerRuntime(env),
    serve: ((options: {
      fetch: (request: Request) => Response | Promise<Response>;
    }) => {
      handler = options.fetch;
      return { stop: () => undefined };
    }) as any,
    // Injected the same way `natsHealth`, `producerHealth`, and `captureHealth`
    // are on the HTTP side (`server/transport/health.ts:118-138`): the live
    // component knows its own counters and the health composer must not guess
    // them. `undefined` composes no block.
    embedWatermarkHealth: () => embedWatermark,
  } as any);

  try {
    if (!handler) throw new Error("worker health server was never composed");
    const response = await (
      handler as (request: Request) => Response | Promise<Response>
    )(new Request("http://127.0.0.1:3110/health"));
    return {
      status: response.status,
      body: (await response.json()) as Record<string, unknown>,
    };
  } finally {
    await processRuntime.shutdown();
  }
}

/** Ages are fixture data. Nothing here reads a wall clock. */
const CURRENT_WATERMARK: EmbedWatermarkHealthShape = {
  stale: false,
  newest_raw_age_seconds: 45,
  newest_embedded_age_seconds: 60,
  lag_seconds: 15,
  lag_threshold_seconds: 3_600,
  raw_rows_recent: 128,
  reason: "embed watermark within threshold",
};

/**
 * The three-day outage, compressed into a fixture: raw rows are arriving
 * steadily and the newest embedded row is over three days behind them.
 */
const LAGGING_WATERMARK: EmbedWatermarkHealthShape = {
  stale: true,
  newest_raw_age_seconds: 30,
  newest_embedded_age_seconds: 259_230,
  lag_seconds: 259_200,
  lag_threshold_seconds: 3_600,
  raw_rows_recent: 1_412,
  reason: "embed watermark lags newest raw row past threshold",
};

describe("nats worker /health embed watermark (#724 item 3)", () => {
  it("carries the embed watermark ages when an observer is composed", async () => {
    const { body } = await readWorkerHealth(CURRENT_WATERMARK);

    const block = body.embed_watermark as EmbedWatermarkHealthShape | undefined;
    expect(block).toBeDefined();
    expect(block?.newest_raw_age_seconds).toBe(45);
    expect(block?.newest_embedded_age_seconds).toBe(60);
    expect(block?.lag_seconds).toBe(15);
    expect(block?.lag_threshold_seconds).toBe(3_600);
    expect(block?.raw_rows_recent).toBe(128);
  });

  it("CONTROL — a current watermark leaves the worker healthy", async () => {
    // Without this control the lagging assertion below proves nothing: a
    // surface that reported `degraded` unconditionally would pass it.
    const { status, body } = await readWorkerHealth(CURRENT_WATERMARK);

    expect(body.status).toBe("healthy");
    expect(status).toBe(200);
    expect((body.embed_watermark as EmbedWatermarkHealthShape).stale).toBe(
      false,
    );
  });

  it("flips off healthy when the embed watermark lags raw past the threshold", async () => {
    // The bridge is `available` in this fixture — a healthy NATS block must not
    // be able to hold the endpoint green while the embed lane is three days
    // behind. This is the assertion the three-day outage would have tripped.
    const { status, body } = await readWorkerHealth(LAGGING_WATERMARK);

    expect(body.status).toBe("degraded");
    expect(status).toBe(503);
    const block = body.embed_watermark as EmbedWatermarkHealthShape;
    expect(block.stale).toBe(true);
    expect(block.lag_seconds).toBeGreaterThan(block.lag_threshold_seconds);
    expect(block.raw_rows_recent).toBeGreaterThan(0);
    expect(block.reason).toBeTruthy();
  });

  it("stale requires FRESH RAW ROWS — an idle corpus is not a stalled embedder", async () => {
    // A quiet week produces an old embedded row too, and alarming on that is
    // how a check stops being read (`server/capture/liveness-observer.ts`
    // MIN_SESSIONS_FOR_SILENCE carries the same argument for capture). The
    // verdict must need evidence that raw rows were still arriving.
    const idleCorpus: EmbedWatermarkHealthShape = {
      stale: false,
      newest_raw_age_seconds: 259_200,
      newest_embedded_age_seconds: 259_260,
      lag_seconds: 60,
      lag_threshold_seconds: 3_600,
      raw_rows_recent: 0,
      reason: "no recent raw rows; watermark lag is not evidence of a stall",
    };
    const { status, body } = await readWorkerHealth(idleCorpus);

    expect(body.status).toBe("healthy");
    expect(status).toBe(200);
    expect((body.embed_watermark as EmbedWatermarkHealthShape).stale).toBe(
      false,
    );
  });

  it("ABSENCE IS NOT STALENESS — no observer composes no block and stays healthy", async () => {
    // A worker that does not own the embed lane must be unaffected, exactly as
    // `maintenance_producer` and `capture` are optional on the HTTP payload
    // (`server/transport/health.ts:93-105`).
    const { status, body } = await readWorkerHealth(undefined);

    expect(body.status).toBe("healthy");
    expect(status).toBe(200);
    expect(body.embed_watermark).toBeUndefined();
  });
});
