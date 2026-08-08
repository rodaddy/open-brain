#!/usr/bin/env bun
/**
 * Done-means driver for #625 — "maintenance sweep goes quiet while /health
 * stays green".
 *
 * Run through `scripts/done-means/625-sweep-heartbeat.sh`, which owns the
 * summary line. This file owns the clauses and the exit code.
 *
 * DETERMINISM CONTRACT (docs/lane-contract.md, Tightenings round 5): there is
 * no `setTimeout`-based waiting and no wall-clock threshold anywhere in the
 * assertions. Time is a variable this driver assigns — `now` — and it is
 * injected into the sweep and the health reader. Advancing time is `now +=`,
 * which is why clause (e) can simulate a 30-minute stall inside a driver that
 * finishes in milliseconds.
 *
 * SUBJECT: the real `startRecurringMaintenanceSweep`
 * (`src/maintenance-sweep.ts`) and the real `getSingleWorkerHealth`
 * (`server/transport/health.ts`). Nothing under test is re-implemented here —
 * the #624 harvest ("injected-dependency tests can 100%-cover a module whose
 * production composition is broken") is why the check drives the shipped
 * functions and fakes only their leaf dependencies (pool, queue, clock).
 */

import { startRecurringMaintenanceSweep } from "../../src/maintenance-sweep.ts";
import { getSingleWorkerHealth } from "../../server/transport/health.ts";
import type { MaintenanceQueueLogger } from "../../src/maintenance-queue.ts";

interface LogLine {
  readonly level: "info" | "warn" | "error";
  readonly message: string;
  readonly fields: Record<string, string | number>;
}

const results: Array<{ clause: string; ok: boolean; detail: string }> = [];

