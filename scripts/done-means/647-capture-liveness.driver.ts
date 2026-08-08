#!/usr/bin/env bun
/**
 * Done-means driver for #647 — the health-composition clauses.
 *
 * Run through `scripts/done-means/647-capture-liveness.sh`, which owns the
 * summary line. This file owns clauses (d), (e-health), (f-health) and its own
 * exit code.
 *
 * DETERMINISM CONTRACT (docs/lane-contract.md, Tightenings round 5): no
 * `setTimeout` waiting, no wall-clock threshold in any assertion. The capture
 * reading is a VALUE injected into the health reader, exactly as `#625` injects
 * `producerHealth` — the staleness decision was already made (and proven,
 * count-based and clock-injected) by the Python driver; this file proves only
 * that the decision REACHES `/health` and moves it.
 *
 * SUBJECT: the real `getSingleWorkerHealth` (`server/transport/health.ts`).
 * Nothing under test is re-implemented — the #624 harvest ("injected-dependency
 * tests can 100%-cover a module whose production composition is broken") is why
 * this drives the shipped function and fakes only its leaf dependencies.
 *
 * WHY THE SUBJECT IS THIS FUNCTION AND NOT THE HTTP ROUTE: `getSingleWorkerHealth`
 * is where the status is DERIVED (health.ts:131-134), and the route's 503 is a
 * pure function of that status. Driving the derivation needs no listener, no
 * port, and no database, which is what keeps this runnable in CI.
 */

import { getSingleWorkerHealth } from "../../server/transport/health.ts";

const results: Array<{ clause: string; ok: boolean; detail: string }> = [];

function clause(name: string, ok: boolean, detail: string): void {
  results.push({ clause: name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  (${name}) ${detail}`);
}

interface Recorded {
  readonly level: "info" | "warn";
  readonly message: string;
  readonly fields: Record<string, unknown>;
}

function recordingLogger(): { logger: unknown; lines: Recorded[] } {
  const lines: Recorded[] = [];
  const at =
    (level: Recorded["level"]) =>
    (fields: Record<string, unknown>, message: string) => {
      // pino's signature is (obj, msg); health.ts calls it that way.
      lines.push({ level, message, fields });
    };
  return { lines, logger: { info: at("info"), warn: at("warn") } };
}

/**
 * A capture reading shaped as the health layer's input.
 *
 * Deliberately a PLAIN VALUE, not a live reader: what is under test here is the
 * composition, and a real capture lane would drag SQLite files and a transcript
 * into a check that must run in CI. The Python driver owns proving the reading
 * itself is derived from counts.
 */
function captureReading(stale: boolean): Record<string, unknown> {
  return {
    stale,
    sessions_observed: 9,
    turns_delivered: stale ? 0 : 238,
    watermark_bytes_advanced: stale ? 0 : 1_048_576,
    spool_pending: 0,
    spool_unannounced: false,
    watermark_wedged: stale,
    silent_roles: stale ? ["user", "assistant"] : [],
    silence_seconds: stale ? 1_800 : 1,
  };
}

function baseInput(logger: unknown): Record<string, unknown> {
  return {
    databaseHealth: async () => ({ connected: true }),
    hostname: "done-means-647",
    serverIp: "127.0.0.1",
    serverIps: ["127.0.0.1"],
    probeTimeoutMs: 100,
    logger,
  };
}

async function main(): Promise<void> {
  // -----------------------------------------------------------------------
  // Clause (d) — a stale capture reading takes the worker NON-green and names
  // capture as the reason.
  //
  // On origin/main `captureHealth` is not a field of `SingleWorkerHealthInput`
  // (health.ts:60-79), so it is ignored entirely and the status stays "healthy"
  // off the database probe alone (health.ts:131-134). The RED is a runtime
  // absence rather than a compile error — deliberate, so the check RUNS and
  // reports FAIL on the pre-fix tree instead of failing to start, which would
  // not distinguish "not fixed yet" from "check is broken" (#625 precedent).
  // -----------------------------------------------------------------------
  const staleLogs = recordingLogger();
  const staleHealth = await getSingleWorkerHealth({
    ...baseInput(staleLogs.logger),
    ...({ captureHealth: () => captureReading(true) } as object),
  } as never);

  const staleBody = JSON.stringify(staleHealth);
  const namesCapture = staleBody.includes("capture");
  const warned = staleLogs.lines.some(
    (l) => l.level === "warn" && l.message.includes("capture"),
  );
  clause(
    "d",
    staleHealth.status !== "healthy" && namesCapture,
    `/health with a silent capture lane reported status=${staleHealth.status}, ` +
      `names-capture=${namesCapture}, warn-line=${warned}` +
      (staleHealth.status === "healthy"
        ? " — silent-but-green reproduced (the #647 defect)"
        : ""),
  );

  // -----------------------------------------------------------------------
  // Clause (e-health) — CONTROL: a HEALTHY capture reading keeps /health green
  // and still publishes the block.
  //
  // The block must be present on the healthy path too, for the reason
  // health.ts:143-145 already gives about the producer: "the healthy reading is
  // what makes a later stale one comparable, and a field that appears only on
  // failure cannot be graphed."
  // -----------------------------------------------------------------------
  const healthyLogs = recordingLogger();
  const healthyHealth = await getSingleWorkerHealth({
    ...baseInput(healthyLogs.logger),
    ...({ captureHealth: () => captureReading(false) } as object),
  } as never);

  const healthyBody = JSON.stringify(healthyHealth);
  clause(
    "e-health",
    healthyHealth.status === "healthy" && healthyBody.includes("capture"),
    `control: healthy capture reading -> status=${healthyHealth.status}, ` +
      `block published=${healthyBody.includes("capture")}`,
  );

  // -----------------------------------------------------------------------
  // Clause (f-health) — CONTROL: absence is not staleness.
  //
  // docs/lane-contract.md Tightenings round 8. A process that composes no
  // capture lane supplies no reading; it must get NO capture block and must
  // stay green. Without this clause the feature degrades every worker that
  // legitimately opted out — and core01 runs multiple workers (AGENTS.md), so
  // "not my job" is the ordinary case for most of them, not an edge.
  // -----------------------------------------------------------------------
  const absentLogs = recordingLogger();
  const absentHealth = await getSingleWorkerHealth(
    baseInput(absentLogs.logger) as never,
  );
  const absentBody = JSON.stringify(absentHealth);
  clause(
    "f-health",
    absentHealth.status === "healthy" && !absentBody.includes("capture"),
    `control: no capture lane composed -> status=${absentHealth.status}, ` +
      `capture block absent=${!absentBody.includes("capture")}`,
  );

  // An UNDEFINED reading from a composed-but-not-yet-ready reader is the same
  // case as absence, and is the shape `producerHealth` already returns while
  // maintenance is disabled (server/application/index.ts:159-161). It must not
  // degrade either.
  const undefinedLogs = recordingLogger();
  const undefinedHealth = await getSingleWorkerHealth({
    ...baseInput(undefinedLogs.logger),
    ...({ captureHealth: () => undefined } as object),
  } as never);
  clause(
    "f-health-undefined",
    undefinedHealth.status === "healthy" &&
      !JSON.stringify(undefinedHealth).includes("capture"),
    `control: reader present but returns undefined -> status=${undefinedHealth.status}`,
  );

  const failed = results.filter((r) => !r.ok);
  console.log();
  console.log(`clauses: ${results.length} run, ${failed.length} failed`);
  if (failed.length > 0) {
    console.log(`failing: ${failed.map((f) => f.clause).join(", ")}`);
  }
  process.exit(failed.length > 0 ? 1 : 0);
}

await main();
