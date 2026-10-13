/**
 * dream.route registers only when its config is enabled (issue 1525).
 */
import type pg from "pg";
import { describe, expect, test } from "vitest";
import type { RouteProducerConfig } from "../config/maintenance.ts";
import {
  MAINTENANCE_GRAPH_AUTH,
  composeMaintenanceHandlers,
} from "./maintenance-bootstrap.ts";
import { DREAM_ROUTE_JOB_KIND, buildDreamRouteEnqueue } from "./dream-route.ts";

const logger = { info: () => undefined, warn: () => undefined, error: () => undefined };

function handlersWith(route?: RouteProducerConfig) {
  return composeMaintenanceHandlers({
    pool: {} as pg.Pool,
    logger,
    embedFn: async () => {
      throw new Error("not called");
    },
    graphAuth: MAINTENANCE_GRAPH_AUTH,
    ...(route ? { route } : {}),
  });
}

describe("dream.route registration", () => {
  test("absent when the route config is missing", () => {
    expect(handlersWith().has(DREAM_ROUTE_JOB_KIND)).toBe(false);
  });

  test("absent when the route config is disabled", () => {
    expect(handlersWith({ enabled: false }).has(DREAM_ROUTE_JOB_KIND)).toBe(false);
  });

  test("present when the route config is enabled", () => {
    const handlers = handlersWith({
      enabled: true,
      backend: "fake",
      sliceSize: 10,
      minGapMs: 0,
      maxUsdPerRun: 0.5,
    });
    expect(handlers.has(DREAM_ROUTE_JOB_KIND)).toBe(true);
  });

  test("the enqueue request carries the kind in its idempotency key", () => {
    expect(buildDreamRouteEnqueue({ sweepLabel: "t1" })).toEqual({
      kind: "dream.route",
      version: 1,
      payload: {},
      idempotencyKey: "dream.route:t1",
    });
  });
});