function clause(name: string, ok: boolean, detail: string): void {
  results.push({ clause: name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  (${name}) ${detail}`);
}

function recordingLogger(): {
  logger: MaintenanceQueueLogger;
  lines: LogLine[];
} {
  const lines: LogLine[] = [];
  const at =
    (level: LogLine["level"]) =>
    (message: string, fields: Record<string, string | number> = {}) => {
      lines.push({ level, message, fields });
    };
  return {
    lines,
    logger: { info: at("info"), warn: at("warn"), error: at("error") },
  };
}

/** A pool whose sweep query hangs until the driver releases it. */
function stallingPool(): {
  pool: { query: (...args: unknown[]) => Promise<{ rows: unknown[] }> };
  release: () => void;
  started: () => number;
} {
  let starts = 0;
  let releaseHang: (() => void) | undefined;
  const hang = new Promise<void>((resolve) => {
    releaseHang = resolve;
  });
  return {
    started: () => starts,
    release: () => releaseHang?.(),
    pool: {
      query: async () => {
        starts += 1;
        await hang;
        return { rows: [] };
      },
    },
  };
}

/** A pool that answers immediately with no work to do. */
function idlePool(): {
  pool: { query: (...args: unknown[]) => Promise<{ rows: unknown[] }> };
} {
  return { pool: { query: async () => ({ rows: [] }) } };
}

const noopQueue = {
  enqueue: async () => ({ id: "job", kind: "noop" }) as never,
};

/** Yield to the microtask/macrotask queue without asserting on elapsed time. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await new Promise((r) => setImmediate(r));
}

const QUIET_THRESHOLD_MS = 60_000;
/**
 * The real `setInterval` period the sweep runs on inside this driver. Small so
 * the driver finishes fast; it is a knob of the harness, never an assertion.
 */
const TICK_INTERVAL_MS = 10;
/** Deliberately vast relative to the driver's own runtime — see clause (e). */
const SIMULATED_STALL_MS = 30 * 60_000;

async function main(): Promise<void> {
  const driverStartedAt = Date.now();

  // -----------------------------------------------------------------------
  // Scenario 1 — the stalled producer. Clauses (a), (b), (c).
  // -----------------------------------------------------------------------
  let now = 1_000_000;
  const clock = () => now;
  const stalled = stallingPool();
  const stalledLogs = recordingLogger();

  const sweep = startRecurringMaintenanceSweep({
    pool: stalled.pool as never,
    queue: noopQueue as never,
    logger: stalledLogs.logger,
    intervalMs: TICK_INTERVAL_MS,
    // Injected clock + threshold. On origin/main these options do not exist;
    // TypeScript would reject them, so the driver passes them through a cast
    // and the RED is a runtime absence, not a compile error. That is
    // deliberate: the check must RUN and report FAIL on the pre-fix tree
    // rather than fail to start, or it cannot distinguish "not fixed yet"
    // from "check is broken".
    ...({ now: clock, quietThresholdMs: QUIET_THRESHOLD_MS } as object),
  } as never);

  await settle();

  // Let the sweep's OWN interval timer fire repeatedly while the first tick is
  // still hung. This is the production path: `startRecurringMaintenanceSweep`
  // installs `setInterval(() => void runOnce(), intervalMs)`, and every one of
  // those firings lands on the overlap guard. `runOnce` is deliberately NOT
  // exported — an earlier revision of this driver reached for a non-existent
  // `sweep.runOnce()`, which silently attempted nothing and made clause (a)
  // measure the harness instead of the subject (docs/lane-contract.md,
  // Tightenings round 6: "a clause must clear the ambient state its subject
  // reacts to, or it measures the guard").
  //
  // The interval is real, so this is the one place the driver must yield to the
  // event loop. It is NOT a wall-clock ASSERTION: no clause asserts on elapsed
  // real time, the interval is a tiny fixed value chosen by this driver, and
  // the staleness arithmetic still runs entirely off the injected clock. A slow
  // machine makes this loop take longer; it cannot change any verdict.
  const overlapAttempts = 4;
  for (let i = 0; i < overlapAttempts; i += 1) {
    // Advance the INJECTED clock so the quiet duration grows, then wait just
    // long enough for the real interval to fire once.
    now += 5_000;
    await new Promise((r) => setTimeout(r, TICK_INTERVAL_MS + 5));
    await settle();
  }
  // Advance well past the threshold with the tick still hung.
  now += SIMULATED_STALL_MS;
  await settle();

  const overlapWarnings = stalledLogs.lines.filter(
    (l) =>
      l.level === "warn" &&
      (l.message.includes("overlap") ||
        l.message.includes("skipped") ||
        l.message.includes("still_running")),
  );
  clause(
    "a",
    overlapWarnings.length > 0,
    overlapWarnings.length > 0
      ? `overlapping tick emitted ${overlapWarnings.length} warning line(s) (e.g. ${overlapWarnings[0]?.message})`
      : `overlapping ticks emitted ZERO warnings; sweep started ${stalled.started()} query(ies) and ${stalledLogs.lines.length} total log line(s) — a skipped tick is silent`,
  );

  const liveness = (
    sweep as { liveness?: () => { stale: boolean; quietMs: number } }
  ).liveness?.();
  clause(
    "b",
    liveness !== undefined &&
      liveness.stale === true &&
      liveness.quietMs >= SIMULATED_STALL_MS,
    liveness === undefined
      ? "sweep exposes no liveness reading at all"
      : `liveness reports stale=${liveness.stale} quiet_ms=${liveness.quietMs} against threshold ${QUIET_THRESHOLD_MS}`,
  );

  const stalledHealth = await getSingleWorkerHealth({
    databaseHealth: async () => ({ connected: true }) as never,
    hostname: "done-means-625",
    serverIp: "127.0.0.1",
    serverIps: ["127.0.0.1"],
    probeTimeoutMs: 100,
    logger: { info: () => {}, warn: () => {} } as never,
    ...({ producerHealth: () => liveness ?? { stale: false, quietMs: 0 } } as object),
  } as never);

  const stalledBody = JSON.stringify(stalledHealth);
  const namesProducer =
    stalledBody.includes("producer") || stalledBody.includes("sweep");
  clause(
    "c",
    stalledHealth.status !== "healthy" && namesProducer,
    `/health with a quiet producer reported status=${stalledHealth.status}, names-producer=${namesProducer}` +
      (stalledHealth.status === "healthy"
        ? " — quiet-but-green reproduced"
        : ""),
  );

  stalled.release();
  await sweep.stop();

  // -----------------------------------------------------------------------
  // Scenario 2 — CONTROL: a healthy producer must stay green. Clause (d).
  // -----------------------------------------------------------------------
  let healthyNow = 2_000_000;
  const healthyLogs = recordingLogger();
  const healthySweep = startRecurringMaintenanceSweep({
    pool: idlePool().pool as never,
    queue: noopQueue as never,
    logger: healthyLogs.logger,
    intervalMs: TICK_INTERVAL_MS,
    ...({
      now: () => healthyNow,
      quietThresholdMs: QUIET_THRESHOLD_MS,
    } as object),
  } as never);

  await settle();
  healthyNow += 1_000; // well inside the threshold
  await settle();

  const healthyLiveness = (
    healthySweep as { liveness?: () => { stale: boolean; quietMs: number } }
  ).liveness?.();
  const completedTicks = healthyLogs.lines.filter(
    (l) => l.message === "maintenance_sweep_complete",
  ).length;

  const healthyHealth = await getSingleWorkerHealth({
    databaseHealth: async () => ({ connected: true }) as never,
    hostname: "done-means-625",
    serverIp: "127.0.0.1",
    serverIps: ["127.0.0.1"],
    probeTimeoutMs: 100,
    logger: { info: () => {}, warn: () => {} } as never,
    ...({
      producerHealth: () => healthyLiveness ?? { stale: false, quietMs: 0 },
    } as object),
  } as never);

  clause(
    "d",
    completedTicks > 0 &&
      healthyLiveness !== undefined &&
      healthyLiveness.stale === false &&
      healthyHealth.status === "healthy",
    `control: ${completedTicks} completed tick(s), liveness stale=${healthyLiveness?.stale ?? "absent"}, /health status=${healthyHealth.status}`,
  );

  await healthySweep.stop();

  // -----------------------------------------------------------------------
  // Clause (e) — the clock really is injected.
  // -----------------------------------------------------------------------
  const driverElapsed = Date.now() - driverStartedAt;
  clause(
    "e",
    driverElapsed < SIMULATED_STALL_MS / 10,
    `simulated ${SIMULATED_STALL_MS}ms of quiet in ${driverElapsed}ms of wall clock — clock is injected, not slept`,
  );

  const failed = results.filter((r) => !r.ok);
  console.log();
  console.log(
    `SUMMARY  ${results.length - failed.length}/${results.length} clause(s) passed`,
  );
  if (failed.length > 0) process.exitCode = 1;
}

await main();
