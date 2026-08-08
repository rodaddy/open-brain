/**
 * DONE-MEANS driver for #652 — the capture reading reaches a LIVE /health.
 *
 * Subject: the real serving composition. `createShadowApplication`
 * (server/application/index.ts:114) is what `server/main.ts:280` calls to build
 * the process that serves traffic, and this driver binds its Express app to an
 * ephemeral port and makes real HTTP requests against it. Nothing here
 * re-implements the composition — a check that rebuilds its subject proves the
 * rebuild works (docs/lane-contract.md, #624 harvest).
 *
 * The distinction from #647's driver is the whole point of this issue: that one
 * called `getSingleWorkerHealth(...)` directly with a hand-supplied
 * `captureHealth`, which proves the FUNCTION honors the input. It cannot prove
 * any process ever SUPPLIES one, and #648's own report recorded that none does.
 * Here the input must arrive from the composition itself.
 *
 * Clock: injected. `silence_seconds` is carried through and never compared
 * against a threshold; every verdict is a count or a boolean
 * (docs/lane-contract.md Tightenings round 5 — wall-clock assertions are flake
 * generators, #632/#634).
 */
import express from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createShadowApplication } from "../../server/application/index.ts";
import type { ShadowApplication } from "../../server/application/index.ts";
import { parseServerConfig } from "../../server/config.ts";
import type { ServerConfig } from "../../server/config.ts";
import type { Database, DatabaseHealth } from "../../server/db/pool.ts";
import { silentLogger } from "../../server/transport/testing/silent-logger.ts";

const driverStartedAt = Date.now();

/**
 * Simulated capture silence, in seconds. Orders of magnitude beyond this
 * driver's own runtime — clause (g) asserts the gap, which is what proves the
 * clock is assigned rather than slept through.
 */
const SIMULATED_SILENCE_SECONDS = 1_800;

const results: Array<{ clause: string; ok: boolean; detail: string }> = [];

