import { expect, test, vi } from "vitest";
import type pg from "pg";

import { BackgroundTraceRecorder } from "../observability/background-tracing.ts";
import {
  buildRemPassDeps,
  type DreamRemHandlerDeps,
  type NamedRemGrader,
} from "./dream-rem.ts";
import type { MaintenanceJob } from "./maintenance-job.ts";

test("threads the current job recorder through the scheduled grader factory", () => {
  const trace = new BackgroundTraceRecorder(undefined, {
    name: "dream.rem",
    tags: ["rem"],
  });
  const grader: NamedRemGrader = {
    name: "fixture",
    grade: vi.fn(async () => ({ grade: "inconclusive" as const })),
  };
  const factory = vi.fn(() => grader);
  const deps = {
    pool: {} as pg.Pool,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    graderFactory: factory,
  } as unknown as DreamRemHandlerDeps;
  const job = { payload: {}, namespace: null } as MaintenanceJob;

  const result = buildRemPassDeps(deps, job, trace);

  expect(factory).toHaveBeenCalledWith(trace);
  expect(result.grader).toBe(grader);
});