function clause(name: string, ok: boolean, detail: string): void {
  results.push({ clause: name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  (${name}) ${detail}`);
}

const CONNECTED: DatabaseHealth = { connected: true, total: 2, idle: 2, waiting: 0 };

function testConfig(overrides: Record<string, string> = {}): ServerConfig {
  const result = parseServerConfig({
    DB_HOST: "db.internal",
    DB_NAME: "open_brain_test",
    DB_USER: "open_brain",
    LOG_FILE: "logs/open-brain.log",
    OPEN_BRAIN_SERVER_IP: "192.0.2.21",
    ...overrides,
  });
  if (!result.ok) {
    throw new Error(`invalid driver configuration: ${JSON.stringify(result.issues)}`);
  }
  return result.config;
}

function fakeDatabase(): Database {
  return {
    pool: {} as Database["pool"],
    close: async () => {},
    health: async () => CONNECTED,
  } as Database;
}

interface LiveApp {
  readonly base: string;
  close(): Promise<void>;
}

/**
 * Compose the REAL application and bind it to a kernel-assigned ephemeral port.
 *
 * `overrides` is spread as `object` for the same reason #647's driver did it:
 * on the pre-fix tree the capture input is not a field of the composition's
 * input type, so a typed literal would be a COMPILE error and the check would
 * fail to start. A check that cannot run does not distinguish "not fixed yet"
 * from "check is broken" (#625 precedent), and the RED must be a runtime
 * observation.
 */
async function listen(overrides: Record<string, unknown> = {}): Promise<LiveApp> {
  const application: ShadowApplication = createShadowApplication({
    config: testConfig(),
    logger: silentLogger(),
    database: fakeDatabase(),
    authenticate: ((
      _request: unknown,
      _response: unknown,
      next: () => void,
    ) => next()) as never,
    parseRequestBody: express.json(),
    serverFactory: () => ({ connect: async () => {} }) as never,
    fetch: (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch,
    ...(overrides as object),
  } as never);

  const server: Server = await new Promise((resolve) => {
    const listener = application.app.listen(0, "127.0.0.1", () => resolve(listener));
  });
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await application.close();
    },
  };
}

interface HealthResponse {
  readonly status: number;
  readonly body: Record<string, unknown>;
  readonly raw: string;
}

async function getHealth(base: string): Promise<HealthResponse> {
  const response = await fetch(`${base}/health`);
  const raw = await response.text();
  return {
    status: response.status,
    body: JSON.parse(raw) as Record<string, unknown>,
    raw,
  };
}

/**
 * A capture observation as the gatherer produces one.
 *
 * `watermarkBytesAdvanced` is carried explicitly rather than defaulted, because
 * the wedged-watermark fault fires on ZERO bytes while sessions ran — a
 * gatherer that cannot observe the watermark and reports zero anyway would
 * degrade every healthy deployment. Clause (d) is what catches that.
 */
interface CaptureObservation {
  readonly sessionsObserved: number;
  readonly watermarkBytesAdvanced: number;
  readonly spoolPending: number;
  readonly outageAnnouncements: number;
  readonly turnsByRole: Readonly<Record<string, number>>;
  readonly silenceSeconds: number;
}

const HEALTHY_OBSERVATION: CaptureObservation = {
  sessionsObserved: 9,
  watermarkBytesAdvanced: 1_048_576,
  spoolPending: 0,
  outageAnnouncements: 0,
  turnsByRole: { user: 120, assistant: 118 },
  silenceSeconds: 1,
};

/**
 * The #447 shape, verbatim: a lane total that reads busy while one speaker is
 * dead. `capture-never-drops-a-turn.md:291` records 365 user rows against 13
 * assistant rows over the six days the defect hid; zero is the same failure at
 * full strength.
 */
const HALF_DEAD_OBSERVATION: CaptureObservation = {
  sessionsObserved: 9,
  watermarkBytesAdvanced: 1_048_576,
  spoolPending: 0,
  outageAnnouncements: 0,
  turnsByRole: { user: 365, assistant: 0 },
  silenceSeconds: SIMULATED_SILENCE_SECONDS,
};

function captureBlock(body: Record<string, unknown>): Record<string, unknown> | undefined {
  const capture = body.capture;
  return typeof capture === "object" && capture !== null
    ? (capture as Record<string, unknown>)
    : undefined;
}

async function main(): Promise<void> {
  // -------------------------------------------------------------------------
  // Clauses (a) + (c) — the composition supplies a capture input, and a silent
  // lane observed THROUGH it takes the live endpoint non-green.
  //
  // RED on main: `createShadowApplication` accepts no capture observer, so the
  // override is ignored, no `capture` block is published, and /health answers
  // 200/healthy no matter how dead the lane is.
  // -------------------------------------------------------------------------
  let silentObservation: CaptureObservation | undefined = HALF_DEAD_OBSERVATION;
  const silent = await listen({
    captureObserver: () => silentObservation,
  });

  try {
    const silentHealth = await getHealth(silent.base);
    const silentBlock = captureBlock(silentHealth.body);

    clause(
      "a",
      silentBlock !== undefined,
      silentBlock === undefined
        ? "the serving composition supplied NO capture input — /health published no capture block " +
          "(the #648 residual risk reproduced: reader merged, nothing composes it)"
        : `the serving composition supplied a capture input — /health published a capture block ` +
          `with ${Object.keys(silentBlock).length} field(s)`,
    );

    clause(
      "b",
      silentHealth.raw.includes("capture"),
      `live GET /health over HTTP names-capture=${silentHealth.raw.includes("capture")} ` +
        `(status ${silentHealth.status})`,
    );

    const silentRoles = silentBlock?.silent_roles;
    const namesAssistant =
      Array.isArray(silentRoles) && silentRoles.includes("assistant");
    clause(
      "c",
      silentHealth.status === 503 &&
        silentHealth.body.status === "degraded" &&
        silentBlock?.stale === true &&
        namesAssistant,
      `silent lane (365 user turns beside 0 assistant) -> HTTP ${silentHealth.status}, ` +
        `status=${String(silentHealth.body.status)}, stale=${String(silentBlock?.stale)}, ` +
        `silent_roles=${JSON.stringify(silentRoles ?? null)}` +
        (silentHealth.body.status === "healthy"
          ? " — silent-but-green reproduced (the #652 defect)"
          : ""),
    );

    // -----------------------------------------------------------------------
    // Clause (h) — the reading is LATE-BOUND.
    //
    // Same composed application, same listener; only the observation changes.
    // A value captured at composition time would answer identically forever,
    // which is the stale-but-confident reading server/application/index.ts
    // already argues against for the producer.
    // -----------------------------------------------------------------------
    silentObservation = HEALTHY_OBSERVATION;
    const recovered = await getHealth(silent.base);
    clause(
      "h",
      silentHealth.body.status === "degraded" &&
        recovered.body.status === "healthy" &&
        captureBlock(recovered.body)?.stale === false,
      `same composed app, observation changed: first=${String(silentHealth.body.status)} ` +
        `then=${String(recovered.body.status)} (stale=${String(captureBlock(recovered.body)?.stale)}) ` +
        `— reading is late-bound, not captured at boot`,
    );

    // -----------------------------------------------------------------------
    // Clause (g) — the clock is injected.
    // -----------------------------------------------------------------------
    const carriedSilence = captureBlock(silentHealth.body)?.silence_seconds;
    const driverElapsedSeconds = (Date.now() - driverStartedAt) / 1000;
    clause(
      "g",
      driverElapsedSeconds < SIMULATED_SILENCE_SECONDS / 10 &&
        (carriedSilence === undefined || typeof carriedSilence === "number"),
      `simulated ${SIMULATED_SILENCE_SECONDS}s of capture silence in ` +
        `${driverElapsedSeconds.toFixed(3)}s of wall clock ` +
        `(carried as silence_seconds=${String(carriedSilence)}, never compared) ` +
        `— clock is injected, not slept`,
    );
  } finally {
    await silent.close();
  }

  // -------------------------------------------------------------------------
  // Clause (d) — CONTROL: a delivering lane stays green AND publishes.
  //
  // This is the clause a always-degrade implementation fails, and it is also
  // the one that catches a gatherer reporting watermark bytes it cannot
  // observe as zero: zero bytes while sessions ran is the wedged-watermark
  // fault, so such a gatherer would degrade every healthy deployment here.
  // -------------------------------------------------------------------------
  const healthy = await listen({
    captureObserver: () => HEALTHY_OBSERVATION,
  });
  try {
    const health = await getHealth(healthy.base);
    const block = captureBlock(health.body);
    clause(
      "d",
      health.status === 200 &&
        health.body.status === "healthy" &&
        block !== undefined &&
        block.stale === false,
      `control: delivering lane -> HTTP ${health.status}, status=${String(health.body.status)}, ` +
        `block published=${block !== undefined}, stale=${String(block?.stale)}`,
    );
  } finally {
    await healthy.close();
  }

  // -------------------------------------------------------------------------
  // Clause (e) — CONTROL: absence is not staleness.
  //
  // A deployment that composes no capture lane at all. This clause PASSES
  // pre-fix, deliberately: a check that fails everywhere proves only that it
  // fails, and this is the half that stops the feature degrading every worker
  // that legitimately opted out (docs/lane-contract.md round 13).
  // -------------------------------------------------------------------------
  const absent = await listen();
  try {
    const health = await getHealth(absent.base);
    clause(
      "e",
      health.status === 200 &&
        health.body.status === "healthy" &&
        captureBlock(health.body) === undefined,
      `control: no capture lane composed -> HTTP ${health.status}, ` +
        `status=${String(health.body.status)}, capture block absent=${
          captureBlock(health.body) === undefined
        }`,
    );
  } finally {
    await absent.close();
  }

  // -------------------------------------------------------------------------
  // Clause (f) — CONTROL: a composed observer with nothing to report.
  //
  // A fresh process, or a window in which no session was seen at all. The
  // observer exists but has no observation; it must publish nothing and stay
  // green rather than fabricate either verdict. Same shape `producerHealth`
  // already returns while maintenance is disabled (index.ts:159-161).
  // -------------------------------------------------------------------------
  const quiet = await listen({
    captureObserver: () => undefined,
  });
  try {
    const health = await getHealth(quiet.base);
    clause(
      "f",
      health.status === 200 &&
        health.body.status === "healthy" &&
        captureBlock(health.body) === undefined,
      `control: observer composed but observation unavailable -> HTTP ${health.status}, ` +
        `status=${String(health.body.status)}, capture block absent=${
          captureBlock(health.body) === undefined
        }`,
    );
  } finally {
    await quiet.close();
  }

  const failed = results.filter((r) => !r.ok);
  console.log();
  console.log(`clauses: ${results.length} run, ${failed.length} failed`);
  if (failed.length > 0) {
    console.log(`failing: ${failed.map((f) => f.clause).join(", ")}`);
  }
  process.exit(failed.length > 0 ? 1 : 0);
}

// An exception escaping `main` must FAIL, loudly. Without this the top-level
// `await` rejects, Bun prints the trace, and the process still exits 0 — a
// crashing subject would bank a false GREEN. Observed for real in #648's own
// driver while mutation-testing it (docs/lane-contract.md Tightenings round 13;
// SME entry order 67), which is why this catch is written before the first RED
// rather than after a surprise.
main().catch((error: unknown) => {
  console.log();
  console.log(
    `FAIL  (driver) threw before completing: ${
      error instanceof Error ? error.message : String(error)
    }`,
  );
  process.exit(1);
});
